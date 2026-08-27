/**
 * ThemeSwitcher — đổi theme trong header (D4; SPEC-M3 §3.2).
 *
 * Chỉ dùng API của `lib/theme.ts` dựng ở M1 — không có cơ chế lưu thứ hai (D2/D12),
 * không reload trang. Ba trạng thái `system | light | dark`; `system` bám
 * `prefers-color-scheme` của OS.
 */
import { Dropdown, List } from 'tea-component';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';

const OPTIONS: ThemePreference[] = ['system', 'light', 'dark'];

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());

  const apply = (next: ThemePreference) => {
    setThemePreference(next);
    setPreference(next);
  };

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button
          type="button"
          className="_memory-theme-switcher-btn"
          title={t('header.theme.label')}
          aria-label={t('header.theme.label')}
        >
          <span className="_memory-theme-switcher-glyph" aria-hidden="true">
            {preference === 'dark' ? '◐' : preference === 'light' ? '○' : '◑'}
          </span>
        </button>
      }
    >
      {() => (
        <List type="option">
          {OPTIONS.map((option) => (
            <List.Item key={option} selected={preference === option} onClick={() => apply(option)}>
              {t(`header.theme.${option}`)}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}
