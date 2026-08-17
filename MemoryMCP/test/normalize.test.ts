import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeConversationSearch } from "../src/normalize.js";

const dir = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(dir, "fixtures", name), "utf8"));
}

describe("normalizeConversationSearch", () => {
  it("uses Core canonical data.messages", () => {
    const raw = loadFixture("l0-messages.json");
    const out = normalizeConversationSearch(raw);
    expect(out.source).toBe("messages");
    expect(out.drift).toBe(false);
    expect(out.messages.map((m) => m.id)).toEqual(["msg-seed-messages"]);
    expect(out.messages[0]?.content).toMatch(/canonical messages hit/);
  });

  it("does not drop items-only results as a silent empty list", () => {
    const raw = loadFixture("l0-items-only.json");
    const out = normalizeConversationSearch(raw);
    expect(out.source).toBe("items");
    expect(out.drift).toBe(true);
    expect(out.messages).not.toEqual([]);
    expect(out.messages[0]?.id).toBe("msg-seed-items");
    expect(out.messages[0]?.content).toMatch(/must not be dropped/);
  });

  it("treats explicit empty messages as empty even if items exist", () => {
    const out = normalizeConversationSearch({
      messages: [],
      items: [{ content: "should-not-win" }],
    });
    expect(out.source).toBe("messages");
    expect(out.messages).toEqual([]);
    expect(out.drift).toBe(false);
  });

  it("returns empty when neither field is present", () => {
    const out = normalizeConversationSearch({});
    expect(out.source).toBe("empty");
    expect(out.messages).toEqual([]);
  });
});
