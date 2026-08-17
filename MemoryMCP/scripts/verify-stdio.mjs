#!/usr/bin/env node
/**
 * Drive the real stdio MCP entry: initialize + tools/list twice,
 * then tools/call L0 search against an HTTP stand-in.
 *
 * Scratch dir: TDAI_VERIFY_SCRATCH or the goal implementer scratch.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch =
  process.env.TDAI_VERIFY_SCRATCH ||
  "/var/folders/nq/w629yzfx38qcyxx4rztxzc5w0000gn/T/grok-goal-2a07e6ebbd73/implementer";
mkdirSync(scratch, { recursive: true });

const fixtures = {
  messages: JSON.parse(readFileSync(resolve(root, "test/fixtures/l0-messages.json"), "utf8")),
  items: JSON.parse(readFileSync(resolve(root, "test/fixtures/l0-items-only.json"), "utf8")),
};

const API_KEY = "sk-verify-DO-NOT-LEAK-9f3a";

/** Official MCP TypeScript SDK stdio transport is newline-delimited JSON. */
function encodeFrame(obj) {
  return Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
}

function createFramedReader(stream) {
  let buf = Buffer.alloc(0);
  const queue = [];
  let waiter = null;

  const consume = () => {
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiter) {
        const resolveWait = waiter;
        waiter = null;
        resolveWait(msg);
      } else {
        queue.push(msg);
      }
    }
  };

  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    consume();
  });

  return {
    next(timeoutMs = 8000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolveNext, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting MCP frame")), timeoutMs);
        waiter = (msg) => {
          clearTimeout(timer);
          resolveNext(msg);
        };
      });
    },
    async nextId(id, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const msg = await this.next(Math.max(50, deadline - Date.now()));
        if (msg.id === id) return msg;
      }
      throw new Error(`timeout waiting MCP response id=${id}`);
    },
  };
}

function startStandin() {
  return new Promise((resolveListen) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        const query = typeof body.query === "string" ? body.query : "";
        const data = query.includes("from-items") ? fixtures.items : fixtures.messages;
        const envelope = { code: 0, message: "ok", data };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveListen({ server, port: addr.port });
    });
  });
}

function spawnMcp(envExtra, stdoutPath, stderrPath) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, [resolve(root, "bin/tdai-memory-mcp.mjs")], {
    cwd: root,
    env: { ...process.env, ...envExtra },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => stdoutChunks.push(c));
  child.stderr.on("data", (c) => stderrChunks.push(c));
  const reader = createFramedReader(child.stdout);

  const flush = () => {
    writeFileSync(stdoutPath, Buffer.concat(stdoutChunks));
    writeFileSync(stderrPath, Buffer.concat(stderrChunks));
  };

  return { child, reader, flush, stdoutChunks, stderrChunks };
}

async function handshakeAndList(session, label) {
  session.child.stdin.write(
    encodeFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tdai-verify", version: "0.1.0" },
      },
    }),
  );
  const init = await session.reader.nextId(1);
  if (init.error) throw new Error(`${label} initialize error: ${JSON.stringify(init.error)}`);

  session.child.stdin.write(
    encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );

  session.child.stdin.write(
    encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  );
  const listed = await session.reader.nextId(2);
  if (listed.error) throw new Error(`${label} tools/list error: ${JSON.stringify(listed.error)}`);
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  return { init, listed, names };
}

function assertFourTools(names, label) {
  const expected = [
    "tdai_memory_context",
    "tdai_memory_search",
    "tdai_conversation_search",
    "tdai_scene_read",
  ];
  if (names.length !== 4 || expected.some((n) => !names.includes(n))) {
    throw new Error(`${label} expected ${expected.join(",")} got ${names.join(",")}`);
  }
}

function assertProtocolStdout(buf, label) {
  const text = buf.toString("utf8");
  if (text.includes(API_KEY)) throw new Error(`${label} stdout leaked API key`);
  if (/\[INFO\]|\[DEBUG\]|tdai-memory-mcp starting/i.test(text) && !text.includes("jsonrpc")) {
    throw new Error(`${label} stdout looks like logger lines`);
  }
  if (!/"jsonrpc"\s*:\s*"2.0"/.test(text)) {
    throw new Error(`${label} stdout is not MCP JSON-RPC`);
  }
  // Each non-empty stdout line must parse as JSON-RPC (no logger bleed).
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.jsonrpc !== "2.0") {
      throw new Error(`${label} non-protocol stdout line: ${line.slice(0, 120)}`);
    }
  }
}

