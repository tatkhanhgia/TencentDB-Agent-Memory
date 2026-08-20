export const TOOL_NAMES = [
  "tdai_memory_context",
  "tdai_memory_search",
  "tdai_conversation_search",
  "tdai_scene_read",
] as const;

export const OPTIONAL_TOOL_NAMES = [
  "tdai_memory_capture",
  "tdai_skill_search",
  "tdai_skill_get",
] as const;

export const IDENTITY_TOOL_NAMES = [
  "tdai_identity_list",
  "tdai_identity_use",
] as const;

export type ToolName =
  | (typeof TOOL_NAMES)[number]
  | (typeof OPTIONAL_TOOL_NAMES)[number]
  | (typeof IDENTITY_TOOL_NAMES)[number];

export interface ToolDef {
  name: ToolName;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
  };
}

const QUERY_PROP = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  description: "Search / recall query (1–2048 characters).",
};

const LIMIT_PROP = {
  type: "integer",
  minimum: 1,
  maximum: 10,
  description: "Max hits to return (1–10, default 5).",
};

export const TOOLS: ToolDef[] = [
  {
    name: "tdai_memory_context",
    description:
      "One-shot self-scope recall: L3 persona summary, bounded L2 scene index, and top L1 atomic matches. Use first when the user asks about identity, preferences, past decisions, or project conventions. Returns partial=true if one source fails.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: QUERY_PROP,
        max_items: LIMIT_PROP,
        max_chars: {
          type: "integer",
          minimum: 256,
          maximum: 100000,
          description: "Soft character budget for the bundled text (default ~12KB).",
        },
      },
    },
  },
  {
    name: "tdai_memory_search",
    description: "Targeted L1 atomic memory search within the frozen self scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: QUERY_PROP,
        limit: LIMIT_PROP,
        type: {
          type: "string",
          description: "Optional memory type filter (e.g. preference, decision).",
        },
        time_start: { type: "string", description: "Optional ISO start time." },
        time_end: { type: "string", description: "Optional ISO end time." },
      },
    },
  },
  {
    name: "tdai_conversation_search",
    description:
      "Targeted L0 conversation search across sessions in the frozen self scope. Canonical Core field is data.messages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: QUERY_PROP,
        limit: LIMIT_PROP,
        time_start: { type: "string", description: "Optional ISO start time." },
        time_end: { type: "string", description: "Optional ISO end time." },
      },
    },
  },
  {
    name: "tdai_scene_read",
    description:
      "Read one L2 scene file by path returned from tdai_memory_context. Relative scene paths only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Relative scene path (e.g. auth.md). A scene_blocks/ prefix, as shown in the persona scene index, is accepted and stripped.",
        },
        max_chars: {
          type: "integer",
          minimum: 256,
          maximum: 100000,
          description: "Character budget for file content.",
        },
      },
    },
  },
];

export const CAPTURE_TOOL: ToolDef = {
  name: "tdai_memory_capture",
  description:
    "Opt-in write: persist one incremental turn (one user + one assistant message) to L0. Requires capture_id for idempotency and conversation_ref for session partitioning. Does not auto-capture.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["capture_id", "user", "assistant"],
    properties: {
      capture_id: {
        type: "string",
        description: "Caller-generated idempotency key unique within this conversation.",
      },
      conversation_ref: {
        type: "string",
        description: "Opaque host conversation id. Namespaced under the frozen MCP identity.",
      },
      user: { type: "string", description: "User turn text (incremental, not full transcript)." },
      assistant: { type: "string", description: "Assistant turn text for this same turn." },
      user_timestamp: { type: "string", description: "Optional ISO timestamp for the user message." },
      assistant_timestamp: { type: "string", description: "Optional ISO timestamp for the assistant message." },
    },
  },
};

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: "tdai_skill_search",
    description: "Search team Skills (read-only) in the frozen identity scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: QUERY_PROP,
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "tdai_skill_get",
    description: "Read one Skill by id (read-only).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["skill_id"],
      properties: {
        skill_id: { type: "string", description: "Skill id returned by tdai_skill_search." },
      },
    },
  },
];

export const IDENTITY_TOOLS: ToolDef[] = [
  {
    name: "tdai_identity_list",
    description:
      "List the memory identities this MCP session may act as, and which one is active. Only present when the session token maps to multiple identities.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  },
  {
    name: "tdai_identity_use",
    description:
      "Bind this session to one memory identity by name (from tdai_identity_list). All memory tools then read that identity's store. If unsure which identity the user wants, ask them before choosing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Identity name exactly as returned by tdai_identity_list.",
        },
      },
    },
  },
];

export function listToolDescriptors(
  opts: { captureEnabled?: boolean; skillsEnabled?: boolean; identityEnabled?: boolean } = {},
) {
  const extra: ToolDef[] = [];
  if (opts.captureEnabled) extra.push(CAPTURE_TOOL);
  if (opts.skillsEnabled) extra.push(...SKILL_TOOLS);
  if (opts.identityEnabled) extra.push(...IDENTITY_TOOLS);
  return [...TOOLS, ...extra].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
