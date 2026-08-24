import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';

const SERVICE_ID = 'test-instance';
const USER_KEY = 'test-user-key';
const TEAM_ID = 'team-1';
const USER_ID = 'user-1';

type InvokeHandler = (
  action: string,
  body: Record<string, unknown>,
) => MetaEnvelope<unknown> | Promise<MetaEnvelope<unknown>>;

function envelope(data: unknown, code = 0): MetaEnvelope<unknown> {
  return { code, message: code === 0 ? 'ok' : 'failed', request_id: 'test-request', data };
}

function makeDeps(handler: InvokeHandler) {
  const invoke = vi.fn((action: string, body: Record<string, unknown>) => handler(action, body));
  const deps = {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    instanceRegistry: new InstanceRegistry([{
      instance_id: SERVICE_ID,
      name: 'test',
      gateway_endpoint: 'https://kernel.test',
      api_key: 'test-api-key',
    }]),
    kernelHttp: { postEnvelope: vi.fn() },
    metaKernel: { invoke },
    knowledgeClientFactory: vi.fn(),
    skillKernel: { invoke: vi.fn() },
    knowledgeTaskRegistry: {},
  } as unknown as PanelDeps;
  return { deps, invoke };
}

function authResponse() {
  return envelope({ valid: true, user: { user_id: USER_ID } });
}

async function post(app: Hono, path: string, body: Record<string, unknown>) {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': SERVICE_ID,
      'X-Tdai-User-Key': USER_KEY,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ code: number; data: { items: Array<Record<string, unknown>> } }>;
}

function appWith(deps: PanelDeps) {
  const app = new Hono();
  registerChatMemoryRoutes(app, deps);
  return app;
}

