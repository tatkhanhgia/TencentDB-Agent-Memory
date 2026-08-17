export interface ConversationHit {
  id?: string;
  role?: string;
  content: string;
  timestamp?: string;
  score?: number;
}

export interface NormalizedConversationSearch {
  messages: ConversationHit[];
  source: "messages" | "items" | "empty";
  /** True when Core (or a stand-in) only provided `items` — not dropped. */
  drift: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toHit(raw: unknown): ConversationHit | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const content = rec.content;
  if (typeof content !== "string") return null;
  const hit: ConversationHit = { content };
  if (typeof rec.id === "string") hit.id = rec.id;
  if (typeof rec.role === "string") hit.role = rec.role;
  if (typeof rec.timestamp === "string") hit.timestamp = rec.timestamp;
  if (typeof rec.score === "number") hit.score = rec.score;
  return hit;
}

function mapHits(list: unknown): ConversationHit[] {
  if (!Array.isArray(list)) return [];
  const out: ConversationHit[] = [];
  for (const item of list) {
    const hit = toHit(item);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Canonical L0 search shape is Core `data.messages`.
 *
 * - `messages` present (including []) → use it.
 * - `messages` absent and `items` present → return those hits (do not drop)
 *   and set `drift: true` so callers do not treat this as a silent empty list.
 * - neither present → empty.
 */
export function normalizeConversationSearch(data: unknown): NormalizedConversationSearch {
  const rec = asRecord(data) ?? {};
  const hasMessages = Array.isArray(rec.messages);
  const hasItems = Array.isArray(rec.items);

  if (hasMessages) {
    const messages = mapHits(rec.messages);
    return { messages, source: "messages", drift: false };
  }

  if (hasItems) {
    const messages = mapHits(rec.items);
    return { messages, source: "items", drift: true };
  }

  return { messages: [], source: "empty", drift: false };
}

export interface AtomicHit {
  id?: string;
  type?: string;
  content: string;
  background?: string;
  score?: number;
}

export function normalizeAtomicSearch(data: unknown): AtomicHit[] {
  const rec = asRecord(data) ?? {};
  const list = Array.isArray(rec.items) ? rec.items : [];
  const out: AtomicHit[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row || typeof row.content !== "string") continue;
    const hit: AtomicHit = { content: row.content };
    if (typeof row.id === "string") hit.id = row.id;
    if (typeof row.type === "string") hit.type = row.type;
    if (typeof row.background === "string") hit.background = row.background;
    if (typeof row.score === "number") hit.score = row.score;
    out.push(hit);
  }
  return out;
}

export interface SceneIndexEntry {
  path: string;
  summary?: string;
}

export function normalizeSceneList(data: unknown): SceneIndexEntry[] {
  const rec = asRecord(data) ?? {};
  const list = Array.isArray(rec.entries) ? rec.entries : [];
  const out: SceneIndexEntry[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row || typeof row.path !== "string") continue;
    const entry: SceneIndexEntry = { path: row.path };
    if (typeof row.summary === "string") entry.summary = row.summary;
    out.push(entry);
  }
  return out;
}

export function normalizeCore(data: unknown): { content: string | null } {
  const rec = asRecord(data);
  if (!rec) return { content: null };
  if (typeof rec.content === "string") return { content: rec.content };
  return { content: null };
}

export function normalizeSceneFile(data: unknown): { path?: string; content: string | null } {
  const rec = asRecord(data);
  if (!rec) return { content: null };
  return {
    path: typeof rec.path === "string" ? rec.path : undefined,
    content: typeof rec.content === "string" ? rec.content : null,
  };
}
