import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CaptureEvent,
  type CaptureEventName,
  type CaptureRun,
  type CaptureStatus,
  type DistillLayerStatus,
  type DistillRunStatus,
  type DistillState,
  normalizeKindCounts,
} from '../domain/capture-run.js';

const TERMINAL_STATUSES = new Set<CaptureStatus>([
  'written',
  'empty',
  'skipped',
  'dry-run',
  'refused_unbound',
  'error',
]);
const EVENT_NAMES = new Set<CaptureEventName>(['started', 'finished']);
const MAX_TEXT = 512;
export const ABANDONED_STAGE = 'abandoned';

interface DistillJournalEvent {
  event: 'distill';
  event_seq: number;
  run_id: string;
  occurred_at: string;
  distill: DistillRunStatus;
}

type JournalEvent = CaptureEvent | DistillJournalEvent;

interface StoredRun extends CaptureRun {
  session_key: string;
  instance_id: string | null;
  last_event_seq: number;
}

export interface CaptureIngestMetadata {
  instanceId?: string;
}

export interface DistillWatchRun extends CaptureRun {
  instance_id: string | null;
}

const DISTILL_LAYERS = ['l1', 'l2', 'l3'] as const;

export interface CaptureIngestResult {
  duplicate: boolean;
  run: CaptureRun;
}

export class CaptureRunRegistry {
  private readonly runs = new Map<string, StoredRun>();
  private readonly seenEvents = new Set<string>();
  private readonly journalPath: string;
  private readonly rotatedPath: string;
  private readonly maxBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private nextDistillEventSeq = 0;

  constructor(journalDir: string, maxBytes = 5 * 1024 * 1024) {
    this.journalPath = path.join(journalDir, 'capture-runs.ndjson');
    this.rotatedPath = `${this.journalPath}.1`;
    this.maxBytes = Math.max(1024, maxBytes);
    mkdirSync(journalDir, { recursive: true });
    this.replayFile(this.rotatedPath);
    this.replayFile(this.journalPath);
  }

