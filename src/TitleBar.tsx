// The Windows app has no standard caption: like Discord it draws its own slim title bar with the window buttons.
// The bar is a drag region (CSS app-region), so moving, snapping and double-click to maximize work natively.
import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { useStore, totalBadge } from './store';
import { isDesktop, sendNative } from './desktop';
import { t, lang } from './i18n';

let windowState = { maximized: false, fullscreen: false };
const listeners = new Set<() => void>();
if (isDesktop) {
  document.documentElement.classList.add('desktop-app');
  (window as any).chrome.webview.addEventListener('message', (e: any) => {
    if (e.data?.type !== 'window') return;
    windowState = { maximized: !!e.data.maximized, fullscreen: !!e.data.fullscreen };
    document.documentElement.classList.toggle('window-fullscreen', windowState.fullscreen);
    listeners.forEach((f) => f());
  });
  sendNative({ type: 'window', action: 'state' });
  // A desktop app has no browser menu: only text fields and selected text keep the native one (copy/paste).
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    if (e.defaultPrevented) return;
    if (el.closest('input, textarea, [contenteditable="true"]')) return;
    if (String(window.getSelection() || '').trim()) return;
    e.preventDefault();
  });
  // Images and links are not dragged out of the window like in a browser.
  document.addEventListener('dragstart', (e) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLImageElement || el instanceof HTMLAnchorElement) e.preventDefault();
  });
}

export function TitleBar() {
  const [, render] = useState(0);
  const status = useStore((s: any) => s.status);
  const badge = useStore((s: any) => (s.status === 'ready' ? totalBadge() : 0));
  useEffect(() => {
    const f = () => render((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  if (!isDesktop || windowState.fullscreen) return null;
  const act = (action: string) => sendNative({ type: 'window', action });
  return (
    <div className="titlebar">
      <div className="tb-title">
        <img src="/favicon.svg" alt="" width={14} height={14} draggable={false} />
        <span>{lang() === 'fa' ? 'همصحبت' : 'Hamsohbat'}</span>
        {badge > 0 && <span className="tb-badge">{badge}</span>}
        {status === 'reconnecting' && <span className="tb-status">{t('Reconnecting…')}</span>}
      </div>
      <div className="tb-buttons" dir="ltr">
        <button title={t('Minimize')} onClick={() => act('minimize')}>
          <Minus size={16} />
        </button>
        <button title={windowState.maximized ? t('Restore') : t('Maximize')} onClick={() => act('maximize')}>
          {windowState.maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12} />}
        </button>
        <button className="tb-close" title={t('Close')} onClick={() => act('close')}>
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
