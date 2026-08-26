/**
 * Regression tests for the L2/L1 race.
 *
 * Before the fix, L1 took a *session*-level lock while L2 took an *agent*-level
 * one, so an L2 timer that expired mid-L1 ran anyway, found nothing new, and its
 * "skip" suppressed the L3 cascade for that round. The guard reconstructs the
 * key the running L1 would be holding and postpones the round instead.
 */
import { describe, it, expect, vi } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import type { IStateBackend, TaskPayload } from "../core/state/types.js";

const INSTANCE = "default";
const TEAM = "team-vuu5jktlav";
const AGENT = "agt-ghsrnvreea";
const SOURCE_SESSION = "reflect:594f6994-7b70-4fa3-8d1b-f5f962ccc79c";
const L2_SESSION = `profile:team:${TEAM}|agent:${AGENT}|session:${encodeURIComponent(SOURCE_SESSION)}`;

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function l2Task(): TaskPayload {
  return {
    id: "L2-test-1",
    type: "L2",
    instanceId: INSTANCE,
    sessionId: L2_SESSION,
    teamId: TEAM,
    agentId: AGENT,
    priority: 1,
    data: { instanceId: INSTANCE, teamId: TEAM, agentId: AGENT },
    createdAt: 0,
  } as TaskPayload;
}

function l1Task(): TaskPayload {
  return {
    id: "L1-test-1",
    type: "L1",
    instanceId: INSTANCE,
    sessionId: SOURCE_SESSION,
    teamId: TEAM,
    agentId: AGENT,
    priority: 0,
    data: { instanceId: INSTANCE, teamId: TEAM, agentId: AGENT },
    createdAt: 0,
  } as TaskPayload;
}

/** Minimal backend: only what processTask touches, plus a real lock table. */
function makeBackend(heldLocks: Set<string>) {
  return {
    acquireLock: vi.fn(async (key: string) => {
      if (heldLocks.has(key)) return false;
      heldLocks.add(key);
      return true;
    }),
    releaseLock: vi.fn(async (key: string) => { heldLocks.delete(key); }),
    renewLock: vi.fn(async () => true),
    ackTask: vi.fn(async () => {}),
    enqueueTask: vi.fn(async () => {}),
    updateSessionState: vi.fn(async () => {}),
    removeTimer: vi.fn(async () => {}),
  } as unknown as IStateBackend;
}

function makeWorker(backend: IStateBackend, extra: Record<string, unknown> = {}) {
  const executor = {
    executeL1: vi.fn(async () => {}),
    executeL2: vi.fn(async () => {}),
    executeL3: vi.fn(async () => {}),
  };
  const worker = new PipelineWorker(
    backend,
    executor,
    { workerId: "worker-test", lockRenewIntervalMs: 1_000_000, ...extra },
    silentLogger,
  );
  return { worker, executor };
}

describe("L2/L1 race guard", () => {
  it("derives the exact lock key the running L1 holds", () => {
    const backend = makeBackend(new Set());
    const { worker } = makeWorker(backend);
    const guardKey = (worker as any).getL1GuardLockKey(l2Task());
    const l1LockKey = (worker as any).getLockKey(l1Task());
    expect(guardKey).toBe(l1LockKey);
    expect(guardKey).toBe(`pipeline:{${INSTANCE}:${TEAM}:${AGENT}}:s:${SOURCE_SESSION}`);
  });

  it("defers the L2 round while an L1 for the same source session is running", async () => {
    const held = new Set<string>();
    const backend = makeBackend(held);
    const onL2Deferred = vi.fn(async () => {});
    const { worker, executor } = makeWorker(backend, { onL2Deferred });

    // Simulate the in-flight L1 by holding its lock.
    held.add((worker as any).getLockKey(l1Task()));

    await (worker as any).processTask(l2Task());

    expect(executor.executeL2).not.toHaveBeenCalled();
    // Round postponed, not dropped.
    expect(onL2Deferred).toHaveBeenCalledWith(L2_SESSION, INSTANCE, TEAM, AGENT);
    expect(worker.getMetrics().l2DeferredForL1).toBe(1);
  });

  it("runs L2 normally when no L1 is in flight, and leaves no guard lock behind", async () => {
    const held = new Set<string>();
    const backend = makeBackend(held);
    const onL2Deferred = vi.fn(async () => {});
    const { worker, executor } = makeWorker(backend, { onL2Deferred });

    await (worker as any).processTask(l2Task());

    expect(executor.executeL2).toHaveBeenCalledTimes(1);
    expect(onL2Deferred).not.toHaveBeenCalled();
    // Probe-and-release: a later L1 must not be blocked by the guard.
    expect(held.has((worker as any).getLockKey(l1Task()))).toBe(false);
  });

  it("does not guard agent-wide L2 keys that carry no source session", () => {
    const backend = makeBackend(new Set());
    const { worker } = makeWorker(backend);
    const agentWide = { ...l2Task(), sessionId: `profile:team:${TEAM}|agent:${AGENT}` };
    expect((worker as any).getL1GuardLockKey(agentWide)).toBeNull();
  });

  it("does not guard when the lock is already instance-wide (L1 and L2 share it)", () => {
    const backend = makeBackend(new Set());
    const { worker } = makeWorker(backend, { lockGranularity: "instance" });
    expect((worker as any).getL1GuardLockKey(l2Task())).toBeNull();
  });
});

describe("L2 extraction failure is not 'no new data'", () => {
  it("re-arms the L2 timer and does not enqueue L3 when extraction failed", async () => {
    const backend = makeBackend(new Set());
    const onL2Deferred = vi.fn(async () => {});
    const onL2Complete = vi.fn(async () => {});
    const { worker } = makeWorker(backend, { onL2Deferred, onL2Complete });

    const task = l2Task();
    (task as any)._l2Failed = true;
    await (worker as any).cascadeSchedule(task);

    expect(onL2Deferred).toHaveBeenCalledWith(L2_SESSION, INSTANCE, TEAM, AGENT);
    expect(backend.enqueueTask).not.toHaveBeenCalled(); // no L3 cascade
    expect(onL2Complete).not.toHaveBeenCalled();        // no maxInterval arming
    expect(worker.getMetrics().l2ExtractionFailed).toBe(1);
  });

  it("still treats a genuine no-new-data round as a silent skip", async () => {
    const backend = makeBackend(new Set());
    const onL2Deferred = vi.fn(async () => {});
    const { worker } = makeWorker(backend, { onL2Deferred });

    const task = l2Task();
    (task as any)._l2Skipped = true;
    await (worker as any).cascadeSchedule(task);

    expect(onL2Deferred).not.toHaveBeenCalled();
    expect(backend.enqueueTask).not.toHaveBeenCalled();
    expect(worker.getMetrics().l2ExtractionFailed).toBe(0);
  });
});
