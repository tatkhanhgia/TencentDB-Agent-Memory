import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMemorySources, collectSearchHits, parseChatMemoryAssetId } from "../memory-sources.js";

describe("memory-sources", () => {
  it("parses chat_memory asset ids", () => {
    const p = parseChatMemoryAssetId("chat_memory-team-abc-agt-xyz");
    assert.ok(p);
    assert.equal(p!.teamId, "team-abc");
    assert.equal(p!.agentId, "agt-xyz");
  });

  it("keeps self and imported same-team sources only", () => {
    const sources = buildMemorySources({
      self: { teamId: "team-a", userId: "u1", agentId: "agt-self" },
      detail: {
        agent: { agent_id: "agt-self", team_id: "team-a", owner_user_id: "u1", name: "self" },
        items: [
          { asset_id: "chat_memory-team-a-agt-other", asset_type: "chat_memory", name: "other" },
          { asset_id: "chat_memory-team-b-agt-x", asset_type: "chat_memory", name: "foreign" },
        ],
      },
      sourceAgents: {
        "agt-other": { agent_id: "agt-other", team_id: "team-a", owner_user_id: "u2", name: "Other" },
        "agt-x": { agent_id: "agt-x", team_id: "team-b", owner_user_id: "u3", name: "X" },
      },
    });
    assert.equal(sources[0]!.role, "self");
    assert.equal(sources.length, 2);
    assert.equal(sources[1]!.agentId, "agt-other");
    assert.equal(sources[1]!.role, "imported_from");
  });

  it("collects messages first then items", () => {
    const msgs = collectSearchHits({ messages: [{ id: "m1" }], items: [{ id: "i1" }] });
    assert.equal((msgs[0] as { id: string }).id, "m1");
    const items = collectSearchHits({ items: [{ id: "i1" }] });
    assert.equal((items[0] as { id: string }).id, "i1");
    assert.deepEqual(collectSearchHits({}), []);
  });
});
