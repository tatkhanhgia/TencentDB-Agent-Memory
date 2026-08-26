/**
 * 颜色工具 — 从 App.tsx 抽出
 *
 * 团队头像配色：按 team_id 稳定取色，确保同一团队始终显示同一颜色。
 *
 * M5 N3: bỏ 10 class Tailwind `bg-*-500`. Chúng nằm ngoài hệ token và cặp
 * (nền, chữ) trượt WCAG AA nặng — `bg-emerald-500` #10b981 với
 * `--tea-color-text-on-bg-brand-default` chỉ đạt 2,31:1 ở CẢ hai theme.
 * Nay mỗi sắc là một class có token riêng, khai ở `theme-tokens.css` và lật
 * theo theme; 10 sắc vẫn phân biệt được nhau vì giữ nguyên 10 tông màu cũ.
 */

/** 团队头像配色列表（class name，token khai ở theme-tokens.css） */
export const TEAM_AVATAR_COLORS = [
  '_team-avatar--rose',
  '_team-avatar--amber',
  '_team-avatar--blue',
  '_team-avatar--emerald',
  '_team-avatar--violet',
  '_team-avatar--cyan',
  '_team-avatar--orange',
  '_team-avatar--pink',
  '_team-avatar--teal',
  '_team-avatar--indigo',
];

/** Sắc dùng khi chưa chọn team nào. */
export const TEAM_AVATAR_FALLBACK = '_team-avatar--none';

/**
 * 根据 seed（通常是 team_id）稳定取一个头像配色 class。
 * 同一 seed 始终返回同一颜色（hàm băm giữ nguyên như trước, nên team không đổi sắc).
 */
export function teamColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TEAM_AVATAR_COLORS[h % TEAM_AVATAR_COLORS.length];
}
