/** Capture activity API — owner-scoped run telemetry for the GlobalHeader drawer. */
import { getPanelSession } from '../panelSession';
import { ApiError, request } from './base';
import type { MetaEnvelope } from './types';

export type CaptureStatus =
  | 'running'
  | 'written'
  | 'empty'
  | 'skipped'
  | 'dry-run'
  | 'refused_unbound'
  | 'error';

export interface CaptureKindCounts {
  adr: number;
  preference: number;
  constraint: number;
  other: number;
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

export interface CaptureRun {
  run_id: string;
  session_id: string;
  source: string;
  agent_id: string | null;
  team_id: string | null;
  route: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  status: CaptureStatus;
  written_count: number;
  kind_counts: CaptureKindCounts;
  error_stage: string | null;
  distill?: PipelineStatusView;
}

interface CaptureRunList {
  items: CaptureRun[];
  total: number;
}

function captureHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

async function captureCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>(method, path, body, captureHeaders());
  if (envelope.code !== 0 || envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'Capture request failed', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'Capture request failed',
    });
  }
  return envelope.data;
}

export const captureApi = {
  listRuns: () => captureCall<CaptureRunList>('GET', '/api/v1/capture-runs'),

  pipelineStatus: async (sessionId: string): Promise<PipelineStatusView> => {
    try {
      return await captureCall<PipelineStatusView>(
        'POST',
        '/api/v1/capture/pipeline-status',
        { session_id: sessionId },
      );
    } catch (error) {
      // Keep feature detection quiet when the kernel has no status endpoint.
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) {
        return { observable: false };
      }
      throw error;
    }
  },
};
