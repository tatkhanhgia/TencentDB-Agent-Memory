import { executeMemorySearch } from "../core/tools/memory-search.js";
import { createScopedStorageAdapter } from "../core/storage/adapter.js";
import { StoragePaths } from "../core/storage/types.js";
import { buildProfileIsolationScope } from "../core/profile/profile-sync.js";
import { readSceneIndex } from "../core/scene/scene-index.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { V2AuthContext } from "./v2-schemas.js";
import { buildMemorySources, type MemorySource } from "./memory-sources.js";

function ok<T>(data: T, requestId: string) {
  return { code: 0, message: "ok", request_id: requestId, data };
}
function err(code: number, message: string, requestId: string) {
  return { code, message, request_id: requestId };
}

type Iso = { teamId?: string; userId?: string; agentId?: string };

export const memoryRecallRequestSchema = {
  parse(body: unknown): { query: string; max_items: number } {
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const query = typeof rec.query === "string" ? rec.query.trim() : "";
    if (!query || query.length > 2048) throw new Error("query must be 1–2048 characters");
    const n = typeof rec.max_items === "number" ? rec.max_items : 5;
    const max_items = Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5;
    return { query, max_items };
  },
};

async function resolveSources(
  deps: V2RouterDeps,
  auth: V2AuthContext,
  iso: Iso,
): Promise<{ sources: MemorySource[]; error?: string; forbidden?: boolean }> {
  const self = {
    teamId: iso.teamId ?? "",
    userId: iso.userId ?? "",
    agentId: iso.agentId ?? "",
  };
  const selfOnly: MemorySource[] = [{ ...self, agentName: self.agentId, role: "self" }];
  if (!self.teamId || !self.agentId || !self.userId) {
    return { sources: selfOnly };
  }
  if (!deps.getMetadataService) {
    return { sources: selfOnly };
  }
  try {
    const meta = await deps.getMetadataService(auth.serviceId);
    const detail = await meta.listAgentFixedAssetsWithDetail({
      agent_id: self.agentId,
      apply_visibility_filter: true,
    });
    if (detail.agent.agent_id !== self.agentId || detail.agent.team_id !== self.teamId) {
      return { sources: [], forbidden: true, error: "agent/team mismatch with frozen isolation" };
    }
    const sourceAgents: Record<string, Awaited<ReturnType<typeof meta.getAgentById>>> = {};
    for (const item of detail.items) {
      if (item.asset_type !== "chat_memory") continue;
      const parsed = item.asset_id.startsWith("chat_memory-")
        ? item.asset_id.slice("chat_memory-".length)
        : "";
      const marker = "-agt";
      const idx = parsed.lastIndexOf(marker);
      if (idx < 0) continue;
      const agentId = parsed.slice(idx + 1);
      if (agentId && !sourceAgents[agentId]) {
        sourceAgents[agentId] = await meta.getAgentById(agentId);
      }
    }
    return {
      sources: buildMemorySources({
        self,
        detail: {
          agent: detail.agent,
          items: detail.items,
        },
        sourceAgents,
      }),
    };
  } catch (e) {
    return {
      sources: selfOnly,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function handleMemoryRecall(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: V2RouterDeps,
) {
  let parsed: { query: string; max_items: number };
  try {
    parsed = memoryRecallRequestSchema.parse(body);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : "invalid recall request", requestId);
  }
  const iso = deps.requestIsolation;
  if (!iso?.teamId || !iso.agentId || !iso.userId) {
    return err(422, "Tenancy isolation required: team_id, agent_id, user_id", requestId);
  }

  const resolvedSources = await resolveSources(deps, auth, iso);
  if (resolvedSources.forbidden) {
    return err(403, resolvedSources.error ?? "forbidden", requestId);
  }
  const sources = resolvedSources.sources;
  const errors: Array<{ source: string; message: string }> = [];
  if (resolvedSources.error) {
    errors.push({ source: "metadata", message: resolvedSources.error });
  }
  const l1: Array<Record<string, unknown>> = [];
  const scenes: Array<Record<string, unknown>> = [];
  let persona: string | null = null;

  for (const src of sources) {
    const filter = { teamId: src.teamId, userId: src.userId, agentId: src.agentId };
    const attr = {
      source_agent_id: src.agentId,
      source_agent_name: src.agentName,
      source_agent_role: src.role,
    };

    const resolved = deps.resolveStore
      ? await deps.resolveStore(auth.serviceId)
      : { store: deps.getStore(), embedding: deps.getEmbedding() };
    try {
      const result = await executeMemorySearch({
        query: parsed.query,
        limit: parsed.max_items,
        filter,
        vectorStore: resolved.store,
        embeddingService: resolved.embedding,
        logger: deps.logger,
      });
      for (const r of result.results) {
        l1.push({
          id: r.id,
          type: r.type,
          content: r.content,
          score: r.score,
          ...attr,
        });
      }
    } catch (err) {
      errors.push({ source: `l1:${src.agentId}`, message: err instanceof Error ? err.message : String(err) });
    }

    const storage = deps.resolveStorage
      ? await deps.resolveStorage(auth.serviceId)
      : deps.getStorage();
    if (!storage) continue;
    const scoped = createScopedStorageAdapter(
      storage,
      `profiles/${encodeURIComponent(buildProfileIsolationScope({
        teamId: src.teamId,
        userId: src.userId,
        agentId: src.agentId,
      }))}/`,
    );

    try {
      const index = await readSceneIndex("", scoped);
      for (const e of index.slice(0, 50)) {
        scenes.push({ path: e.filename, summary: e.summary, ...attr });
      }
    } catch (err) {
      errors.push({ source: `scenes:${src.agentId}`, message: err instanceof Error ? err.message : String(err) });
    }

    if (src.role === "self") {
      try {
        persona = await scoped.readFile(StoragePaths.persona);
      } catch (err) {
        errors.push({ source: "persona", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  l1.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));

  return ok({
    scope: "bound",
    query: parsed.query,
    persona,
    scenes,
    l1: l1.slice(0, parsed.max_items),
    sources: sources.map((s) => ({
      agent_id: s.agentId,
      name: s.agentName,
      role: s.role,
    })),
    partial: errors.length > 0,
    errors,
  }, requestId);
}
