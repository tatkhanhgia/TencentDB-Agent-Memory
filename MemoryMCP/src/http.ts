import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IdentityConfig } from "./config.js";
import { createSdkMemoryPort } from "./client.js";
import type { Logger } from "./logger.js";
import { createMemoryMcpServer } from "./server.js";
import { configForBinding, extractBearer, parseBindingsJson, type PrincipalBinding } from "./bindings.js";

export interface HttpOptions {
  config: IdentityConfig;
  log: Logger;
  port: number;
  host: string;
  bindings: Map<string, PrincipalBinding>;
  allowedOrigins: string[];
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

/**
 * Streamable HTTP MCP. Auth token is an MCP principal mapped server-side
 * to team/agent/user. Core API key stays on the server and is never forwarded.
 */
export function startHttpServer(opts: HttpOptions): Promise<{ close: () => Promise<void> }> {
  if (opts.bindings.size === 0) {
    throw new Error("TDAI_MCP_HTTP_PORT set but TDAI_MCP_BINDINGS is empty");
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

    const cfg = configForBinding(opts.config, binding);
    const mcp = createMemoryMcpServer({
      config: cfg,
      memory: createSdkMemoryPort(cfg),
      log: opts.log,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
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
        close: () => new Promise((r) => httpServer.close(() => r())),
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
