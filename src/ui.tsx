import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useStore, closeModal, displayName } from './store';
import { t, lang } from './i18n';

const COLORS = ['#5865f2', '#3ba55d', '#faa81a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#e67e22'];
export const colorFor = (id: string) => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export function Avatar({ userId, size = 32, status = false, speaking = false }: { userId: string; size?: number; status?: boolean; speaking?: boolean }) {
  const user = useStore((s: any) => s.users[userId]);
  const presence = useStore((s: any) => (status ? s.presences[userId] || 'offline' : null));
  const name = user?.displayName || user?.username || '?';
  return (
    <div className={'avatar' + (speaking ? ' speaking' : '')} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {user?.avatar ? <img src={user.avatar} alt="" draggable={false} /> : <div className="avatar-fallback" style={{ background: colorFor(userId) }}>{[...name][0]?.toUpperCase()}</div>}
      {status && <span className={'status-dot ' + presence} style={{ width: size * 0.34, height: size * 0.34 }} />}
    </div>
  );
}

export function ServerIcon({ server, size = 48 }: { server: any; size?: number }) {
  return server.icon ? (
    <img className="server-img" src={server.icon} alt="" style={{ width: size, height: size }} draggable={false} />
  ) : (
    <div className="server-initials" style={{ width: size, height: size, fontSize: size * 0.34 }}>
      {server.name
        .split(/\s+/)
        .map((w: string) => [...w][0])
        .join('')
        .slice(0, 3)}
    </div>
  );
}

export function Modal({ title, children, onClose = closeModal, width = 440, className = '' }: any) {
  const closing = useStore((s: any) => !!s.modal?.closing);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className={'backdrop' + (closing ? ' closing' : '')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal ' + className} style={{ width }} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
              <X size={20} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}

export interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
  sep?: boolean;
  hidden?: boolean;
  custom?: React.ReactNode;
}
let showMenu: (m: { x: number; y: number; items: MenuItem[] } | null) => void = () => {};
/** Opens a context menu at the pointer (or under the clicked element when `anchor` is set). */
export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[], anchor = false) {
  e.preventDefault();
  e.stopPropagation();
  const list = items.filter((i) => !i.hidden);
  // Drop separators that ended up first, last or doubled after filtering.
  const clean = list.filter((it, i) => !it.sep || (i > 0 && i < list.length - 1 && !list[i - 1].sep));
  if (!clean.length) return;
  let x = e.clientX;
  let y = e.clientY;
  if (anchor) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = lang() === 'fa' ? r.right : r.left;
    y = r.bottom + 4;
  }
  showMenu({ x, y, items: clean });
}

export function MenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  showMenu = setMenu;
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(
    <div ref={ref} className="menu" style={pos} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : it.custom ? (
          <div key={i} className="menu-custom">
            {it.custom}
          </div>
        ) : (
          <button
            key={i}
            className={'menu-item' + (it.danger ? ' danger' : '')}
            onClick={() => {
              setMenu(null);
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.icon}
          </button>
        )
      )}
    </div>,
    document.body
  );
}

/** A floating panel anchored to an element, closed by clicking elsewhere. */
export function Popover({ anchor, onClose, children, placement = 'top' }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode; placement?: 'top' | 'bottom' | 'side' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    let left = a.left + a.width / 2 - r.width / 2;
    let top = placement === 'bottom' ? a.bottom + 8 : a.top - r.height - 8;
    if (placement === 'side') {
      left = lang() === 'fa' ? a.left - r.width - 8 : a.right + 8;
      if (left < 8 || left + r.width > window.innerWidth - 8) left = lang() === 'fa' ? a.right + 8 : a.left - r.width - 8;
      top = a.top;
    }
    if (top < 8) top = Math.min(a.bottom + 8, window.innerHeight - r.height - 8);
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - r.height - 8)),
    });
  }, [anchor, placement]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="popover" style={pos ? pos : { left: 0, top: 0, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body
  );
}

export function Toasts() {
  const toasts = useStore((s: any) => s.toasts);
  return createPortal(
    <div className="toasts" role="status">
      {toasts.map((x: any) => (
        <div key={x.id} className={'toast ' + x.kind}>
          {x.text}
        </div>
      ))}
    </div>,
    document.body
  );
}

export function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className={'field' + (error ? ' has-error' : '')}>
      <span className="field-label">
        {label}
        {error && <em> — {error}</em>}
      </span>
      {children}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={'toggle' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Name({ userId, serverId }: { userId: string; serverId?: string | null }) {
  useStore((s: any) => s.users[userId]);
  useStore((s: any) => (serverId ? s.servers[serverId]?.members[userId]?.nickname : null));
  return <>{displayName(userId, serverId)}</>;
}

export function fmtTime(ts: number) {
  const h24 = useStore.getState().settings.clock24;
  return new Intl.DateTimeFormat(lang() === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: !h24 }).format(ts);
}
export function fmtDate(ts: number) {
  return new Intl.DateTimeFormat(lang() === 'fa' ? 'fa-IR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(ts);
}
export function fmtStamp(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return t('Today at {time}', { time: fmtTime(ts) });
  if (diff === 1) return t('Yesterday at {time}', { time: fmtTime(ts) });
  return fmtDate(ts) + ' ' + fmtTime(ts);
}
export function fmtSize(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
export const num = (n: number) => (lang() === 'fa' ? n.toLocaleString('fa-IR') : String(n));
