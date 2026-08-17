import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MemoryReadPort } from "../src/client.js";
import type { IdentityConfig } from "../src/config.js";
import { handleToolCall } from "../src/handlers.js";

const dir = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(dir, "fixtures", name), "utf8"));
}

const config: IdentityConfig = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "sk-test-secret-key",
  serviceId: "default",
  teamId: "team-a",
  agentId: "agt-a",
  userId: "usr-a",
  timeoutMs: 5000,
  maxChars: 12_288,
  logLevel: "info",
  captureEnabled: false,
  skillsEnabled: false,
};

function port(partial: Partial<MemoryReadPort>): MemoryReadPort {
  const missing = async () => {
    throw new Error("not implemented");
  };
  return {
    searchAtomic: partial.searchAtomic ?? missing,
    searchConversation: partial.searchConversation ?? missing,
    listScenarios: partial.listScenarios ?? missing,
    readScenario: partial.readScenario ?? missing,
    readCore: partial.readCore ?? missing,
    addConversation: partial.addConversation,
    recallBundle: partial.recallBundle,
    searchSkills: partial.searchSkills,
    getSkill: partial.getSkill,
  };
}

describe("handleToolCall", () => {
  it("marks partial self-scope when recallBundle fails", async () => {
    const result = await handleToolCall(
      "tdai_memory_context",
      { query: "prefs" },
      {
        config,
        memory: port({
          recallBundle: async () => {
            throw new Error("core recall down");
          },
          readCore: async () => ({ content: "p" }),
          listScenarios: async () => ({ entries: [] }),
          searchAtomic: async () => ({ items: [] }),
        }),
      },
    );
    expect(result.isError).toBe(false);
    expect(result.structured.scope).toBe("self");
    expect(result.structured.partial).toBe(true);
    expect(JSON.stringify(result.structured.errors)).toContain("core recall down");
  });

  it("uses Core recallBundle bound scope when the port provides it", async () => {
    const result = await handleToolCall(
      "tdai_memory_context",
      { query: "prefs" },
      {
        config,
        memory: port({
          recallBundle: async () => ({
            scope: "bound",
            persona: "p",
            scenes: [],
            l1: [{ content: "from-imported", source_agent_role: "imported_from" }],
            sources: [{ agent_id: "agt-b", role: "imported_from" }],
            partial: false,
            errors: [],
          }),
        }),
      },
    );
    expect(result.isError).toBe(false);
    expect(result.structured.scope).toBe("bound");
    expect(JSON.stringify(result.structured.l1)).toContain("from-imported");
  });

  it("returns scope=self and a partial bundle when one recall source fails", async () => {
    const result = await handleToolCall(
      "tdai_memory_context",
      { query: "preferences" },
      {
        config,
        memory: port({
          readCore: async () => {
            throw new Error("core down");
          },
          listScenarios: async () => ({
            entries: [{ path: "scene_blocks/ok.md", summary: "ok" }],
            total: 1,
          }),
          searchAtomic: async () => ({
            items: [{ id: "a1", type: "preference", content: "likes vim", score: 1 }],
          }),
        }),
      },
    );
    expect(result.isError).toBe(false);
    expect(result.structured.scope).toBe("self");
    expect(result.structured.partial).toBe(true);
    expect(result.structured.persona).toBeNull();
    expect(result.structured.l1).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "likes vim" })]),
    );
    const errors = result.structured.errors as Array<{ source: string }>;
    expect(errors.map((e) => e.source)).toContain("persona");
    expect(result.text).not.toContain(config.apiKey);
  });

  it("returns canonical messages hits from L0 search", async () => {
    const result = await handleToolCall(
      "tdai_conversation_search",
      { query: "theme" },
      {
        config,
        memory: port({
          searchConversation: async () => fixture("l0-messages.json"),
        }),
      },
    );
    expect(result.isError).toBe(false);
    const messages = result.structured.messages as Array<{ id: string }>;
    expect(messages[0]?.id).toBe("msg-seed-messages");
    expect(result.structured.source).toBe("messages");
    expect(result.structured.drift).toBe(false);
  });

  it("does not turn items-only L0 data into a silent empty success", async () => {
    const result = await handleToolCall(
      "tdai_conversation_search",
      { query: "from-items" },
      {
        config,
        memory: port({
          searchConversation: async () => fixture("l0-items-only.json"),
        }),
      },
    );
    expect(result.isError).toBe(false);
    const messages = result.structured.messages as Array<{ id: string }>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.id).toBe("msg-seed-items");
    expect(result.structured.source).toBe("items");
    expect(result.structured.drift).toBe(true);
  });

  it("ignores identity override fields in tool arguments", async () => {
    let seenQuery: string | undefined;
    const result = await handleToolCall(
      "tdai_memory_search",
      {
        query: "prefs",
        team_id: "team-attacker",
        apiKey: "sk-stolen",
      },
      {
        config,
        memory: port({
          searchAtomic: async (req) => {
            seenQuery = req.query;
            return { items: [{ content: "ok" }] };
          },
        }),
      },
    );
    expect(result.isError).toBe(false);
    expect(seenQuery).toBe("prefs");
    expect(result.structured.scope).toBe("self");
    expect(JSON.stringify(result.structured)).not.toContain("team-attacker");
    expect(JSON.stringify(result.structured)).not.toContain("sk-stolen");
    expect(JSON.stringify(result.structured)).not.toContain(config.apiKey);
  });

  it("rejects scene path traversal via the shipped handler", async () => {
    const result = await handleToolCall(
      "tdai_scene_read",
      { path: "../secret" },
      { config, memory: port({}) },
    );
    expect(result.isError).toBe(true);
    expect(String(result.structured.message)).toMatch(/path/i);
  });
});
