import type { IdentityConfig } from "./config.js";

/** One selectable identity inside a binding. */
export interface NamedIdentity {
  /** Stable selector shown to the user (e.g. "coder", "project-x"). */
  name: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  /** Optional human hint rendered next to the name in pickers. */
  description?: string;
}

/**
 * token -> binding. A binding is a set of identities the token may act as.
 * Legacy single-identity bindings parse into a one-element set that binds
 * automatically. Core API key is never stored here.
 */
export interface PrincipalBinding {
  identities: NamedIdentity[];
  /** When set, sessions bind to this identity without asking. */
  defaultName?: string;
}

function parseIdentity(raw: Record<string, unknown>, label: string, fallbackName?: string): NamedIdentity {
  const teamId = String(raw.teamId ?? raw.team_id ?? "").trim();
  const agentId = String(raw.agentId ?? raw.agent_id ?? "").trim();
  const userId = String(raw.userId ?? raw.user_id ?? "").trim();
  const taskId = String(raw.taskId ?? raw.task_id ?? "").trim() || undefined;
  const name = String(raw.name ?? "").trim() || fallbackName || agentId;
  const description = String(raw.description ?? "").trim() || undefined;
  if (!teamId || !agentId || !userId) {
    throw new Error(`TDAI_MCP_BINDINGS[${label}] missing teamId/agentId/userId`);
  }
  if (!name) {
    throw new Error(`TDAI_MCP_BINDINGS[${label}] identity missing name`);
  }
  return { name, teamId, agentId, userId, taskId, description };
}

/** token -> binding. Accepts both the legacy single-identity shape and the multi-identity shape. */
export function parseBindingsJson(raw: string | undefined): Map<string, PrincipalBinding> {
  const map = new Map<string, PrincipalBinding>();
  if (!raw || !raw.trim()) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TDAI_MCP_BINDINGS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TDAI_MCP_BINDINGS must be a JSON object of token → binding");
  }
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!token.trim()) continue;
    // Underscore-prefixed keys are comments (e.g. "_comment" in .mcp.bindings.json).
    if (token.startsWith("_")) continue;
    const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

    if (Array.isArray(rec.identities)) {
      const identities: NamedIdentity[] = [];
      const seen = new Set<string>();
      rec.identities.forEach((entry, i) => {
        const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const id = parseIdentity(item, `${token}].identities[${i}`);
        if (seen.has(id.name)) {
          throw new Error(`TDAI_MCP_BINDINGS[${token}] duplicate identity name "${id.name}"`);
        }
        seen.add(id.name);
        identities.push(id);
      });
      if (identities.length === 0) {
        throw new Error(`TDAI_MCP_BINDINGS[${token}] identities must be non-empty`);
      }
      const defaultName = String(rec.default ?? rec.defaultName ?? "").trim() || undefined;
      if (defaultName && !seen.has(defaultName)) {
        throw new Error(`TDAI_MCP_BINDINGS[${token}] default "${defaultName}" not in identities`);
      }
      map.set(token, { identities, defaultName });
      continue;
    }

    // Legacy shape: the record itself is one identity; binds automatically.
    const identity = parseIdentity(rec, token);
    map.set(token, { identities: [identity], defaultName: identity.name });
  }
  return map;
}

/**
 * Identity a session starts with: the sole identity, or the declared default.
 * Returns null when the user (or a fallback tool call) must choose.
 */
export function resolveInitialIdentity(binding: PrincipalBinding): NamedIdentity | null {
  if (binding.identities.length === 1) return binding.identities[0];
  if (binding.defaultName) {
    return binding.identities.find((i) => i.name === binding.defaultName) ?? null;
  }
  return null;
}

export function findIdentity(binding: PrincipalBinding, name: string): NamedIdentity | null {
  return binding.identities.find((i) => i.name === name) ?? null;
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)/i);
  return m?.[1] ?? null;
}

export function configForIdentity(base: IdentityConfig, identity: NamedIdentity): IdentityConfig {
  return {
    ...base,
    teamId: identity.teamId,
    agentId: identity.agentId,
    userId: identity.userId,
    taskId: identity.taskId,
  };
}
