/**
 * theme.ts — nguồn duy nhất cho preference theme của panel.
 *
 * Hợp đồng (SPEC-M1 §3.2):
 *   - preference là source of truth DUY NHẤT; không lưu resolved theme riêng.
 *   - `system` được resolve bằng `prefers-color-scheme` tại thời điểm áp dụng.
 *   - Luôn đặt cả `data-ui-skin="v2"` và `theme-mode` trên <html>.
 *
 * M1 chỉ cung cấp API này; công tắc theme nhìn thấy trong header là việc của M3.
 * Không đưa logic vào React state/ConfigProvider vì tea-component 2.8.0 không có
 * theme API — theme sống ở thuộc tính trên <html>, ngoài vòng đời React.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'tdai-panel.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * HMR của Vite nạp lại module thành một instance MỚI, nên biến module-scope của
 * instance cũ biến mất cùng nó. Muốn "gọi lại thì tháo listener cũ trước" đúng cả
 * qua HMR thì bản ghi teardown phải sống ngoài module — đây là chi tiết nội bộ,
 * không thuộc API export.
 */
type TeardownHost = typeof globalThis & { __tdaiThemeSyncTeardown?: () => void };

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Cùng validation/fallback/try-catch với inline bootstrap trong index.html. */
export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    // storage bị chặn (private mode, chặn site data) → coi như chưa chọn gì
  }
  return 'system';
}

export function getResolvedTheme(
  preference: ThemePreference = getThemePreference(),
): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  root.setAttribute('data-ui-skin', 'v2');
  root.setAttribute('theme-mode', getResolvedTheme(preference));
}

/** Ghi preference và áp ngay; không reload trang. */
export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ghi hỏng thì vẫn áp cho phiên hiện tại, không làm vỡ UI
  }
  applyTheme(preference);
}

/**
 * Áp theme hiện tại rồi giữ đồng bộ: `storage` cho đa tab, `matchMedia` cho OS.
 * Idempotent — gọi lại sẽ tháo lần chạy trước. Trả về teardown tháo đủ listener.
 */
export function startThemeSync(): () => void {
  const host = globalThis as TeardownHost;
  host.__tdaiThemeSyncTeardown?.();

  applyTheme(getThemePreference());

  const media = window.matchMedia(DARK_QUERY);

  // OS đổi màu chỉ có ý nghĩa khi người dùng đang để 'system'.
  const onMediaChange = (): void => {
    if (getThemePreference() === 'system') applyTheme('system');
  };

  // key === null nghĩa là localStorage.clear() — vẫn phải áp lại.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyTheme(getThemePreference());
  };

  media.addEventListener('change', onMediaChange);
  window.addEventListener('storage', onStorage);

  const teardown = (): void => {
    media.removeEventListener('change', onMediaChange);
    window.removeEventListener('storage', onStorage);
    if (host.__tdaiThemeSyncTeardown === teardown) delete host.__tdaiThemeSyncTeardown;
  };

  host.__tdaiThemeSyncTeardown = teardown;
  return teardown;
}
