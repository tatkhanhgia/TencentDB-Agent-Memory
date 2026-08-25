import type { Context } from 'hono';
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError } from '../envelope.js';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import {
  type PipelineLayerStatus,
  type PipelineStatusView,
  type CaptureRun,
} from '../../domain/capture-run.js';

interface RawPipelineLayer {
  queued?: unknown;
  running?: unknown;
  queued_sessions?: unknown;
  running_sessions?: unknown;
  idle?: unknown;
}

interface RawPipelineStatus {
  l1?: RawPipelineLayer;
  l2?: RawPipelineLayer;
  l3?: RawPipelineLayer;
}

interface RawAtomicQuery {
  items?: unknown[];
  total?: unknown;
}

interface PipelineReadDeps {
  kernelHttp: PanelDeps['kernelHttp'];
  config: Pick<PanelDeps['config'], 'metadataRemoteTimeoutMs'>;
}

export function registerCaptureRoutes(api: Hono, deps: PanelDeps): void {
  const browserMiddleware = validatePanelMetaHeaders(deps);
  const pipelineHandler = async (c: Context) => {
    const ctx = panelContext(c);
    const body = await readJson(c);
    const sessionId = stringValue(body.session_id);
    const status = await readPipelineStatus(deps, ctx, sessionId);
    return jsonEnvelope(c, status);
  };

  api.post('/capture/pipeline-status', browserMiddleware, pipelineHandler);
  // Keep the noun form used by early internal clients while the canonical route is /capture/*.
  api.post('/capture-runs/pipeline-status', browserMiddleware, pipelineHandler);

  const ingestHandler = async (c: Context) => {
    if (!validIngestCredentials(c, deps)) return respondControlError(c, 401, 'INVALID_CAPTURE_TOKEN');
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return respondControlError(c, 400, 'INVALID_CAPTURE_EVENT');
    }
    try {
      const serviceId = c.req.header('x-tdai-service-id')?.trim() ?? '';
      const result = await deps.captureRunRegistry.ingest(payload, { instanceId: serviceId });
      deps.captureDistillPoller?.notify();
      return c.json({
        code: 0,
        message: 'accepted',
        request_id: c.get('reqId') ?? '',
        data: { duplicate: result.duplicate, run_id: result.run.run_id },
      }, 202);
    } catch {
      return respondControlError(c, 400, 'INVALID_CAPTURE_EVENT');
    }
  };

  api.post('/capture/events', ingestHandler);
  api.post('/capture-runs/events', ingestHandler);

  const listHandler = async (c: Context) => {
    const ctx = panelContext(c);
    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const requestedAgentId = c.req.query('agent_id')?.trim() || undefined;
    const limit = parseLimit(c.req.query('limit'));
    const candidates = deps.captureRunRegistry.list({ agentId: requestedAgentId, limit: 200 });
    const ownedAgentIds = await ownedAgentIdsForRuns(deps, ctx, candidates, caller);
    const owned = candidates
      .filter((run) => run.agent_id !== null && ownedAgentIds.has(run.agent_id))
      .slice(0, limit);
    return jsonEnvelope(c, { items: owned, total: owned.length });
  };

  api.get('/capture/runs', browserMiddleware, listHandler);
  api.get('/capture-runs', browserMiddleware, listHandler);
}

export async function readPipelineStatus(
  deps: PipelineReadDeps,
  ctx: MetaCallContext,
  sessionId?: string,
): Promise<PipelineStatusView> {
  try {
    const credentials = toKernelCredentials(
      ctx,
      { timeoutMs: deps.config.metadataRemoteTimeoutMs },
      { omitUserKey: true },
    );
    const envelope = await deps.kernelHttp.postEnvelope<RawPipelineStatus>(
      '/v2/pipeline/status',
      {},
      credentials,
    );
    if (!envelope || envelope.code !== 0 || !envelope.data) return { observable: false };
    const raw = envelope.data;
    const sessionKey = sessionId ? `reflect:${sessionId}` : undefined;
    return {
      observable: true,
      l1: normalizeLayer(raw.l1, sessionKey, 'l1'),
      l2: normalizeLayer(raw.l2, sessionKey, 'l2'),
      l3: normalizeLayer(raw.l3, sessionKey, 'l3'),
    };
  } catch {
    // Feature detection is deliberately quiet: service mode is 404 and old standalone is 503.
    return { observable: false };
  }
}