function assertNoKey(buf, label) {
  if (buf.toString("utf8").includes(API_KEY)) {
    throw new Error(`${label} contains API key`);
  }
}

async function runListSession(label, stdoutPath, stderrPath, transcriptPath, env) {
  const session = spawnMcp(env, stdoutPath, stderrPath);
  try {
    const { listed, names } = await handshakeAndList(session, label);
    assertFourTools(names, label);
    writeFileSync(transcriptPath, JSON.stringify({ names, listed }, null, 2));
    session.flush();
    return names;
  } finally {
    session.flush();
    session.child.kill("SIGTERM");
    await new Promise((r) => session.child.once("exit", r));
  }
}

const standin = await startStandin();
const env = {
  TDAI_ENDPOINT: `http://127.0.0.1:${standin.port}`,
  TDAI_API_KEY: API_KEY,
  TDAI_SERVICE_ID: "default",
  TDAI_TEAM_ID: "team-verify",
  TDAI_AGENT_ID: "agt-verify",
  TDAI_USER_ID: "usr-verify",
  TDAI_LOG_LEVEL: "info",
};

try {
  const names1 = await runListSession(
    "run-1",
    resolve(scratch, "mcp-stdout.bin"),
    resolve(scratch, "mcp-stderr.log"),
    resolve(scratch, "mcp-list-1.log"),
    env,
  );
  const names2 = await runListSession(
    "run-2",
    resolve(scratch, "mcp-stdout-run2.bin"),
    resolve(scratch, "mcp-stderr-run2.log"),
    resolve(scratch, "mcp-list-2.log"),
    env,
  );

  const callSession = spawnMcp(
    env,
    resolve(scratch, "mcp-stdout-call.bin"),
    resolve(scratch, "mcp-stderr-call.log"),
  );
  try {
    await handshakeAndList(callSession, "call");
    callSession.child.stdin.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "tdai_conversation_search",
          arguments: { query: "canonical-messages" },
        },
      }),
    );
    const msgRes = await callSession.reader.nextId(10, 15000);
    callSession.child.stdin.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "tdai_conversation_search",
          arguments: { query: "from-items" },
        },
      }),
    );
    const itemsRes = await callSession.reader.nextId(11, 15000);
    callSession.flush();

    const parseText = (res) => {
      const text = res.result?.content?.[0]?.text ?? "";
      return JSON.parse(text);
    };
    const messagesBody = parseText(msgRes);
    const itemsBody = parseText(itemsRes);
    writeFileSync(
      resolve(scratch, "mcp-l0-call.log"),
      JSON.stringify({ messagesBody, itemsBody, msgRes, itemsRes }, null, 2),
    );

    if (!messagesBody.messages?.some((m) => m.id === "msg-seed-messages")) {
      throw new Error("messages fixture hits missing from tools/call");
    }
    if (!itemsBody.messages?.length) {
      throw new Error("items-only fixture silently became an empty list");
    }
    if (itemsBody.messages[0].id !== "msg-seed-items") {
      throw new Error("items-only hits were dropped");
    }

    const stdout = readFileSync(resolve(scratch, "mcp-stdout.bin"));
    const stderr = readFileSync(resolve(scratch, "mcp-stderr.log"));
    assertProtocolStdout(stdout, "mcp-stdout.bin");
    assertNoKey(stdout, "stdout");
    assertNoKey(stderr, "stderr");
    assertNoKey(readFileSync(resolve(scratch, "mcp-stdout-call.bin")), "call-stdout");
    assertNoKey(readFileSync(resolve(scratch, "mcp-stderr-call.log")), "call-stderr");

    writeFileSync(
      resolve(scratch, "verify-summary.json"),
      JSON.stringify({ ok: true, names1, names2, standinPort: standin.port }, null, 2),
    );
    process.stderr.write(`verify-stdio ok tools=${names1.join(",")}\n`);
  } finally {
    callSession.flush();
    callSession.child.kill("SIGTERM");
    await new Promise((r) => callSession.child.once("exit", r));
  }
} finally {
  standin.server.close();
}
