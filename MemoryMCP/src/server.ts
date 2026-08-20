import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IdentityConfig } from "./config.js";
import type { MemoryReadPort } from "./client.js";
import type { Logger } from "./logger.js";
import {
  resolveInitialIdentity,
  findIdentity,
  type NamedIdentity,
  type PrincipalBinding,
} from "./bindings.js";
import { handleToolCall } from "./handlers.js";
import { IDENTITY_TOOL_NAMES, listToolDescriptors } from "./tools.js";
import { redactSecrets } from "./redact.js";

/**
 * Multi-identity mode: the session's token maps to several identities and
 * the active one is chosen per session (default → silent bind; otherwise
 * elicitation, falling back to the tdai_identity_use tool).
 */
export interface IdentitySelection {
  binding: PrincipalBinding;
  makeConfig: (identity: NamedIdentity) => IdentityConfig;
  makeMemory: (cfg: IdentityConfig) => MemoryReadPort;
}

export interface ServerDeps {
  config: IdentityConfig;
  log: Logger;
  /** Required unless `selection` is provided (then created per identity). */
  memory?: MemoryReadPort;
  selection?: IdentitySelection;
}

interface ActiveIdentity {
  config: IdentityConfig;
  memory: MemoryReadPort;
  name?: string;
}

function identityLabel(id: NamedIdentity): string {
  return id.description ? `${id.name} — ${id.description}` : `${id.name} (${id.agentId})`;
}

function identityListPayload(selection: IdentitySelection, activeName: string | undefined) {
  return selection.binding.identities.map((i) => ({
    name: i.name,
    agent_id: i.agentId,
    description: i.description ?? null,
    active: i.name === activeName,
  }));
}

export function createMemoryMcpServer(deps: ServerDeps): Server {
  const secrets = [deps.config.apiKey];
  const redact = (msg: string) => redactSecrets(msg, secrets);
  const selection = deps.selection;

  const server = new Server(
    { name: "tdai-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  let active: ActiveIdentity | null = null;
  if (selection) {
    const initial = resolveInitialIdentity(selection.binding);
    if (initial) active = bindIdentity(initial);
  } else {
    if (!deps.memory) throw new Error("ServerDeps.memory required without selection");
    active = { config: deps.config, memory: deps.memory };
  }

  function bindIdentity(identity: NamedIdentity): ActiveIdentity {
    const cfg = selection!.makeConfig(identity);
    return { config: cfg, memory: selection!.makeMemory(cfg), name: identity.name };
  }

  const selectable = selection && selection.binding.identities.length > 1;

  // Single-flight: concurrent tool calls must not open two pickers.
  let pendingElicit: Promise<NamedIdentity | null> | null = null;

  async function elicitIdentity(): Promise<NamedIdentity | null> {
    if (!selection) return null;
    if (pendingElicit) return pendingElicit;
    pendingElicit = (async () => {
      const ids = selection.binding.identities;
      try {
        const result = await server.elicitInput({
          message: "Select the memory identity for this session (each identity is a separate memory store).",
          requestedSchema: {
            type: "object",
            properties: {
              identity: {
                type: "string",
                title: "Memory identity",
                description: "The identity decides which memory store this session reads.",
                enum: ids.map((i) => i.name),
                enumNames: ids.map((i) => identityLabel(i)),
                // Preselect so a single Enter accepts the usual choice.
                default: selection.binding.suggestedName ?? ids[0].name,
              },
            },
            required: ["identity"],
          },
        });
        if (result.action !== "accept") return null;
        const chosen = String(result.content?.identity ?? "").trim();
        return findIdentity(selection.binding, chosen);
      } catch (err) {
        deps.log.warn(`identity elicitation failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        pendingElicit = null;
      }
    })();
    return pendingElicit;
  }

  function identityRequiredResult() {
    const names = selection!.binding.identities.map((i) => i.name);
    const structured = {
      error: "identity_not_selected",
      message:
        "This MCP token maps to multiple memory identities and none is active yet. " +
        "Call tdai_identity_use with one of the listed names (ask the user which one if unclear).",
      identities: identityListPayload(selection!, undefined),
      hint: `tdai_identity_use {"name": "${names[0]}"}`,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
      isError: true,
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDescriptors({
      captureEnabled: deps.config.captureEnabled,
      skillsEnabled: deps.config.skillsEnabled,
      identityEnabled: Boolean(selectable),
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (selectable && (IDENTITY_TOOL_NAMES as readonly string[]).includes(name)) {
      if (name === "tdai_identity_list") {
        const structured = { identities: identityListPayload(selection!, active?.name) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          isError: false,
        };
      }
      // tdai_identity_use
      const requested = String(args.name ?? "").trim();
      const identity = requested ? findIdentity(selection!.binding, requested) : null;
      if (!identity) {
        const structured = {
          error: "unknown_identity",
          message: `No identity named "${requested}" on this token.`,
          identities: identityListPayload(selection!, active?.name),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          isError: true,
        };
      }
      active = bindIdentity(identity);
      deps.log.info(`session identity bound via tool: ${identity.name} (${identity.agentId})`);
      const structured = {
        ok: true,
        active: { name: identity.name, agent_id: identity.agentId },
        message: `Memory identity "${identity.name}" is now active for this session.`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
        isError: false,
      };
    }

    if (!active) {
      // Ask the user directly when the client supports elicitation;
      // otherwise instruct the model to use tdai_identity_use.
      if (server.getClientCapabilities()?.elicitation) {
        const identity = await elicitIdentity();
        if (identity) {
          active = bindIdentity(identity);
          deps.log.info(`session identity bound via elicitation: ${identity.name} (${identity.agentId})`);
        }
      }
      if (!active) return identityRequiredResult();
    }

    const result = await handleToolCall(name, args, {
      config: active.config,
      memory: active.memory,
    });
    const text = redact(result.text);
    if (result.isError) {
      deps.log.warn(`tool ${name} error: ${text}`);
    }
    return {
      content: [{ type: "text" as const, text }],
      isError: result.isError,
    };
  });

  return server;
}

export async function startStdioServer(deps: ServerDeps): Promise<void> {
  const server = createMemoryMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  deps.log.info("stdio transport connected");
}
