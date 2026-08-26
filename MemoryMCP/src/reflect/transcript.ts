/** Session transcript parsing for tdai-reflect. Tolerant by design: an unknown
 * line shape is skipped, never fatal. */

export type TranscriptFormat = "claude-code" | "generic-jsonl";

export const TRANSCRIPT_FORMATS: readonly TranscriptFormat[] = ["claude-code", "generic-jsonl"];

export function isTranscriptFormat(value: string): value is TranscriptFormat {
  return (TRANSCRIPT_FORMATS as readonly string[]).includes(value);
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface ParsedTranscript {
  turns: Turn[];
  /** Host session id when the transcript carries one. */
  sessionId?: string;
  /** Non-blank lines seen. */
  lines: number;
  /** Non-blank lines that were not valid JSON. */
  badLines: number;
  /**
   * Tool-use blocks seen across the transcript.
   *
   * Text turns alone under-describe agentic sessions: an agent can run 44 tools
   * and summarise in two sentences, which counts as 2 turns while being exactly
   * the kind of session that produces durable lessons. Callers use this as a
   * second signal so those sessions are not prefiltered away.
   */
  toolUses: number;
}

/** Total transcript characters handed to the LLM. */
export const TOTAL_CHAR_BUDGET = 60_000;
/** Of that budget, how much is spent on the head; the rest goes to the tail. */
export const HEAD_CHAR_BUDGET = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRole(value: unknown): "user" | "assistant" | null {
  return value === "user" || value === "assistant" ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Claude Code content is either a plain string or an array of blocks.
 * Only `{type:"text"}` blocks carry conversation; tool_use / tool_result /
 * thinking blocks are noise for reflection.
 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec || rec.type !== "text") continue;
    if (typeof rec.text !== "string") continue;
    const text = rec.text.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/** Count `{type:"tool_use"}` blocks; the counterpart signal to text turns. */
function toolUsesInContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    const rec = asRecord(block);
    if (rec && rec.type === "tool_use") n += 1;
  }
  return n;
}

function nonBlankLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.trim() !== "");
}

export function parseClaudeCodeTranscript(raw: string): ParsedTranscript {
  const turns: Turn[] = [];
  let sessionId: string | undefined;
  let badLines = 0;
  let toolUses = 0;
  const lines = nonBlankLines(raw);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    sessionId ??= optionalString(rec.sessionId) ?? optionalString(rec.session_id);

    if (rec.isMeta === true) continue;
    const role = asRole(rec.type);
    if (!role) continue;
    const message = asRecord(rec.message);
    if (!message) continue;
    // Count tools before the text guard below: a tool-only assistant message
    // carries no text but is still evidence the session did real work.
    toolUses += toolUsesInContent(message.content);
    const text = textFromContent(message.content);
    if (!text) continue;

    const turn: Turn = { role, text };
    const timestamp = optionalString(rec.timestamp);
    if (timestamp) turn.timestamp = timestamp;
    turns.push(turn);
  }

  const out: ParsedTranscript = { turns, lines: lines.length, badLines, toolUses };
  if (sessionId) out.sessionId = sessionId;
  return out;
}

export function parseGenericJsonl(raw: string): ParsedTranscript {
  const turns: Turn[] = [];
  let sessionId: string | undefined;
  let badLines = 0;
  let toolUses = 0;
  const lines = nonBlankLines(raw);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    sessionId ??= optionalString(rec.sessionId) ?? optionalString(rec.session_id);

    const role = asRole(rec.role);
    if (!role) continue;
    toolUses += toolUsesInContent(rec.content);
    const text = textFromContent(rec.content);
    if (!text) continue;

    const turn: Turn = { role, text };
    const timestamp = optionalString(rec.timestamp);
    if (timestamp) turn.timestamp = timestamp;
    turns.push(turn);
  }

  const out: ParsedTranscript = { turns, lines: lines.length, badLines, toolUses };
  if (sessionId) out.sessionId = sessionId;
  return out;
}

export function parseTranscript(raw: string, format: TranscriptFormat): ParsedTranscript {
  return format === "claude-code" ? parseClaudeCodeTranscript(raw) : parseGenericJsonl(raw);
}

/** Last timestamp in transcript order, if the host recorded any. */
export function lastTimestamp(turns: readonly Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const ts = turns[i]?.timestamp;
    if (ts) return ts;
  }
  return undefined;
}

export interface TruncateOptions {
  totalBudget?: number;
  headBudget?: number;
}

export interface TruncatedTranscript {
  turns: Turn[];
  truncated: boolean;
  omittedTurns: number;
  /** Index in `turns` where the omission sits (head length). */
  gapIndex: number;
}

/**
 * Keep the head (how the session was framed) and the tail (where decisions
 * land), dropping the middle. The tail gets the larger share of the budget.
 */
export function truncateTurns(
  turns: readonly Turn[],
  options: TruncateOptions = {},
): TruncatedTranscript {
  const totalBudget = options.totalBudget ?? TOTAL_CHAR_BUDGET;
  const headBudget = Math.min(options.headBudget ?? HEAD_CHAR_BUDGET, totalBudget);
  const tailBudget = totalBudget - headBudget;

  const total = turns.reduce((n, turn) => n + turn.text.length, 0);
  if (total <= totalBudget) {
    return { turns: [...turns], truncated: false, omittedTurns: 0, gapIndex: turns.length };
  }

  const tail: Turn[] = [];
  let tailChars = 0;
  let cursor = turns.length - 1;
  for (; cursor >= 0; cursor--) {
    const turn = turns[cursor]!;
    if (tailChars + turn.text.length > tailBudget) break;
    tail.unshift(turn);
    tailChars += turn.text.length;
  }

  const head: Turn[] = [];
  let headChars = 0;
  for (let i = 0; i <= cursor; i++) {
    const turn = turns[i]!;
    if (headChars + turn.text.length > headBudget) break;
    head.push(turn);
    headChars += turn.text.length;
  }

  if (head.length === 0 && tail.length === 0) {
    // Degenerate case: one turn larger than the whole budget. Keep its tail.
    const last = turns[turns.length - 1]!;
    const clipped: Turn = { ...last, text: last.text.slice(-totalBudget) };
    return {
      turns: [clipped],
      truncated: true,
      omittedTurns: turns.length - 1,
      gapIndex: 0,
    };
  }

  return {
    turns: [...head, ...tail],
    truncated: true,
    omittedTurns: turns.length - head.length - tail.length,
    gapIndex: head.length,
  };
}

/** Flatten turns into the plain-text block sent to the LLM. */
export function renderTurns(view: TruncatedTranscript): string {
  const parts: string[] = [];
  view.turns.forEach((turn, index) => {
    if (view.truncated && index === view.gapIndex) {
      parts.push(`[... ${view.omittedTurns} middle turn(s) omitted ...]`);
    }
    parts.push(`${turn.role}: ${turn.text}`);
  });
  if (view.truncated && view.gapIndex >= view.turns.length) {
    parts.push(`[... ${view.omittedTurns} middle turn(s) omitted ...]`);
  }
  return parts.join("\n\n");
}
