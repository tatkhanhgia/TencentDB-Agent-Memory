import { describe, expect, it } from "vitest";
import type { MemoryReadPort } from "../src/client.js";
import type { IdentityConfig } from "../src/config.js";
import { loadConfigFromEnv } from "../src/config.js";
import { handleToolCall } from "../src/handlers.js";

/**
 * A project that resolves to no agent of its own must not borrow the machine
 * default's memory: that is another project's context on the read side and
 * another project's notebook on the write side. Skills are team assets and
 * stay reachable.
 */

const base: IdentityConfig = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "sk-test-secret-key",
  serviceId: "default",
  teamId: "team-a",
  agentId: "agt-machine-default",
  userId: "usr-a",
  timeoutMs: 5000,
  maxChars: 12_288,
  logLevel: "info",
  captureEnabled: true,
  skillsEnabled: true,
  identityUnbound: true,
};

/** Every port method throws: reaching Core at all is the failure under test. */
function forbiddenPort(overrides: Partial<MemoryReadPort> = {}): MemoryReadPort {
  const forbidden = async () => {
    throw new Error("must not reach Core for an unbound project");
  };
  return {
    searchAtomic: forbidden,
    searchConversation: forbidden,
    listScenarios: forbidden,
    readScenario: forbidden,
    readCore: forbidden,
    addConversation: forbidden,
    recallBundle: forbidden,
    ...overrides,
  };
}

const MEMORY_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["tdai_memory_context", { query: "anything" }],
  ["tdai_memory_search", { query: "anything" }],
  ["tdai_conversation_search", { query: "anything" }],
  ["tdai_scene_read", { path: "auth.md" }],
];

describe("unbound project", () => {
  for (const [tool, args] of MEMORY_TOOLS) {
    it(`${tool} answers empty without calling Core`, async () => {
      const res = await handleToolCall(tool, args, { config: base, memory: forbiddenPort() });
      expect(res.isError).toBe(false);
      expect(res.structured.unbound).toBe(true);
      // The model must be able to tell "no memory yet" from "recall broke".
      expect(String(res.structured.reason)).toMatch(/not bound/i);
      const payload = JSON.stringify(res.structured);
      expect(payload).not.toContain("agt-machine-default");
    });
  }

  it("refuses capture instead of writing into the default agent", async () => {
    const res = await handleToolCall(
      "tdai_memory_capture",
      { capture_id: "cap-1", user: "u", assistant: "a" },
      { config: base, memory: forbiddenPort() },
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structured)).toMatch(/identity_unbound/);
  });

  it("keeps Skills reachable and forces team scope", async () => {
    const seen: unknown[] = [];
    const memory = forbiddenPort({
      listSkills: async (req) => {
        seen.push(req);
        return { items: [{ skill_id: "skl-1", name: "deploy", description: "d" }], total: 1 };
      },
    });
    // Ask for the agent scope explicitly: unbound must still widen it to team,
    // otherwise the owner filter is the default agent and the team library
    // looks empty.
    const res = await handleToolCall("tdai_skill_list", { scope: "agent" }, { config: base, memory });
    expect(res.isError).toBe(false);
    expect(res.structured.skill_scope).toBe("team");
    expect((seen[0] as { scope?: string }).scope).toBe("team");
  });

  it("leaves a bound project untouched", async () => {
    const bound: IdentityConfig = { ...base, identityUnbound: false };
    const memory = forbiddenPort({ searchAtomic: async () => ({ items: [{ id: "l1-1" }] }) });
    const res = await handleToolCall("tdai_memory_search", { query: "x" }, { config: bound, memory });
    expect(res.structured.unbound).toBeUndefined();
  });
});

describe("loadConfigFromEnv", () => {
  const env = {
    TDAI_ENDPOINT: "http://127.0.0.1:8420",
    TDAI_API_KEY: "k",
    TDAI_SERVICE_ID: "default",
    TDAI_TEAM_ID: "team-a",
    TDAI_AGENT_ID: "agt-a",
    TDAI_USER_ID: "usr-a",
  };

  it("defaults to bound when the wrapper says nothing", () => {
    expect(loadConfigFromEnv(env).identityUnbound).toBe(false);
  });

  it("reads TDAI_IDENTITY_UNBOUND", () => {
    expect(loadConfigFromEnv({ ...env, TDAI_IDENTITY_UNBOUND: "1" }).identityUnbound).toBe(true);
    expect(loadConfigFromEnv({ ...env, TDAI_IDENTITY_UNBOUND: "true" }).identityUnbound).toBe(true);
    expect(loadConfigFromEnv({ ...env, TDAI_IDENTITY_UNBOUND: "0" }).identityUnbound).toBe(false);
  });
});