  list(options: { agentId?: string; limit?: number } = {}): CaptureRun[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    return [...this.runs.values()]
      .filter((run) => !options.agentId || run.agent_id === options.agentId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map((run) => this.publicRun(run));
  }

  async ingest(raw: unknown, metadata: CaptureIngestMetadata = {}): Promise<CaptureIngestResult> {
    const event = parseCaptureEvent(raw, metadata);
    if (!event) throw new Error('INVALID_CAPTURE_EVENT');

    const eventKey = `capture:${event.run_id}:${event.event_seq}`;
    const duplicate = this.seenEvents.has(eventKey);
    if (duplicate) {
      const existing = this.runs.get(event.run_id);
      if (!existing) throw new Error('INVALID_CAPTURE_EVENT');
      return { duplicate: true, run: this.publicRun(existing) };
    }

    this.seenEvents.add(eventKey);
    const run = this.applyCaptureEvent(event);
    await this.persist(event);
    return { duplicate: false, run: this.publicRun(run) };
  }

  watchableRuns(now = Date.now(), windowMs = 20 * 60 * 1000): DistillWatchRun[] {
    return [...this.runs.values()]
      .filter((run) => {
        if (!run.ended_at || run.distill?.observable === false) return false;
        const endedAt = Date.parse(run.ended_at);
        if (!Number.isFinite(endedAt) || endedAt > now || now - endedAt > windowMs) return false;
        return !isDistillTerminal(run.distill);
      })
      .map((run) => ({ ...this.publicRun(run), instance_id: run.instance_id }));
  }

  /**
   * Reaps runs whose process died after `started` and never sent `finished`.
   * The terminal state is persisted as a real `finished` event so a panel
   * restart replays it instead of resurrecting the run as `running`.
   */
  async expireStaleRuns(now = Date.now(), staleMs = 20 * 60 * 1000): Promise<void> {
    const candidates = [...this.runs.values()].filter((run) => {
      if (run.status !== 'running' || run.ended_at) return false;
      const startedAt = Date.parse(run.started_at);
      return Number.isFinite(startedAt) && now - startedAt > staleMs;
    });
    for (const run of candidates) {
      const occurredAt = new Date(now).toISOString();
      await this.ingest({
        event: 'finished',
        event_seq: run.last_event_seq + 1,
        run_id: run.run_id,
        session_id: run.session_id,
        instance_id: run.instance_id,
        source: run.source,
        agent_id: run.agent_id,
        team_id: run.team_id,
        user_id: run.user_id,
        route: run.route,
        model: run.model,
        occurred_at: occurredAt,
        status: 'error',
        written_count: run.written_count,
        kind_counts: run.kind_counts,
        error_stage: ABANDONED_STAGE,
      });
      // Nothing ever distilled for a run that died before writing anything.
      await this.setDistill(run.run_id, { observable: false }, occurredAt);
    }
  }

  async expireDistillRuns(now = Date.now(), windowMs = 20 * 60 * 1000): Promise<void> {
    const candidates = [...this.runs.values()].filter((run) => {
      if (!run.ended_at || run.distill?.observable === false || isDistillTerminal(run.distill)) return false;
      const endedAt = Date.parse(run.ended_at);
      return Number.isFinite(endedAt) && now - endedAt > windowMs;
    });
    for (const run of candidates) {
      const current = run.distill ?? pendingDistill();
      const next = { ...current, observable: true };
      for (const layer of DISTILL_LAYERS) {
        const status = next[layer] ?? pendingLayer();
        if (status.state === 'pending' || status.state === 'queued' || status.state === 'running') {
          next[layer] = { ...status, state: 'unobserved' };
        }
      }
      await this.setDistill(run.run_id, next);
    }
  }

  async setDistill(runId: string, incoming: DistillRunStatus, occurredAt = new Date().toISOString()): Promise<boolean> {
    const current = this.runs.get(runId);
    if (!current) return false;
    const next = mergeDistill(current.distill, incoming);
    if (sameDistill(current.distill, next)) return false;
    current.distill = cloneDistill(next);
    const event: DistillJournalEvent = {
      event: 'distill',
      event_seq: ++this.nextDistillEventSeq,
      run_id: runId,
      occurred_at: occurredAt,
      distill: cloneDistill(next),
    };
    await this.persist(event);
    return true;
  }

  private replayFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = parseJournalEvent(JSON.parse(line));
        if (!event) continue;
        const eventKey = event.event === 'distill'
          ? `distill:${event.run_id}:${event.event_seq}`
          : `capture:${event.run_id}:${event.event_seq}`;
        if (this.seenEvents.has(eventKey)) continue;
        this.seenEvents.add(eventKey);
        if (event.event === 'distill') {
          this.nextDistillEventSeq = Math.max(this.nextDistillEventSeq, event.event_seq);
          this.applyDistillEvent(event);
        } else {
          this.applyCaptureEvent(event);
        }
      } catch {
        // A torn final line or an old schema must not prevent the panel booting.
      }
    }
  }

  private applyCaptureEvent(event: CaptureEvent): StoredRun {
    const sessionKey = `reflect:${event.session_id}`;
    const current = this.runs.get(event.run_id);
    if (!current) {
      const created: StoredRun = {
        run_id: event.run_id,
        session_id: event.session_id,
        session_key: sessionKey,
        instance_id: event.instance_id,
        source: event.source,
        agent_id: event.agent_id,
        team_id: event.team_id,
        user_id: event.user_id,
        route: event.route,
        model: event.model,
        started_at: event.occurred_at,
        ended_at: event.event === 'finished' ? event.occurred_at : null,
        status: event.status,
        written_count: event.written_count,
        kind_counts: event.kind_counts,
        error_stage: event.error_stage,
        distill: event.event === 'finished' ? pendingDistill() : undefined,
        last_event_seq: event.event_seq,
      };
      this.runs.set(event.run_id, created);
      return created;
    }

    if (event.event_seq > current.last_event_seq) {
      current.last_event_seq = event.event_seq;
      if (event.event === 'finished') {
        current.ended_at = event.occurred_at;
        current.status = event.status;
        current.written_count = event.written_count;
        current.kind_counts = event.kind_counts;
        current.error_stage = event.error_stage;
      } else if (!TERMINAL_STATUSES.has(current.status)) {
        current.status = 'running';
      }
      current.agent_id ??= event.agent_id;
      current.team_id ??= event.team_id;
      current.user_id ??= event.user_id;
      current.instance_id ??= event.instance_id;
      current.source ||= event.source;
      current.route ||= event.route;
      current.model ??= event.model;
    }
    return current;
  }

  private applyDistillEvent(event: DistillJournalEvent): void {
    const current = this.runs.get(event.run_id);
    if (!current) return;
    current.distill = mergeDistill(current.distill, event.distill);
  }

  private async persist(event: JournalEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const job = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.journalPath), { recursive: true });
      let currentBytes = 0;
      try {
        currentBytes = (await stat(this.journalPath)).size;
      } catch {
        currentBytes = 0;
      }
      if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > this.maxBytes) {
        await rm(this.rotatedPath, { force: true });
        await rename(this.journalPath, this.rotatedPath);
      }
      await appendFile(this.journalPath, line, 'utf8');
    });
    this.writeQueue = job.catch(() => undefined);
    await job;
  }

  private publicRun(run: StoredRun): CaptureRun {
    return {
      run_id: run.run_id,
      session_id: run.session_id,
      source: run.source,
      agent_id: run.agent_id,
      team_id: run.team_id,
      user_id: run.user_id,
      route: run.route,
      model: run.model,
      started_at: run.started_at,
      ended_at: run.ended_at,
      status: run.status,
      written_count: run.written_count,
      kind_counts: { ...run.kind_counts },
      error_stage: run.error_stage,
      ...(run.distill ? { distill: cloneDistill(run.distill) } : {}),
    };
  }
}

