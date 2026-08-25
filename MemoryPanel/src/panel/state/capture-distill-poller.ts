import type { InstanceEntry, InstanceRegistry } from '../config/instance-registry.js';
import type { PanelConfig } from '../config/panel-config.js';
import type { Logger } from '../infra/logger.js';
import type { KernelHttpPort } from '../kernel/ports/kernel-http-port.js';
import type { MetaCallContext } from '../kernel/types.js';
import type { CaptureRun, DistillLayerStatus, DistillRunStatus } from '../domain/capture-run.js';
import { readAtomicCount, readPipelineStatus } from '../http/routes/capture.js';
import { CaptureRunRegistry, type DistillWatchRun } from './capture-run-registry.js';

const LAYERS = ['l1', 'l2', 'l3'] as const;
type LayerKey = (typeof LAYERS)[number];

export interface CaptureDistillPollerDeps {
  config: PanelConfig;
  instanceRegistry: InstanceRegistry;
  kernelHttp: KernelHttpPort;
  captureRunRegistry: CaptureRunRegistry;
  logger: Logger;
}

/**
 * Observes kernel distillation without depending on an open browser tab.
 * The registry owns persistence; this class only schedules reads and computes
 * monotonic transitions for each run.
 */
export class CaptureDistillPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private inFlight = false;
  private rerun = false;
  private readonly corroborationRequested = new Set<string>();

  constructor(private readonly deps: CaptureDistillPollerDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.requestPoll(0);
  }

  stop(): void {
    this.started = false;
    this.rerun = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  notify(): void {
    if (!this.started) return;
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.requestPoll(0);
  }

  /** Exposed for deterministic unit and operational smoke tests. */
  async pollOnce(now = Date.now()): Promise<void> {
    const { captureRunRegistry, config } = this.deps;
    await captureRunRegistry.expireStaleRuns(now, config.capture.staleRunMs);
    await captureRunRegistry.expireDistillRuns(now, config.capture.distillWatchMs);
    const runs = captureRunRegistry.watchableRuns(now, config.capture.distillWatchMs);
    if (runs.length === 0) return;

    const groups = new Map<string, { entry: InstanceEntry; runs: DistillWatchRun[] }>();
    const missingInstanceRuns: DistillWatchRun[] = [];
    for (const run of runs) {
      const entry = this.resolveInstance(run);
      if (!entry) {
        missingInstanceRuns.push(run);
        continue;
      }
      const group = groups.get(entry.instance_id) ?? { entry, runs: [] };
      group.runs.push(run);
      groups.set(entry.instance_id, group);
    }

    for (const run of missingInstanceRuns) {
      await captureRunRegistry.setDistill(run.run_id, { observable: false });
    }

    await Promise.all([...groups.values()].map(async ({ entry, runs: groupedRuns }) => {
      const context = instanceContext(entry);
      for (const run of groupedRuns) {
        const pipeline = await readPipelineStatus(this.deps, context, run.session_id);
        if (!pipeline.observable) {
          await captureRunRegistry.setDistill(run.run_id, { observable: false });
          continue;
        }
        await this.observeRun(run, pipeline, context, now);
      }
    }));
  }

  private async observeRun(
    run: DistillWatchRun,
    pipeline: Awaited<ReturnType<typeof readPipelineStatus>>,
    context: MetaCallContext,
    now: number,
  ): Promise<void> {
    const current = run.distill ?? pendingDistill();
    const next = cloneDistill(current);
    const leftQueue: LayerKey[] = [];
    const nowIso = new Date(now).toISOString();

    for (const layer of LAYERS) {
      const existing = next[layer] ?? pendingLayer();
      if (existing.state === 'left_queue' || existing.state === 'unobserved') continue;
      const observed = pipeline[layer]?.observed;
      if (observed === 'queued' || observed === 'running') {
        next[layer] = {
          ...existing,
          state: existing.state === 'running' && observed === 'queued' ? 'running' : observed,
          first_seen_at: existing.first_seen_at ?? nowIso,
        };
      } else if (existing.state === 'queued' || existing.state === 'running') {
        next[layer] = { ...existing, state: 'left_queue', left_queue_at: existing.left_queue_at ?? nowIso };
        leftQueue.push(layer);
      }
    }

    await this.deps.captureRunRegistry.setDistill(run.run_id, next, nowIso);
    for (const layer of leftQueue) {
      await this.corroborate(run, layer, context, nowIso);
    }
  }

  private async corroborate(
    run: CaptureRun,
    layer: LayerKey,
    context: MetaCallContext,
    queriedAt: string,
  ): Promise<void> {
    const key = `${run.run_id}:${layer}`;
    if (this.corroborationRequested.has(key)) return;
    this.corroborationRequested.add(key);
    try {
      const count = await readAtomicCount(this.deps, context, run);
      if (count === null) return;
      const current = this.deps.captureRunRegistry.list({ limit: 200 })
        .find((candidate) => candidate.run_id === run.run_id);
      if (!current?.distill) return;
      const next = cloneDistill(current.distill);
      const status = next[layer] ?? pendingLayer();
      next[layer] = { ...status, corroboration: { count, queried_at: queriedAt } };
      await this.deps.captureRunRegistry.setDistill(run.run_id, next, queriedAt);
    } catch (error) {
      this.deps.logger.warn('capture distillation corroboration failed', {
        run_id: run.run_id,
        layer,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveInstance(run: DistillWatchRun): InstanceEntry | null {
    const entries = this.deps.instanceRegistry.listAll();
    if (run.instance_id) {
      return entries.find((entry) => entry.instance_id === run.instance_id) ?? null;
    }
    return entries.length === 1 ? entries[0] ?? null : null;
  }

  private requestPoll(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.pollOnce();
    } catch (error) {
      this.deps.logger.warn('capture distillation poll failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
      if (!this.started) return;
      // Keep ticking even with nothing watchable: abandoned runs are only ever
      // reaped from inside a poll, and they carry no watchable state at all.
      const immediate = this.rerun;
      this.rerun = false;
      this.requestPoll(immediate ? 0 : this.deps.config.capture.distillPollMs);
    }
  }
}

function instanceContext(entry: InstanceEntry): MetaCallContext {
  return {
    instanceId: entry.instance_id,
    gatewayEndpoint: entry.gateway_endpoint,
    gatewayApiKey: entry.api_key,
  };
}

function pendingLayer(): DistillLayerStatus {
  return { state: 'pending', first_seen_at: null, left_queue_at: null };
}

function pendingDistill(): DistillRunStatus {
  return { observable: true, l1: pendingLayer(), l2: pendingLayer(), l3: pendingLayer() };
}

function cloneDistill(value: DistillRunStatus): DistillRunStatus {
  return JSON.parse(JSON.stringify(value)) as DistillRunStatus;
}
