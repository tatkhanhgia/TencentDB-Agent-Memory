/** Dedupe against existing L1 atoms, then write survivors to L0 through the
 * SDK port. `capture_id` carries idempotency, so a retried hook is a no-op
 * server-side.
 *
 * Core hashes role+content+timestamp per capture_id and rejects a replay whose
 * hash differs, so everything written here must be a pure function of the
 * transcript: no wall-clock reads in message content or timestamps. */

import type { MemoryReadPort } from "../client.js";
import { normalizeAtomicSearch } from "../normalize.js";
import type { Lesson } from "./extract.js";

export const DEDUPE_THRESHOLD = 0.6;
export const DEDUPE_SEARCH_LIMIT = 5;

/** Latin word runs plus individual CJK characters, lowercased. */
export function normalizeTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? [];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function isDuplicate(
  title: string,
  existing: readonly string[],
  threshold = DEDUPE_THRESHOLD,
): boolean {
  const titleTokens = normalizeTokens(title);
  if (titleTokens.length === 0) return false;
  return existing.some((text) => jaccard(titleTokens, normalizeTokens(text)) >= threshold);
}

export function buildSessionId(sessionId: string): string {
  return `reflect:${sessionId}`;
}

/**
 * A slot index into the filtered lesson list, not a content hash: slot N of a
 * re-run may hold a different lesson than slot N of the first run, because the
 * model is free to return something else. That is tolerable only because a
 * conflicting replay is absorbed as "already captured" (see isConflictError)
 * rather than overwriting or failing — the first write of a slot wins.
 */
export function buildCaptureId(sessionId: string, index: number): string {
  return `reflect-${sessionId}-${index}`;
}

/** Footer date comes from the transcript, never the clock; omitted if absent. */
export function buildBody(lesson: Lesson, ctx: SourceContext): string {
  const source = ctx.isoDate
    ? `session ${ctx.sessionId}, ${ctx.isoDate}, host=${ctx.format}`
    : `session ${ctx.sessionId}, host=${ctx.format}`;
  return `${lesson.body}\n\n(source: ${source})`;
}

export interface SourceContext {
  sessionId: string;
  /** Transcript-derived date. Omitted when the transcript carried no timestamp. */
  isoDate?: string;
  format: string;
}

export class MemoryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

const CONFLICT_MESSAGE = /\b409\d{0,2}\b|conflict|already captured|already exists/i;

function numericField(rec: Record<string, unknown>, key: string): number | undefined {
  const value = rec[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Core answers a replayed capture_id whose payload hash differs with a 409.
 * For reflection that means "this slot is already captured" — the first write
 * wins and the retry is a no-op, not a failure.
 *
 * The SDK raises TDAMError with `code` set to the HTTP status (409) or to a
 * 409xx business code; other transports may use `status` / `statusCode`.
 * Message matching is the last resort.
 */
export function isConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const response = rec.response && typeof rec.response === "object"
    ? (rec.response as Record<string, unknown>)
    : undefined;
  const codes = [
    numericField(rec, "code"),
    numericField(rec, "status"),
    numericField(rec, "statusCode"),
    response ? numericField(response, "status") : undefined,
  ];
  for (const code of codes) {
    if (code === undefined) continue;
    if (code === 409 || (code >= 40_900 && code <= 40_999)) return true;
  }
  const message = typeof rec.message === "string" ? rec.message : "";
  return CONFLICT_MESSAGE.test(message);
}

export interface WriteOptions extends SourceContext {
  memory: MemoryReadPort;
  /** Applied to both messages when the transcript carried a timestamp. */
  timestamp?: string;
  threshold?: number;
  warn?: (message: string) => void;
}

export interface WriteResult {
  written: Lesson[];
  /** Skipped before the write (L1 near-match) or absorbed as an already-captured replay. */
  duplicates: Lesson[];
}

/** Core reports an accepted replay of a known capture_id as `duplicate: true`. */
function isDuplicateResponse(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { duplicate?: unknown }).duplicate === true);
}

async function existingTextsFor(
  memory: MemoryReadPort,
  query: string,
  warn: (message: string) => void,
): Promise<string[]> {
  try {
    const data = await memory.searchAtomic({ query, limit: DEDUPE_SEARCH_LIMIT });
    return normalizeAtomicSearch(data).map((hit) => hit.content);
  } catch (err) {
    // Dedupe is best effort: a search outage must not block the write.
    const message = err instanceof Error ? err.message : String(err);
    warn(`dedupe search failed, writing anyway: ${message}`);
    return [];
  }
}

export async function writeLessons(
  lessons: readonly Lesson[],
  options: WriteOptions,
): Promise<WriteResult> {
  const { memory } = options;
  const warn = options.warn ?? (() => {});
  const written: Lesson[] = [];
  const duplicates: Lesson[] = [];

  for (const [index, lesson] of lessons.entries()) {
    const existing = await existingTextsFor(memory, lesson.title, warn);
    if (isDuplicate(lesson.title, existing, options.threshold)) {
      duplicates.push(lesson);
      continue;
    }

    const add = memory.addConversation;
    if (!add) {
      throw new MemoryWriteError("memory port does not support addConversation");
    }
    const messages = [
      { role: "user" as const, content: `[reflect:${lesson.kind}] ${lesson.title}` },
      { role: "assistant" as const, content: buildBody(lesson, options) },
    ].map((message) =>
      options.timestamp ? { ...message, timestamp: options.timestamp } : message,
    );

    let response: unknown;
    try {
      response = await add.call(memory, {
        session_id: buildSessionId(options.sessionId),
        capture_id: buildCaptureId(options.sessionId, index),
        messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isConflictError(err)) {
        // Idempotent retry of a hook that already ran: keep going.
        warn(`lesson "${lesson.title}" was already captured, skipping: ${message}`);
        duplicates.push(lesson);
        continue;
      }
      throw new MemoryWriteError(`failed to write lesson "${lesson.title}": ${message}`);
    }

    if (isDuplicateResponse(response)) {
      // Core recognised the replayed capture_id and stored nothing new.
      duplicates.push(lesson);
      continue;
    }
    written.push(lesson);
  }

  return { written, duplicates };
}