function text(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : fallback;
}

function nullableText(value: unknown): string | null {
  return text(value);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseJournalEvent(raw: unknown): JournalEvent | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).event === 'distill') {
    return parseDistillEvent(raw);
  }
  return parseCaptureEvent(raw);
}

function parseDistillEvent(raw: unknown): DistillJournalEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const runId = text(input.run_id);
  const occurredAt = text(input.occurred_at);
  const seq = input.event_seq;
  if (!runId || !occurredAt || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  const distill = parseDistill(input.distill);
  if (!distill) return null;
  return { event: 'distill', event_seq: seq, run_id: runId, occurred_at: occurredAt, distill };
}

function parseCaptureEvent(raw: unknown, metadata: CaptureIngestMetadata = {}): CaptureEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const eventName = text(input.event ?? input.phase ?? input.type);
  const event = eventName && EVENT_NAMES.has(eventName as CaptureEventName)
    ? (eventName as CaptureEventName)
    : null;
  const runId = text(input.run_id);
  const sessionId = text(input.session_id);
  const occurredAt = text(input.occurred_at ?? input.timestamp ?? input.at);
  const seq = input.event_seq;
  if (!event || !runId || !sessionId || !occurredAt) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  if (event === 'started' && input.status !== undefined && input.status !== 'running') return null;

  const status = event === 'started' ? 'running' : text(input.status);
  if (!status || !isCaptureStatus(status)) return null;

  return {
    event,
    event_seq: seq,
    run_id: runId,
    session_id: sessionId,
    instance_id: nullableText(input.instance_id) ?? text(metadata.instanceId),
    source: text(input.source, 'unknown') ?? 'unknown',
    agent_id: nullableText(input.agent_id),
    team_id: nullableText(input.team_id),
    user_id: nullableText(input.user_id),
    route: text(input.route, 'unknown') ?? 'unknown',
    model: nullableText(input.model),
    occurred_at: occurredAt,
    status,
    written_count: positiveInt(input.written_count, 0),
    kind_counts: normalizeKindCounts(input.kind_counts),
    error_stage: nullableText(input.error_stage),
  };
}

