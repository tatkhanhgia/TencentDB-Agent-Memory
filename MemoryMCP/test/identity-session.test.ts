import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { configForIdentity, parseBindingsJson } from "../src/bindings.js";
import type { IdentityConfig } from "../src/config.js";
import type { MemoryReadPort } from "../src/client.js";
import { createMemoryMcpServer } from "../src/server.js";

const base: IdentityConfig = {
  endpoint: "http://127.0.0.1:9",
  apiKey: "sk-test",
  serviceId: "default",
  teamId: "team-env",
  agentId: "agt-env",
  userId: "usr-env",
  timeoutMs: 1000,
  maxChars: 4096,
  logLevel: "error",
  captureEnabled: false,
  skillsEnabled: false,
};

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Records which identity's port served each call (normalization strips custom fields). */
const served: string[] = [];
function fakeMemory(cfg: IdentityConfig): MemoryReadPort {
  return {
    searchAtomic: async () => {
      served.push(cfg.agentId);
      return { items: [] };
    },
    searchConversation: async () => ({ messages: [] }),
    listScenarios: async () => ({ entries: [] }),
    readScenario: async () => ({ content: null }),
    readCore: async () => ({ content: `persona-of-${cfg.agentId}` }),
  };
}

const MULTI_BINDINGS = JSON.stringify({
  "tok-device": {
    identities: [
      { name: "coder", teamId: "t", agentId: "agt-coder", userId: "u" },
      { name: "testing", teamId: "t", agentId: "agt-testing", userId: "u" },
    ],
  },
});

function makeServer(bindingsJson: string) {
  const binding = parseBindingsJson(bindingsJson).get("tok-device")!;
  return createMemoryMcpServer({
    config: base,
    log: silentLog,
    selection: {
      binding,
      makeConfig: (identity) => configForIdentity(base, identity),
      makeMemory: fakeMemory,
    },
  });
}

async function connect(server: ReturnType<typeof createMemoryMcpServer>, client: Client) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("identity selection per MCP session", () => {
  it("without elicitation support: errors with the identity list, then binds via tdai_identity_use", async () => {
    const server = makeServer(MULTI_BINDINGS);
    const client = new Client({ name: "test", version: "0" });
    await connect(server, client);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("tdai_identity_list");
    expect(names).toContain("tdai_identity_use");

    const blocked = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(blocked.isError).toBe(true);
    const body = textOf(blocked);
    expect(body.error).toBe("identity_not_selected");
    expect((body.identities as Array<{ name: string }>).map((i) => i.name)).toEqual([
      "coder",
      "testing",
    ]);

    const wrong = await client.callTool({ name: "tdai_identity_use", arguments: { name: "nope" } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong).error).toBe("unknown_identity");

    const bound = await client.callTool({
      name: "tdai_identity_use",
      arguments: { name: "testing" },
    });
    expect(bound.isError).toBe(false);

    const search = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(search.isError).toBe(false);
    expect(served.at(-1)).toBe("agt-testing");

    const list = await client.callTool({ name: "tdai_identity_list", arguments: {} });
    const active = (textOf(list).identities as Array<{ name: string; active: boolean }>).find(
      (i) => i.active,
    );
    expect(active?.name).toBe("testing");
  });

  it("with elicitation support: asks the user on first tool call and binds the chosen identity", async () => {
    const server = makeServer(MULTI_BINDINGS);
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: { elicitation: {} } },
    );
    let asked = 0;
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked += 1;
      const schema = req.params.requestedSchema as {
        properties: { identity: { enum: string[]; default?: string } };
      };
      expect(schema.properties.identity.enum).toEqual(["coder", "testing"]);
      // no `suggested` declared → first identity is preselected for one-Enter accept
      expect(schema.properties.identity.default).toBe("coder");
      return { action: "accept", content: { identity: "coder" } };
    });
    await connect(server, client);

    const search = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(asked).toBe(1);
    expect(search.isError).toBe(false);
    expect(served.at(-1)).toBe("agt-coder");

    // Second call must not ask again.
    await client.callTool({ name: "tdai_memory_search", arguments: { query: "again" } });
    expect(asked).toBe(1);
  });

  it("with elicitation declined: falls back to the identity_not_selected error", async () => {
    const server = makeServer(MULTI_BINDINGS);
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    await connect(server, client);

    const blocked = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked).error).toBe("identity_not_selected");
  });

  it("binds silently when the binding declares a default", async () => {
    const server = makeServer(JSON.stringify({
      "tok-device": {
        identities: [
          { name: "coder", teamId: "t", agentId: "agt-coder", userId: "u" },
          { name: "testing", teamId: "t", agentId: "agt-testing", userId: "u" },
        ],
        default: "coder",
      },
    }));
    const client = new Client({ name: "test", version: "0" });
    await connect(server, client);

    const search = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(search.isError).toBe(false);
    expect(served.at(-1)).toBe("agt-coder");

    // Switching later is still allowed.
    await client.callTool({ name: "tdai_identity_use", arguments: { name: "testing" } });
    const after = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(served.at(-1)).toBe("agt-testing");
  });

  it("hides identity tools for single-identity (legacy) bindings", async () => {
    const server = makeServer(JSON.stringify({
      "tok-device": { teamId: "t", agentId: "agt-solo", userId: "u" },
    }));
    const client = new Client({ name: "test", version: "0" });
    await connect(server, client);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("tdai_identity_use");

    const search = await client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "anything" },
    });
    expect(search.isError).toBe(false);
    expect(served.at(-1)).toBe("agt-solo");
  });
});
