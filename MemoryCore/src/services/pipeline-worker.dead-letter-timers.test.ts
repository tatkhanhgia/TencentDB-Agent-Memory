/**
 * Regression test for a silent defect: `moveToDeadLetter()` called
 * `buildPipelineTimerMember()` without importing it.
 *
 * The container runs TypeScript straight through `tsx`, which strips types but
 * does not check them, so nothing caught the missing binding at build time. At
 * runtime the call threw `ReferenceError`, and the surrounding
 * `try { … } catch { /* best effort *\/ }` swallowed it — so a dead-lettered
 * task never had its L1_idle / L2_schedule timers removed and left ghost timers
 * behind, with no log line to show for it.
 *
 * This test asserts the cleanup actually happens, so the defect cannot return
 * as another silent one.
 */
import { describe, it, expect, vi } from "vitest";
import { PipelineWorker } from "./pipeline-worker.js";
import { buildPipelineTimerMember } from "../core/state/timer-member.js";
import type { IStateBackend, TaskPayload } from "../core/state/types.js";

const INSTANCE = "default";
const TEAM = "team-vuu5jktlav";
const AGENT = "agt-ghsrnvreea";
const SESSION = "reflect:594f6994-7b70-4fa3-8d1b-f5f962ccc79c";

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function deadTask(): TaskPayload {
  return {
    id: "L1-dead-1",
    type: "L1",
    instanceId: INSTANCE,
    sessionId: SESSION,
    teamId: TEAM,
    agentId: AGENT,
    priority: 0,
    data: { instanceId: INSTANCE, teamId: TEAM, agentId: AGENT },
    createdAt: 0,
  } as TaskPayload;
}

function makeWorker() {
  const removeTimer = vi.fn(async () => {});
  const backend = {
    removeTimer,
    ackTask: vi.fn(async () => {}),
    enqueueTask: vi.fn(async () => {}),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
    renewLock: vi.fn(async () => true),
    updateSessionState: vi.fn(async () => {}),
  } as unknown as IStateBackend;
  const executor = {
    executeL1: vi.fn(async () => {}),
    executeL2: vi.fn(async () => {}),
    executeL3: vi.fn(async () => {}),
  };
  const worker = new PipelineWorker(backend, executor, { workerId: "worker-test" }, silentLogger);
  return { worker, backend, removeTimer };
}

describe("dead letter timer cleanup", () => {
  it("removes both pipeline timers for the dead task", async () => {
    const { worker, removeTimer } = makeWorker();

    await (worker as any).moveToDeadLetter(deadTask(), "boom", 3);

    const members = removeTimer.mock.calls.map((c) => c[1]);
    expect(members).toContain(buildPipelineTimerMember(SESSION, "L1_idle", { teamId: TEAM, agentId: AGENT }));
    expect(members).toContain(buildPipelineTimerMember(SESSION, "L2_schedule", { teamId: TEAM, agentId: AGENT }));
    expect(removeTimer).toHaveBeenCalledTimes(2);
    for (const call of removeTimer.mock.calls) expect(call[0]).toBe(INSTANCE);
  });

  it("still records the task in the dead letter queue", async () => {
    const { worker } = makeWorker();
    await (worker as any).moveToDeadLetter(deadTask(), "boom", 3);
    const dlq = worker.getDeadLetterQueue();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe("boom");
    expect(worker.getMetrics().tasksDeadLettered).toBe(1);
  });
});
