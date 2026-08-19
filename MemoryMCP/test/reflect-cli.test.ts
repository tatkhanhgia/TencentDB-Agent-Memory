import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConversationAddInput, MemoryReadPort } from "../src/client.js";
import { LlmError, type Lesson } from "../src/reflect/extract.js";
import {
  deriveSessionId,
  EXIT_LLM,
  EXIT_OK,
  EXIT_TRANSCRIPT,
  EXIT_USAGE,
  parseArgs,
  run,
  USAGE,
  type ReflectSummary,
} from "../src/reflect/cli.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/reflect-claude-code.jsonl", import.meta.url));

const identityEnv: NodeJS.Dict<string> = {
  TDAI_ENDPOINT: "http://127.0.0.1:8420",
  TDAI_API_KEY: "sk-test-secret",
  TDAI_SERVICE_ID: "default",
  TDAI_TEAM_ID: "team-a",
  TDAI_AGENT_ID: "agt-a",
  TDAI_USER_ID: "usr-a",
  TDAI_REFLECT_LLM_BASE_URL: "http://127.0.0.1:4000/v1",
  TDAI_REFLECT_LLM_API_KEY: "sk-llm-secret",
  TDAI_REFLECT_LLM_MODEL: "m1",
};

const lesson: Lesson = {
  title: "MCP HTTP clients never hold the Core API key",
  body: "Bearer tokens map to principal bindings; Core credentials stay server-side.",
  kind: "constraint",
  confidence: 0.9,
};

interface Harness {
  out: string[];
  err: string[];
  writes: ConversationAddInput[];
}

function harness(): Harness {
  return { out: [], err: [], writes: [] };
}

function summaryOf(h: Harness): ReflectSummary {
  expect(h.out).toHaveLength(1);
  return JSON.parse(h.out[0]!) as ReflectSummary;
}

function deps(
  h: Harness,
  over: {
    env?: NodeJS.Dict<string>;
    chat?: () => Promise<string>;
    hits?: string[];
    addFails?: boolean;
    addConflicts?: boolean;
  } = {},
) {
  const memory = {
    async searchAtomic() {
      return { items: (over.hits ?? []).map((content) => ({ content })) };
    },
    async addConversation(req: ConversationAddInput) {
      if (over.addFails) throw new Error("core unavailable");
      if (over.addConflicts) {
        throw Object.assign(new Error("[409] HTTP 409: capture_id already exists"), { code: 409 });
      }
      h.writes.push(req);
      return { accepted_ids: ["a", "b"], total_count: 2, capture_id: req.capture_id };
    },
  } as unknown as MemoryReadPort;

  return {
    env: over.env ?? identityEnv,
    readFile: (path: string) => readFile(path, "utf8"),
    chat: over.chat ?? (async () => JSON.stringify({ lessons: [lesson] })),
    createMemory: () => memory,
    stdout: (text: string) => void h.out.push(text.trimEnd()),
    stderr: (text: string) => void h.err.push(text.trimEnd()),
  };
}

describe("parseArgs", () => {
  it("accepts the documented flags", () => {
    const result = parseArgs([
      "--transcript",
      "/tmp/t.jsonl",
      "--format",
      "generic-jsonl",
      "--session-id",
      "s1",
      "--max-lessons",
      "5",
      "--min-turns",
      "0",
      "--dry-run",
      "--quiet",
    ]);
    expect(result).toEqual({
      kind: "options",
      options: {
        transcript: "/tmp/t.jsonl",
        format: "generic-jsonl",
        sessionId: "s1",
        maxLessons: 5,
        minTurns: 0,
        dryRun: true,
        quiet: true,
      },
    });
  });

  it("applies documented defaults", () => {
    const result = parseArgs(["--transcript", "t", "--format", "claude-code"]);
    expect(result).toMatchObject({
      kind: "options",
      options: { maxLessons: 3, minTurns: 6, dryRun: false, quiet: false },
    });
  });

  it("recognises help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("rejects bad usage", () => {
    expect(parseArgs([])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--format", "claude-code"])).toMatchObject({
      kind: "error",
      message: "--transcript is required",
    });
    expect(parseArgs(["--transcript", "t"])).toMatchObject({ message: "--format is required" });
    expect(parseArgs(["--transcript", "t", "--format", "csv"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--transcript"])).toMatchObject({ message: "--transcript requires a value" });
    expect(parseArgs(["--transcript", "t", "--format", "claude-code", "--max-lessons", "6"])).toMatchObject(
      { kind: "error" },
    );
    expect(parseArgs(["--transcript", "t", "--format", "claude-code", "--min-turns", "-1"])).toMatchObject(
      { kind: "error" },
    );
    expect(parseArgs(["--oops"])).toMatchObject({ message: "unknown argument: --oops" });
  });
});

describe("deriveSessionId", () => {
  it("prefers the flag, then the transcript, then a path hash", () => {
    expect(deriveSessionId(" s1 ", "s2", "/tmp/t.jsonl")).toBe("s1");
    expect(deriveSessionId(undefined, "s2", "/tmp/t.jsonl")).toBe("s2");
    const hashed = deriveSessionId(undefined, undefined, "/tmp/t.jsonl");
    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSessionId(undefined, undefined, "/tmp/t.jsonl")).toBe(hashed);
    expect(deriveSessionId(undefined, undefined, "/tmp/other.jsonl")).not.toBe(hashed);
  });
});

