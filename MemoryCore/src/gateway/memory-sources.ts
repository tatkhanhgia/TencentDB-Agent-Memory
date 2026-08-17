/**
 * Resolve self + imported chat_memory sources for team recall.
 * ACL stays on Core (fixed-asset bindings + same-team check).
 */

export interface MemorySource {
  teamId: string;
  userId: string;
  agentId: string;
  agentName: string;
  role: "self" | "imported_from";
}

export function parseChatMemoryAssetId(assetId: string): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith("chat_memory-")) return null;
  const marker = "-agt";
  const inner = assetId.slice("chat_memory-".length);
  const dashAgt = inner.lastIndexOf(marker);
  if (dashAgt < 0) return null;
  return {
    teamId: inner.slice(0, dashAgt),
    agentId: inner.slice(dashAgt + 1),
  };
}

export interface FixedAssetLike {
  asset_id: string;
  asset_type: string;
  name?: string;
}

export interface AgentLike {
  agent_id: string;
  team_id: string;
  owner_user_id?: string;
  name?: string;
}

export function buildMemorySources(input: {
  self: { teamId: string; userId: string; agentId: string; agentName?: string };
  detail?: { agent?: AgentLike; items?: FixedAssetLike[] } | null;
  sourceAgents?: Record<string, AgentLike | null>;
}): MemorySource[] {
  const selfTeam = input.detail?.agent?.team_id || input.self.teamId;
  const selfAgent = input.detail?.agent?.agent_id || input.self.agentId;
  const self: MemorySource = {
    teamId: selfTeam,
    userId: input.detail?.agent?.owner_user_id || input.self.userId,
    agentId: selfAgent,
    agentName: input.detail?.agent?.name || input.self.agentName || selfAgent,
    role: "self",
  };
  const imported: MemorySource[] = [];
  for (const item of input.detail?.items ?? []) {
    if (item.asset_type !== "chat_memory") continue;
    const parsed = parseChatMemoryAssetId(item.asset_id);
    if (!parsed || parsed.teamId !== selfTeam || parsed.agentId === selfAgent) continue;
    const src = input.sourceAgents?.[parsed.agentId];
    if (!src || src.team_id !== selfTeam) continue;
    imported.push({
      teamId: src.team_id,
      userId: src.owner_user_id || input.self.userId,
      agentId: src.agent_id,
      agentName: src.name || item.name || src.agent_id,
      role: "imported_from",
    });
    if (imported.length >= 2) break;
  }
  return [self, ...imported];
}

/** Collect L0/L1 search hits from either Core-canonical `messages` or legacy `items`. */
export function collectSearchHits(data: { messages?: unknown; items?: unknown } | null | undefined): unknown[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.items)) return data.items;
  return [];
}
