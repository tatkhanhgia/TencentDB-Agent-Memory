import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBindingsJson } from "../src/bindings.js";
import { agentsToIdentities, createRegistryIdentityProvider } from "../src/registry.js";

describe("registry bindings parse", () => {
  it('accepts identities: "registry" with default/suggested deferred', () => {
    const map = parseBindingsJson(JSON.stringify({
      "tok-device": { identities: "registry", suggested: "coder" },
    }));
    const b = map.get("tok-device")!;
    expect(b.identities).toBe("registry");
    expect(b.suggestedName).toBe("coder");
  });
});

describe("agentsToIdentities", () => {
  it("maps active agents, slugs names, dedupes, skips inactive", () => {
    const ids = agentsToIdentities(
      [
        { agent_id: "agt-1", team_id: "t", name: "Coder", status: "active", description: "main" },
        { agent_id: "agt-2", team_id: "t", name: "Coder", status: "active" },
        { agent_id: "agt-3", team_id: "t", name: "Old Agent", status: "archived" },
        { agent_id: "agt-4", team_id: "t", name: "Dự án X!", status: "active" },
      ],
      "usr-1",
    );
    expect(ids.map((i) => i.name)).toEqual(["coder", "coder-2", "d-n-x"]);
    expect(ids[0]).toMatchObject({ agentId: "agt-1", teamId: "t", userId: "usr-1", description: "main" });
  });
});

describe("createRegistryIdentityProvider", () => {
  let server: ReturnType<typeof createServer>;
  let port = 0;
  let hits = 0;
  let fail = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (fail) {
        res.writeHead(500);
        res.end();
        return;
      }
      expect(req.headers["x-tdai-user-key"]).toBe("sk-admin");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        code: 0,
        message: "ok",
        data: { items: [{ agent_id: "agt-live", team_id: "t", name: "live", status: "active" }] },
      }));
    });
    port = await new Promise<number>((r) => {
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        r(typeof a === "object" && a ? a.port : 0);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("fetches, caches within TTL, and serves stale on failure", async () => {
    const provider = createRegistryIdentityProvider({
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "sk-admin",
      serviceId: "default",
      teamId: "t",
      userId: "usr-1",
      ttlMs: 60_000,
    });
    const first = await provider();
    expect(first.map((i) => i.agentId)).toEqual(["agt-live"]);
    await provider();
    expect(hits).toBe(1); // cached

    // Expired TTL + failing upstream → stale list survives
    const flaky = createRegistryIdentityProvider({
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "sk-admin",
      serviceId: "default",
      teamId: "t",
      userId: "usr-1",
      ttlMs: 1,
    });
    await flaky();
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    const stale = await flaky();
    expect(stale.map((i) => i.agentId)).toEqual(["agt-live"]);
    fail = false;
  });
});
