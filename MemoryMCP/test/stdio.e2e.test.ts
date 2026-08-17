import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-e2e-not-for-logs";

function encode(obj: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

async function rpc(
  child: ReturnType<typeof spawn>,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolveRpc, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stdout?.off("data", onData);
      reject(new Error(`timeout ${method}`));
    }, 10000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id === id) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          resolveRpc(msg as Record<string, unknown>);
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stdin?.write(encode({ jsonrpc: "2.0", id, method, params }));
  });
}

describe("stdio MCP entry", () => {
  let server: ReturnType<typeof createServer>;
  let port = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          query?: string;
        };
        const data = String(body.query ?? "").includes("from-items")
          ? {
              items: [{ id: "msg-seed-items", role: "user", content: "items-only", score: 1 }],
            }
          : {
              messages: [
                { id: "msg-seed-messages", role: "user", content: "canonical", score: 1 },
              ],
            };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, message: "ok", data }));
      });
    });
    port = await new Promise<number>((resolvePort) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolvePort(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    child = spawn(process.execPath, [resolve(root, "bin/tdai-memory-mcp.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        TDAI_ENDPOINT: `http://127.0.0.1:${port}`,
        TDAI_API_KEY: KEY,
        TDAI_SERVICE_ID: "default",
        TDAI_TEAM_ID: "team-e2e",
        TDAI_AGENT_ID: "agt-e2e",
        TDAI_USER_ID: "usr-e2e",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c) => stdoutChunks.push(c as Buffer));
    child.stderr?.on("data", (c) => stderrChunks.push(c as Buffer));

    await rpc(child, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    child.stdin?.write(encode({ jsonrpc: "2.0", method: "notifications/initialized" }));
  });

  afterAll(async () => {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("close", r));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("lists exactly four read tools and searches L0 via shipped stdio entry", async () => {
    const listed = await rpc(child, 2, "tools/list", {});
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "tdai_memory_context",
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_scene_read",
    ]);

    const call = await rpc(child, 3, "tools/call", {
      name: "tdai_conversation_search",
      arguments: { query: "canonical" },
    });
    const text = (call.result as { content: Array<{ text: string }> }).content[0].text;
    const body = JSON.parse(text) as { messages: Array<{ id: string }> };
    expect(body.messages[0]?.id).toBe("msg-seed-messages");

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(stdout).not.toContain(KEY);
    expect(stderr).not.toContain(KEY);
    for (const line of stdout.split("\n").filter(Boolean)) {
      expect(JSON.parse(line).jsonrpc).toBe("2.0");
    }
  });
});
