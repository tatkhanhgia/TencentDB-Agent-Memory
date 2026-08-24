import type { TFunction } from 'i18next';

export interface BlockTimeKeys {
  lastMemory: string;
  updated: string;
  empty: string;
}

/**
 * 一行显示 memory block 的时间信息。优先显示最新 memory 时间；没有时回退到
 * metadata 更新时间；两者都没有时显示「尚无记忆」，避免把 epoch 0 渲染成 1970。
 */
export function blockTimeLabel(
  block: { last_memory_at_ms?: number | null; updated_at_ms?: number | null },
  t: TFunction,
  keys: BlockTimeKeys,
): string {
  const lastMemoryAt = validTimestamp(block.last_memory_at_ms);
  if (lastMemoryAt !== null) {
    return t(keys.lastMemory, { time: new Date(lastMemoryAt).toLocaleString() });
  }

  const updatedAt = validTimestamp(block.updated_at_ms);
  if (updatedAt !== null) {
    return t(keys.updated, { time: new Date(updatedAt).toLocaleString() });
  }

  return t(keys.empty);
}

function validTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
