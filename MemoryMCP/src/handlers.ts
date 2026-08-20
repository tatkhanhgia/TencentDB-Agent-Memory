import type { IdentityConfig } from "./config.js";
import type { MemoryReadPort } from "./client.js";
import {
  parseMaxChars,
  parseMaxItems,
  parseOptionalTime,
  parseOptionalType,
  parseQuery,
  parseSkillEncoding,
  parseSkillScope,
  parseSkillVersion,
  truncateText,
} from "./limits.js";
import {
  normalizeAtomicSearch,
  normalizeConversationSearch,
  normalizeCore,
  normalizeSceneFile,
  normalizeSceneList,
} from "./normalize.js";
import { validateScenePath, validateSkillResourcePath } from "./paths.js";
import { stripTdaiWrappers, validateCaptureId, validateConversationRef } from "./sanitize.js";
import { namespaceConversationRef } from "./session-key.js";
import { OPTIONAL_TOOL_NAMES, TOOL_NAMES, type ToolName } from "./tools.js";

export interface ToolResult {
  structured: Record<string, unknown>;
  text: string;
  isError: boolean;
}

export interface HandlerContext {
  config: IdentityConfig;
  memory: MemoryReadPort;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorResult(code: string, message: string): ToolResult {
  const structured = { error: code, message };
  return { structured, text: jsonText(structured), isError: true };
}

async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleTdaiMemoryContext(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const query = parseQuery(args.query);
  const maxItems = parseMaxItems(args.max_items);
  const maxChars = parseMaxChars(args.max_chars, ctx.config.maxChars);

  if (ctx.memory.recallBundle) {
    try {
      const raw = await ctx.memory.recallBundle({ query, max_items: maxItems });
      const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const structured = {
        scope: rec.scope === "bound" ? "bound" : "self",
        query,
        persona: typeof rec.persona === "string" ? rec.persona : null,
        scenes: Array.isArray(rec.scenes) ? rec.scenes : [],
        l1: Array.isArray(rec.l1) ? rec.l1 : [],
        sources: rec.sources,
        partial: rec.partial === true,
        errors: Array.isArray(rec.errors) ? rec.errors : [],
        truncated: false,
        max_chars: maxChars,
      };
      const cut = truncateText(jsonText(structured), maxChars);
      if (cut.truncated) structured.truncated = true;
      return { structured, text: cut.text, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Continue with self-scope but surface that bound recall failed.
      const [coreR, scenesR, l1R] = await Promise.all([
        settled(ctx.memory.readCore()),
        settled(ctx.memory.listScenarios()),
        settled(ctx.memory.searchAtomic({ query, limit: maxItems })),
      ]);
      const errors: Array<{ source: string; message: string }> = [
        { source: "recallBundle", message },
      ];
      const persona = coreR.ok ? normalizeCore(coreR.value).content : null;
      if (!coreR.ok) errors.push({ source: "persona", message: coreR.error });
      const scenes = scenesR.ok ? normalizeSceneList(scenesR.value) : [];
      if (!scenesR.ok) errors.push({ source: "scenes", message: scenesR.error });
      const l1 = l1R.ok ? normalizeAtomicSearch(l1R.value).slice(0, maxItems) : [];
      if (!l1R.ok) errors.push({ source: "l1", message: l1R.error });
      const structured = {
        scope: "self" as const,
        query,
        persona,
        scenes,
        l1,
        partial: true,
        errors,
        truncated: false,
        max_chars: maxChars,
      };
      return { structured, text: jsonText(structured), isError: false };
    }
  }

  const [coreR, scenesR, l1R] = await Promise.all([
    settled(ctx.memory.readCore()),
    settled(ctx.memory.listScenarios()),
    settled(ctx.memory.searchAtomic({ query, limit: maxItems })),
  ]);

  const errors: Array<{ source: string; message: string }> = [];
  let persona: string | null = null;
  let scenes: ReturnType<typeof normalizeSceneList> = [];
  let l1: ReturnType<typeof normalizeAtomicSearch> = [];

  if (coreR.ok) {
    persona = normalizeCore(coreR.value).content;
  } else {
    errors.push({ source: "persona", message: coreR.error });
  }

  if (scenesR.ok) {
    scenes = normalizeSceneList(scenesR.value).slice(0, 50);
  } else {
    errors.push({ source: "scenes", message: scenesR.error });
  }

  if (l1R.ok) {
    l1 = normalizeAtomicSearch(l1R.value).slice(0, maxItems);
  } else {
    errors.push({ source: "l1", message: l1R.error });
  }

  const partial = errors.length > 0;
  let remaining = maxChars;
  let truncated = false;

  const personaCut = persona ? truncateText(persona, remaining) : { text: "", truncated: false };
  if (persona) {
    remaining = Math.max(0, remaining - personaCut.text.length);
    truncated = truncated || personaCut.truncated;
  }

  const scenePayload = scenes.map((s) => ({
    path: s.path,
    summary: s.summary ? truncateText(s.summary, 240).text : undefined,
  }));
  const scenesJson = jsonText(scenePayload);
  const scenesCut = truncateText(scenesJson, remaining);
  remaining = Math.max(0, remaining - scenesCut.text.length);
  truncated = truncated || scenesCut.truncated;

  const l1Limited = l1.map((item) => {
    const cut = truncateText(item.content, Math.min(2000, remaining || 2000));
    remaining = Math.max(0, remaining - cut.text.length);
    truncated = truncated || cut.truncated;
    return { ...item, content: cut.text };
  });

  const structured = {
    scope: "self" as const,
    query,
    persona: persona ? personaCut.text : null,
    scenes: scenePayload,
    l1: l1Limited,
    partial,
    errors,
    truncated,
    max_chars: maxChars,
  };

  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiMemorySearch(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const query = parseQuery(args.query);
  const limit = parseMaxItems(args.limit);
  const type = parseOptionalType(args.type);
  const time_start = parseOptionalTime(args.time_start, "time_start");
  const time_end = parseOptionalTime(args.time_end, "time_end");
  const raw = await ctx.memory.searchAtomic({ query, limit, type, time_start, time_end });
  const items = normalizeAtomicSearch(raw).slice(0, limit);
  const structured = { scope: "self" as const, query, items };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiConversationSearch(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const query = parseQuery(args.query);
  const limit = parseMaxItems(args.limit);
  const time_start = parseOptionalTime(args.time_start, "time_start");
  const time_end = parseOptionalTime(args.time_end, "time_end");
  const raw = await ctx.memory.searchConversation({ query, limit, time_start, time_end });
  const normalized = normalizeConversationSearch(raw);
  const messages = normalized.messages.slice(0, limit);
  const structured = {
    scope: "self" as const,
    query,
    messages,
    source: normalized.source,
    drift: normalized.drift,
  };
  return { structured, text: jsonText(structured), isError: false };
}

const MAX_TURN_CHARS = 8000;

export async function handleTdaiMemoryCapture(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  if (!ctx.config.captureEnabled) {
    return errorResult("capture_disabled", "tdai_memory_capture is disabled (set TDAI_ENABLE_CAPTURE=true)");
  }
  if (!ctx.memory.addConversation) {
    return errorResult("capture_unavailable", "memory port does not implement addConversation");
  }
  const captureId = validateCaptureId(args.capture_id);
  const refRaw = args.conversation_ref ?? ctx.config.conversationRef;
  const ref = validateConversationRef(refRaw);
  if (typeof args.user !== "string" || typeof args.assistant !== "string") {
    return errorResult("invalid_turn", "user and assistant must be strings");
  }
  const user = stripTdaiWrappers(args.user);
  const assistant = stripTdaiWrappers(args.assistant);
  if (!user || !assistant) {
    return errorResult("invalid_turn", "user and assistant must be non-empty after sanitization");
  }
  if (user.length > MAX_TURN_CHARS || assistant.length > MAX_TURN_CHARS) {
    return errorResult("turn_too_large", `each message must be ≤ ${MAX_TURN_CHARS} characters`);
  }
  const sessionId = namespaceConversationRef(ctx.config, ref);
  const raw = await ctx.memory.addConversation({
    session_id: sessionId,
    capture_id: captureId,
    messages: [
      {
        role: "user",
        content: user,
        timestamp: typeof args.user_timestamp === "string" ? args.user_timestamp : undefined,
      },
      {
        role: "assistant",
        content: assistant,
        timestamp: typeof args.assistant_timestamp === "string" ? args.assistant_timestamp : undefined,
      },
    ],
  });
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const structured = {
    scope: "self" as const,
    capture_id: typeof rec.capture_id === "string" ? rec.capture_id : captureId,
    session_hash: sessionId,
    accepted_count: typeof rec.total_count === "number" ? rec.total_count : Array.isArray(rec.accepted_ids) ? rec.accepted_ids.length : 2,
    duplicate: rec.duplicate === true,
    request_id: typeof rec.trace_id === "string" ? rec.trace_id : undefined,
  };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiSkillSearch(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  if (!ctx.config.skillsEnabled || !ctx.memory.searchSkills) {
    return errorResult("skills_disabled", "tdai_skill_search is disabled (set TDAI_ENABLE_SKILLS=true)");
  }
  const query = parseQuery(args.query);
  const limit = parseMaxItems(args.limit);
  const skillScope = parseSkillScope(args.scope);
  const raw = await ctx.memory.searchSkills({
    query,
    limit,
    // Only "team" travels — "agent" is the gateway default and sending it
    // would fail the enum on the wire.
    scope: skillScope === "team" ? "team" : undefined,
  });
  const structured = { scope: "self" as const, skill_scope: skillScope, query, result: raw };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiSkillGet(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  if (!ctx.config.skillsEnabled || !ctx.memory.getSkill) {
    return errorResult("skills_disabled", "tdai_skill_get is disabled (set TDAI_ENABLE_SKILLS=true)");
  }
  if (typeof args.skill_id !== "string" || !args.skill_id.trim()) {
    return errorResult("invalid_skill", "skill_id is required");
  }
  const raw = await ctx.memory.getSkill({
    skill_id: args.skill_id.trim(),
    version: parseSkillVersion(args.version),
  });
  const structured = { scope: "self" as const, result: raw };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiSkillFileRead(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  if (!ctx.config.skillsEnabled || !ctx.memory.readSkillFile) {
    return errorResult(
      "skills_disabled",
      "tdai_skill_file_read is disabled (set TDAI_ENABLE_SKILLS=true)",
    );
  }
  if (typeof args.skill_id !== "string" || !args.skill_id.trim()) {
    return errorResult("invalid_skill", "skill_id is required");
  }
  const path = validateSkillResourcePath(args.path);
  const encoding = parseSkillEncoding(args.encoding);
  const maxChars = parseMaxChars(args.max_chars, ctx.config.maxChars);
  const raw = await ctx.memory.readSkillFile({
    skill_id: args.skill_id.trim(),
    path,
    version: parseSkillVersion(args.version),
    encoding,
  });
  const file = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const content = typeof file.content === "string" ? file.content : "";
  const cut = truncateText(content, maxChars);
  const structured = {
    scope: "self" as const,
    skill_id: args.skill_id.trim(),
    path: typeof file.path === "string" ? file.path : path,
    version: typeof file.version === "number" ? file.version : undefined,
    encoding: typeof file.encoding === "string" ? file.encoding : encoding ?? "utf-8",
    size_bytes: typeof file.size_bytes === "number" ? file.size_bytes : undefined,
    mime_type: typeof file.mime_type === "string" ? file.mime_type : undefined,
    content: cut.text,
    truncated: cut.truncated,
  };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleTdaiSceneRead(
  args: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const path = validateScenePath(args.path);
  const maxChars = parseMaxChars(args.max_chars, ctx.config.maxChars);
  const raw = await ctx.memory.readScenario(path);
  const file = normalizeSceneFile(raw);
  const content = file.content ?? "";
  const cut = truncateText(content, maxChars);
  const structured = {
    scope: "self" as const,
    path: file.path ?? path,
    content: file.content === null ? null : cut.text,
    truncated: file.content === null ? false : cut.truncated,
    exists: file.content !== null,
  };
  return { structured, text: jsonText(structured), isError: false };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: HandlerContext,
): Promise<ToolResult> {
  const body = args ?? {};
  const known = new Set<string>([...TOOL_NAMES, ...OPTIONAL_TOOL_NAMES]);
  if (!known.has(name)) {
    return errorResult("unknown_tool", `Unknown tool: ${name}`);
  }
  try {
    switch (name as ToolName) {
      case "tdai_memory_context":
        return await handleTdaiMemoryContext(body, ctx);
      case "tdai_memory_search":
        return await handleTdaiMemorySearch(body, ctx);
      case "tdai_conversation_search":
        return await handleTdaiConversationSearch(body, ctx);
      case "tdai_scene_read":
        return await handleTdaiSceneRead(body, ctx);
      case "tdai_memory_capture":
        return await handleTdaiMemoryCapture(body, ctx);
      case "tdai_skill_search":
        return await handleTdaiSkillSearch(body, ctx);
      case "tdai_skill_get":
        return await handleTdaiSkillGet(body, ctx);
      case "tdai_skill_file_read":
        return await handleTdaiSkillFileRead(body, ctx);
      default:
        // Identity tools are session-scoped and handled in server.ts.
        return errorResult("unknown_tool", `Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult("tool_error", message);
  }
}
