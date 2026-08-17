import type { IdentityConfig } from "./config.js";

export interface PrincipalBinding {
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
}

/** token -> binding. Core API key is never stored here. */
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
    const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const teamId = String(rec.teamId ?? rec.team_id ?? "").trim();
    const agentId = String(rec.agentId ?? rec.agent_id ?? "").trim();
    const userId = String(rec.userId ?? rec.user_id ?? "").trim();
    const taskId = String(rec.taskId ?? rec.task_id ?? "").trim() || undefined;
    if (!teamId || !agentId || !userId) {
      throw new Error(`TDAI_MCP_BINDINGS[${token}] missing teamId/agentId/userId`);
    }
    map.set(token, { teamId, agentId, userId, taskId });
  }
  return map;
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)/i);
  return m?.[1] ?? null;
}

export function configForBinding(base: IdentityConfig, binding: PrincipalBinding): IdentityConfig {
  return {
    ...base,
    teamId: binding.teamId,
    agentId: binding.agentId,
    userId: binding.userId,
    taskId: binding.taskId,
  };
}