function isCaptureStatus(value: string): value is CaptureStatus {
  return value === 'running' || TERMINAL_STATUSES.has(value as CaptureStatus);
}

function pendingLayer(): DistillLayerStatus {
  return { state: 'pending', first_seen_at: null, left_queue_at: null };
}

function pendingDistill(): DistillRunStatus {
  return {
    observable: true,
    l1: pendingLayer(),
    l2: pendingLayer(),
    l3: pendingLayer(),
  };
}

function parseDistill(raw: unknown): DistillRunStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.observable !== 'boolean') return null;
  const output: DistillRunStatus = { observable: input.observable };
  for (const layer of DISTILL_LAYERS) {
    const parsed = parseDistillLayer(input[layer]);
    if (parsed) output[layer] = parsed;
  }
  return output;
}

function parseDistillLayer(raw: unknown): DistillLayerStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const state = input.state;
  if (!isDistillState(state)) return null;
  const firstSeen = input.first_seen_at === null ? null : text(input.first_seen_at);
  const leftQueue = input.left_queue_at === null ? null : text(input.left_queue_at);
  const corr = input.corroboration;
  const corrRecord = corr && typeof corr === 'object' && !Array.isArray(corr)
    ? corr as Record<string, unknown>
    : null;
  const corroboration = corrRecord
    && typeof corrRecord.count === 'number'
    && Number.isInteger(corrRecord.count)
    && corrRecord.count >= 0
    && typeof corrRecord.queried_at === 'string'
    ? {
      count: corrRecord.count,
      queried_at: corrRecord.queried_at,
    }
    : undefined;
  return {
    state,
    first_seen_at: firstSeen,
    left_queue_at: leftQueue,
    ...(corroboration ? { corroboration } : {}),
  };
}

function isDistillState(value: unknown): value is DistillState {
  return value === 'pending' || value === 'queued' || value === 'running'
    || value === 'left_queue' || value === 'unobserved';
}

function cloneDistill(value: DistillRunStatus): DistillRunStatus {
  return JSON.parse(JSON.stringify(value)) as DistillRunStatus;
}

function sameDistill(left: DistillRunStatus | undefined, right: DistillRunStatus): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeDistill(current: DistillRunStatus | undefined, incoming: DistillRunStatus): DistillRunStatus {
  if (current?.observable === false) return cloneDistill(current);
  if (incoming.observable === false) return { observable: false };
  const base = current ?? pendingDistill();
  const output: DistillRunStatus = { observable: true };
  for (const layer of DISTILL_LAYERS) {
    output[layer] = mergeDistillLayer(base[layer] ?? pendingLayer(), incoming[layer] ?? pendingLayer());
  }
  return output;
}

function mergeDistillLayer(current: DistillLayerStatus, incoming: DistillLayerStatus): DistillLayerStatus {
  if (current.state === 'left_queue' || current.state === 'unobserved') {
    return {
      ...current,
      corroboration: current.corroboration ?? incoming.corroboration,
    };
  }
  const state = current.state === 'running' && incoming.state === 'queued'
    ? current.state
    : incoming.state;
  return {
    state,
    first_seen_at: current.first_seen_at ?? incoming.first_seen_at,
    left_queue_at: current.left_queue_at ?? incoming.left_queue_at,
    ...(incoming.corroboration ?? current.corroboration
      ? { corroboration: incoming.corroboration ?? current.corroboration } : {}),
  };
}

function isDistillTerminal(distill: DistillRunStatus | undefined): boolean {
  return Boolean(distill && DISTILL_LAYERS.every((layer) => {
    const state = distill[layer]?.state;
    return state === 'left_queue' || state === 'unobserved';
  }));
}
