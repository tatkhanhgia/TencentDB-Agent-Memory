/**
 * AssetStatePanel — khuôn dùng chung cho 3 trạng thái không-có-danh-sách của 4 trang
 * tài sản: rỗng · lọc-không-ra · lỗi tải. Kèm khuôn skeleton lúc đang tải.
 *
 * PLAN §3.3 (PO ký): bốn trang phải dùng CHUNG một component — cùng vị trí, canh lề,
 * cỡ icon, cỡ chữ, vị trí nút hành động. Vì vậy component này KHÔNG có prop kích cỡ:
 * mọi kích thước do CSS quyết định, người gọi chỉ truyền nội dung.
 */
import type { ReactNode } from 'react';
import './asset-state-panel.css';

export type AssetStateTone = 'empty' | 'filtered' | 'error';

interface AssetStatePanelProps {
  /** 'empty' = chưa có gì · 'filtered' = lọc không ra · 'error' = tải hỏng */
  tone?: AssetStateTone;
  /** Icon truyền TRẦN, KHÔNG kèm prop size — cỡ do `._aes-icon svg` ấn định 32px. */
  icon: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  /** Nút hành động; luôn nằm cuối khối, cách desc 16px. */
  action?: ReactNode;
}

export function AssetStatePanel({
  tone = 'empty',
  icon,
  title,
  desc,
  action,
}: AssetStatePanelProps) {
  return (
    <div className={`_aes _aes--${tone}`}>
      <div className="_aes-icon">{icon}</div>
      <div className="_aes-title">{title}</div>
      {desc != null && <div className="_aes-desc">{desc}</div>}
      {action != null && <div className="_aes-action">{action}</div>}
    </div>
  );
}

/**
 * AssetSkeleton — khuôn đang-tải dùng chung.
 *   variant="rows" → cho cột danh sách 280px (Skills / Chat_Memory)
 *   variant="grid" → cho lưới thẻ trang rộng (Wiki / Code)
 * Dùng đúng mẫu shimmer mà G1/G4 đã chốt ở `_memory-agents-skeleton-*` /
 * `_memory-workbench-skeleton-*` — token đã kiểm là CÓ THẬT, xem SPEC §7.
 */
export function AssetSkeleton({
  variant,
  count = 4,
}: {
  variant: 'rows' | 'grid';
  count?: number;
}) {
  return (
    <div className={`_ask _ask--${variant}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="_ask-card">
          <div className="_ask-line _ask-line--primary" />
          <div className="_ask-line _ask-line--secondary" />
        </div>
      ))}
    </div>
  );
}
