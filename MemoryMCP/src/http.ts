import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IdentityConfig } from "./config.js";
import { createSdkMemoryPort } from "./client.js";
import type { Logger } from "./logger.js";
import { createMemoryMcpServer } from "./server.js";
import {
  configForIdentity,
  extractBearer,
  parseBindingsJson,
  type PrincipalBinding,
} from "./bindings.js";

export interface HttpOptions {
  config: IdentityConfig;
  log: Logger;
  port: number;
  host: string;
  bindings: Map<string, PrincipalBinding>;
  allowedOrigins: string[];
}

/** Cap concurrent sessions and reap ones idle beyond the TTL. */
const MAX_SESSIONS = 200;
const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  token: string;
  lastSeen: number;
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

/**
 * Streamable HTTP MCP with stateful sessions. Auth token is an MCP principal
 * mapped server-side to one or more identities; the active identity is chosen
 * per session (elicitation or tdai_identity_use). Core API key stays on the
 * server and is never forwarded.
 */
export function startHttpServer(opts: HttpOptions): Promise<{ close: () => Promise<void> }> {
  if (opts.bindings.size === 0) {
    throw new Error("TDAI_MCP_HTTP_PORT set but TDAI_MCP_BINDINGS is empty");
  }

  const sessions = new Map<string, HttpSession>();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [sid, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(sid);
        session.transport.close().catch(() => {});
        opts.log.info(`session ${sid} expired (idle)`);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  async function createSession(token: string, binding: PrincipalBinding): Promise<StreamableHTTPServerTransport> {
    const mcp = createMemoryMcpServer({
      config: opts.config,
      log: opts.log,
      selection: {
        binding,
        makeConfig: (identity) => configForIdentity(opts.config, identity),
        makeMemory: (cfg) => createSdkMemoryPort(cfg),
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, token, lastSeen: Date.now() });
        opts.log.info(`session ${sid} initialized (${binding.identities.length} identities)`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    await mcp.connect(transport);
    return transport;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(origin, opts.allowedOrigins)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin ?? "*",
        "access-control-allow-headers": "authorization, content-type, mcp-session-id",
        "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    const token = extractBearer(
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    );
    const binding = token ? opts.bindings.get(token) : undefined;
    if (!token || !binding) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    try {
      if (sessionId) {
        const session = sessions.get(sessionId);
        // Sessions are token-scoped: a valid session id under a different
        // token must not resume someone else's identity selection.
        if (!session || session.token !== token) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found; re-initialize" },
              id: null,
            }),
          );
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "too_many_sessions" }));
        return;
      }

      // No session id: must be an initialize request; the transport rejects
      // anything else with a protocol error.
      const transport = await createSession(token, binding);
      await transport.handleRequest(req, res);
    } catch (err) {
      opts.log.error(`http mcp error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      opts.log.info(`streamable HTTP listening on http://${opts.host}:${opts.port}/mcp`);
      resolve({
        close: () =>
          new Promise((r) => {
            clearInterval(sweep);
            for (const [, session] of sessions) session.transport.close().catch(() => {});
            sessions.clear();
            httpServer.close(() => r());
          }),
      });
    });
  });
}

export function httpOptionsFromEnv(
  config: IdentityConfig,
  env: NodeJS.Dict<string>,
  log: Logger,
): HttpOptions | null {
  const portRaw = env.TDAI_MCP_HTTP_PORT;
  if (!portRaw || !portRaw.trim()) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("TDAI_MCP_HTTP_PORT must be a positive integer");
  }
  const host = (env.TDAI_MCP_HTTP_HOST || "127.0.0.1").trim();
  const origins = (env.TDAI_MCP_HTTP_ORIGINS || "http://127.0.0.1,http://localhost")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    config,
    log,
    port,
    host,
    bindings: parseBindingsJson(env.TDAI_MCP_BINDINGS),
    allowedOrigins: origins,
  };
}
