import { describe, expect, it } from "vitest";
import type { AtomicSearchInput, ConversationAddInput, MemoryReadPort } from "../src/client.js";
import type { Lesson } from "../src/reflect/extract.js";
import {
  buildBody,
  buildCaptureId,
  buildSessionId,
  DEDUPE_THRESHOLD,
  isConflictError,
  isDuplicate,
  jaccard,
  MemoryWriteError,
  normalizeTokens,
  writeLessons,
} from "../src/reflect/write.js";

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  title: "Retries live in the SDK",
  body: "Keeps the gateway stateless.",
  kind: "adr",
  confidence: 0.9,
  ...over,
});

interface Fake {
  port: MemoryReadPort;
  searches: AtomicSearchInput[];
  writes: ConversationAddInput[];
}

function fakePort(hits: string[][] = [], failWriteAt = -1): Fake {
  const searches: AtomicSearchInput[] = [];
  const writes: ConversationAddInput[] = [];
  const port = {
    async searchAtomic(req: AtomicSearchInput) {
      searches.push(req);
      const items = (hits[searches.length - 1] ?? []).map((content) => ({ content }));
      return { items };
    },
    async addConversation(req: ConversationAddInput) {
      writes.push(req);
      if (writes.length - 1 === failWriteAt) throw new Error("core unavailable");
      return { accepted_ids: ["a", "b"], total_count: 2, capture_id: req.capture_id };
    },
  } as unknown as MemoryReadPort;
  return { port, searches, writes };
}

describe("normalizeTokens", () => {
  it("lowercases and splits on punctuation", () => {
    expect(normalizeTokens("Retries live in the SDK, not the Gateway!")).toEqual([
      "retries",
      "live",
      "in",
      "the",
      "sdk",
      "not",
      "the",
      "gateway",
    ]);
  });

  it("splits CJK into single characters", () => {
    expect(normalizeTokens("重试 v2")).toEqual(["重", "试", "v2"]);
  });

  it("returns nothing for token-free text", () => {
    expect(normalizeTokens("--- !!! ---")).toEqual([]);
  });
});

