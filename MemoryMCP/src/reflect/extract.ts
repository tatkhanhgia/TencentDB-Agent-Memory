/** Lesson extraction: prompt building, one OpenAI-compatible chat call,
 * defensive response parsing. The chat call is injected so tests never touch
 * the network. */

import { ConfigError } from "../config.js";
import { renderTurns, truncateTurns, type Turn } from "./transcript.js";

export type LessonKind = "adr" | "constraint" | "preference";

export const LESSON_KINDS: readonly LessonKind[] = ["adr", "constraint", "preference"];

export interface Lesson {
  title: string;
  body: string;
  kind: LessonKind;
  confidence: number;
}

export const MIN_CONFIDENCE = 0.6;
export const DEFAULT_MAX_LESSONS = 3;
export const MAX_LESSONS_CAP = 5;

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Returns the assistant message content. Throws LlmError on failure. */
export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

export interface LlmErrorInfo {
  /** HTTP status, when the provider answered with one. */
  status?: number;
  /** First ~200 chars of the response body, for debugging 4xx replies. */
  bodySnippet?: string;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly bodySnippet?: string;

  constructor(message: string, info: LlmErrorInfo = {}) {
    super(message);
    this.name = "LlmError";
    this.status = info.status;
    this.bodySnippet = info.bodySnippet;
  }
}

const BODY_SNIPPET_MAX = 200;

