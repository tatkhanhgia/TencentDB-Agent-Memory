import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  CloseIcon,
  ErrorCircleIcon,
  NextIcon,
  PauseCircleIcon,
  RefreshIcon,
  SlashIcon,
} from 'tea-icons-react';
import {
  captureApi,
  type CaptureRun,
} from '@/lib/api/capture';
import './capture-activity.css';

type LayerKey = 'l1' | 'l2' | 'l3';
type FlashState = { count: number; expiresAt: number };

const LAYERS: LayerKey[] = ['l1', 'l2', 'l3'];

function isDistillationActive(run: CaptureRun): boolean {
  return LAYERS.some((layer) => {
    const state = run.distill?.[layer]?.state;
    return state === 'queued' || state === 'running';
  });
}

function isRunActive(run: CaptureRun): boolean {
  return run.status === 'running' || isDistillationActive(run);
}

function formatClock(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatRelative(value: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return t('capture.relative.now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('capture.relative.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('capture.relative.hours', { count: hours });
  return t('capture.relative.days', { count: Math.floor(hours / 24) });
}

function kindCounts(run: CaptureRun) {
  const counts = run.kind_counts ?? { adr: 0, preference: 0, constraint: 0, other: 0 };
  return [
    ['adr', counts.adr],
    ['preference', counts.preference],
    ['constraint', counts.constraint],
    ['other', counts.other],
  ] as const;
}

type CaptureStatusKind =
  | 'running' | 'distilling' | 'written' | 'empty'
  | 'skipped' | 'dryrun' | 'refused' | 'error';

// Thu tu co y nghia: `running` truoc `distilling` de giu dung uu tien nhan cua
// runStatusKey ngay duoi. Dung dao hai dong do.
function runStatusKind(run: CaptureRun): CaptureStatusKind {
  if (run.status === 'error') return 'error';
  if (run.status === 'running') return 'running';
  if (isDistillationActive(run)) return 'distilling';
  if (run.status === 'written') return 'written';
  if (run.status === 'empty') return 'empty';
  if (run.status === 'skipped') return 'skipped';
  if (run.status === 'dry-run') return 'dryrun';
  if (run.status === 'refused_unbound') return 'refused';
  return 'error';
}

function runStatusKey(run: CaptureRun): string {
  if (run.status === 'running') return 'capture.status.running';
  if (isDistillationActive(run)) return 'capture.status.distilling';
  if (run.status === 'written') return 'capture.status.written';
  if (run.status === 'empty') return 'capture.status.empty';
  if (run.status === 'skipped') return 'capture.status.skipped';
  if (run.status === 'dry-run') return 'capture.status.dryRun';
  if (run.status === 'refused_unbound') return 'capture.status.refused';
  return 'capture.status.error';
}

function observedLayers(run: CaptureRun): LayerKey[] {
  return LAYERS.filter((layer) => {
    const state = run.distill?.[layer]?.state;
    return state === 'queued' || state === 'running';
  });
}

// 5 sac x 8 dau: moi cap (nen, icon) la duy nhat, nen 8 trang thai phan biet duoc
// ma khong phai doc chu (PLAN §3.3, PM-RULING-M5 §6).
const STATUS_ICON: Record<CaptureStatusKind, ReactNode> = {
  running: null,                               // spinner lo phan nay
  distilling: <RefreshIcon size={11} />,
  written: <CheckCircleIcon size={11} />,
  empty: <CircleIcon size={11} />,
  skipped: <NextIcon size={11} />,
  dryrun: <PauseCircleIcon size={11} />,
  refused: <SlashIcon size={11} />,
  error: <ErrorCircleIcon size={11} />,
};

function StatusChip({
  run,
  t,
}: {
  run: CaptureRun;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const kind = runStatusKind(run);
  return (
    <span className={`_capture-status-chip _capture-status-chip--${kind}`}>
      {isRunActive(run) && <span className="_capture-spinner" aria-hidden="true" />}
      {STATUS_ICON[kind] != null && (
        <span className="_capture-status-chip-icon" aria-hidden="true">{STATUS_ICON[kind]}</span>
      )}
      {t(runStatusKey(run))}
    </span>
  );
}

function PipelineSummary({
  run,
  t,
}: {
  run: CaptureRun;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!run.distill || !run.distill.observable) {
    return <p className="_capture-state-copy">{t('capture.state.notObservable')}</p>;
  }
  const activeLayers = observedLayers(run);
  if (activeLayers.length > 0) {
    return (
      <p className="_capture-state-copy">
        {activeLayers.map((layer, index) => {
          const state = run.distill?.[layer]?.state;
          return (
            <span key={layer}>
              {index > 0 && ' · '}
              {t(state === 'queued' ? 'capture.state.layerQueued' : 'capture.state.layerRunning', {
                layer: layer.toUpperCase(),
              })}
            </span>
          );
        })}
      </p>
    );
  }
  const completedLayers = LAYERS.filter((layer) => run.distill?.[layer]?.state === 'left_queue');
  const unobservedLayers = LAYERS.filter((layer) => run.distill?.[layer]?.state === 'unobserved');
  if (completedLayers.length > 0 || unobservedLayers.length > 0) {
    const messages = [
      ...completedLayers.map((layer) => {
        const status = run.distill?.[layer];
        const count = status?.corroboration?.count;
        return count !== undefined && count > 0
          ? t('capture.state.layerDone', {
            layer: layer.toUpperCase(),
            time: formatClock(status?.left_queue_at),
            count,
          })
          : t('capture.state.layerUnknown', {
            layer: layer.toUpperCase(),
            time: formatClock(status?.left_queue_at),
          });
      }),
      ...unobservedLayers.map((layer) => t('capture.state.layerUnobserved', { layer: layer.toUpperCase() })),
    ];
    return <p className={`_capture-state-copy ${completedLayers.some((layer) => (run.distill?.[layer]?.corroboration?.count ?? 0) === 0) ? '_capture-state-copy--amber' : ''}`}>{messages.join(' · ')}</p>;
  }
  if (run.status === 'running') {
    return <p className="_capture-state-copy">{t('capture.state.l0Writing')}</p>;
  }
  if (run.written_count > 0) {
    return <p className="_capture-state-copy">{t('capture.state.l0NoTask')}</p>;
  }
  return null;
}

function TimelineStage({
  run,
  layer,
  t,
}: {
  run: CaptureRun;
  layer: 'l0' | LayerKey;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  let state: 'done' | 'active' | 'unknown' | 'unavailable' | 'pending' = 'pending';
  let time: string | number | null | undefined;
  let label: string;

  if (layer === 'l0') {
    label = t(run.status === 'running' ? 'capture.timeline.l0Writing' : 'capture.timeline.l0');
    if (run.written_count > 0) {
      state = 'done';
      time = run.ended_at ?? run.started_at;
    } else if (run.status === 'running') {
      state = 'active';
      time = run.started_at;
    }
  } else {
    label = t(`capture.timeline.${layer}`);
    const pipeline = run.distill?.[layer];
    if (!run.distill?.observable) {
      state = 'unavailable';
    } else if (pipeline?.state === 'queued' || pipeline?.state === 'running') {
      state = 'active';
      time = pipeline?.first_seen_at;
    } else if (pipeline?.state === 'left_queue') {
      time = pipeline.left_queue_at;
      state = (pipeline.corroboration?.count ?? 0) > 0 ? 'done' : 'unknown';
    } else if (pipeline?.state === 'unobserved') {
      state = 'pending';
    }
  }

  const corroborationCount = layer !== 'l0' ? run.distill?.[layer]?.corroboration?.count : undefined;
  const tooltip = layer !== 'l0' && state === 'done'
    ? t('capture.state.layerDone.title', { count: corroborationCount })
    : undefined;

  return (
    <li className={`_capture-timeline-item _capture-timeline-item--${state}`}>
      <span className="_capture-timeline-icon" aria-hidden="true">
        {state === 'done' ? <CheckIcon size={12} /> : <span />}
      </span>
      <span className="_capture-timeline-content" title={tooltip}>
        <span className="_capture-timeline-label">{label}</span>
        <span className="_capture-timeline-time">
          {state === 'unknown'
            ? t('capture.timeline.unconfirmedAt', { time: formatClock(time) })
            : state === 'unavailable'
              ? t('capture.timeline.unavailable')
              : time
                ? formatClock(time)
                : t('capture.timeline.waiting')}
        </span>
      </span>
    </li>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
  onOpenL0,
  t,
}: {
  run: CaptureRun;
  expanded: boolean;
  onToggle: () => void;
  onOpenL0: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const kindLabels = kindCounts(run).filter(([, count]) => count > 0);
  return (
    <article className={`_capture-run ${expanded ? '_capture-run--expanded' : ''}`}>
      <button type="button" className="_capture-run-button" onClick={onToggle} aria-expanded={expanded}>
        <span className="_capture-run-main">
          <span className="_capture-run-topline">
            <span className="_capture-run-relative">{formatRelative(run.started_at, t)}</span>
            <StatusChip run={run} t={t} />
          </span>
          <span className="_capture-run-meta">
            <span className="_capture-run-agent">{run.agent_id || t('capture.agentUnknown')}</span>
            <span className="_capture-run-source">{run.source || t('capture.sourceUnknown')}</span>
          </span>
          <span className="_capture-run-counts">
            {t('capture.lessons', { count: run.written_count })}
            {kindLabels.length > 0 && (
              <span className="_capture-kind-distribution">
                {kindLabels.map(([kind, count]) => (
                  <span key={kind}>{t(`capture.kind.${kind}`)} {count}</span>
                ))}
              </span>
            )}
          </span>
        </span>
        <ChevronDownIcon size={14} className="_capture-run-chevron" aria-hidden="true" />
      </button>

      {expanded && (
        <div className="_capture-run-details">
          <div className="_capture-detail-header">
            <StatusChip run={run} t={t} />
            <span className="_capture-detail-route">{run.route || t('capture.routeUnknown')}</span>
          </div>
          <PipelineSummary run={run} t={t} />
          <ol className="_capture-timeline">
            {(['l0', ...LAYERS] as const).map((layer) => (
              <TimelineStage
                key={layer}
                run={run}
                layer={layer}
                t={t}
              />
            ))}
          </ol>
          <div className="_capture-detail-footer">
            <span className="_capture-detail-total">
              {t('capture.detail.total', { count: run.written_count })}
            </span>
            <button type="button" className="_capture-open-l0" onClick={onOpenL0}>
              {t('capture.openL0')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function CaptureActivity() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<CaptureRun[]>([]);
  const [offline, setOffline] = useState(false);
  const [unseenErrors, setUnseenErrors] = useState(0);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const previousRunsRef = useRef(new Map<string, CaptureRun>());
  const knownErrorIdsRef = useRef(new Set<string>());
  const drawerOpenRef = useRef(false);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      const result = await captureApi.listRuns();
      const nextRuns = Array.isArray(result.items) ? result.items : [];
      const previousRuns = previousRunsRef.current;
      let flashCount = 0;
      for (const run of nextRuns) {
        const previous = previousRuns.get(run.run_id);
        if (previous && run.status === 'written' && run.written_count > 0 && (
          previous.status !== 'written' || previous.written_count !== run.written_count
        )) {
          flashCount += run.written_count;
        }
      }
      if (flashCount > 0) setFlash({ count: flashCount, expiresAt: Date.now() + 10000 });

      const newErrorCount = nextRuns.filter(
        (run) => run.status === 'error' && !knownErrorIdsRef.current.has(run.run_id),
      ).length;
      for (const run of nextRuns) {
        if (run.status === 'error') knownErrorIdsRef.current.add(run.run_id);
      }
      if (newErrorCount > 0 && !drawerOpenRef.current) {
        setUnseenErrors((count) => count + newErrorCount);
      }

      previousRunsRef.current = new Map(nextRuns.map((run) => [run.run_id, run]));
      setRuns(nextRuns);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const activeCount = useMemo(
    () => runs.filter((run) => run.status === 'running').length,
    [runs],
  );
  const hasActivePipeline = useMemo(() => runs.some(isRunActive), [runs]);
  const pollDelay = open || hasActivePipeline ? 2000 : 12000;

  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      stop();
      if (document.hidden) return;
      void refresh();
      timer = window.setInterval(() => {
        if (!document.hidden) void refresh();
      }, pollDelay);
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [pollDelay, refresh]);

  useEffect(() => {
    if (!flash) return undefined;
    const remaining = Math.max(0, flash.expiresAt - Date.now());
    const timer = window.setTimeout(() => setFlash(null), remaining);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const runningRuns = useMemo(() => runs.filter(isRunActive), [runs]);
  const recentRuns = useMemo(() => runs.filter((run) => !isRunActive(run)), [runs]);

  const openDrawer = () => {
    drawerOpenRef.current = true;
    setOpen(true);
    setUnseenErrors(0);
  };
  const closeDrawer = () => {
    drawerOpenRef.current = false;
    setOpen(false);
  };
  const openL0 = (run: CaptureRun) => {
    const query = new URLSearchParams({ layer: 'L0' });
    if (run.agent_id) query.set('agent_id', run.agent_id);
    closeDrawer();
    navigate(`/memory?${query.toString()}`);
  };

  let badgeContent;
  if (flash) {
    badgeContent = <span>{t('capture.badge.recorded', { count: flash.count })}</span>;
  } else if (activeCount > 0) {
    badgeContent = (
      <>
        <span className="_capture-spinner" aria-hidden="true" />
        <span>{t('capture.badge.capturing', { count: activeCount })}</span>
      </>
    );
  } else if (unseenErrors > 0) {
    badgeContent = (
      <>
        <span className="_capture-error-dot" aria-hidden="true" />
        <span>{t('capture.badge.errors', { count: unseenErrors })}</span>
      </>
    );
  } else {
    badgeContent = (
      <>
        <span className="_capture-neutral-dot" aria-hidden="true" />
        <span>{t('header.sync')}</span>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`_memory-global-header-sync _capture-badge ${unseenErrors > 0 ? '_capture-badge--error' : ''}`}
        title={t('header.sync.title')}
        aria-label={t('header.sync.title')}
        onClick={openDrawer}
      >
        {badgeContent}
      </button>

      {open && (
        <div className="_capture-overlay" role="presentation">
          <button type="button" className="_capture-backdrop" aria-label={t('capture.close')} onClick={closeDrawer} />
          <aside className="_capture-drawer" aria-label={t('capture.title')}>
            <div className="_capture-drawer-header">
              <div>
                <h2>{t('capture.title')}</h2>
                <p>{t('capture.subtitle')}</p>
              </div>
              <button type="button" className="_capture-close" aria-label={t('capture.close')} onClick={closeDrawer}>
                <CloseIcon size={16} />
              </button>
            </div>

            {offline && <div className="_capture-offline">{t('capture.state.offline')}</div>}

            {!offline && <div className="_capture-drawer-body">
              <section className="_capture-section">
                <div className="_capture-section-heading">
                  <h3>{t('capture.running')}</h3>
                  <span>{runningRuns.length}</span>
                </div>
                {runningRuns.length > 0 ? runningRuns.map((run) => (
                  <RunRow
                    key={run.run_id}
                    run={run}
                    expanded={expandedRunId === run.run_id}
                    onToggle={() => setExpandedRunId((id) => (id === run.run_id ? null : run.run_id))}
                    onOpenL0={() => openL0(run)}
                    t={t}
                  />
                )) : <p className="_capture-empty">{t('capture.noRunning')}</p>}
              </section>

              <section className="_capture-section">
                <div className="_capture-section-heading">
                  <h3>{t('capture.recent')}</h3>
                  <span>{recentRuns.length}</span>
                </div>
                {recentRuns.length > 0 ? recentRuns.map((run) => (
                  <RunRow
                    key={run.run_id}
                    run={run}
                    expanded={expandedRunId === run.run_id}
                    onToggle={() => setExpandedRunId((id) => (id === run.run_id ? null : run.run_id))}
                    onOpenL0={() => openL0(run)}
                    t={t}
                  />
                )) : <p className="_capture-empty">{t('capture.noRecent')}</p>}
              </section>
            </div>}
          </aside>
        </div>
      )}
    </>
  );
}
