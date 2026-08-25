import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { CaptureRunRegistry } from '../src/panel/state/capture-run-registry.js';
import { CaptureDistillPoller } from '../src/panel/state/capture-distill-poller.js';
import { registerCaptureRoutes } from '../src/panel/http/routes/capture.js';

const SERVICE_ID = 'test-instance';
const USER_KEY = 'user-key';
const API_KEY = 'capture-key';

function envelope<T>(data: T, code = 0): MetaEnvelope<T> {
  return { code, message: code === 0 ? 'ok' : 'unavailable', request_id: 'request-1', data };
}

function makeDeps(
  journalDir: string,
  kernelData: unknown = { l1: emptyLayer(), l2: emptyLayer(), l3: emptyLayer() },
) {
  const postEnvelope = vi.fn(async () => envelope(kernelData));
  const invoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') return envelope({ valid: true, user: { user_id: 'owner-1' } });
    if (action === 'agent/get') return envelope({ agent_id: 'agent-1', owner_user_id: 'owner-1' });
    return envelope(null, 404);
  });
  const deps = {
      config: {
        metadataRemoteTimeoutMs: 1000,
        capture: {
          journalDir,
          journalMaxBytes: 5 * 1024 * 1024,
          ingestToken: '',
          distillWatchMs: 20 * 60 * 1000,
          distillPollMs: 1000,
        },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    instanceRegistry: new InstanceRegistry([{
      instance_id: SERVICE_ID,
      name: 'test',
      gateway_endpoint: 'https://kernel.test',
      api_key: API_KEY,
    }]),
    kernelHttp: { postEnvelope },
    metaKernel: { invoke },
    knowledgeClientFactory: vi.fn(),
    skillKernel: { invoke: vi.fn() },
    knowledgeTaskRegistry: {},
    captureRunRegistry: new CaptureRunRegistry(journalDir),
  } as unknown as PanelDeps;
  return { deps, postEnvelope, invoke };
}

function emptyLayer() {
  return { queued: 0, running: 0, queued_sessions: [], running_sessions: [], idle: true };
}

function appWith(deps: PanelDeps) {
  const app = new Hono();
  registerCaptureRoutes(app, deps);
  return app;
}

