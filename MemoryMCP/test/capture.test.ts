import { describe, expect, it } from "vitest";
import type { MemoryReadPort } from "../src/client.js";
import type { IdentityConfig } from "../src/config.js";
import { handleToolCall } from "../src/handlers.js";
import { stripTdaiWrappers } from "../src/sanitize.js";
import { namespaceConversationRef } from "../src/session-key.js";

const base: IdentityConfig = {
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

describe("tdai_memory_capture", () => {
  it("is disabled by default", async () => {
    const result = await handleToolCall(
      "tdai_memory_capture",
      { capture_id: "c1", user: "hi", assistant: "hello" },
      { config: base, memory: {} as MemoryReadPort },
    );
    expect(result.isError).toBe(true);
    expect(String(result.structured.error)).toBe("capture_disabled");
  });

  it("rejects transcript-sized payloads", async () => {
    const result = await handleToolCall(
      "tdai_memory_capture",
      {
        capture_id: "c1",
        conversation_ref: "chat-1",
        user: "x".repeat(9000),
        assistant: "ok",
      },
      {
        config: { ...base, captureEnabled: true },
        memory: {
          addConversation: async () => ({ accepted_ids: [], total_count: 0 }),
        } as MemoryReadPort,
      },
    );
    expect(result.isError).toBe(true);
    expect(String(result.structured.error)).toBe("turn_too_large");
  });

  it("strips recall wrappers and namespaces conversation_ref", async () => {
    expect(stripTdaiWrappers("hi <tdai_memory_tools>secret</tdai_memory_tools> there")).toBe(
      "hi  there",
    );
    const sid = namespaceConversationRef(base, "chat-1");
    expect(sid.startsWith("mcp_")).toBe(true);
    expect(sid.endsWith("_chat-1")).toBe(true);
    expect(sid).not.toContain("team-a");

    let seen: { session_id: string; capture_id: string; messages: Array<{ content: string }> } | undefined;
    const result = await handleToolCall(
      "tdai_memory_capture",
      {
        capture_id: "cap-9",
        conversation_ref: "chat-1",
        user: "remember this <user-persona>nope</user-persona>",
        assistant: "noted",
        team_id: "team-attacker",
      },
      {
        config: { ...base, captureEnabled: true },
        memory: {
          addConversation: async (req) => {
            seen = req;
            return { accepted_ids: ["a", "b"], total_count: 2, capture_id: req.capture_id, duplicate: false };
          },
        } as MemoryReadPort,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.structured.duplicate).toBe(false);
    expect(result.structured.capture_id).toBe("cap-9");
    expect(seen?.capture_id).toBe("cap-9");
    expect(seen?.session_id).toBe(sid);
    expect(seen?.messages[0]?.content).toBe("remember this");
    expect(JSON.stringify(result.structured)).not.toContain("team-attacker");
    expect(JSON.stringify(result.structured)).not.toContain(base.apiKey);
  });

  it("returns duplicate=true when the port reports a replay", async () => {
    const result = await handleToolCall(
      "tdai_memory_capture",
      { capture_id: "cap-9", conversation_ref: "chat-1", user: "u", assistant: "a" },
      {
        config: { ...base, captureEnabled: true },
        memory: {
          addConversation: async () => ({
            accepted_ids: ["a", "b"],
            total_count: 2,
            capture_id: "cap-9",
            duplicate: true,
          }),
        } as MemoryReadPort,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.structured.duplicate).toBe(true);
  });
});
