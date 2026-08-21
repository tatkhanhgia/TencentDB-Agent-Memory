#!/usr/bin/env node
/**
 * End-to-end smoke test for the deployed stdio MCP wrapper.
 *
 * Drives ./tdai-memory-mcp.sh exactly the way a harness does (spawn, stdio,
 * newline-delimited JSON-RPC) against the LIVE Core, and walks the whole
 * chain: identity -> handshake -> memory recall -> scene read -> skill
 * catalogue -> skill body -> skill file. Each step feeds the next, so a
 * broken link surfaces as a failing step instead of an empty-but-green run.
 *
 * Usage:
 *   node smoke-mcp.mjs                 # cwd = this repo
 *   node smoke-mcp.mjs --cwd <dir>     # test identity routing for a project
 *   node smoke-mcp.mjs --query "..."   # recall query (default: memory)
 *   node smoke-mcp.mjs --json          # machine-readable summary on stdout
 *   node smoke-mcp.mjs --wrapper <sh>  # test another install of the wrapper
 *
 * Exit 0 = every step PASS or SKIP. Exit 1 = at least one FAIL.
 * SKIP means "nothing to chain from" (e.g. no scenes yet), not a defect.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

// ─── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const WRAPPER = resolve(argOf("--wrapper", resolve(SCRIPT_DIR, "tdai-memory-mcp.sh")));
const CWD = resolve(argOf("--cwd", REPO_ROOT));
const QUERY = argOf("--query", "memory");
const JSON_OUT = argv.includes("--json");
const TIMEOUT_MS = Number(argOf("--timeout", "20000"));

// ─── tiny reporter ───────────────────────────────────────────────────
const C = process.stdout.isTTY && !JSON_OUT
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", x: "" };
const steps = [];
let stepNo = 0;

function record(status, name, detail) {
  stepNo += 1;
  steps.push({ n: stepNo, status, name, detail });
  if (JSON_OUT) return;
  const tag = status === "PASS" ? `${C.g}PASS${C.x}`
    : status === "FAIL" ? `${C.r}FAIL${C.x}`
    : `${C.y}SKIP${C.x}`;
  const num = String(stepNo).padStart(2, "0");
  console.log(`${tag}  ${num}  ${name.padEnd(26)} ${C.d}${detail ?? ""}${C.x}`);
}

/** Run one step: fn returns a detail string, throws to fail, or returns {skip}. */
async function step(name, fn) {
  if (steps.some((s) => s.status === "FAIL" && s.fatal)) {
    record("SKIP", name, "skipped after fatal failure");
    return null;
  }
  try {
    const out = await fn();
    if (out && out.skip) {
      record("SKIP", name, out.skip);
      return null;
    }
    record("PASS", name, out?.detail ?? out ?? "");
    return out?.value ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("FAIL", name, msg.replace(/\s+/g, " ").slice(0, 300));
    steps[steps.length - 1].fatal = Boolean(err.fatal);
    return null;
  }
}
const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });

