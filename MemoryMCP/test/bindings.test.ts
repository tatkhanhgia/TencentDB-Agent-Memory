import { describe, expect, it } from "vitest";
import {
  configForIdentity,
  extractBearer,
  findIdentity,
  parseBindingsJson,
  resolveInitialIdentity,
} from "../src/bindings.js";
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
  it("parses the legacy single-identity shape into an auto-binding set", () => {
    const map = parseBindingsJson(JSON.stringify({
      "mcp-alice": { teamId: "team-a", agentId: "agt-a", userId: "usr-a" },
    }));
    const binding = map.get("mcp-alice")!;
    expect(binding.identities).toHaveLength(1);
    expect(binding.identities[0].name).toBe("agt-a");
    const initial = resolveInitialIdentity(binding);
    expect(initial?.userId).toBe("usr-a");
    const cfg = configForIdentity(base, initial!);
    expect(cfg.teamId).toBe("team-a");
    expect(cfg.apiKey).toBe("sk-core-never-leave-server");
    expect(cfg.userId).toBe("usr-a");
  });

  it("parses the multi-identity shape and honours default", () => {
    const map = parseBindingsJson(JSON.stringify({
      "tok-device": {
        identities: [
          { name: "coder", teamId: "t", agentId: "agt-1", userId: "u", description: "main" },
          { name: "project-x", teamId: "t", agentId: "agt-2", userId: "u" },
        ],
        default: "project-x",
      },
    }));
    const binding = map.get("tok-device")!;
    expect(binding.identities.map((i) => i.name)).toEqual(["coder", "project-x"]);
    expect(resolveInitialIdentity(binding)?.agentId).toBe("agt-2");
    expect(findIdentity(binding, "coder")?.agentId).toBe("agt-1");
    expect(findIdentity(binding, "nope")).toBeNull();
  });

  it("returns null initial identity when multiple identities have no default", () => {
    const map = parseBindingsJson(JSON.stringify({
      "tok-device": {
        identities: [
          { name: "a", teamId: "t", agentId: "agt-1", userId: "u" },
          { name: "b", teamId: "t", agentId: "agt-2", userId: "u" },
        ],
      },
    }));
    expect(resolveInitialIdentity(map.get("tok-device")!)).toBeNull();
  });

  it("rejects malformed multi-identity bindings", () => {
    expect(() => parseBindingsJson(JSON.stringify({
      "tok-x": { identities: [] },
    }))).toThrow(/non-empty/);
    expect(() => parseBindingsJson(JSON.stringify({
      "tok-x": {
        identities: [
          { name: "a", teamId: "t", agentId: "agt-1", userId: "u" },
          { name: "a", teamId: "t", agentId: "agt-2", userId: "u" },
        ],
      },
    }))).toThrow(/duplicate identity name/);
    expect(() => parseBindingsJson(JSON.stringify({
      "tok-x": {
        identities: [{ name: "a", teamId: "t", agentId: "agt-1", userId: "u" }],
        default: "missing",
      },
    }))).toThrow(/default "missing"/);
    expect(() => parseBindingsJson(JSON.stringify({
      "tok-x": { identities: [{ name: "a", teamId: "t", userId: "u" }] },
    }))).toThrow(/missing teamId\/agentId\/userId/);
  });

  it("ignores underscore-prefixed comment keys", () => {
    const map = parseBindingsJson(JSON.stringify({
      _comment: "docs only",
      "tok-real": { teamId: "t", agentId: "agt-1", userId: "u" },
    }));
    expect(map.size).toBe(1);
    expect(map.has("tok-real")).toBe(true);
  });

  it("extracts Bearer tokens and rejects missing ones", () => {
    expect(extractBearer("Bearer tok-1")).toBe("tok-1");
    expect(extractBearer("Basic x")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});