describe("run", () => {
  const args = ["--transcript", FIXTURE, "--format", "claude-code"];

  it("prints usage for --help and exits 0", async () => {
    const h = harness();
    expect(await run(["--help"], deps(h))).toBe(EXIT_OK);
    expect(h.out[0]).toBe(USAGE);
    expect(h.err).toEqual([]);
  });

  it("exits 2 on bad usage", async () => {
    const h = harness();
    expect(await run([], deps(h))).toBe(EXIT_USAGE);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("--transcript is required");
  });

  it("exits 2 when identity or LLM config is missing", async () => {
    const h = harness();
    const env = { ...identityEnv };
    delete env.TDAI_TEAM_ID;
    expect(await run(args, { ...deps(h), env, chat: undefined })).toBe(EXIT_USAGE);
    expect(h.err.join("\n")).toContain("TDAI_TEAM_ID");

    const h2 = harness();
    const env2 = { ...identityEnv };
    delete env2.TDAI_REFLECT_LLM_MODEL;
    expect(await run(args, { ...deps(h2), env: env2, chat: undefined })).toBe(EXIT_USAGE);
    expect(h2.err.join("\n")).toContain("TDAI_REFLECT_LLM_MODEL");
  });

  it("exits 3 when the transcript cannot be read", async () => {
    const h = harness();
    expect(await run(["--transcript", "/nope/missing.jsonl", "--format", "claude-code"], deps(h))).toBe(
      EXIT_TRANSCRIPT,
    );
    expect(h.err.join("\n")).toContain("cannot read transcript");
  });

  it("exits 3 when no line parses as JSON", async () => {
    const h = harness();
    const code = await run(args, {
      ...deps(h),
      readFile: async () => "not json\nalso not json\n",
    });
    expect(code).toBe(EXIT_TRANSCRIPT);
    expect(h.err.join("\n")).toContain("wrong --format?");
  });

  it("skips short sessions without calling the LLM", async () => {
    const h = harness();
    let called = 0;
    const code = await run(args, {
      ...deps(h, {
        chat: async () => {
          called += 1;
          return "{}";
        },
      }),
      readFile: async () =>
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    });
    expect(code).toBe(EXIT_OK);
    expect(called).toBe(0);
    expect(summaryOf(h)).toEqual({ status: "skipped", lessons: [], written: 0 });
    expect(h.writes).toEqual([]);
  });

  it("prints lessons and writes nothing on --dry-run", async () => {
    const h = harness();
    const code = await run([...args, "--dry-run"], deps(h));
    expect(code).toBe(EXIT_OK);
    expect(summaryOf(h)).toEqual({ status: "dry-run", lessons: [lesson], written: 0 });
    expect(h.writes).toEqual([]);
  });

  it("writes surviving lessons and reports status written", async () => {
    const h = harness();
    const code = await run(args, deps(h));
    expect(code).toBe(EXIT_OK);
    expect(summaryOf(h)).toEqual({ status: "written", lessons: [lesson], written: 1 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.session_id).toBe("reflect:sess-fixture-1");
    expect(h.writes[0]?.capture_id).toBe("reflect-sess-fixture-1-0");
    expect(h.writes[0]?.messages[0]?.content).toBe(`[reflect:constraint] ${lesson.title}`);
    expect(h.writes[0]?.messages[1]?.content).toBe(
      `${lesson.body}\n\n(source: session sess-fixture-1, 2026-08-19T09:02:10.000Z, host=claude-code)`,
    );
    expect(h.writes[0]?.messages[1]?.timestamp).toBe("2026-08-19T09:02:10.000Z");
  });

  it("writes content that does not depend on the wall clock", async () => {
    const first = harness();
    const second = harness();
    expect(await run(args, deps(first))).toBe(EXIT_OK);
    expect(await run(args, deps(second))).toBe(EXIT_OK);
    expect(first.writes).toEqual(second.writes);
    const stamps = JSON.stringify(first.writes).match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g) ?? [];
    expect(new Set(stamps)).toEqual(new Set(["2026-08-19T09:02:10.000Z"]));
  });

  it("exits 0 when Core reports the capture was already taken", async () => {
    const h = harness();
    const code = await run(args, deps(h, { addConflicts: true }));
    expect(code).toBe(EXIT_OK);
    expect(summaryOf(h)).toEqual({ status: "empty", lessons: [], written: 0 });
    expect(h.err.join("\n")).toContain("was already captured");
  });

  it("warns when valid JSON lines yield no turns", async () => {
    const h = harness();
    const code = await run(args, {
      ...deps(h),
      readFile: async () =>
        [
          JSON.stringify({ role: "user", content: "wrong format for this parser" }),
          JSON.stringify({ role: "assistant", content: "still no turns" }),
        ].join("\n"),
    });
    expect(code).toBe(EXIT_OK);
    expect(h.err.join("\n")).toContain("parsed 2 line(s) but extracted 0 turns — wrong --format?");
    expect(summaryOf(h)).toEqual({ status: "skipped", lessons: [], written: 0 });
  });

  it("reports empty when the model finds nothing durable", async () => {
    const h = harness();
    const code = await run(args, deps(h, { chat: async () => '{"lessons":[]}' }));
    expect(code).toBe(EXIT_OK);
    expect(summaryOf(h)).toEqual({ status: "empty", lessons: [], written: 0 });
    expect(h.writes).toEqual([]);
  });

  it("reports empty when every lesson is a duplicate", async () => {
    const h = harness();
    const code = await run(args, deps(h, { hits: [lesson.title] }));
    expect(code).toBe(EXIT_OK);
    expect(summaryOf(h)).toEqual({ status: "empty", lessons: [], written: 0 });
    expect(h.writes).toEqual([]);
    expect(h.err.join("\n")).toContain("1 duplicate lesson(s)");
  });

  it("exits 4 when the LLM call fails", async () => {
    const h = harness();
    const code = await run(args, {
      ...deps(h),
      chat: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      },
    });
    expect(code).toBe(EXIT_LLM);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("extraction failed");
  });

  it("exits 4 with the provider body snippet after a second 400", async () => {
    const h = harness();
    const code = await run(args, {
      ...deps(h),
      chat: async () => {
        throw new LlmError(
          "chat completion returned HTTP 400: 'response_format.type' must be 'json_schema' or 'text'",
          { status: 400, bodySnippet: "'response_format.type' must be 'json_schema' or 'text'" },
        );
      },
    });
    expect(code).toBe(EXIT_LLM);
    expect(h.out).toEqual([]);
    const stderr = h.err.join("\n");
    expect(stderr).toContain("extraction failed: chat completion returned HTTP 400");
    expect(stderr).toContain("must be 'json_schema' or 'text'");
  });

  it("exits 5 when the memory write fails", async () => {
    const h = harness();
    const code = await run(args, deps(h, { addFails: true }));
    expect(code).toBe(5);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("memory write failed");
  });

  it("keeps stderr quiet except for errors under --quiet", async () => {
    const h = harness();
    expect(await run([...args, "--quiet"], deps(h, { chat: async () => "garbage" }))).toBe(EXIT_OK);
    expect(h.err).toEqual([]);
    expect(summaryOf(h).status).toBe("empty");
  });

  it("never leaks secrets into diagnostics", async () => {
    const h = harness();
    await run(args, {
      ...deps(h),
      chat: async () => {
        throw new Error(`bad key sk-llm-secret for sk-test-secret`);
      },
    });
    const stderr = h.err.join("\n");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("sk-llm-secret");
    expect(stderr).not.toContain("sk-test-secret");
  });
});