// ─── stdio JSON-RPC client ───────────────────────────────────────────
function createClient() {
  const stdoutBufs = [];
  const stderrBufs = [];
  const child = spawn("bash", [WRAPPER], {
    cwd: CWD,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = Buffer.alloc(0);
  const pending = new Map();
  const stray = [];
  let protocolViolation = null;

  child.stdout.on("data", (chunk) => {
    stdoutBufs.push(chunk);
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Logger bleed onto stdout corrupts the protocol for every harness.
        protocolViolation ??= `non-JSON stdout line: ${line.slice(0, 120)}`;
        continue;
      }
      if (msg.jsonrpc !== "2.0") {
        protocolViolation ??= `stdout line is not JSON-RPC 2.0: ${line.slice(0, 120)}`;
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      } else {
        stray.push(msg);
      }
    }
  });
  child.stderr.on("data", (c) => stderrBufs.push(c));

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const [, w] of pending) w.reject(new Error(`server exited (code=${code} signal=${signal})`));
    pending.clear();
  });

  let nextId = 0;
  function send(method, params) {
    if (exited) throw fatal(`server already exited (code=${exited.code})`);
    const id = (nextId += 1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`timeout ${TIMEOUT_MS}ms waiting ${method}`));
      }, TIMEOUT_MS);
      pending.set(id, {
        resolve: (m) => { clearTimeout(timer); res(m); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** tools/call + unwrap content[0].text as JSON; MCP-level errors throw. */
  async function call(name, args) {
    const res = await send("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(res.error)}`);
    const text = res.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name}: no text content in result`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { raw: text };
    }
    // Handlers report tool-level failures in-band rather than as JSON-RPC
    // errors, splitting the kind (`error`) from the cause (`message`).
    if (body?.error) {
      const why = typeof body.message === "string" ? ` — ${body.message}` : "";
      throw new Error(`${name}: ${String(body.error).slice(0, 80)}${why.slice(0, 160)}`);
    }
    if (res.result?.isError) throw new Error(`${name}: isError — ${text.slice(0, 200)}`);
    return body;
  }

  return {
    child, send, notify, call,
    stderr: () => Buffer.concat(stderrBufs).toString("utf8"),
    stdout: () => Buffer.concat(stdoutBufs).toString("utf8"),
    violation: () => protocolViolation,
    stray: () => stray,
    async close() {
      child.stdin.end();
      child.kill("SIGTERM");
      await new Promise((r) => (exited ? r() : child.once("exit", r)));
    },
  };
}

// ─── shape-tolerant extractors (chain values without hardcoding schemas) ──
function deepCollect(node, pick, out = [], seen = new Set()) {
  if (node === null || typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) deepCollect(v, pick, out, seen);
    return out;
  }
  const hit = pick(node);
  if (hit !== undefined && hit !== null) out.push(hit);
  for (const v of Object.values(node)) deepCollect(v, pick, out, seen);
  return out;
}

const firstString = (obj, keys) =>
  deepCollect(obj, (o) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  })[0];

const scenePaths = (obj) =>
  deepCollect(obj, (o) => {
    for (const k of ["path", "scene_path", "file", "scene"]) {
      const v = o[k];
      if (typeof v === "string" && /\.md$/i.test(v.trim())) return v.trim();
    }
    return undefined;
  });

const skillIds = (obj) => {
  const direct = deepCollect(obj, (o) =>
    typeof o.skill_id === "string" && o.skill_id.trim() ? o.skill_id.trim() : undefined);
  if (direct.length) return direct;
  const m = JSON.stringify(obj).match(/skl-[A-Za-z0-9_-]+/g);
  return m ? [...new Set(m)] : [];
};

/**
 * Hit list, wherever the handler put it. tdai_skill_search nests under
 * `result.items` while tdai_memory_search returns a flat `items`, so a
 * top-level-only reader reports a healthy search as zero hits.
 */
function itemsOf(body) {
  for (const v of [body?.items, body?.result?.items, body?.results, body?.data?.items, body?.messages]) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * A term the corpus provably contains, harvested from an earlier response.
 * Asserting on a hardcoded word makes the test fail whenever memory simply
 * has nothing about that word — a flaky red that says nothing about health.
 */
function harvestTerm(...sources) {
  for (const s of sources) {
    for (const raw of Array.isArray(s) ? s : [s]) {
      if (typeof raw !== "string") continue;
      const word = raw
        .replace(/\.md$/i, "")
        .split(/[^A-Za-z0-9]+/)
        .filter((w) => w.length >= 4 && !/^\d+$/.test(w))[0];
      if (word) return word.toLowerCase();
    }
  }
  return null;
}

/** Parse the KEY=VALUE files the wrapper and the hook source (no shell eval). */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const bytes = (s) => `${Buffer.byteLength(String(s ?? ""), "utf8")}B`;

// ─── the run ─────────────────────────────────────────────────────────
if (!existsSync(WRAPPER)) {
  console.error(`smoke-mcp: wrapper not found: ${WRAPPER}`);
  process.exit(1);
}
if (!JSON_OUT) {
  console.log(`${C.d}wrapper : ${WRAPPER}`);
  console.log(`cwd     : ${CWD}`);
  console.log(`query   : "${QUERY}"${C.x}\n`);
}

const client = createClient();
let toolNames = [];
let skillsOn = false;
let unbound = false;

try {
  await step("spawn + identity", async () => {
    // The wrapper prints its resolved identity to stderr before exec'ing node.
    const deadline = Date.now() + 8000;
    let line = null;
    while (Date.now() < deadline) {
      line = client.stderr().match(/identity route=(\S+) agent=(\S+)/);
      if (line) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!line) throw fatal("no identity line on stderr within 8s (wrapper failed to start?)");
    // _identity.sh validates the resolved agent against the Panel registry and
    // warns on a deleted/inactive one. Left on stderr this is invisible: the
    // session still starts, reads come back empty, and lessons write into the
    // void — so the warning is a failure here, not a note.
    // Order matters: an invalid binding is also unbound, and the memory steps
    // must know that before this step throws.
    unbound = /memory disabled \(Skills still available\)/.test(client.stderr());
    const warn = client.stderr().match(/\[tdai-identity\] warning: (.+)/);
    if (warn) throw new Error(`route=${line[1]} agent=${line[2]} — ${warn[1].trim()}`);
    const note = unbound ? " — UNBOUND: memory off, Skills only" : "";
    return { detail: `route=${line[1]} agent=${line[2]}${note}` };
  });

  await step("initialize", async () => {
    const res = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tdai-smoke", version: "1.0.0" },
    });
    if (res.error) throw fatal(`initialize error ${JSON.stringify(res.error)}`);
    const info = res.result?.serverInfo;
    if (!info?.name) throw fatal("initialize returned no serverInfo");
    client.notify("notifications/initialized");
    return { detail: `${info.name} v${info.version} proto=${res.result.protocolVersion}` };
  });

  await step("tools/list", async () => {
    const res = await client.send("tools/list", {});
    if (res.error) throw fatal(`tools/list error ${JSON.stringify(res.error)}`);
    toolNames = (res.result?.tools ?? []).map((t) => t.name);
    const base = [
      "tdai_memory_context", "tdai_memory_search",
      "tdai_conversation_search", "tdai_scene_read",
    ];
    const missing = base.filter((n) => !toolNames.includes(n));
    if (missing.length) throw fatal(`missing base tools: ${missing.join(",")}`);
    // Skill tools are gated by TDAI_ENABLE_SKILLS; all four or none.
    const skill = [
      "tdai_skill_list", "tdai_skill_search",
      "tdai_skill_get", "tdai_skill_file_read",
    ];
    const present = skill.filter((n) => toolNames.includes(n));
    if (present.length && present.length !== skill.length) {
      throw new Error(`partial skill toolset: ${present.join(",")}`);
    }
    skillsOn = present.length === skill.length;
    return { detail: `${toolNames.length} tools — skills=${skillsOn ? "on" : "off"}${
      toolNames.includes("tdai_memory_capture") ? " capture=on" : ""}` };
  });

  // ── memory lane ────────────────────────────────────────────────────
  let scenePath = null;
  let seedTerm = null;

  await step("tdai_memory_context", async () => {
    if (unbound) return { skip: "project not bound to an agent — memory is off by design" };
    const body = await client.call("tdai_memory_context", { query: QUERY, max_items: 5 });
    const found = scenePaths(body);
    if (found.length) scenePath = found[0];
    const l3 = firstString(body, ["persona", "summary", "l3"]);
    if (body.partial === true) {
      throw new Error(`partial=true — one source failed: ${JSON.stringify(body.errors ?? body).slice(0, 160)}`);
    }
    // Seed the search step with a word this memory provably holds.
    seedTerm = harvestTerm(found, l3);
    return { detail: `${bytes(JSON.stringify(body))} l3=${l3 ? "yes" : "no"} scenes=${found.length}` };
  });

  await step("tdai_memory_search", async () => {
    if (unbound) return { skip: "project not bound to an agent — memory is off by design" };
    // Two probes: the caller's query (informational — memory may hold
    // nothing about it) and a harvested term (asserted — zero hits there
    // means retrieval is broken, not that the corpus is thin).
    const asked = itemsOf(await client.call("tdai_memory_search", { query: QUERY }));
    if (!scenePath) scenePath = scenePaths(asked)[0] ?? null;
    if (!seedTerm) {
      return { detail: `"${QUERY}" → ${asked.length} hit(s) (no seed term to assert on)` };
    }
    const seeded = itemsOf(await client.call("tdai_memory_search", { query: seedTerm }));
    if (seeded.length === 0) {
      throw new Error(`"${seedTerm}" came from this memory's own scene index yet matched 0 L1 items`);
    }
    return { detail: `"${QUERY}" → ${asked.length}, "${seedTerm}" → ${seeded.length} hit(s)` };
  });

  await step("tdai_scene_read", async () => {
    if (unbound) return { skip: "project not bound to an agent — memory is off by design" };
    if (!scenePath) return { skip: "no scene path surfaced by context/search" };
    const body = await client.call("tdai_scene_read", { path: scenePath });
    const text = body.content ?? body.text ?? body.raw ?? JSON.stringify(body);
    if (!String(text).trim()) throw new Error(`scene ${scenePath} read back empty`);
    return { detail: `${scenePath} → ${bytes(text)}` };
  });

  await step("tdai_conversation_search", async () => {
    if (unbound) return { skip: "project not bound to an agent — memory is off by design" };
    const body = await client.call("tdai_conversation_search", { query: QUERY });
    const hits = itemsOf(body);
    return { detail: `${hits.length} message(s) source=${body.source ?? "?"}${body.drift ? " drift=true" : ""}` };
  });

  // ── skill lane ─────────────────────────────────────────────────────
  let skillId = null;
  let skillName = null;
  let manifestPath = null;

  await step("tdai_skill_list (agent)", async () => {
    if (!skillsOn) return { skip: "TDAI_ENABLE_SKILLS off" };
    const body = await client.call("tdai_skill_list", {});
    const items = itemsOf(body);
    if (items.length) {
      skillId = items[0].skill_id ?? skillIds(body)[0] ?? null;
      skillName = items[0].name ?? null;
    }
    return { detail: `total=${body.total ?? items.length} scope=${body.skill_scope ?? "agent"}` };
  });

  await step("tdai_skill_list (team)", async () => {
    if (!skillsOn) return { skip: "TDAI_ENABLE_SKILLS off" };
    const body = await client.call("tdai_skill_list", { scope: "team" });
    const items = itemsOf(body);
    if (!skillId && items.length) {
      skillId = items[0].skill_id ?? skillIds(body)[0] ?? null;
      skillName = items[0].name ?? null;
    }
    return { detail: `total=${body.total ?? items.length}` };
  });

  await step("tdai_skill_search", async () => {
    if (!skillsOn) return { skip: "TDAI_ENABLE_SKILLS off" };
    // Search for the Skill we just listed: an empty result here means the
    // index is stale, which listing alone would never reveal.
    const term = skillName ? skillName.split(/[-_\s]/)[0] : QUERY;
    const body = await client.call("tdai_skill_search", { query: term, scope: "team" });
    const items = itemsOf(body);
    if (skillName && items.length === 0) {
      throw new Error(`"${term}" matched 0 Skills although "${skillName}" is in the catalogue (index stale?)`);
    }
    if (!skillId) skillId = skillIds(body)[0] ?? null;
    return { detail: `"${term}" → ${items.length} hit(s)` };
  });

  await step("tdai_skill_get", async () => {
    if (!skillsOn) return { skip: "TDAI_ENABLE_SKILLS off" };
    if (!skillId) return { skip: "catalogue is empty — nothing to fetch" };
    const body = await client.call("tdai_skill_get", { skill_id: skillId });
    const md = firstString(body, ["content", "body", "markdown", "skill_md"]);
    if (!md) throw new Error(`skill ${skillId} returned no SKILL.md body`);
    const files = deepCollect(body, (o) =>
      typeof o.path === "string" && o.path.trim() ? o.path.trim() : undefined);
    manifestPath = files[0] ?? null;
    return { detail: `${skillId} → ${bytes(md)} md, ${files.length} file(s)` };
  });

  await step("tdai_skill_file_read", async () => {
    if (!skillsOn) return { skip: "TDAI_ENABLE_SKILLS off" };
    if (!skillId) return { skip: "catalogue is empty" };
    if (!manifestPath) return { skip: "Skill has no attached resource files" };
    const body = await client.call("tdai_skill_file_read", { skill_id: skillId, path: manifestPath });
    const text = body.content ?? body.text ?? body.raw ?? "";
    if (!String(text).trim()) throw new Error(`${manifestPath} read back empty`);
    return { detail: `${manifestPath} → ${bytes(text)}` };
  });

  // ── hygiene ────────────────────────────────────────────────────────
  await step("stdout is protocol-only", async () => {
    const v = client.violation();
    if (v) throw new Error(v);
    return { detail: `${client.stdout().split("\n").filter((l) => l.trim()).length} JSON-RPC line(s), 0 stray` };
  });

  await step("no secret leak", async () => {
    const key = process.env.TDAI_API_KEY;
    const both = client.stdout() + client.stderr();
    const leaks = [];
    if (key && key.length > 8 && both.includes(key)) leaks.push("TDAI_API_KEY");
    for (const m of both.matchAll(/\b(sk-[A-Za-z0-9]{12,}|tok-[a-f0-9]{24,})\b/g)) leaks.push(m[1].slice(0, 10) + "…");
    if (leaks.length) throw new Error(`secret-looking strings in output: ${[...new Set(leaks)].join(", ")}`);
    return { detail: "stdout/stderr clean" };
  });

  // ── write path (hook-owned; the read tools above never touch it) ───
  // A green read lane says nothing about capture: lessons are written by the
  // SessionEnd hook through a separate LLM. Both legs are checked here so
  // "all passed" cannot mean "recall works, nothing is ever saved".
  await step("session-end hook wired", async () => {
    // Capture is refused for an unbound project anyway, so hook wiring says
    // nothing about it — bind the project first, then this check means something.
    if (unbound) return { skip: "project unbound — capture is refused regardless" };
    const candidates = [
      resolve(process.env.HOME ?? "", ".claude/settings.json"),
      resolve(CWD, ".claude/settings.json"),
      resolve(CWD, ".claude/settings.local.json"),
    ];
    const hits = [];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      let cfg;
      try {
        cfg = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const wired = JSON.stringify(cfg.hooks?.SessionEnd ?? "").includes("tdai-reflect-hook.sh");
      if (wired) hits.push(file.replace(process.env.HOME ?? "", "~"));
    }
    if (!hits.length) {
      throw new Error(`no SessionEnd hook for tdai-reflect-hook.sh in ${candidates.length} settings file(s) — this project never captures lessons`);
    }
    return { detail: `${hits.join(", ")}${unbound ? " (will refuse: project unbound)" : ""}` };
  });

  await step("reflect LLM reachable", async () => {
    // Same resolution the hook does: .mcp.env first, then MEMORY_LLM_* from
    // the stack .env with the docker host rewritten.
    const mcpEnv = readEnvFile(resolve(SCRIPT_DIR, ".mcp.env"));
    const stackEnv = readEnvFile(resolve(SCRIPT_DIR, ".env"));
    let base = mcpEnv.TDAI_REFLECT_LLM_BASE_URL;
    let model = mcpEnv.TDAI_REFLECT_LLM_MODEL;
    let via = ".mcp.env";
    if (!base) {
      base = (stackEnv.MEMORY_LLM_BASE_URL ?? "").replace("host.docker.internal", "127.0.0.1");
      model = stackEnv.MEMORY_LLM_MODEL;
      via = ".env MEMORY_LLM_*";
    }
    if (!base) throw new Error("no reflect LLM configured — the hook would fail on every session");
    const url = `${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/models`;
    try {
      // Any HTTP answer proves reachability; auth/404 is the provider's
      // business, a refused connection is what silently kills capture.
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${mcpEnv.TDAI_REFLECT_LLM_API_KEY ?? stackEnv.MEMORY_LLM_API_KEY ?? "x"}` },
        signal: AbortSignal.timeout(6000),
      });
      return { detail: `${url} → HTTP ${res.status} (${via}, model=${model ?? "?"})` };
    } catch (err) {
      throw new Error(`${url} unreachable (${via}) — session-end capture fails with "fetch failed": ${err instanceof Error ? err.message : String(err)}`);
    }
  });
} finally {
  await client.close();
}

// ─── summary ─────────────────────────────────────────────────────────
const failed = steps.filter((s) => s.status === "FAIL");
const skipped = steps.filter((s) => s.status === "SKIP");
const passed = steps.filter((s) => s.status === "PASS");

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    cwd: CWD,
    query: QUERY,
    tools: toolNames,
    skills_enabled: skillsOn,
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length,
    steps,
  }, null, 2));
} else {
  console.log("");
  if (failed.length === 0) {
    console.log(`${C.g}✓ ${passed.length} passed${C.x}${skipped.length ? `, ${C.y}${skipped.length} skipped${C.x}` : ""} — MCP flow healthy end to end`);
  } else {
    console.log(`${C.r}✗ ${failed.length} failed${C.x}, ${passed.length} passed${skipped.length ? `, ${skipped.length} skipped` : ""}`);
    for (const f of failed) console.log(`  ${C.r}·${C.x} ${f.name}: ${f.detail}`);
    const tail = client.stderr().trim().split("\n").slice(-6).join("\n  ");
    if (tail) console.log(`\n${C.d}server stderr (tail):\n  ${tail}${C.x}`);
  }
}
process.exit(failed.length ? 1 : 0);
