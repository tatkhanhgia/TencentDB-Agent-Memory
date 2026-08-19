import { describe, expect, it } from "vitest";
import {
  HEAD_CHAR_BUDGET,
  lastTimestamp,
  parseTranscript,
  renderTurns,
  TOTAL_CHAR_BUDGET,
  truncateTurns,
  type Turn,
} from "../src/reflect/transcript.js";

const claudeCode = [
  JSON.stringify({
    type: "user",
    sessionId: "sess-abc",
    timestamp: "2026-08-19T10:00:00.000Z",
    message: { role: "user", content: "use zod for validation?" },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: "sess-abc",
    timestamp: "2026-08-19T10:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "yes, at the boundary only" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "and never in the core" },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a b" }] },
  }),
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: "<system-reminder>meta noise</system-reminder>" },
  }),
  JSON.stringify({ type: "summary", summary: "not a turn" }),
  "{ this is not json",
  "",
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
].join("\n");

describe("parseTranscript(claude-code)", () => {
  it("keeps text blocks and drops tool / meta / malformed noise", () => {
    const parsed = parseTranscript(claudeCode, "claude-code");
    expect(parsed.turns).toEqual([
      {
        role: "user",
        text: "use zod for validation?",
        timestamp: "2026-08-19T10:00:00.000Z",
      },
      {
        role: "assistant",
        text: "yes, at the boundary only\n\nand never in the core",
        timestamp: "2026-08-19T10:00:01.000Z",
      },
    ]);
    expect(parsed.sessionId).toBe("sess-abc");
    expect(parsed.badLines).toBe(1);
    expect(parsed.lines).toBe(7);
  });

  it("never throws on garbage input", () => {
    const parsed = parseTranscript("not json\n[]\nnull\n42", "claude-code");
    expect(parsed.turns).toEqual([]);
    expect(parsed.badLines).toBe(1);
  });

  it("reports the last available timestamp", () => {
    const parsed = parseTranscript(claudeCode, "claude-code");
    expect(lastTimestamp(parsed.turns)).toBe("2026-08-19T10:00:01.000Z");
    expect(lastTimestamp([{ role: "user", text: "x" }])).toBeUndefined();
  });
});

describe("parseTranscript(generic-jsonl)", () => {
  it("reads role/content lines and skips unknown roles", () => {
    const raw = [
      JSON.stringify({ role: "user", content: "why postgres?" }),
      JSON.stringify({ role: "system", content: "ignored" }),
      JSON.stringify({ role: "assistant", content: "row locks", timestamp: "2026-08-19T11:00:00Z" }),
      JSON.stringify({ role: "assistant", content: "   " }),
      "}{",
    ].join("\n");
    const parsed = parseTranscript(raw, "generic-jsonl");
    expect(parsed.turns).toEqual([
      { role: "user", text: "why postgres?" },
      { role: "assistant", text: "row locks", timestamp: "2026-08-19T11:00:00Z" },
    ]);
    expect(parsed.badLines).toBe(1);
    expect(parsed.sessionId).toBeUndefined();
  });
});

function turnsOfSize(count: number, size: number): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `${i}`.padEnd(size, "x"),
  }));
}

describe("truncateTurns", () => {
  it("passes short transcripts through untouched", () => {
    const turns = turnsOfSize(4, 100);
    const view = truncateTurns(turns);
    expect(view.truncated).toBe(false);
    expect(view.turns).toEqual(turns);
    expect(view.omittedTurns).toBe(0);
  });

  it("keeps head and tail within the char budget", () => {
    const turns = turnsOfSize(100, 5_000); // 500k chars
    const view = truncateTurns(turns);
    const chars = view.turns.reduce((n, t) => n + t.text.length, 0);
    expect(view.truncated).toBe(true);
    expect(chars).toBeLessThanOrEqual(TOTAL_CHAR_BUDGET);
    expect(view.gapIndex).toBe(HEAD_CHAR_BUDGET / 5_000);
    expect(view.turns[0]).toEqual(turns[0]);
    expect(view.turns[view.turns.length - 1]).toEqual(turns[turns.length - 1]);
    expect(view.omittedTurns).toBe(100 - view.turns.length);
  });

  it("respects a custom budget split", () => {
    const turns = turnsOfSize(10, 100);
    const view = truncateTurns(turns, { totalBudget: 300, headBudget: 100 });
    expect(view.turns).toHaveLength(3);
    expect(view.turns[0]).toEqual(turns[0]);
    expect(view.turns[2]).toEqual(turns[9]);
    expect(view.omittedTurns).toBe(7);
  });

  it("clips a single oversized turn instead of returning nothing", () => {
    const view = truncateTurns([{ role: "assistant", text: "abcdefghij" }], {
      totalBudget: 4,
      headBudget: 1,
    });
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.text).toBe("ghij");
    expect(view.truncated).toBe(true);
  });
});

describe("renderTurns", () => {
  it("labels roles and marks the omitted middle", () => {
    const turns = turnsOfSize(10, 100);
    const view = truncateTurns(turns, { totalBudget: 300, headBudget: 100 });
    const rendered = renderTurns(view);
    expect(rendered).toContain("[... 7 middle turn(s) omitted ...]");
    expect(rendered.startsWith("user: 0")).toBe(true);
  });

  it("omits the marker when nothing was dropped", () => {
    const rendered = renderTurns(truncateTurns([{ role: "user", text: "hi" }]));
    expect(rendered).toBe("user: hi");
  });
});
