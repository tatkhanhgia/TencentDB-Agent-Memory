import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  bodySnippet,
  buildMessages,
  createOpenAiChatFn,
  extractJsonObject,
  extractLessons,
  filterLessons,
  loadLlmConfigFromEnv,
  LlmError,
  MIN_CONFIDENCE,
  parseLessonsResponse,
  SYSTEM_PROMPT,
  type ChatMessage,
  type Lesson,
} from "../src/reflect/extract.js";
import type { Turn } from "../src/reflect/transcript.js";

const turns: Turn[] = [
  { role: "user", text: "should the gateway own retries?" },
  { role: "assistant", text: "no, the SDK owns them" },
];

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  title: "Retries live in the SDK, not the gateway",
  body: "The gateway stays stateless so retry policy is testable in one place.",
  kind: "adr",
  confidence: 0.9,
  ...over,
});

describe("buildMessages", () => {
  it("puts the strict policy in the system message", () => {
    const messages = buildMessages(turns, 3);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain("An empty list is the expected answer for most sessions.");
    expect(SYSTEM_PROMPT).toContain("architecture or design decisions (ADRs)");
    expect(SYSTEM_PROMPT).toContain("Do NOT record:");
    expect(SYSTEM_PROMPT).toContain("git history");
  });

  it("wraps the transcript and states the lesson cap", () => {
    const messages = buildMessages(turns, 2);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("user");
    const user = messages[1]!.content;
    expect(user).toContain("<transcript>");
    expect(user).toContain("user: should the gateway own retries?");
    expect(user).toContain("assistant: no, the SDK owns them");
    expect(user).toContain("Return at most 2 lesson(s).");
    expect(user).toContain('{"lessons":[]}');
  });

  it("keeps the prompt inside the char budget for a huge session", () => {
    const big: Turn[] = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: "x".repeat(5_000),
    }));
    const user = buildMessages(big, 3)[1]!.content;
    expect(user.length).toBeLessThan(70_000);
    expect(user).toContain("middle turn(s) omitted");
  });
});