describe("jaccard", () => {
  it("is 1 for identical token sets and 0 for disjoint ones", () => {
    expect(jaccard(["a", "b"], ["b", "a", "a"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("is 0 when either side is empty", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("computes intersection over union", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
  });
});

describe("isDuplicate", () => {
  it("flags a near-identical existing atom", () => {
    expect(isDuplicate("Retries live in the SDK", ["retries live in the sdk"])).toBe(true);
    expect(isDuplicate("Retries live in the SDK", ["Retries live in the SDK, not gateway"])).toBe(
      true,
    );
  });

  it("does not flag unrelated atoms", () => {
    expect(isDuplicate("Retries live in the SDK", ["Use postgres for the job queue"])).toBe(false);
  });

  it("does not flag an empty result set or a token-free title", () => {
    expect(isDuplicate("Retries live in the SDK", [])).toBe(false);
    expect(isDuplicate("???", ["???"])).toBe(false);
  });

  it("honours a custom threshold", () => {
    const title = "a b c";
    expect(isDuplicate(title, ["b c d"], 0.4)).toBe(true);
    expect(isDuplicate(title, ["b c d"], DEDUPE_THRESHOLD)).toBe(false);
  });
});

describe("id shapes", () => {
  it("namespaces the session and numbers captures by input index", () => {
    expect(buildSessionId("sess-abc")).toBe("reflect:sess-abc");
    expect(buildCaptureId("sess-abc", 0)).toBe("reflect-sess-abc-0");
    expect(buildCaptureId("sess-abc", 2)).toBe("reflect-sess-abc-2");
  });
});

describe("writeLessons", () => {
  const ctx = { sessionId: "sess-abc", isoDate: "2026-08-19T12:00:00.000Z", format: "claude-code" };

  it("writes one L0 capture per lesson with idempotent ids", async () => {
    const fake = fakePort();
    const lessons = [lesson({ title: "A one" }), lesson({ title: "B two", kind: "preference" })];
    const result = await writeLessons(lessons, { memory: fake.port, ...ctx });

    expect(result.written).toEqual(lessons);
    expect(result.duplicates).toEqual([]);
    expect(fake.searches).toEqual([
      { query: "A one", limit: 5 },
      { query: "B two", limit: 5 },
    ]);
    expect(fake.writes.map((w) => w.session_id)).toEqual(["reflect:sess-abc", "reflect:sess-abc"]);
    expect(fake.writes.map((w) => w.capture_id)).toEqual([
      "reflect-sess-abc-0",
      "reflect-sess-abc-1",
    ]);
    expect(fake.writes[0]?.messages[0]).toEqual({
      role: "user",
      content: "[reflect:adr] A one",
    });
    expect(fake.writes[1]?.messages[0]?.content).toBe("[reflect:preference] B two");
    expect(fake.writes[0]?.messages[1]?.content).toBe(
      "Keeps the gateway stateless.\n\n(source: session sess-abc, 2026-08-19T12:00:00.000Z, host=claude-code)",
    );
    expect(fake.writes[0]?.messages[0]?.timestamp).toBeUndefined();
  });

  it("keeps capture ids stable when an earlier lesson is a duplicate", async () => {
    const fake = fakePort([["Retries live in the SDK"], []]);
    const lessons = [lesson(), lesson({ title: "Use postgres for the queue" })];
    const result = await writeLessons(lessons, { memory: fake.port, ...ctx });

    expect(result.duplicates.map((l) => l.title)).toEqual(["Retries live in the SDK"]);
    expect(result.written.map((l) => l.title)).toEqual(["Use postgres for the queue"]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.capture_id).toBe("reflect-sess-abc-1");
  });

  it("stamps the transcript timestamp on both messages when given", async () => {
    const fake = fakePort();
    await writeLessons([lesson()], {
      memory: fake.port,
      ...ctx,
      timestamp: "2026-08-19T10:00:01.000Z",
    });
    expect(fake.writes[0]?.messages.map((m) => m.timestamp)).toEqual([
      "2026-08-19T10:00:01.000Z",
      "2026-08-19T10:00:01.000Z",
    ]);
  });

  it("writes anyway when the dedupe search fails", async () => {
    const warnings: string[] = [];
    const port = {
      async searchAtomic() {
        throw new Error("search down");
      },
      async addConversation() {
        return { accepted_ids: [], total_count: 0 };
      },
    } as unknown as MemoryReadPort;
    const result = await writeLessons([lesson()], {
      memory: port,
      ...ctx,
      warn: (m) => warnings.push(m),
    });
    expect(result.written).toHaveLength(1);
    expect(warnings[0]).toContain("dedupe search failed");
  });

  it("raises MemoryWriteError when the port cannot write", async () => {
    const readOnly = {
      async searchAtomic() {
        return { items: [] };
      },
    } as unknown as MemoryReadPort;
    await expect(writeLessons([lesson()], { memory: readOnly, ...ctx })).rejects.toBeInstanceOf(
      MemoryWriteError,
    );
  });

  it("raises MemoryWriteError when Core rejects the write", async () => {
    const fake = fakePort([[]], 0);
    await expect(writeLessons([lesson()], { memory: fake.port, ...ctx })).rejects.toThrow(
      /failed to write lesson "Retries live in the SDK"/,
    );
  });
});

/** Mirrors the SDK's TDAMError: `code` holds the HTTP status or a business code. */
class TdamErrorLike extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TDAMError";
    this.code = code;
  }
}

/**
 * Stand-in for Core's capture_id idempotency: the first write of a capture_id
 * wins; a replay with the same payload hash is an accepted duplicate, and a
 * replay with a different hash is a 409.
 */
class FakeCore {
  readonly stored = new Map<string, string>();
  readonly seen: ConversationAddInput[] = [];

  addConversation = async (req: ConversationAddInput) => {
    this.seen.push(req);
    const hash = JSON.stringify(req.messages);
    const prior = this.stored.get(req.capture_id);
    if (prior === undefined) {
      this.stored.set(req.capture_id, hash);
      return { accepted_ids: ["a", "b"], total_count: 2, capture_id: req.capture_id, duplicate: false };
    }
    if (prior !== hash) {
      throw new TdamErrorLike(409, `HTTP 409: capture_id ${req.capture_id} already exists`);
    }
    return { accepted_ids: [], total_count: 0, capture_id: req.capture_id, duplicate: true };
  };

  get port(): MemoryReadPort {
    return {
      searchAtomic: async () => ({ items: [] }),
      addConversation: this.addConversation,
    } as unknown as MemoryReadPort;
  }
}

describe("buildBody", () => {
  const ctx = { sessionId: "sess-abc", format: "claude-code" };

  it("dates the footer from the transcript when a timestamp exists", () => {
    expect(buildBody(lesson(), { ...ctx, isoDate: "2026-08-19T09:02:10.000Z" })).toBe(
      "Keeps the gateway stateless.\n\n(source: session sess-abc, 2026-08-19T09:02:10.000Z, host=claude-code)",
    );
  });

  it("omits the date entirely when the transcript had no timestamp", () => {
    expect(buildBody(lesson(), ctx)).toBe(
      "Keeps the gateway stateless.\n\n(source: session sess-abc, host=claude-code)",
    );
  });
});

describe("isConflictError", () => {
  it("recognises HTTP and business conflict codes", () => {
    expect(isConflictError(new TdamErrorLike(409, "HTTP 409: already exists"))).toBe(true);
    expect(isConflictError(new TdamErrorLike(40_901, "CAPTURE_CONFLICT"))).toBe(true);
    expect(isConflictError({ status: 409 })).toBe(true);
    expect(isConflictError({ statusCode: 409 })).toBe(true);
    expect(isConflictError({ response: { status: 409 } })).toBe(true);
  });

  it("falls back to the message when no code is exposed", () => {
    expect(isConflictError(new Error("409 Conflict"))).toBe(true);
    expect(isConflictError(new Error("capture already captured"))).toBe(true);
    expect(isConflictError(new Error("capture_id already exists"))).toBe(true);
  });

  it("does not treat other failures as conflicts", () => {
    expect(isConflictError(new TdamErrorLike(500, "HTTP 500: boom"))).toBe(false);
    expect(isConflictError(new Error("core unavailable"))).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
    expect(isConflictError("409")).toBe(false);
  });
});

describe("writeLessons idempotency", () => {
  const ctx = { sessionId: "sess-abc", format: "claude-code" };

  it("produces byte-identical payloads across runs at different wall-clock times", async () => {
    const a = fakePort();
    const b = fakePort();
    const options = { ...ctx, isoDate: "2026-08-19T09:02:10.000Z", timestamp: "2026-08-19T09:02:10.000Z" };
    await writeLessons([lesson()], { memory: a.port, ...options });
    await writeLessons([lesson()], { memory: b.port, ...options });
    expect(a.writes).toEqual(b.writes);
    // Every timestamp in the payload comes from the transcript, none from the clock.
    const stamps = JSON.stringify(a.writes).match(/\d{4}-\d\d-\d\dT[\d:.]+Z/g) ?? [];
    expect(new Set(stamps)).toEqual(new Set(["2026-08-19T09:02:10.000Z"]));
  });

  it("writes no date at all when the transcript carried no timestamps", async () => {
    const fake = fakePort();
    await writeLessons([lesson()], { memory: fake.port, ...ctx });
    expect(JSON.stringify(fake.writes)).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });

  it("re-running a hook against Core is a no-op, not a failure", async () => {
    const core = new FakeCore();
    const lessons = [lesson(), lesson({ title: "Use postgres for the queue" })];
    const options = { ...ctx, isoDate: "2026-08-19T09:02:10.000Z", timestamp: "2026-08-19T09:02:10.000Z" };

    const first = await writeLessons(lessons, { memory: core.port, ...options });
    expect(first.written).toHaveLength(2);

    const second = await writeLessons(lessons, { memory: core.port, ...options });
    expect(second.written).toEqual([]);
    expect(second.duplicates).toEqual(lessons);
    expect(core.stored.size).toBe(2);
  });

  it("absorbs a 409 on a slot whose content changed and keeps going", async () => {
    const core = new FakeCore();
    const options = { ...ctx, isoDate: "2026-08-19T09:02:10.000Z" };
    await writeLessons([lesson()], { memory: core.port, ...options });

    const warnings: string[] = [];
    const rerun = await writeLessons(
      [lesson({ title: "A different lesson in slot 0" }), lesson({ title: "Use postgres for the queue" })],
      { memory: core.port, ...options, warn: (m) => warnings.push(m) },
    );

    expect(rerun.duplicates.map((l) => l.title)).toEqual(["A different lesson in slot 0"]);
    expect(rerun.written.map((l) => l.title)).toEqual(["Use postgres for the queue"]);
    expect(warnings.join("\n")).toContain("was already captured");
    expect(core.stored.has("reflect-sess-abc-1")).toBe(true);
  });

  it("counts an accepted replay reported by Core as a duplicate, not a write", async () => {
    const port = {
      searchAtomic: async () => ({ items: [] }),
      addConversation: async () => ({ accepted_ids: [], total_count: 0, duplicate: true }),
    } as unknown as MemoryReadPort;
    const result = await writeLessons([lesson()], { memory: port, ...ctx });
    expect(result.written).toEqual([]);
    expect(result.duplicates).toHaveLength(1);
  });
});
