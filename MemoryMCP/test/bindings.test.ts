import { describe, expect, it } from "vitest";
import { configForBinding, extractBearer, parseBindingsJson } from "../src/bindings.js";
import type { IdentityConfig } from "../src/config.js";

const base: IdentityConfig = {
  endpoint: "http://127.0.0.1:8420",
  apiKey: "sk-core-never-leave-server",
  serviceId: "default",
  teamId: "team-env",
  agentId: "agt-env",
  userId: "usr-env",
  timeoutMs: 1000,
  maxChars: 1000,
  logLevel: "info",
  captureEnabled: false,
  skillsEnabled: false,
};

describe("MCP HTTP bindings", () => {
  it("maps a principal token to a server-side binding without exposing the Core key", () => {
    const map = parseBindingsJson(JSON.stringify({
      "mcp-alice": { teamId: "team-a", agentId: "agt-a", userId: "usr-a" },
    }));
    expect(map.get("mcp-alice")?.userId).toBe("usr-a");
    const cfg = configForBinding(base, map.get("mcp-alice")!);
    expect(cfg.teamId).toBe("team-a");
    expect(cfg.apiKey).toBe("sk-core-never-leave-server");
    expect(cfg.userId).toBe("usr-a");
  });

  it("extracts Bearer tokens and rejects missing ones", () => {
    expect(extractBearer("Bearer tok-1")).toBe("tok-1");
    expect(extractBearer("Basic x")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});
