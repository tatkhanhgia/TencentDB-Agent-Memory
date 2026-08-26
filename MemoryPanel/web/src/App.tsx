/**
 * App.tsx — 根组件
 *
 * 职责：
 *   1. 管理登录态（zustand auth store，对接新面板 Control 的 sessionStorage 会话）
 *   2. 启动时读取本地会话缓存是否有效（checkSession）：
 *        - 检测中 → loading
 *        - 未登录 → LoginGate
 *        - 已登录 → RouterProvider（ConsoleLayout + pages）
 *   3. 初始化 team store 的事件同步
 *   4. 同步 react-i18next 语言 → tea-component ConfigProvider，
 *      让 tea-component 内置组件文案（StatusTip 加载中、Table 暂无数据 等）
 *      随用户切换语言自动跟随。
 */
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

/** react-i18next 语言 → tea-component locale 映射 */
function toTeaLocale(lang: string): 'zh' | 'en' {
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // 当前 tea-component locale，跟 react-i18next 同步
  const [teaLocale, setTeaLocale] = useState<'zh' | 'en'>(() => toTeaLocale(i18n.language));

  // 监听 react-i18next 语言切换，同步给 tea-component
  useEffect(() => {
    setTeaLocale(toTeaLocale(i18n.language));
    const handler = (lng: string) => setTeaLocale(toTeaLocale(lng));
    i18n.on('languageChanged', handler);
    return () => i18n.off('languageChanged', handler);
  }, [i18n]);

  // 启动时读取 sessionStorage 缓存的 { instance_id, user_key, user } 是否有效
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        // PLAN §4.6 / PM-LEDGER-COLOR-CLEANUP mục 6: bỏ 1 hex + 3 utility khoá màu.
        //
        // KHÔNG dùng biến thể tối của Tailwind ở đây. Repo không khai `darkMode` trong
        // `tailwind.config.js`, nên Tailwind rơi về mặc định `media`: biến thể đó nghe
        // `prefers-color-scheme` của HỆ ĐIỀU HÀNH, KHÔNG nghe `theme-mode` mà app đặt
        // trên <html>. Đã kiểm trong CSS đã build — nó biên dịch ra một khối
        // `@media (prefers-color-scheme: dark)`, và cả bundle có 0 rule dùng class
        // `.dark`. Tức màn này có thể tối trong khi app đang sáng.
        //
        // Token Tea flip theo `theme-mode` nên đi đúng hệ theme. Hai token dưới đây đã
        // kiểm CÓ THẬT trong `default-pack.css`, cả khối light lẫn dark (bug ở mục 4 của
        // sổ là dùng token KHÔNG tồn tại rồi rơi về fallback sáng); fallback giữ giá trị
        // light của chính token đó.
        //
        // Lưu ý cho người sửa sau: `content` của Tailwind quét cả comment trong `src`,
        // nên ĐỪNG viết nguyên văn tên class đã gỡ vào đây — làm vậy là dựng lại đúng
        // cái rule vừa xoá trong bundle, và làm mọi phép grep kiểm chứng báo dương tính giả.
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: 'var(--tea-color-bg-page-default, #f2f4f8)' }}
        >
          <div className="text-sm" style={{ color: 'var(--tea-color-text-secondary, rgba(0, 0, 0, 0.7))' }}>
            {t('app.checkingSession')}
          </div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale={teaLocale}>
      {content}
    </ConfigProvider>
  );
}