export async function readAtomicCount(
  deps: PipelineReadDeps,
  ctx: MetaCallContext,
  run: Pick<CaptureRun, 'started_at' | 'team_id' | 'user_id' | 'agent_id'>,
): Promise<number | null> {
  try {
    const credentials = toKernelCredentials(
      ctx,
      { timeoutMs: deps.config.metadataRemoteTimeoutMs },
      { omitUserKey: true },
    );
    const body = {
      limit: 1,
      offset: 0,
      time_start: run.started_at,
      ...(run.team_id ? { team_id: run.team_id } : {}),
      ...(run.user_id ? { user_id: run.user_id } : {}),
      ...(run.agent_id ? { agent_id: run.agent_id } : {}),
    };
    const envelope = await deps.kernelHttp.postEnvelope<RawAtomicQuery>(
      '/v2/atomic/query',
      body,
      credentials,
    );
    if (!envelope || envelope.code !== 0 || !envelope.data) return null;
    return nonNegativeInt(envelope.data.total) || (Array.isArray(envelope.data.items) ? envelope.data.items.length : 0);
  } catch {
    return null;
  }
}

function normalizeLayer(
  raw: RawPipelineLayer | undefined,
  sessionKey: string | undefined,
  layer: 'l1' | 'l2' | 'l3',
): PipelineLayerStatus {
  const queued = nonNegativeInt(raw?.queued);
  const running = nonNegativeInt(raw?.running);
  const queuedSessions = stringArray(raw?.queued_sessions);
  const runningSessions = stringArray(raw?.running_sessions);
  let observed: PipelineLayerStatus['observed'] = 'none';
  if (sessionKey) {
    const matches = layer === 'l1'
      ? (value: string) => value === sessionKey
      : (value: string) => value.endsWith(`|session:${encodeURIComponent(sessionKey)}`);
    if (runningSessions.some(matches)) observed = 'running';
    else if (queuedSessions.some(matches)) observed = 'queued';
  }
  return {
    queued,
    running,
    idle: typeof raw?.idle === 'boolean' ? raw.idle : queued === 0 && running === 0,
    observed,
  };
}

function validIngestCredentials(c: Context, deps: PanelDeps): boolean {
  const serviceId = c.req.header('x-tdai-service-id')?.trim();
  const authorization = c.req.header('Authorization')?.trim() ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!serviceId || !token) return false;
  try {
    const entry = deps.instanceRegistry.resolve(serviceId);
    const configured = deps.config.capture?.ingestToken ?? '';
    return token === (configured || entry.api_key);
  } catch {
    return false;
  }
}

async function ownedAgentIdsForRuns(
  deps: PanelDeps,
  ctx: MetaCallContext,
  runs: CaptureRun[],
  callerUserId: string,
): Promise<Set<string>> {
  const ids = [...new Set(runs.flatMap((run) => run.agent_id ? [run.agent_id] : []))];
  const checks = await Promise.all(ids.map(async (agentId) => {
    try {
      const envelope = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
      const agent = envelope.code === 0 ? envelope.data as { owner_user_id?: unknown } | null : null;
      return agent?.owner_user_id === callerUserId ? agentId : null;
    } catch {
      return null;
    }
  }));
  return new Set(checks.filter((id): id is string => id !== null));
}

async function resolveCallerUserId(deps: PanelDeps, ctx: MetaCallContext): Promise<string | null> {
  if (!ctx.userKey) return null;
  try {
    const envelope = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
    if (envelope.code !== 0) return null;
    const data = envelope.data as { valid?: boolean; user?: { user_id?: unknown } } | null;
    const id = data?.user?.user_id;
    return data?.valid && typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function panelContext(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

function jsonEnvelope<T>(c: Context, data: T) {
  const envelope: MetaEnvelope<T> = {
    code: 0,
    message: 'ok',
    request_id: c.get('reqId') ?? '',
    data,
  };
  return c.json(envelope);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseLimit(raw: string | undefined): number {
  const value = raw ? Number(raw) : 50;
  return Number.isInteger(value) && value > 0 ? Math.min(value, 200) : 50;
}
