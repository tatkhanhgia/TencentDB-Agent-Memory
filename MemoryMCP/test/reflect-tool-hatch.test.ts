import { describe, expect, it } from "vitest";

import { parseTranscript } from "../src/reflect/transcript.js";

/**
 * The prefilter used to count text turns only. That measure under-describes
 * agentic sessions: an agent can run dozens of tools and summarise in two
 * sentences, scoring 2 turns while being exactly the kind of session that
 * produces durable lessons. Measured over 34 skipped sessions, a dry run at
 * --min-turns 1 recovered real lessons from 4 of 5 sampled ones.
 *
 * These tests pin the second signal: tool-use counting must see tool-only
 * assistant messages, and must stay at zero for genuinely thin sessions.
 */
describe("tool-use counting for the prefilter escape hatch", () => {
  const assistantTools = (n: number) =>
    JSON.stringify({
      type: "assistant",
      message: {
        content: Array.from({ length: n }, (_, i) => ({
          type: "tool_use",
          id: `t${i}`,
          name: "Bash",
          input: {},
        })),
      },
    });

  const assistantText = (text: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

  it("counts tool_use blocks in messages that carry no text at all", () => {
    // The failure mode: these messages are skipped by the text guard, so
    // counting after that guard would report zero.
    const raw = [assistantTools(3), assistantTools(4)].join("\n");
    const parsed = parseTranscript(raw, "claude-code");

    expect(parsed.turns).toHaveLength(0);
    expect(parsed.toolUses).toBe(7);
  });

  it("counts tools and text from the same transcript independently", () => {
    const raw = [
      assistantText("starting"),
      assistantTools(12),
      assistantText("done"),
    ].join("\n");
    const parsed = parseTranscript(raw, "claude-code");

    // 2 text turns — far below the 6-turn floor — but plainly a working session.
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.toolUses).toBe(12);
  });

  it("reports zero tools for a genuinely thin chat session", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
      assistantText("hello"),
    ].join("\n");
    const parsed = parseTranscript(raw, "claude-code");

    expect(parsed.turns).toHaveLength(2);
    expect(parsed.toolUses).toBe(0);
  });

  it("ignores non-tool blocks such as thinking and tool_result", () => {
    const raw = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_result", tool_use_id: "t0", content: "ok" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    });
    const parsed = parseTranscript(raw, "claude-code");

    expect(parsed.toolUses).toBe(1);
  });
});
