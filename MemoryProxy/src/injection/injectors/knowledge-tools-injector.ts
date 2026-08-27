/**
 * Knowledge Tools Injector — injects a `<knowledge_tools>` block listing
 * team knowledge resources (wiki / code-graph) with a two-step self-discovery
 * flow (tools/list → tools/call).
 *
 * v7 progressive exposure: prompt only contains resource list + discovery
 * entry points. Agent calls tools/list to discover available tools, then
 * tools/call to execute. Tool definitions live in the knowledge service,
 * not in the proxy.
 *
 * Strategy:
 *   - cacheStrategy: "session_init" — knowledge list fetched once at prewarm,
 *     reused for all turns in the session.
 *   - **Per-agent** (设计 §0.6): 读 meta agent-fixed-asset 绑定（过滤
 *     llm_wiki/code_graph）→ asset_ids(=knowledge_id) → 按 id 联查 entity_knowledge
 *     取渲染字段。绑定权威在 meta；明细缺失（未 ready）则不注入。
 *   - Fallback: 无 caller user-key / 无 agent → 退回 team 全量 list（过渡兼容）。
 *   - Failure / empty → 0 blocks (graceful degradation).
 *
 * See `docs/design/knowledge-injection-v7.md`。
 */

import type {
  AgentContext,
  AnchorTarget,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import {
  CoreKnowledgeClient,
  getCoreKnowledgeClient,
  type KnowledgeItem,
} from "../../knowledge/core-client.js";
import type { CoreSkillConfig } from "../../types.js";

const TAG = "[knowledge-tools-injector]";

export interface KnowledgeToolsInjectorConfig {
  /** Core kernel config (same endpoint as skill — 8420). */
  coreSkill: CoreSkillConfig;
}

/**
 * Render the `<knowledge_tools>` block from a list of knowledge resources.
 * Pure function for ease of testing.
 *
 * `service_url` is the tools self-discovery base (already includes the API
 * prefix, e.g. `http://host:8421/v3`). The tools endpoints are service-level
 * (`{service_url}/tools/list` | `/tools/call`); the target resource is selected
 * via the `knowledge_id` field in the body, NOT via the URL path.
 *
 * `serviceId` is the tenant identity (= `x-tdai-service-id`, unified with the
 * kernel routing key). The knowledge service REQUIRES it as a header on every
 * tools call, so we bake it into the curl examples the agent runs.
 */
function filterResourcesByCapabilities(
  resources: KnowledgeItem[],
  caps: AssetCapabilityFlags | undefined,
): KnowledgeItem[] {
  if (!caps) return resources;
  return resources.filter((r) => {
    if (r.type === "wiki") return caps.llm_wiki !== false;
    if (r.type === "code-graph") return caps.code_graph !== false;
    return true;
  });
}

export function renderKnowledgeToolsBlock(resources: KnowledgeItem[], serviceId: string): string | null {
  if (!resources || resources.length === 0) return null;

  const resourceTags = resources
    .map((r) => {
      const summaryAttr = r.summary ? `\n  summary="${r.summary}"` : "";
      const repoAttrs = r.repo_url ? `\n  repo_url="${r.repo_url}"\n  branch="${r.branch ?? "main"}"` : "";
      return `<knowledge type="${r.type}" id="${r.knowledge_id}"\n  url="${r.service_url}"\n  name="${r.name}"${summaryAttr}${repoAttrs} />`;
    })
    .join("\n\n");

  return [
    "<knowledge_tools>",
    "You have **team knowledge base resources** (listed below) to **speed up code understanding** —",
    "reference/navigation tools, not a substitute for reading source.",
    "  - code-graph: pre-built repo index (symbols / call graph / file structure), may match the local repo",
    "  - wiki: engineering design docs",
    "",
    "Use them to quickly locate symbols, call relationships, module structure, and rough implementation —",
    "treat as \"map first, then read source by the map\".",
    "",
    "## Answer directly — avoid redundant grep/browse (save tokens)",
    "- code-graph is a pre-built search index. For \"how X works / where / call graph / architecture\", answer with 1-3 calls;",
    "  **do not** start grep + Read loops or delegate exploration to sub-agents — that duplicates code-graph work.",
    "- **Trust its output** (from full parsing, not text match); do not grep to double-check. explore/node source is verbatim (same as Read) — **do not re-Read files already returned**.",
    "- Fall back to source only when: ① index is clearly stale; ② **you are about to edit code and need latest content for final confirmation**.",
    "",
    "## Which tool when (replace blind grep — not replace reading source)",
    "",
    "### code-graph",
    "  - \"implementation skeleton / trace call flow X→Y\" → explore first (returns source along the path)",
    "  - \"where is symbol defined / what is it called\" → search",
    "  - \"single symbol definition + source\" → node",
    "  - \"who calls it / what it calls\" → callers / callees",
    "  - \"blast radius before refactor\" → impact",
    "  - \"one-shot project tree overview\" → files (**only this scenario** — see rules below)",
    "  Chains: refactor = search → callers → impact; understand feature = explore (then node if needed).",
    "",
    "### wiki",
    "  - \"design/architecture/concept background\" → search (BM25), then read_page",
    "  - \"what docs exist\" → list_pages",
    "  - \"doc relationships / graph\" → get_graph",
    "  - \"original uploaded files\" → list_raw / read_raw",
    "",
    "  (Exact tool names/params come from tools/list; above is intent → tool mapping)",
    "",
    "## Bound resources",
    resourceTags,
    "",
    "## How to call (service-level endpoint — append to resource url)",
    "Target resource is knowledge_id in the body — **do not** put knowledge_id in the URL path.",
    `**Every request must include** header \`x-tdai-service-id: ${serviceId}\` (tenant id; missing = rejected).`,
    "",
    "### Step 1: list tools (once per resource on first use)",
    "curl -sSk -X POST <url>/tools/list \\",
    "  -H 'content-type: application/json' \\",
    `  -H 'x-tdai-service-id: ${serviceId}' \\`,
    "  -d '{\"knowledge_id\":\"<knowledge-id>\"}'",
    "",
    "Returns: {code, message, data:{knowledge_id, type, name, summary, status, tools:[...]}}",
    "Remember tool names/params — **reuse within the session**; don't re-list unless forgotten.",
    "",
    "### Step 2: call tool",
    "curl -sSk -X POST <url>/tools/call \\",
    "  -H 'content-type: application/json' \\",
    `  -H 'x-tdai-service-id: ${serviceId}' \\`,
    "  -d '{\"knowledge_id\":\"<knowledge-id>\", \"tool_name\":\"<name from step 1>\", \"params\":{...}}'",
    "",
    "Returns: {code, message, data}; code=0 means success.",
    "",
    "## Hard rules",
    "- tool_name must **exactly match** tools/list names — code-graph uses explore / search / node / files / status, not get_node / list_files.",
    "- code-graph **prefer explore** for overview; read source for precise/latest details when editing.",
    "- **Don't use files to find paths**: explore/search queries accept filenames (e.g. \"session-manager.ts\") — one explore step, not files then explore.",
    "- **files only for one-shot directory overview**: at most once per resource per session.",
    "- **wiki: search then read_page** — don't list_pages everything upfront.",
    "- params must be a JSON object; empty {} for no-param tools.",
    "- Pick resources by summary relevance; skip unrelated ones.",
    "- Calls to different resources may run **in parallel** in the same turn.",
    "- After 2 consecutive failures for the same tool, stop retrying; fall back to local Read if available.",
    "- Response envelope: {code, message, data}, code=0 = success.",
    "</knowledge_tools>\n",
  ].join("\n");
}

/**
 * Knowledge tools injector.
 *
 * Anchor: lands in the `knowledge` semantic slot.
 * Priority: HOOK_PRIORITY.WIKI (300).
 */
export class KnowledgeToolsInjector implements InjectionHook {
  id = "knowledge-tools-injector";
  point = "system.before_tools" as const;
  anchor: AnchorTarget = { slot: "knowledge", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.WIKI;
  description = "Inject the <knowledge_tools> block with team knowledge resources.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private config: KnowledgeToolsInjectorConfig,
    /** Optional override (tests). */
    private clientOverride?: CoreKnowledgeClient,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const ids = this.resolveSession(ctx);
    if (!ids.teamId) return [];
    return this.fetchBlocks(ids.teamId, ids.agentId, ids.userKey, ids.spaceId, ids.assetCapabilities, "execute");
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    const teamId = input.sessionInfo.team_id;
    if (!teamId) return [];
    return this.fetchBlocks(
      teamId,
      input.sessionInfo.agent_id ?? null,
      input.callerUserKey ?? null,
      input.sessionInfo.space_id ?? null,
      input.assetCapabilities,
      "prewarm",
    );
  }

  private resolveSession(ctx: AgentContext): {
    teamId: string | null;
    agentId: string | null;
    userKey: string | null;
    spaceId: string | null;
    assetCapabilities?: AssetCapabilityFlags;
  } {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    const teamId = typeof session?.team_id === "string" && session.team_id.length > 0 ? session.team_id : null;
    const agentId = typeof session?.agent_id === "string" && session.agent_id.length > 0 ? session.agent_id : null;
    const userKey = typeof custom?.userKey === "string" && custom.userKey.length > 0 ? custom.userKey : null;
    const spaceId = typeof session?.space_id === "string" && session.space_id.length > 0 ? session.space_id : null;
    const assetCapabilities = custom?.assetCapabilities as AssetCapabilityFlags | undefined;
    return { teamId, agentId, userKey, spaceId, assetCapabilities };
  }

  private async fetchBlocks(
    teamId: string,
    agentId: string | null,
    userKey: string | null,
    spaceId: string | null,
    assetCapabilities: AssetCapabilityFlags | undefined,
    phase: "prewarm" | "execute",
  ): Promise<ContextBlock[]> {
    try {
      const client = this.clientOverride ?? getCoreKnowledgeClient(this.config.coreSkill);

      console.log(`${TAG} ${phase} team=${teamId} agent=${agentId ?? "(none)"} userKey=${userKey ? "(set)" : "(none)"} space=${spaceId ?? "(none)"}`);

      // Per-agent（首选）：meta 绑定 → asset_ids → 按 id 联查明细。
      // serviceId 透传 spaceId（与 SkillInjector 一致：`/{agent}/{spaceId}/...`）。
      let resources: KnowledgeItem[];
      let scope: string;
      if (agentId && userKey) {
        const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} per-agent path: listAgentKnowledgeIds → ${ids.length} ids [${ids.join(",")}]`);
        resources = ids.length > 0 ? await client.listKnowledgeByIds(teamId, ids, { serviceId: spaceId ?? undefined }) : [];
        console.log(`${TAG} ${phase} per-agent path: listKnowledgeByIds → ${resources.length} resources`);
        scope = `agent:${agentId}`;
      } else {
        // Fallback：无 caller 身份 → team 全量。
        // 传 space_id 作 kernel 租户路由 header（与 SkillInjector 一致）。
        resources = await client.listKnowledge(teamId, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} fallback path: listKnowledge → ${resources.length} resources`);
        scope = `team:${teamId}`;
      }

      resources = filterResourcesByCapabilities(resources, assetCapabilities);
      // 注入 prompt 里给 LLM 用的 service-id 也要是 spaceId（LLM 拿它调 KS 的 tools/list|call）。
      const injectionServiceId = spaceId || this.config.coreSkill.serviceId;
      const content = renderKnowledgeToolsBlock(resources, injectionServiceId);
      if (!content) return [];
      return [{
        type: "text",
        content,
        metadata: {
          source: this.id,
          cacheKey: `knowledge-tools-injector:${scope}`,
        },
      }];
    } catch (err) {
      console.warn(`${TAG} ${phase} failed: ${(err as Error).message}`);
      return [];
    }
  }
}