/** Collapse whitespace and clip, so a provider error fits on one log line. */
export function bodySnippet(text: string, max = BODY_SNIPPET_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

export const SYSTEM_PROMPT = [
  "You review a finished coding-agent session and decide whether it produced any",
  "durable lesson worth writing to long-term team memory.",
  "",
  "Record ONLY:",
  "- architecture or design decisions (ADRs) together with their rationale;",
  "- changes that alter system behaviour, interfaces, or contracts;",
  "- durable project constraints (invariants, policies, hard requirements);",
  "- durable user preferences about how work should be done.",
  "",
  "Do NOT record:",
  "- task narration, progress reports, or what was worked on;",
  "- transient bugs that were fixed, or one-off commands and their output;",
  "- anything already obvious from reading the code or the git history;",
  "- speculation, plans that were not decided, or restatements of the request.",
  "",
  "An empty list is the expected answer for most sessions. Prefer writing nothing",
  "over writing something marginal.",
  "",
  "Reply with JSON only, in exactly this shape:",
  '{"lessons":[{"title":"...","body":"...","kind":"adr|constraint|preference","confidence":0.0}]}',
  "",
  "Rules for each lesson: `title` is one short declarative sentence; `body` states",
  "the decision plus its rationale in at most 5 sentences and is understandable",
  "without the session; `kind` is one of adr, constraint, preference; `confidence`",
  "is a number between 0 and 1 expressing how durable and worth remembering it is.",
].join("\n");

export function buildMessages(turns: readonly Turn[], maxLessons: number): ChatMessage[] {
  const view = truncateTurns(turns);
  const user = [
    `Session transcript (${view.turns.length} turn(s)${view.truncated ? ", middle omitted" : ""}):`,
    "",
    "<transcript>",
    renderTurns(view),
    "</transcript>",
    "",
    `Return at most ${maxLessons} lesson(s). Return {"lessons":[]} if nothing durable was decided.`,
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * Models wrap JSON in prose or markdown fences even when asked not to.
 * Strip fences, then take the outermost brace-delimited span.
 */
export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toLesson(raw: unknown): Lesson | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  const body = typeof rec.body === "string" ? rec.body.trim() : "";
  const kind = rec.kind;
  if (!title || !body) return null;
  if (typeof kind !== "string" || !(LESSON_KINDS as readonly string[]).includes(kind)) return null;
  const confidence = typeof rec.confidence === "number" && Number.isFinite(rec.confidence)
    ? Math.min(1, Math.max(0, rec.confidence))
    : 0;
  return { title, body, kind: kind as LessonKind, confidence };
}

export interface ParsedLessons {
  lessons: Lesson[];
  /** Set when the response could not be understood; caller logs it and treats
   * the result as "no lessons". */
  warning?: string;
}

export function parseLessonsResponse(raw: string): ParsedLessons {
  const json = extractJsonObject(raw ?? "");
  if (!json) return { lessons: [], warning: "no JSON object in LLM response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { lessons: [], warning: "LLM response was not valid JSON" };
  }
  const rec = asRecord(parsed);
  if (!rec) return { lessons: [], warning: "LLM response was not a JSON object" };
  if (!Array.isArray(rec.lessons)) {
    return { lessons: [], warning: "LLM response had no lessons array" };
  }
  const lessons: Lesson[] = [];
  let dropped = 0;
  for (const item of rec.lessons) {
    const lesson = toLesson(item);
    if (lesson) lessons.push(lesson);
    else dropped += 1;
  }
  const out: ParsedLessons = { lessons };
  if (dropped > 0) out.warning = `dropped ${dropped} malformed lesson(s)`;
  return out;
}

export function filterLessons(
  lessons: readonly Lesson[],
  maxLessons: number,
  minConfidence = MIN_CONFIDENCE,
): Lesson[] {
  return lessons.filter((l) => l.confidence >= minConfidence).slice(0, Math.max(0, maxLessons));
}

export interface ReflectLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const LLM_ENV = {
  baseUrl: "TDAI_REFLECT_LLM_BASE_URL",
  apiKey: "TDAI_REFLECT_LLM_API_KEY",
  model: "TDAI_REFLECT_LLM_MODEL",
} as const;

function requireLlmEnv(env: NodeJS.Dict<string>, name: string): string {
  const raw = env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new ConfigError(name, `missing required environment variable ${name}`);
  return value;
}

/** Fail-closed LLM config: no silent default endpoint or model. */
export function loadLlmConfigFromEnv(env: NodeJS.Dict<string> = process.env): ReflectLlmConfig {
  const baseUrl = requireLlmEnv(env, LLM_ENV.baseUrl);
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new ConfigError(LLM_ENV.baseUrl, `${LLM_ENV.baseUrl} must be a valid HTTP(S) URL`);
  }
  const rawTimeout = env.TDAI_REFLECT_TIMEOUT_MS;
  let timeoutMs = 60_000;
  if (rawTimeout !== undefined && rawTimeout.trim() !== "") {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConfigError("TDAI_REFLECT_TIMEOUT_MS", "TDAI_REFLECT_TIMEOUT_MS must be a positive number");
    }
    timeoutMs = Math.floor(n);
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: requireLlmEnv(env, LLM_ENV.apiKey),
    model: requireLlmEnv(env, LLM_ENV.model),
    timeoutMs,
  };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ChatDeps {
  fetchImpl?: FetchLike;
  /** Diagnostics sink; the caller routes this to stderr. */
  warn?: (message: string) => void;
}

/**
 * `response_format: {type:"json_object"}` is an OpenAI extension that not every
 * OpenAI-compatible server implements: LM Studio answers HTTP 400
 * ("response_format.type must be json_schema or text"). Ask for it first,
 * because it makes compliant providers reliable, then retry once without it and
 * lean on the defensive parser. Anything other than a 400 is not retried.
 */
export function createOpenAiChatFn(cfg: ReflectLlmConfig, deps: ChatDeps = {}): ChatFn {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const warn = deps.warn ?? (() => {});
  const url = `${cfg.baseUrl}/chat/completions`;

  const attempt = async (messages: ChatMessage[], withResponseFormat: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      temperature: 0,
      messages,
    };
    if (withResponseFormat) body.response_format = { type: "json_object" };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LlmError(`chat completion request failed: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const snippet = bodySnippet(text);
      throw new LlmError(
        `chat completion returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        { status: response.status, bodySnippet: snippet },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError("chat completion response was not JSON");
    }
    const choices = asRecord(payload)?.choices;
    const first = Array.isArray(choices) ? asRecord(choices[0]) : null;
    const content = asRecord(first?.message)?.content;
    if (typeof content !== "string") {
      throw new LlmError("chat completion response had no message content");
    }
    return content;
  };

  return async (messages) => {
    try {
      return await attempt(messages, true);
    } catch (err) {
      if (!(err instanceof LlmError) || err.status !== 400) throw err;
      warn(
        `provider rejected response_format=json_object (HTTP 400), retrying once without it: ${err.bodySnippet ?? ""}`.trimEnd(),
      );
      return attempt(messages, false);
    }
  };
}

export interface ExtractResult {
  lessons: Lesson[];
  warnings: string[];
}

/** One LLM round trip, then defensive parsing plus the confidence/count filters. */
export async function extractLessons(
  turns: readonly Turn[],
  maxLessons: number,
  chat: ChatFn,
): Promise<ExtractResult> {
  const raw = await chat(buildMessages(turns, maxLessons));
  const parsed = parseLessonsResponse(raw);
  const warnings = parsed.warning ? [parsed.warning] : [];
  return { lessons: filterLessons(parsed.lessons, maxLessons), warnings };
}
