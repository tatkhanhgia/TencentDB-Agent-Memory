export const CAPTURE_KINDS = ['adr', 'preference', 'constraint'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export type CaptureStatus =
  | 'running'
  | 'written'
  | 'empty'
  | 'skipped'
  | 'dry-run'
  | 'refused_unbound'
  | 'error';

export type CaptureEventName = 'started' | 'finished';

export type DistillState = 'pending' | 'queued' | 'running' | 'left_queue' | 'unobserved';

export interface DistillCorroboration {
  count: number;
  queried_at: string;
}

export interface DistillLayerStatus {
  state: DistillState;
  first_seen_at: string | null;
  left_queue_at: string | null;
  corroboration?: DistillCorroboration;
}

export interface DistillRunStatus {
  observable: boolean;
  l1?: DistillLayerStatus;
  l2?: DistillLayerStatus;
  l3?: DistillLayerStatus;
}

export interface CaptureKindCounts {
  adr: number;
  preference: number;
  constraint: number;
  other: number;
}

export interface CaptureEvent {
  event: CaptureEventName;
  event_seq: number;
  run_id: string;
  session_id: string;
  instance_id: string | null;
  source: string;
  agent_id: string | null;
  team_id: string | null;
  user_id: string | null;
  route: string;
  model: string | null;
  occurred_at: string;
  status: CaptureStatus;
  written_count: number;
  kind_counts: CaptureKindCounts;
  error_stage: string | null;
}

/** Public run data. It deliberately has no cwd, transcript path, lesson title, or lesson body. */
export interface CaptureRun {
  run_id: string;
  session_id: string;
  source: string;
  agent_id: string | null;
  team_id: string | null;
  user_id: string | null;
  route: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  status: CaptureStatus;
  written_count: number;
  kind_counts: CaptureKindCounts;
  error_stage: string | null;
  distill?: DistillRunStatus;
}

export interface PipelineLayerStatus {
  queued: number;
  running: number;
  idle: boolean;
  observed: 'queued' | 'running' | 'none';
}

export interface PipelineStatusView {
  observable: boolean;
  l1?: PipelineLayerStatus;
  l2?: PipelineLayerStatus;
  l3?: PipelineLayerStatus;
}

export function emptyKindCounts(): CaptureKindCounts {
  return { adr: 0, preference: 0, constraint: 0, other: 0 };
}

export function normalizeKindCounts(raw: unknown): CaptureKindCounts {
  const out = emptyKindCounts();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue;
    if (key === 'adr' || key === 'preference' || key === 'constraint' || key === 'other') {
      out[key] = value;
    }
  }
  return out;
}
