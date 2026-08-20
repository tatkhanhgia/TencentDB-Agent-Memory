export const QUERY_MIN = 1;
export const QUERY_MAX = 2048;
export const DEFAULT_MAX_ITEMS = 5;
export const ABS_MAX_ITEMS = 10;
export const DEFAULT_MAX_CHARS = 12_288;

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export function parseQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new LimitError("query is required");
  }
  const query = raw.trim();
  if (query.length < QUERY_MIN || query.length > QUERY_MAX) {
    throw new LimitError(`query must be ${QUERY_MIN}–${QUERY_MAX} characters`);
  }
  return query;
}

export function parseMaxItems(raw: unknown, fallback = DEFAULT_MAX_ITEMS): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > ABS_MAX_ITEMS) {
    throw new LimitError(`max_items / limit must be an integer 1–${ABS_MAX_ITEMS}`);
  }
  return n;
}

export function parseMaxChars(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 256 || n > 100_000) {
    throw new LimitError("max_chars must be an integer 256–100000");
  }
  return n;
}

export function parseOptionalTime(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new LimitError(`${field} must be a string`);
  }
  return raw;
}

export function parseOptionalType(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new LimitError("type must be a non-empty string");
  }
  return raw.trim();
}

/**
 * Skill search scope. "agent" (default) keeps the gateway's owner filter —
 * only the active identity's own skills. "team" asks the gateway to strip
 * agent_id and search the whole team library.
 */
export function parseSkillScope(raw: unknown): "agent" | "team" {
  if (raw === undefined || raw === null || raw === "") return "agent";
  if (raw === "agent" || raw === "team") return raw;
  throw new LimitError('scope must be "agent" or "team"');
}

export function parseSkillVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new LimitError("version must be a positive integer");
  }
  return n;
}

export function parseSkillEncoding(raw: unknown): "utf-8" | "base64" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "utf-8" || raw === "base64") return raw;
  throw new LimitError('encoding must be "utf-8" or "base64"');
}

export function truncateText(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, budget)), truncated: true };
}
