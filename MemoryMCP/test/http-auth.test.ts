import { describe, expect, it } from "vitest";
import { extractBearer, parseBindingsJson } from "../src/bindings.js";

describe("HTTP MCP auth helpers", () => {
  it("rejects unknown tokens and empty bindings objects", () => {
    const map = parseBindingsJson(JSON.stringify({
      "mcp-alice": { team_id: "team-a", agent_id: "agt-a", user_id: "usr-a" },
    }));
    expect(map.has("mcp-alice")).toBe(true);
    expect(map.has("mcp-bob")).toBe(false);
    expect(extractBearer("Bearer mcp-alice")).toBe("mcp-alice");
    expect(extractBearer("bearer mcp-alice")).toBe("mcp-alice");
  });
});