function asset(assetId: string, overrides: Record<string, unknown> = {}) {
  return {
    asset_id: assetId,
    team_id: TEAM_ID,
    asset_type: 'chat_memory',
    name: assetId,
    owner_user_id: USER_ID,
    visibility: 'team',
    status: 'active',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('chat memory last_memory_at mapping', () => {
  it('maps team-assets last memory and falls back to updated metadata', async () => {
    const { deps } = makeDeps((action) => {
      if (action === 'asset/list') {
        return envelope({
          items: [
            asset('team-memory-1', { last_memory_at: '2026-08-20T12:34:56.000Z' }),
            asset('team-memory-2'),
          ],
          total: 2,
          limit: 20,
          offset: 0,
        });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await post(appWith(deps), '/chat-memory/team-assets', { team_id: TEAM_ID });
    expect(result.code).toBe(0);
    expect(result.data.items).toMatchObject([
      { id: 'team-memory-1', last_memory_at_ms: Date.parse('2026-08-20T12:34:56.000Z') },
      { id: 'team-memory-2', last_memory_at_ms: null, updated_at_ms: Date.parse('2026-08-01T00:00:00.000Z') },
    ]);
  });

  it('maps agent-fixed details directly with exactly three kernel calls for five items', async () => {
    const fixedItems = Array.from({ length: 5 }, (_, index) => ({
      asset_id: `fixed-${index}`,
      asset_type: 'chat_memory',
      name: `Fixed ${index}`,
      status: 'active',
      visibility: 'team',
      created_at: '2026-08-01T00:00:00.000Z',
      owner_user_id: 'owner-from-detail',
      updated_at: '2026-08-10T00:00:00.000Z',
      last_memory_at: index === 0 ? '2026-08-21T00:00:00.000Z' : null,
    }));
    const { deps, invoke } = makeDeps((action) => {
      if (action === 'auth/verify') return authResponse();
      if (action === 'agent/get') {
        return envelope({ agent_id: 'agent-1', team_id: TEAM_ID, owner_user_id: USER_ID, name: 'Agent 1' });
      }
      if (action === 'agent-fixed-asset/list-with-detail') {
        return envelope({ items: fixedItems, total: fixedItems.length });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await post(appWith(deps), '/chat-memory/agent-fixed', { agent_id: 'agent-1' });
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0]).toMatchObject({
      uploaded_by_user_id: 'owner-from-detail',
      updated_at_ms: Date.parse('2026-08-10T00:00:00.000Z'),
      last_memory_at_ms: Date.parse('2026-08-21T00:00:00.000Z'),
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.map(([action]) => action)).toEqual([
      'auth/verify',
      'agent/get',
      'agent-fixed-asset/list-with-detail',
    ]);
    expect(invoke.mock.calls.some(([action]) => action === 'asset/get')).toBe(false);
  });

  it('uses one asset/list for five my-agents blocks and defaults a missing asset to no memory', async () => {
    const agents = Array.from({ length: 5 }, (_, index) => ({
      agent_id: `agent-${index}`,
      team_id: TEAM_ID,
      owner_user_id: USER_ID,
      name: `Agent ${index}`,
    }));
    const { deps, invoke } = makeDeps((action) => {
      if (action === 'auth/verify') return authResponse();
      if (action === 'agent/list') return envelope({ items: agents, total: agents.length });
      if (action === 'asset/list') {
        return envelope({
          items: [asset(`chat_memory-${TEAM_ID}-agent-0`, { last_memory_at: '2026-08-22T00:00:00.000Z' })],
          total: 1,
          limit: 20,
          offset: 0,
        });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await post(appWith(deps), '/chat-memory/my-agents', { team_id: TEAM_ID });
    expect(result.data.items).toHaveLength(5);
    expect(result.data.items[0]).toMatchObject({ last_memory_at_ms: Date.parse('2026-08-22T00:00:00.000Z') });
    expect(result.data.items[4]).toMatchObject({ updated_at_ms: 0, last_memory_at_ms: null });
    expect(invoke.mock.calls.filter(([action]) => action === 'asset/list')).toHaveLength(1);
    expect(invoke.mock.calls.some(([action]) => action === 'asset/get')).toBe(false);
  });

  it('continues my-agents asset/list by offset when the first page is incomplete', async () => {
    const agents = Array.from({ length: 21 }, (_, index) => ({
      agent_id: `agent-${index}`,
      team_id: TEAM_ID,
      owner_user_id: USER_ID,
      name: `Agent ${index}`,
    }));
    const firstPage = agents.slice(0, 20).map((a) => asset(`chat_memory-${TEAM_ID}-${a.agent_id}`));
    const lastAsset = asset(`chat_memory-${TEAM_ID}-agent-20`, {
      last_memory_at: '2026-08-23T00:00:00.000Z',
    });
    const { deps, invoke } = makeDeps((action, body) => {
      if (action === 'auth/verify') return authResponse();
      if (action === 'agent/list') return envelope({ items: agents, total: agents.length });
      if (action === 'asset/list') {
        if (body.offset === undefined) {
          return envelope({ items: firstPage, total: 21, limit: 20, offset: 0 });
        }
        expect(body.offset).toBe(20);
        return envelope({ items: [lastAsset], total: 21, limit: 20, offset: 20 });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await post(appWith(deps), '/chat-memory/my-agents', { team_id: TEAM_ID });
    expect(result.data.items).toHaveLength(21);
    expect(result.data.items[20]).toMatchObject({ last_memory_at_ms: Date.parse('2026-08-23T00:00:00.000Z') });
    expect(invoke.mock.calls.filter(([action]) => action === 'asset/list')).toHaveLength(2);
  });

  it('maps mine last memory time without changing updated metadata', async () => {
    const { deps } = makeDeps((action) => {
      if (action === 'auth/verify') return authResponse();
      if (action === 'asset/list') {
        return envelope({
          items: [asset('mine-1', { owner_user_id: USER_ID, last_memory_at: '2026-08-24T01:02:03.000Z' })],
          total: 1,
          limit: 20,
          offset: 0,
        });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    const result = await post(appWith(deps), '/chat-memory/mine', { team_id: TEAM_ID });
    expect(result.data.items[0]).toMatchObject({
      updated_at_ms: Date.parse('2026-08-01T00:00:00.000Z'),
      last_memory_at_ms: Date.parse('2026-08-24T01:02:03.000Z'),
    });
  });
});