describe("extractJsonObject", () => {
  it("passes clean JSON through", () => {
    expect(extractJsonObject('{"lessons":[]}')).toBe('{"lessons":[]}');
  });

  it("unwraps markdown fences", () => {
    expect(extractJsonObject('```json\n{"lessons":[]}\n```')).toBe('{"lessons":[]}');
    expect(extractJsonObject('```\n{"lessons":[]}\n```')).toBe('{"lessons":[]}');
  });

  it("finds the object inside surrounding prose", () => {
    expect(extractJsonObject('Sure! {"lessons":[]} hope that helps')).toBe('{"lessons":[]}');
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("I found nothing durable.")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("parseLessonsResponse", () => {
  it("parses a well-formed payload", () => {
    const raw = JSON.stringify({ lessons: [lesson()] });
    const parsed = parseLessonsResponse(raw);
    expect(parsed.lessons).toEqual([lesson()]);
    expect(parsed.warning).toBeUndefined();
  });

  it("parses fenced JSON", () => {
    const parsed = parseLessonsResponse("```json\n" + JSON.stringify({ lessons: [lesson()] }) + "\n```");
    expect(parsed.lessons).toHaveLength(1);
  });

  it("treats garbage as empty with a warning", () => {
    for (const raw of ["", "no lessons here", "{not json}", "[]", '{"other":1}']) {
      const parsed = parseLessonsResponse(raw);
      expect(parsed.lessons).toEqual([]);
      expect(parsed.warning).toBeTruthy();
    }
  });

  it("drops malformed lesson entries and warns", () => {
    const parsed = parseLessonsResponse(
      JSON.stringify({
        lessons: [
          lesson(),
          { title: "", body: "b", kind: "adr", confidence: 1 },
          { title: "t", body: "", kind: "adr", confidence: 1 },
          { title: "t", body: "b", kind: "narration", confidence: 1 },
          "nope",
        ],
      }),
    );
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.warning).toBe("dropped 4 malformed lesson(s)");
  });

  it("treats a missing or non-numeric confidence as zero", () => {
    const parsed = parseLessonsResponse(
      JSON.stringify({ lessons: [{ title: "t", body: "b", kind: "preference" }] }),
    );
    expect(parsed.lessons[0]?.confidence).toBe(0);
  });

  it("clamps confidence into 0..1", () => {
    const parsed = parseLessonsResponse(
      JSON.stringify({ lessons: [lesson({ confidence: 7 }), lesson({ confidence: -1 })] }),
    );
    expect(parsed.lessons.map((l) => l.confidence)).toEqual([1, 0]);
  });
});

describe("filterLessons", () => {
  it("drops anything under the confidence floor", () => {
    const kept = filterLessons(
      [lesson({ confidence: MIN_CONFIDENCE }), lesson({ confidence: 0.59 })],
      5,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.confidence).toBe(MIN_CONFIDENCE);
  });

  it("caps the count at max-lessons, preserving order", () => {
    const kept = filterLessons(
      [lesson({ title: "a" }), lesson({ title: "b" }), lesson({ title: "c" })],
      2,
    );
    expect(kept.map((l) => l.title)).toEqual(["a", "b"]);
  });
});

describe("extractLessons", () => {
  it("passes the built prompt to the injected chat fn and filters the result", async () => {
    let seen: ChatMessage[] | undefined;
    const result = await extractLessons(turns, 1, async (messages) => {
      seen = messages;
      return JSON.stringify({
        lessons: [lesson({ title: "keep" }), lesson({ title: "cap" }), lesson({ confidence: 0.1 })],
      });
    });
    expect(seen?.[0]?.content).toBe(SYSTEM_PROMPT);
    expect(result.lessons.map((l) => l.title)).toEqual(["keep"]);
    expect(result.warnings).toEqual([]);
  });

  it("surfaces a parse warning instead of failing", async () => {
    const result = await extractLessons(turns, 3, async () => "sorry, nothing");
    expect(result.lessons).toEqual([]);
    expect(result.warnings).toEqual(["no JSON object in LLM response"]);
  });

  it("propagates chat failures", async () => {
    await expect(
      extractLessons(turns, 3, async () => {
        throw new LlmError("boom");
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe("loadLlmConfigFromEnv", () => {
  const valid: NodeJS.Dict<string> = {
    TDAI_REFLECT_LLM_BASE_URL: "http://127.0.0.1:4000/v1/",
    TDAI_REFLECT_LLM_API_KEY: "sk-llm",
    TDAI_REFLECT_LLM_MODEL: "gpt-4o-mini",
  };

  it("loads config and strips the trailing slash", () => {
    const cfg = loadLlmConfigFromEnv(valid);
    expect(cfg.baseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.timeoutMs).toBe(60_000);
  });

  it("fails closed for each required variable", () => {
    for (const key of Object.keys(valid)) {
      const env = { ...valid };
      delete env[key];
      expect(() => loadLlmConfigFromEnv(env)).toThrow(ConfigError);
    }
  });

  it("rejects a bad URL or timeout", () => {
    expect(() => loadLlmConfigFromEnv({ ...valid, TDAI_REFLECT_LLM_BASE_URL: "ftp://x" })).toThrow(
      /HTTP/,
    );
    expect(() => loadLlmConfigFromEnv({ ...valid, TDAI_REFLECT_TIMEOUT_MS: "0" })).toThrow(
      ConfigError,
    );
  });

  it("honours TDAI_REFLECT_TIMEOUT_MS", () => {
    expect(loadLlmConfigFromEnv({ ...valid, TDAI_REFLECT_TIMEOUT_MS: "1500" }).timeoutMs).toBe(1500);
  });
});

describe("createOpenAiChatFn", () => {
  const cfg = {
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKey: "sk-llm",
    model: "m1",
    timeoutMs: 1000,
  };

  it("posts chat completions and returns the message content", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const chat = createOpenAiChatFn(cfg, {
      fetchImpl: async (u, i) => {
        url = u;
        init = i;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
        });
      },
    });
    expect(await chat([{ role: "user", content: "hi" }])).toBe("{}");
    expect(url).toBe("http://127.0.0.1:4000/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("m1");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
  });

  it("maps transport, HTTP and shape failures to LlmError", async () => {
    const failing = createOpenAiChatFn(cfg, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(failing([])).rejects.toBeInstanceOf(LlmError);

    const http500 = createOpenAiChatFn(cfg, {
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    await expect(http500([])).rejects.toThrow(/HTTP 500/);

    const noContent = createOpenAiChatFn(cfg, {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(noContent([])).rejects.toThrow(/no message content/);
  });

  it("does not retry a non-400 failure", async () => {
    const bodies: string[] = [];
    const chat = createOpenAiChatFn(cfg, {
      fetchImpl: async (_u, init) => {
        bodies.push(String(init.body));
        return new Response("upstream exploded", { status: 500 });
      },
    });
    await expect(chat([])).rejects.toThrow(/HTTP 500: upstream exploded/);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).response_format).toEqual({ type: "json_object" });
  });

  it("does not retry a transport failure", async () => {
    let calls = 0;
    const chat = createOpenAiChatFn(cfg, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(chat([])).rejects.toThrow(/request failed/);
    expect(calls).toBe(1);
  });

  it("retries once without response_format when the provider 400s (LM Studio)", async () => {
    const bodies: string[] = [];
    const warnings: string[] = [];
    const chat = createOpenAiChatFn(cfg, {
      warn: (message) => warnings.push(message),
      fetchImpl: async (_u, init) => {
        bodies.push(String(init.body));
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: "'response_format.type' must be 'json_schema' or 'text'",
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"lessons":[]}' } }] }),
          { status: 200 },
        );
      },
    });

    expect(await chat([{ role: "user", content: "hi" }])).toBe('{"lessons":[]}');
    expect(bodies).toHaveLength(2);
    const first = JSON.parse(bodies[0]!);
    const second = JSON.parse(bodies[1]!);
    expect(first.response_format).toEqual({ type: "json_object" });
    expect(second.response_format).toBeUndefined();
    expect(second.messages).toEqual(first.messages);
    expect(second.model).toBe("m1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("retrying once without it");
    expect(warnings[0]).toContain("must be 'json_schema' or 'text'");
  });

  it("gives up after a second 400 and reports the body snippet", async () => {
    const warnings: string[] = [];
    let calls = 0;
    const chat = createOpenAiChatFn(cfg, {
      warn: (message) => warnings.push(message),
      fetchImpl: async () => {
        calls += 1;
        return new Response("model 'm1' is not loaded", { status: 400 });
      },
    });
    await expect(chat([])).rejects.toThrow(/HTTP 400: model 'm1' is not loaded/);
    expect(calls).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it("clips a long error body to keep one log line", async () => {
    const chat = createOpenAiChatFn(cfg, {
      fetchImpl: async () => new Response("x".repeat(5_000), { status: 503 }),
    });
    const err = await chat([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const info = err as LlmError;
    expect(info.status).toBe(503);
    expect(info.bodySnippet).toBe(`${"x".repeat(200)}...`);
    expect(info.message.length).toBeLessThan(300);
  });

  it("keeps a multi-line error body on one line", () => {
    expect(bodySnippet("  line one\n\n  line two  ")).toBe("line one line two");
    expect(bodySnippet("")).toBe("");
  });
});
