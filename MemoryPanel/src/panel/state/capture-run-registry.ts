import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CaptureEvent,
  type CaptureEventName,
  type CaptureRun,
  type CaptureStatus,
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

interface StoredRun extends CaptureRun {
  session_key: string;
  last_event_seq: number;
}

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

  async ingest(raw: unknown): Promise<CaptureIngestResult> {
    const event = parseCaptureEvent(raw);
    if (!event) throw new Error('INVALID_CAPTURE_EVENT');

    const eventKey = `${event.run_id}:${event.event_seq}`;
    const duplicate = this.seenEvents.has(eventKey);
    if (duplicate) {
      const existing = this.runs.get(event.run_id);
      if (!existing) throw new Error('INVALID_CAPTURE_EVENT');
      return { duplicate: true, run: this.publicRun(existing) };
    }

    this.seenEvents.add(eventKey);
    const run = this.applyEvent(event);
    await this.persist(event);
    return { duplicate: false, run: this.publicRun(run) };
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
        const event = parseCaptureEvent(JSON.parse(line));
        if (!event) continue;
        const eventKey = `${event.run_id}:${event.event_seq}`;
        if (this.seenEvents.has(eventKey)) continue;
        this.seenEvents.add(eventKey);
        this.applyEvent(event);
      } catch {
        // A torn final line or an old schema must not prevent the panel booting.
      }
    }
  }

  private applyEvent(event: CaptureEvent): StoredRun {
    const sessionKey = `reflect:${event.session_id}`;
    const current = this.runs.get(event.run_id);
    if (!current) {
      const created: StoredRun = {
        run_id: event.run_id,
        session_id: event.session_id,
        session_key: sessionKey,
        source: event.source,
        agent_id: event.agent_id,
        team_id: event.team_id,
        route: event.route,
        model: event.model,
        started_at: event.occurred_at,
        ended_at: event.event === 'finished' ? event.occurred_at : null,
        status: event.status,
        written_count: event.written_count,
        kind_counts: event.kind_counts,
        error_stage: event.error_stage,
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
      current.source ||= event.source;
      current.route ||= event.route;
      current.model ??= event.model;
    }
    return current;
  }

  private async persist(event: CaptureEvent): Promise<void> {
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
      route: run.route,
      model: run.model,
      started_at: run.started_at,
      ended_at: run.ended_at,
      status: run.status,
      written_count: run.written_count,
      kind_counts: { ...run.kind_counts },
      error_stage: run.error_stage,
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

function parseCaptureEvent(raw: unknown): CaptureEvent | null {
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
    source: text(input.source, 'unknown') ?? 'unknown',
    agent_id: nullableText(input.agent_id),
    team_id: nullableText(input.team_id),
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