async function post(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {
    'X-Tdai-Service-Id': SERVICE_ID,
    'X-Tdai-User-Key': USER_KEY,
  },
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function get(app: Hono, path: string) {
  return app.request(path, {
    headers: {
      'X-Tdai-Service-Id': SERVICE_ID,
      'X-Tdai-User-Key': USER_KEY,
    },
  });
}

describe('capture pipeline status', () => {
  it('calls the generic kernel port and correlates L1 equality and L2/L3 encoded suffixes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-status-'));
    try {
      const key = 'reflect:session-1';
      const { deps, postEnvelope } = makeDeps(dir, {
        l1: { queued: 2, running: 1, queued_sessions: ['other'], running_sessions: [key], idle: false },
        l2: {
          queued: 3,
          running: 0,
          queued_sessions: [`profile:team|session:${encodeURIComponent(key)}`],
          running_sessions: [`profile:team|session:${encodeURIComponent('reflect:session-10')}`],
          idle: false,
        },
        l3: {
          queued: 0,
          running: 4,
          queued_sessions: [],
          running_sessions: [`profile:team|session:${encodeURIComponent(key)}`],
          idle: false,
        },
      });
      const response = await post(appWith(deps), '/capture/pipeline-status', { session_id: 'session-1' });
      const body = await response.json() as { data: Record<string, any> };

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        observable: true,
        l1: { queued: 2, running: 1, observed: 'running' },
        l2: { queued: 3, running: 0, observed: 'queued' },
        l3: { queued: 0, running: 4, observed: 'running' },
      });
      expect(body.data.l1.queued_sessions).toBeUndefined();
      expect(body.data.l2.running_sessions).toBeUndefined();
      expect(postEnvelope).toHaveBeenCalledWith('/v2/pipeline/status', {}, expect.objectContaining({
        apiKey: API_KEY,
        instanceId: SERVICE_ID,
        userKey: undefined,
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([404, 503])('degrades kernel %s to observable:false without throwing', async (code) => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-guard-'));
    try {
      const { deps, postEnvelope } = makeDeps(dir);
      postEnvelope.mockResolvedValueOnce(envelope(null, code));
      const response = await post(appWith(deps), '/capture/pipeline-status', {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code: 0, data: { observable: false } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('capture run journal and owner-only list', () => {
  it('is idempotent, keeps terminal state above older events, filters metadata, and replays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-journal-'));
    try {
      const { deps, postEnvelope } = makeDeps(dir, emptyLayer());
      const app = appWith(deps);
      const started = {
        event: 'started', event_seq: 1, run_id: 'run-1', session_id: 'session-1',
        source: 'claude-code', agent_id: 'agent-1', team_id: 'team-1', route: 'file', model: 'model-1',
        occurred_at: '2026-08-25T01:00:00.000Z', status: 'running', cwd: '/secret', transcript_path: '/secret/log',
      };
      const finished = {
        event: 'finished', event_seq: 2, run_id: 'run-1', session_id: 'session-1',
        source: 'claude-code', agent_id: 'agent-1', team_id: 'team-1', route: 'file', model: 'model-1',
        occurred_at: '2026-08-25T01:00:01.000Z', status: 'written', written_count: 2,
        kind_counts: { adr: 1, preference: 0, constraint: 1, leaked: 99 },
        title: 'must not persist', body: 'must not persist',
      };
      const badOldStarted = { ...started, event_seq: 3, status: 'running' };

      const ingestHeaders = {
        'X-Tdai-Service-Id': SERVICE_ID,
        Authorization: `Bearer ${API_KEY}`,
      };
      expect((await post(app, '/capture/events', started, ingestHeaders)).status).toBe(202);
      expect((await post(app, '/capture/events', finished, ingestHeaders)).status).toBe(202);
      const duplicate = await post(app, '/capture/events', finished, ingestHeaders);
      expect((await duplicate.json()).data.duplicate).toBe(true);
      expect((await post(app, '/capture/events', badOldStarted, ingestHeaders)).status).toBe(202);

      const listed = await get(app, '/capture/runs');
      const body = await listed.json() as { data: { items: Array<Record<string, any>> } };
      expect(listed.status).toBe(200);
      expect(body.data.items[0]).toMatchObject({ status: 'written', written_count: 2 });
      expect(body.data.items[0]?.kind_counts).toEqual({ adr: 1, preference: 0, constraint: 1, other: 0 });
      expect(postEnvelope).not.toHaveBeenCalledWith('/v2/pipeline/status', expect.anything(), expect.anything());
      const serialized = JSON.stringify(body.data.items[0]);
      expect(serialized).not.toContain('must not persist');
      expect(serialized).not.toContain('/secret');

      const journal = await readFile(join(dir, 'capture-runs.ndjson'), 'utf8');
      expect(journal).not.toContain('title');
      expect(journal).not.toContain('transcript_path');
      await appendFile(join(dir, 'capture-runs.ndjson'), '{broken-tail\n');
      const replayed = new CaptureRunRegistry(dir);
      expect(replayed.list()[0]).toMatchObject({ run_id: 'run-1', status: 'written', written_count: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates the NDJSON journal at the configured size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-rotation-'));
    try {
      const registry = new CaptureRunRegistry(dir, 1024);
      for (let index = 0; index < 12; index += 1) {
        await registry.ingest({
          event: 'finished', event_seq: 1, run_id: `run-${index}`, session_id: `session-${index}`,
          source: 'claude-code', agent_id: 'agent-1', team_id: 'team-1', route: 'file',
          occurred_at: `2026-08-25T01:00:${String(index).padStart(2, '0')}.000Z`, status: 'empty',
        });
      }
      await expect(stat(join(dir, 'capture-runs.ndjson.1'))).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('server-side distillation watcher', () => {
  it('persists queued → running → left_queue, corroborates without claiming run attribution, and never downgrades', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-poller-'));
    try {
      const { deps, postEnvelope } = makeDeps(dir);
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const registry = deps.captureRunRegistry;
      await registry.ingest({
        event: 'finished', event_seq: 2, run_id: 'run-poll', session_id: 'session-poll',
        source: 'test', agent_id: 'agent-1', team_id: 'team-1', user_id: 'user-1', route: 'test',
        occurred_at: startedAt, status: 'written', written_count: 2,
      }, { instanceId: SERVICE_ID });

      const snapshots = [
        { l1: { queued: 1, running: 0, queued_sessions: ['reflect:session-poll'], running_sessions: [], idle: false }, l2: emptyLayer(), l3: emptyLayer() },
        { l1: { queued: 0, running: 1, queued_sessions: [], running_sessions: ['reflect:session-poll'], idle: false }, l2: emptyLayer(), l3: emptyLayer() },
        { l1: emptyLayer(), l2: emptyLayer(), l3: emptyLayer() },
        { l1: { queued: 1, running: 0, queued_sessions: ['reflect:session-poll'], running_sessions: [], idle: false }, l2: emptyLayer(), l3: emptyLayer() },
      ];
      postEnvelope.mockImplementation(async (path: string) => {
        if (path === '/v2/pipeline/status') return envelope(snapshots.shift() ?? snapshots[2]);
        return envelope({ items: [], total: 3 });
      });
      const poller = new CaptureDistillPoller({
        config: deps.config,
        instanceRegistry: deps.instanceRegistry,
        kernelHttp: deps.kernelHttp,
        captureRunRegistry: registry,
        logger: deps.logger,
      });

      await poller.pollOnce();
      expect(registry.list()[0]?.distill?.l1?.state).toBe('queued');
      await poller.pollOnce();
      expect(registry.list()[0]?.distill?.l1?.state).toBe('running');
      await poller.pollOnce();
      expect(registry.list()[0]?.distill?.l1).toMatchObject({
        state: 'left_queue',
        corroboration: { count: 3 },
      });
      const atomicCall = postEnvelope.mock.calls.find(([path]) => path === '/v2/atomic/query');
      expect(atomicCall?.[1]).toMatchObject({
        time_start: startedAt,
        team_id: 'team-1',
        user_id: 'user-1',
        agent_id: 'agent-1',
      });

      await poller.pollOnce();
      expect(registry.list()[0]?.distill?.l1?.state).toBe('left_queue');

      const replayed = new CaptureRunRegistry(dir);
      expect(replayed.list()[0]?.distill?.l1).toMatchObject({
        state: 'left_queue',
        corroboration: { count: 3 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades all layers to unavailable when the kernel status endpoint is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-poller-guard-'));
    try {
      const { deps, postEnvelope } = makeDeps(dir);
      await deps.captureRunRegistry.ingest({
        event: 'finished', event_seq: 1, run_id: 'run-guard', session_id: 'session-guard',
        source: 'test', agent_id: 'agent-1', route: 'test',
        occurred_at: new Date().toISOString(), status: 'written', written_count: 1,
      }, { instanceId: SERVICE_ID });
      postEnvelope.mockResolvedValueOnce(envelope(null, 503));
      const poller = new CaptureDistillPoller({
        config: deps.config,
        instanceRegistry: deps.instanceRegistry,
        kernelHttp: deps.kernelHttp,
        captureRunRegistry: deps.captureRunRegistry,
        logger: deps.logger,
      });

      await expect(poller.pollOnce()).resolves.toBeUndefined();
      expect(deps.captureRunRegistry.list()[0]?.distill).toEqual({ observable: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks pending layers unobserved after the watch window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tdai-capture-poller-timeout-'));
    try {
      const { deps } = makeDeps(dir);
      const endedAt = new Date('2026-08-25T01:00:00.000Z').toISOString();
      await deps.captureRunRegistry.ingest({
        event: 'finished', event_seq: 1, run_id: 'run-timeout', session_id: 'session-timeout',
        source: 'test', agent_id: 'agent-1', route: 'test',
        occurred_at: endedAt, status: 'written', written_count: 1,
      }, { instanceId: SERVICE_ID });
      const poller = new CaptureDistillPoller({
        config: deps.config,
        instanceRegistry: deps.instanceRegistry,
        kernelHttp: deps.kernelHttp,
        captureRunRegistry: deps.captureRunRegistry,
        logger: deps.logger,
      });

      await poller.pollOnce(Date.parse(endedAt) + deps.config.capture.distillWatchMs + 1);
      expect(deps.captureRunRegistry.list()[0]?.distill?.l1?.state).toBe('unobserved');
      expect(deps.captureRunRegistry.list()[0]?.distill?.l2?.state).toBe('unobserved');
      expect(deps.captureRunRegistry.list()[0]?.distill?.l3?.state).toBe('unobserved');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
