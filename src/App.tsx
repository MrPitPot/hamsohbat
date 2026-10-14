import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign, Bell, BellOff, Check, ChevronDown, Compass, Crown, FolderPlus, Hash, Headphones, HeadphoneOff, LogOut, Menu as MenuIcon, MessageCircle, Mic, MicOff, MonitorUp, MoreVertical,
  Phone, PhoneOff, Pin, Plus, Search, Settings, UserPlus, Users, Video, Volume2, X, Pencil, Trash2, MessagesSquare, UserRoundPen, CheckCheck, SignalHigh,
  CalendarDays, Download, Folder, FolderOpen, Link, MessageSquareText, ChevronRight, Archive, ArchiveRestore, Inbox, ShieldAlert, Clock,
} from 'lucide-react';
import {
  useStore, get, set, connect, login, act, toast, navigate, openModal, updateSettings, displayName, roleColor, findChannel, dmName, isUnread, showUnread, isMuted, toggleMute, totalBadge, mentionsIn, serverUnread, sortedDms,
  orderedChannels, voiceIn, can, canIn, markRead, openDm, startCall, permsIn, railOrder, threadsOf, closeModal, history_, P, CH, REL,
} from './store';
import { api } from './api';
import { voice } from './voice';
import { t } from './i18n';
import { Avatar, ServerIcon, MenuHost, Toasts, Field, Modal, openMenu, num, Name } from './ui';
import { plain } from './markdown';
import { ChannelIcon, ForumView, threadMenuItems } from './features/Channels';
import { EventStrip, ImportProgress } from './features/Server';
import { ActivityLine, resendPresenceExtras } from './features/Account';
import { SoundboardButton } from './features/Voice';
import { ChatPane } from './Chat';
import { VoiceStage, IncomingCall } from './VoiceUI';
import { ModalHost, memberMenu, STATUS_LABEL } from './Modals';
import { UpdateBanner } from './AppSettings';
import { TsSidebar, TsMain, TsRailItem } from './TeamSpeak';
import { isDesktop, setServerUrl } from './desktop';
import { TitleBar } from './TitleBar';

// ---------------------------------------------------------------- auth
function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ username: '', displayName: '', password: '', code: '' });
  const [mfa, setMfa] = useState(false);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const langNow = useStore((s: any) => s.settings.lang);
  const invite = location.pathname.startsWith('/invite/');
  useEffect(() => {
    api('GET', '/api/config').then((c) => setNeedsCode(c.needsCode)).catch(() => {});
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('POST', '/api/auth/' + mode, mode === 'login' ? { username: f.username, password: f.password, ...(mfa ? { code: otp } : {}) } : f);
      login(r.token);
    } catch (err: any) {
      // Accounts with two-factor auth need a code from the authenticator app.
      if (err.data?.mfa && !mfa) setMfa(true);
      else setError(t(err.message));
    }
    setBusy(false);
  };
  const up = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <h1>{mode === 'login' ? t('Welcome back!') : t('Create an account')}</h1>
        <p>{invite ? t('Sign in to accept your invite.') : mode === 'login' ? t("We're so excited to see you again!") : t('Pick a username and start talking with your friends.')}</p>
        <Field label={t('Username')}>
          <input dir="ltr" value={f.username} onChange={up('username')} required autoFocus autoComplete="username" maxLength={32} />
        </Field>
        {mode === 'register' && (
          <Field label={t('Display Name')}>
            <input dir="auto" value={f.displayName} onChange={up('displayName')} maxLength={32} placeholder={t('Optional')} />
          </Field>
        )}
        <Field label={t('Password')}>
          <input dir="ltr" type="password" value={f.password} onChange={up('password')} required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </Field>
        {mode === 'register' && needsCode && (
          <Field label={t('Registration Code')}>
            <input dir="ltr" value={f.code} onChange={up('code')} required />
          </Field>
        )}
        {mfa && mode === 'login' && (
          <Field label={t('Two-Factor Code')}>
            <input dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} maxLength={6} required autoFocus placeholder="123456" />
          </Field>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary wide" disabled={busy}>
          {mode === 'login' ? t('Log In') : t('Continue')}
        </button>
        <div className="auth-switch">
          {mode === 'login' ? t('Need an account?') : t('Already have an account?')}{' '}
          <a onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), setError(''))}>{mode === 'login' ? t('Register') : t('Log In')}</a>
        </div>
        {isDesktop && <DesktopServerField />}
        <a className="lang-switch" onClick={() => updateSettings({ lang: langNow === 'fa' ? 'en' : 'fa' })}>
          {langNow === 'fa' ? 'English' : 'فارسی'}
        </a>
      </form>
    </div>
  );
}

/** In the Windows app the interface is built in, so the login screen says which server it talks to. */
function DesktopServerField() {
  const d = useStore((s: any) => s.desktop);
  const [edit, setEdit] = useState(false);
  const [url, setUrl] = useState('');
  const current = d?.server || location.origin;
  if (!edit)
    return (
      <div className="server-line">
        {t('Server')}: <span dir="ltr">{current.replace(/^https?:\/\//, '')}</span>{' '}
        <a onClick={() => (setUrl(current), setEdit(true))}>{t('Change')}</a>
      </div>
    );
  return (
    <div className="copy-row server-line">
      <input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://chat.example.ir" />
      <button type="button" className="btn primary" onClick={() => setServerUrl(url.trim())}>
        {t('Connect')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- server rail
function RailItem({ active, unread, mentions, title, onClick, onContextMenu, children, className = '', drag }: any) {
  return (
    <div className={'rail-item ' + className + (active ? ' active' : '') + (unread ? ' unread' : '')} title={title} {...(drag || {})}>
      <span className="pill" />
      <button onClick={onClick} onContextMenu={onContextMenu} aria-label={title}>
        {children}
      </button>
      {mentions > 0 && <span className="badge">{mentions > 99 ? '99+' : num(mentions)}</span>}
    </div>
  );
}

const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#faa81a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#99aab5'];
type Folder = { id: string; name: string; color: string; servers: string[]; open?: boolean };

/** The rail as a list of entries: plain servers and folders, in the user's order. */
function railEntries(): ({ kind: 'server'; id: string } | { kind: 'folder'; folder: Folder })[] {
  const s = get();
  const folders: Folder[] = (s.settings.folders || []).map((f: Folder) => ({ ...f, servers: f.servers.filter((id) => s.servers[id]) })).filter((f: Folder) => f.servers.length);
  const inFolder = new Set(folders.flatMap((f) => f.servers));
  const out: any[] = [];
  const seen = new Set<string>();
  for (const id of railOrder()) {
    const f = folders.find((x) => x.servers.includes(id));
    if (f) {
      if (!seen.has(f.id)) out.push({ kind: 'folder', folder: f });
      seen.add(f.id);
    } else if (!inFolder.has(id)) out.push({ kind: 'server', id });
  }
  return out;
}
function saveRail(entries: ReturnType<typeof railEntries>) {
  const order: string[] = [];
  const folders: Folder[] = [];
  for (const e of entries) {
    if (e.kind === 'server') order.push(e.id);
    else {
      order.push(...e.folder.servers);
      if (e.folder.servers.length) folders.push(e.folder);
    }
  }
  updateSettings({ serverOrder: order, folders });
}
function removeFromFolders(entries: ReturnType<typeof railEntries>, id: string) {
  // A folder left with a single server stops being a folder (like Discord).
  return entries
    .filter((e) => !(e.kind === 'server' && e.id === id))
    .flatMap((e) => {
      if (e.kind !== 'folder' || !e.folder.servers.includes(id)) return [e];
      const rest = e.folder.servers.filter((x) => x !== id);
      if (rest.length > 1) return [{ ...e, folder: { ...e.folder, servers: rest } }];
      return rest.map((x) => ({ kind: 'server' as const, id: x }));
    });
}

function ServerRail() {
  const servers = useStore((s: any) => s.servers);
  useStore((s: any) => s.serverOrder);
  useStore((s: any) => s.settings.serverOrder);
  useStore((s: any) => s.settings.folders);
  const route = useStore((s: any) => s.route);
  const rels = useStore((s: any) => s.relationships);
  const meId = useStore((s: any) => s.me.id);
  useStore((s: any) => s.readStates);
  useStore((s: any) => s.dms);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; mode: 'before' | 'into' } | null>(null);
  const pending = Object.values(rels).filter((x) => x === REL.INCOMING).length;
  const unreadDms = sortedDms().filter((d) => mentionsIn(d.id) > 0);
  const entries = railEntries();
  const serverMenu = (e: React.MouseEvent, sv: any) =>
    openMenu(e, [
      { label: t('Mark As Read'), icon: <CheckCheck size={16} />, onClick: () => sv.channels.forEach((c: any) => (isUnread(c) || mentionsIn(c.id)) && markRead(c)) },
      { sep: true },
      { label: t('Invite People'), icon: <UserPlus size={16} />, hidden: !can(sv.id, P.CREATE_INVITE), onClick: () => openModal('invite', { serverId: sv.id }) },
      { label: isMuted(sv.id) ? t('Unmute Server') : t('Mute Server'), icon: isMuted(sv.id) ? <Bell size={16} /> : <BellOff size={16} />, onClick: () => toggleMute(sv.id) },
      { label: t('Notification Settings'), icon: <Bell size={16} />, onClick: () => openModal('notifications', { serverId: sv.id }) },
      { label: t('Events'), icon: <CalendarDays size={16} />, onClick: () => openModal('events', { serverId: sv.id }) },
      { label: t('Server Settings'), icon: <Settings size={16} />, hidden: !(permsIn(sv, meId) & SETTINGS_PERMS), onClick: () => openModal('serverSettings', { serverId: sv.id }) },
      { label: t('Create Folder'), icon: <FolderPlus size={16} />, hidden: entries.some((x) => x.kind === 'folder' && x.folder.servers.includes(sv.id)), onClick: () => makeFolder(sv.id) },
      { label: t('Remove from Folder'), icon: <FolderOpen size={16} />, hidden: !entries.some((x) => x.kind === 'folder' && x.folder.servers.includes(sv.id)), onClick: () => saveRail([...removeFromFolders(entries, sv.id), { kind: 'server', id: sv.id }]) },
      { sep: true },
      { label: t('Copy Server ID'), icon: <Hash size={16} />, onClick: () => navigator.clipboard?.writeText(sv.id) },
      { label: t('Leave Server'), icon: <LogOut size={16} />, danger: true, hidden: sv.ownerId === meId, onClick: () => leaveServer(sv) },
    ]);
  const makeFolder = (id: string) => {
    const f: Folder = { id: 'f' + Date.now().toString(36), name: '', color: FOLDER_COLORS[0], servers: [id], open: true };
    const at = entries.findIndex((e) => e.kind === 'server' && e.id === id);
    const next = [...entries];
    next.splice(at, 1, { kind: 'folder', folder: f });
    // A folder with one server is kept while it is open, so more can be dropped in.
    updateSettings({ folders: [...(get().settings.folders || []), f], serverOrder: next.flatMap((e) => (e.kind === 'server' ? [e.id] : e.folder.servers)) });
  };
  const folderMenu = (e: React.MouseEvent, f: Folder) =>
    openMenu(e, [
      { label: t('Mark Folder As Read'), icon: <CheckCheck size={16} />, onClick: () => f.servers.forEach((id) => servers[id]?.channels.forEach((c: any) => (isUnread(c) || mentionsIn(c.id)) && markRead(c))) },
      { label: t('Folder Settings'), icon: <Settings size={16} />, onClick: () => openModal('folder', { folderId: f.id }) },
      { sep: true },
      { label: t('Ungroup Folder'), icon: <FolderOpen size={16} />, danger: true, onClick: () => updateSettings({ folders: (get().settings.folders || []).filter((x: Folder) => x.id !== f.id) }) },
    ]);
  const setFolder = (f: Folder) => updateSettings({ folders: (get().settings.folders || []).map((x: Folder) => (x.id === f.id ? f : x)) });

  // Drag a server onto another one to make a folder (like Discord), or between servers to reorder.
  const dropOn = (targetId: string, mode: 'before' | 'into') => {
    const src = drag;
    setDrag(null);
    setOver(null);
    if (!src || src === targetId) return;
    let list = removeFromFolders(entries, src);
    const folderIdx = list.findIndex((e) => e.kind === 'folder' && e.folder.id === targetId);
    const folderOf = list.findIndex((e) => e.kind === 'folder' && e.folder.servers.includes(targetId));
    if (mode === 'into') {
      if (folderIdx >= 0) {
        const f = (list[folderIdx] as any).folder as Folder;
        list[folderIdx] = { kind: 'folder', folder: { ...f, servers: [...f.servers, src] } };
      } else if (folderOf >= 0) {
        const f = (list[folderOf] as any).folder as Folder;
        const i = f.servers.indexOf(targetId);
        list[folderOf] = { kind: 'folder', folder: { ...f, servers: [...f.servers.slice(0, i), src, ...f.servers.slice(i)] } };
      } else {
        const i = list.findIndex((e) => e.kind === 'server' && e.id === targetId);
        if (i < 0) return;
        list[i] = { kind: 'folder', folder: { id: 'f' + Date.now().toString(36), name: '', color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)], servers: [targetId, src], open: false } };
      }
    } else {
      let i = list.findIndex((e) => (e.kind === 'server' && e.id === targetId) || (e.kind === 'folder' && e.folder.id === targetId));
      if (i < 0) i = list.length;
      list.splice(i, 0, { kind: 'server', id: src });
    }
    saveRail(list);
  };
  const dnd = (id: string, isFolder = false) => ({
    draggable: !isFolder,
    onDragStart: (e: React.DragEvent) => {
      if (isFolder) return;
      setDrag(id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => (setDrag(null), setOver(null)),
    onDragOver: (e: React.DragEvent) => {
      if (!drag || drag === id) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mode = e.clientY - r.top < r.height * 0.3 ? 'before' : 'into';
      if (over?.id !== id || over.mode !== mode) setOver({ id, mode });
    },
    onDrop: (e: React.DragEvent) => (e.preventDefault(), over && dropOn(id, over.mode)),
    'data-drop': over?.id === id ? over.mode : undefined,
  });
  const serverItem = (id: string, inFolder = false) => {
    const sv = servers[id];
    if (!sv) return null;
    const u = serverUnread(sv);
    return (
      <RailItem
        key={id}
        title={sv.name}
        active={route.serverId === id}
        unread={u.unread}
        mentions={u.mentions}
        className={(inFolder ? 'in-folder ' : '') + (drag === id ? 'dragging' : '')}
        onClick={() => navigate(id)}
        onContextMenu={(e: any) => serverMenu(e, sv)}
        drag={dnd(id)}
      >
        <ServerIcon server={sv} />
        {voiceInServer(sv) && <span className="rail-voice" />}
      </RailItem>
    );
  };
  return (
    <nav className="rail">
      <RailItem active={!route.serverId} title={t('Direct Messages')} mentions={pending} onClick={() => navigate(null, null)} className="home">
        <MessageCircle size={26} />
      </RailItem>
      {unreadDms.map((d) => (
        <RailItem key={d.id} title={dmName(d)} mentions={mentionsIn(d.id)} active={route.channelId === d.id} onClick={() => navigate(null, d.id)} className="dm-bubble">
          {d.type === CH.DM ? <Avatar userId={d.recipients.find((r: string) => r !== meId)} size={48} /> : <div className="server-initials group"><Users size={22} /></div>}
        </RailItem>
      ))}
      <div className="rail-sep" />
      {entries.map((e) => {
        if (e.kind === 'server') return serverItem(e.id);
        const f = e.folder;
        let unread = false;
        let mentions = 0;
        for (const id of f.servers) {
          const u = serverUnread(servers[id]);
          unread ||= u.unread;
          mentions += u.mentions;
        }
        const activeIn = f.servers.includes(route.serverId);
        return (
          <div key={f.id} className={'rail-folder' + (f.open ? ' open' : '')} style={{ '--folder': f.color } as any}>
            <RailItem
              title={f.name || f.servers.map((id) => servers[id]?.name).join(', ')}
              active={activeIn && !f.open}
              unread={!f.open && unread}
              mentions={f.open ? 0 : mentions}
              className="folder-head"
              onClick={() => setFolder({ ...f, open: !f.open })}
              onContextMenu={(ev: any) => folderMenu(ev, f)}
              drag={dnd(f.id, true)}
            >
              {f.open ? (
                <Folder size={22} />
              ) : (
                <div className="folder-grid">
                  {f.servers.slice(0, 4).map((id) => (
                    <ServerIcon key={id} server={servers[id]} size={18} />
                  ))}
                </div>
              )}
            </RailItem>
            {f.open && f.servers.map((id) => serverItem(id, true))}
          </div>
        );
      })}
      <TsRailItem />
      <RailItem title={t('Add a Server')} onClick={() => openModal('createServer')} className="add">
        <Plus size={24} />
      </RailItem>
      <RailItem title={t('Import from Discord')} onClick={() => openModal('discordImport')} className="add">
        <Download size={22} />
      </RailItem>
    </nav>
  );
}
const voiceInServer = (sv: any) => {
  const me = get().voice.channelId;
  return !!me && sv.channels.some((c: any) => c.id === me);
};
const SETTINGS_PERMS = P.MANAGE_SERVER | P.MANAGE_ROLES | P.BAN_MEMBERS | P.MANAGE_EXPRESSIONS | P.MANAGE_WEBHOOKS | P.VIEW_AUDIT_LOG;

export function FolderSettings({ folderId }: { folderId: string }) {
  const folder = useStore((s: any) => (s.settings.folders || []).find((f: any) => f.id === folderId));
  const [name, setName] = useState(folder?.name || '');
  const [color, setColor] = useState(folder?.color || FOLDER_COLORS[0]);
  if (!folder) return null;
  return (
    <Modal title={t('Folder Settings')} width={420}>
      <div className="modal-body">
        <Field label={t('Folder Name')}>
          <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder={t('Server Folder')} autoFocus />
        </Field>
        <Field label={t('Folder Color')}>
          <div className="color-row">
            {FOLDER_COLORS.map((c) => (
              <button type="button" key={c} className={'swatch' + (color === c ? ' active' : '')} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
        </Field>
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          {t('Cancel')}
        </button>
        <button
          className="btn primary"
          onClick={() => {
            updateSettings({ folders: (get().settings.folders || []).map((f: any) => (f.id === folderId ? { ...f, name, color } : f)) });
            closeModal();
          }}
        >
          {t('Done')}
        </button>
      </div>
    </Modal>
  );
}

export function leaveServer(sv: any) {
  openModal('confirm', {
    title: t("Leave '{name}'", { name: sv.name }),
    text: t("Are you sure you want to leave {name}? You won't be able to rejoin unless you are re-invited.", { name: sv.name }),
    danger: true,
    action: t('Leave Server'),
    onConfirm: () => api('DELETE', `/api/servers/${sv.id}/members/@me`),
  });
}

// ---------------------------------------------------------------- sidebars
function VoiceUserRow({ v, serverId }: any) {
  const speaking = useStore((s: any) => !!s.speaking[v.userId]);
  const flash = useStore((s: any) => s.sbFlash[v.userId]);
  return (
    <div className="voice-user" onClick={() => openModal('profile', { userId: v.userId, serverId })} onContextMenu={(e) => memberMenu(e, v.userId, serverId)}>
      <Avatar userId={v.userId} size={24} speaking={speaking} />
      <span className="vu-name">
        <Name userId={v.userId} serverId={serverId} />
      </span>
      {flash && <span className="sb-flash small">{flash.emoji}</span>}
      {v.hand > 0 && <span title={t('Requested to speak')}>✋</span>}
      {v.screen && <span className="live">{t('LIVE')}</span>}
      {v.video && <Video size={14} />}
      {(v.mute || v.serverMute) && <MicOff size={14} className={v.serverMute ? 'red' : ''} />}
      {(v.deaf || v.serverDeaf) && <HeadphoneOff size={14} className={v.serverDeaf ? 'red' : ''} />}
    </div>
  );
}

function ServerSidebar({ serverId }: { serverId: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const route = useStore((s: any) => s.route);
  const meId = useStore((s: any) => s.me.id);
  const collapsed = useStore((s: any) => s.settings.collapsed);
  useStore((s: any) => s.readStates);
  useStore((s: any) => s.voiceStates);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!server) return null;
  const perms = permsIn(server, meId);
  const manage = !!(perms & P.MANAGE_CHANNELS);
  const list = orderedChannels(server);
  const isVoiceType = (c: any) => c.type === CH.VOICE || c.type === CH.STAGE;

  const headerMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      [
        { label: t('Invite People'), icon: <UserPlus size={16} />, hidden: !(perms & P.CREATE_INVITE), onClick: () => openModal('invite', { serverId }) },
        { label: t('Server Settings'), icon: <Settings size={16} />, hidden: !(perms & SETTINGS_PERMS), onClick: () => openModal('serverSettings', { serverId }) },
        { label: t('Create Channel'), icon: <Plus size={16} />, hidden: !manage, onClick: () => openModal('createChannel', { serverId }) },
        { label: t('Create Category'), icon: <FolderPlus size={16} />, hidden: !manage, onClick: () => openModal('createChannel', { serverId, category: true }) },
        { label: t('Create Event'), icon: <CalendarDays size={16} />, hidden: !(perms & P.MANAGE_EVENTS), onClick: () => openModal('createEvent', { serverId }) },
        { sep: true },
        { label: t('Events'), icon: <CalendarDays size={16} />, onClick: () => openModal('events', { serverId }) },
        { label: t('Notification Settings'), icon: <Bell size={16} />, onClick: () => openModal('notifications', { serverId }) },
        { label: t('Change Nickname'), icon: <UserRoundPen size={16} />, onClick: () => openModal('nickname', { serverId, userId: meId }) },
        { label: isMuted(serverId) ? t('Unmute Server') : t('Mute Server'), icon: isMuted(serverId) ? <Bell size={16} /> : <BellOff size={16} />, onClick: () => toggleMute(serverId) },
        { sep: true },
        { label: t('Leave Server'), icon: <LogOut size={16} />, danger: true, hidden: server.ownerId === meId, onClick: () => leaveServer(server) },
      ],
      true
    );
  const channelMenu = (e: React.MouseEvent, c: any) =>
    openMenu(e, [
      { label: t('Mark As Read'), icon: <CheckCheck size={16} />, hidden: c.type === CH.CATEGORY, onClick: () => markRead(c) },
      { ...{ label: isMuted(c.id) ? t('Unmute Channel') : t('Mute Channel'), icon: isMuted(c.id) ? <Bell size={16} /> : <BellOff size={16} />, onClick: () => toggleMute(c.id) }, hidden: c.type === CH.CATEGORY },
      { label: t('Invite People'), icon: <UserPlus size={16} />, hidden: !(perms & P.CREATE_INVITE) || c.type === CH.CATEGORY, onClick: () => openModal('invite', { serverId }) },
      { label: t('Threads'), icon: <MessageSquareText size={16} />, hidden: ![CH.TEXT, CH.ANNOUNCEMENT].includes(c.type), onClick: () => openModal('threads', { channelId: c.id }) },
      { label: t('Create Channel'), icon: <Plus size={16} />, hidden: !manage || c.type !== CH.CATEGORY, onClick: () => openModal('createChannel', { serverId, parentId: c.id }) },
      { sep: true },
      { label: c.type === CH.CATEGORY ? t('Edit Category') : t('Edit Channel'), icon: <Pencil size={16} />, hidden: !manage, onClick: () => openModal('editChannel', { channelId: c.id }) },
      { label: t('Copy Link'), icon: <Link size={16} />, hidden: c.type === CH.CATEGORY, onClick: () => navigator.clipboard?.writeText(`${location.origin}/channels/${serverId}/${c.id}`) },
      { label: t('Copy Channel ID'), icon: <Hash size={16} />, onClick: () => navigator.clipboard?.writeText(c.id) },
      {
        label: c.type === CH.CATEGORY ? t('Delete Category') : t('Delete Channel'),
        icon: <Trash2 size={16} />,
        danger: true,
        hidden: !manage,
        onClick: () =>
          openModal('confirm', {
            title: c.type === CH.CATEGORY ? t('Delete Category') : t('Delete Channel'),
            text: t('Are you sure you want to delete {name}? This cannot be undone.', { name: c.name }),
            danger: true,
            action: t('Delete'),
            onConfirm: () => api('DELETE', '/api/channels/' + c.id),
          }),
      },
    ]);

  // Dropping a channel on another one places it before the target; on a category, at its end.
  const drop = (target: any) => {
    const src = server.channels.find((c: any) => c.id === drag);
    setDrag(null);
    setOver(null);
    if (!src || src.id === target.id) return;
    const byPos = (a: any, b: any) => a.position - b.position || (a.id > b.id ? 1 : -1);
    let items: any[];
    if (src.type === CH.CATEGORY) {
      const cat = target.type === CH.CATEGORY ? target : server.channels.find((c: any) => c.id === target.parentId);
      if (!cat || cat.id === src.id) return;
      const cats = server.channels.filter((c: any) => c.type === CH.CATEGORY && c.id !== src.id).sort(byPos);
      cats.splice(cats.findIndex((c: any) => c.id === cat.id), 0, src);
      items = cats.map((c: any, i: number) => ({ id: c.id, position: i, parentId: null }));
    } else {
      const parentId = target.type === CH.CATEGORY ? target.id : target.parentId || null;
      const sibs = server.channels.filter((c: any) => c.type !== CH.CATEGORY && c.type !== CH.THREAD && (c.parentId || null) === parentId && c.id !== src.id).sort(byPos);
      const at = target.type === CH.CATEGORY ? sibs.length : sibs.findIndex((c: any) => c.id === target.id);
      sibs.splice(at < 0 ? sibs.length : at, 0, src);
      items = sibs.map((c: any, i: number) => ({ id: c.id, position: i, parentId }));
    }
    act(api('PUT', `/api/servers/${serverId}/channels/order`, { items }));
  };
  const dnd = (c: any) =>
    manage
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            setDrag(c.id);
            e.dataTransfer.effectAllowed = 'move';
          },
          onDragEnd: () => (setDrag(null), setOver(null)),
          onDragOver: (e: React.DragEvent) => {
            if (!drag) return;
            e.preventDefault();
            if (over !== c.id) setOver(c.id);
          },
          onDrop: (e: React.DragEvent) => (e.preventDefault(), drop(c)),
        }
      : {};

  const threadRow = (th: any) => (
    <div
      key={th.id}
      className={'channel thread' + (route.channelId === th.id ? ' active' : '') + (showUnread(th) ? ' unread' : '')}
      onClick={() => navigate(serverId, th.id)}
      onContextMenu={(e) => openMenu(e, [{ label: t('Mark As Read'), icon: <CheckCheck size={16} />, onClick: () => markRead(th) }, ...threadMenuItems(th), { label: t('Copy Channel ID'), icon: <Hash size={16} />, onClick: () => navigator.clipboard?.writeText(th.id) }])}
    >
      <span className="thread-branch" />
      <span className="ch-name">{th.name}</span>
      {mentionsIn(th.id) > 0 && <span className="badge">{num(mentionsIn(th.id))}</span>}
    </div>
  );

  return (
    <>
      <button className={'sidebar-head' + (server.banner ? ' has-banner' : '')} onClick={headerMenu} style={server.banner ? { backgroundImage: `linear-gradient(transparent 40%, rgba(0,0,0,.6)), url(${server.banner})` } : undefined}>
        <span>{server.name}</span>
        <ChevronDown size={18} />
      </button>
      <div className="sidebar-scroll">
        <EventStrip server={server} />
        {list.map((c) => {
          const hidden = c.parentId && collapsed[c.parentId] && c.id !== route.channelId && !(isVoiceType(c) && voiceIn(c.id).length) && !isUnread(c);
          if (hidden) return null;
          const cls = (over === c.id && drag !== c.id ? ' drop-target' : '') + (drag === c.id ? ' dragging' : '');
          if (c.type === CH.CATEGORY)
            return (
              <div key={c.id} className={'category' + (collapsed[c.id] ? ' collapsed' : '') + cls} onContextMenu={(e) => channelMenu(e, c)} {...dnd(c)}>
                <button onClick={() => updateSettings({ collapsed: { ...collapsed, [c.id]: !collapsed[c.id] } })}>
                  <ChevronDown size={12} />
                  <span>{c.name}</span>
                </button>
                {manage && (
                  <button className="icon-btn" title={t('Create Channel')} onClick={() => openModal('createChannel', { serverId, parentId: c.id })}>
                    <Plus size={16} />
                  </button>
                )}
              </div>
            );
          const voiceUsers = isVoiceType(c) ? voiceIn(c.id) : [];
          const unread = showUnread(c);
          const m = mentionsIn(c.id);
          // Active threads show under their channel (the open one always does).
          const threads = [CH.TEXT, CH.ANNOUNCEMENT].includes(c.type) ? threadsOf(server, c.id).filter((th: any, i: number) => i < 5 || th.id === route.channelId) : [];
          return (
            <React.Fragment key={c.id}>
              <div
                className={'channel' + (route.channelId === c.id ? ' active' : '') + (unread ? ' unread' : '') + (isMuted(c.id) ? ' muted' : '') + cls}
                onClick={() => {
                  if (isVoiceType(c) && canIn(c, P.CONNECT)) voice.join(c.id);
                  navigate(serverId, c.id);
                }}
                onContextMenu={(e) => channelMenu(e, c)}
                {...dnd(c)}
              >
                <ChannelIcon ch={c} />
                <span className="ch-name">{c.name}</span>
                {c.userLimit > 0 && isVoiceType(c) && (
                  <span className="user-limit">
                    {num(voiceUsers.length)}/{num(c.userLimit)}
                  </span>
                )}
                {m > 0 && <span className="badge">{num(m)}</span>}
                {manage && (
                  <button className="icon-btn ch-edit" title={t('Edit Channel')} onClick={(e) => (e.stopPropagation(), openModal('editChannel', { channelId: c.id }))}>
                    <Settings size={14} />
                  </button>
                )}
              </div>
              {threads.map(threadRow)}
              {voiceUsers.length > 0 && (
                <div className="voice-users">
                  {voiceUsers.map((v) => (
                    <VoiceUserRow key={v.userId} v={v} serverId={serverId} />
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

function HomeSidebar() {
  const route = useStore((s: any) => s.route);
  const meId = useStore((s: any) => s.me.id);
  const rels = useStore((s: any) => s.relationships);
  useStore((s: any) => s.dms);
  useStore((s: any) => s.readStates);
  useStore((s: any) => s.users);
  useStore((s: any) => s.voiceStates);
  const pending = Object.values(rels).filter((x) => x === REL.INCOMING).length;
  const closeDm = (d: any) => {
    if (d.type === CH.GROUP)
      return openModal('confirm', {
        title: t("Leave '{name}'", { name: dmName(d) }),
        text: t('Are you sure you want to leave this group?'),
        danger: true,
        action: t('Leave Group'),
        onConfirm: () => api('DELETE', '/api/channels/' + d.id),
      });
    act(api('DELETE', '/api/channels/' + d.id));
  };
  return (
    <>
      <div className="sidebar-head plain">
        <button className="fake-search" onClick={() => openModal('newDm')}>
          {t('Find or start a conversation')}
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className={'dm-row nav' + (!route.channelId ? ' active' : '')} onClick={() => navigate(null, null)}>
          <Users size={22} />
          <span className="dm-name">{t('Friends')}</span>
          {pending > 0 && <span className="badge">{num(pending)}</span>}
        </div>
        <div className="category static">
          <span>{t('Direct Messages')}</span>
          <button className="icon-btn" title={t('Create DM')} onClick={() => openModal('newDm')}>
            <Plus size={16} />
          </button>
        </div>
        {sortedDms().map((d) => {
          const other = d.recipients.find((r: string) => r !== meId);
          const m = mentionsIn(d.id);
          const inCall = voiceIn(d.id).length > 0;
          return (
            <div
              key={d.id}
              className={'dm-row' + (route.channelId === d.id ? ' active' : '') + (showUnread(d) ? ' unread' : '') + (isMuted(d.id) ? ' muted' : '')}
              onClick={() => navigate(null, d.id)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t('Mark As Read'), icon: <CheckCheck size={16} />, onClick: () => markRead(d) },
                  { label: isMuted(d.id) ? t('Unmute Conversation') : t('Mute Conversation'), icon: isMuted(d.id) ? <Bell size={16} /> : <BellOff size={16} />, onClick: () => toggleMute(d.id) },
                  { label: t('Profile'), hidden: d.type !== CH.DM, onClick: () => openModal('profile', { userId: other }) },
                  { sep: true },
                  { label: d.type === CH.GROUP ? t('Leave Group') : t('Close DM'), danger: true, icon: <X size={16} />, onClick: () => closeDm(d) },
                ])
              }
            >
              {d.type === CH.DM ? <Avatar userId={other} size={32} status /> : <div className="group-icon"><Users size={18} /></div>}
              <div className="dm-text">
                <span className="dm-name">{dmName(d)}</span>
                <small>{d.type === CH.GROUP ? t('{n} Members', { n: num(d.recipients.length) }) : get().users[other]?.customStatus}</small>
              </div>
              {inCall && <Phone size={14} className="green" />}
              {m > 0 && <span className="badge">{num(m)}</span>}
              <button className="icon-btn dm-close" title={d.type === CH.GROUP ? t('Leave Group') : t('Close DM')} onClick={(e) => (e.stopPropagation(), closeDm(d))}>
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function UserPanel() {
  const me = useStore((s: any) => s.me);
  const v = useStore((s: any) => s.voice);
  const speaking = useStore((s: any) => !!s.speaking[s.me.id]);
  useStore((s: any) => s.voiceTick);
  const ch = findChannel(v.channelId);
  const server = ch?.serverId ? get().servers[ch.serverId] : null;
  const setStatus = (status: string) => act(api('PATCH', '/api/users/me', { status }));
  const statusMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      [
        ...['online', 'idle', 'dnd', 'invisible'].map((s) => ({
          label: t(STATUS_LABEL[s]),
          icon: me.statusPref === s ? <Check size={16} /> : <span className={'status-dot static ' + (s === 'invisible' ? 'offline' : s)} />,
          onClick: () => setStatus(s),
        })),
        { sep: true },
        { label: me.customStatus ? t('Edit Custom Status') : t('Set Custom Status'), icon: <Pencil size={16} />, onClick: () => openModal('customStatus') },
        { label: t('Clear Custom Status'), hidden: !me.customStatus, icon: <X size={16} />, onClick: () => act(api('PATCH', '/api/users/me', { customStatus: '' })) },
      ],
      true
    );
  return (
    <div className="user-area">
      {v.channelId && ch && (
        <div className="voice-status">
          <div className="vs-info" onClick={() => navigate(ch.serverId || null, ch.id)}>
            <b className={v.connecting ? 'yellow' : 'green'}>
              <SignalHigh size={16} /> {v.connecting ? t('Connecting…') : t('Voice Connected')}
            </b>
            <small>{server ? `${ch.name} / ${server.name}` : dmName(ch)}</small>
          </div>
          <button className={'icon-btn' + (v.video ? ' on' : '')} title={v.video ? t('Turn Off Camera') : t('Turn On Camera')} onClick={() => voice.setVideo(!v.video)}>
            <Video size={20} />
          </button>
          <button className={'icon-btn' + (v.screen ? ' on' : '')} title={v.screen ? t('Stop Sharing') : t('Share Your Screen')} onClick={() => voice.setScreen(!v.screen)}>
            <MonitorUp size={20} />
          </button>
          <SoundboardButton channelId={v.channelId} className="icon-btn" size={18} />
          <button className="icon-btn danger" title={t('Disconnect')} onClick={() => voice.leave()}>
            <PhoneOff size={20} />
          </button>
        </div>
      )}
      <div className="user-panel">
        <button className="me" onClick={statusMenu}>
          <Avatar userId={me.id} size={32} status speaking={speaking} />
          <div className="me-text">
            <b>{me.displayName}</b>
            <small>{me.customStatus || t(STATUS_LABEL[me.statusPref])}</small>
          </div>
        </button>
        <button className={'icon-btn' + (v.mute || v.noMic || v.serverMute ? ' danger' : '')} title={v.serverMute ? t('Server Muted') : v.mute ? t('Unmute') : t('Mute')} onClick={() => voice.setMute(!v.mute)}>
          {v.mute || v.noMic || v.serverMute ? <MicOff size={20} /> : <Mic size={20} />}
        </button>
        <button className={'icon-btn' + (v.deaf || v.serverDeaf ? ' danger' : '')} title={v.serverDeaf ? t('Server Deafened') : v.deaf ? t('Undeafen') : t('Deafen')} onClick={() => voice.setDeaf(!v.deaf)}>
          {v.deaf || v.serverDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </button>
        <button className="icon-btn" title={t('User Settings')} onClick={() => openModal('userSettings')}>
          <Settings size={20} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- friends
function Friends() {
  const rels = useStore((s: any) => s.relationships);
  const presences = useStore((s: any) => s.presences);
  useStore((s: any) => s.users);
  const [tab, setTab] = useState('online');
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = Object.keys(rels);
  const pendingIn = ids.filter((i) => rels[i] === REL.INCOMING);
  const lists: Record<string, string[]> = {
    online: ids.filter((i) => rels[i] === REL.FRIEND && presences[i] && presences[i] !== 'offline'),
    all: ids.filter((i) => rels[i] === REL.FRIEND),
    pending: ids.filter((i) => rels[i] === REL.INCOMING || rels[i] === REL.OUTGOING),
    blocked: ids.filter((i) => rels[i] === REL.BLOCKED),
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const username = name.trim().replace(/^@/, '');
    if (!username) return;
    try {
      await api('POST', '/api/friends', { username });
      setResult({ ok: true, text: t('Success! Your friend request to {name} was sent.', { name: username }) });
      setName('');
    } catch (err: any) {
      setResult({ ok: false, text: t(err.message) });
    }
  };
  const shown = (lists[tab] || [])
    .filter((i) => !q || displayName(i).toLowerCase().includes(q.toLowerCase()) || get().users[i]?.username.includes(q.toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const titles: Record<string, string> = { online: 'Online', all: 'All Friends', pending: 'Pending', blocked: 'Blocked' };
  const remove = (id: string) =>
    openModal('confirm', {
      title: t("Remove '{name}'", { name: displayName(id) }),
      text: t('Are you sure you want to remove {name} from your friends?', { name: displayName(id) }),
      danger: true,
      action: t('Remove Friend'),
      onConfirm: () => api('DELETE', '/api/friends/' + id),
    });
  return (
    <div className="main-col">
      <header className="main-head">
        <MobileNavButton />
        <Users size={22} />
        <b className="head-title">{t('Friends')}</b>
        <div className="tabs">
          {['online', 'all', 'pending', 'blocked'].map((k) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {t(titles[k] === 'All Friends' ? 'All' : titles[k])}
              {k === 'pending' && pendingIn.length > 0 && <span className="badge">{num(pendingIn.length)}</span>}
            </button>
          ))}
          <button className={'add-friend' + (tab === 'add' ? ' active' : '')} onClick={() => setTab('add')}>
            {t('Add Friend')}
          </button>
        </div>
      </header>
      {tab === 'add' ? (
        <div className="friends-body">
          <h3>{t('Add Friend')}</h3>
          <p className="muted">{t('You can add friends with their username.')}</p>
          <form className="add-friend-form" onSubmit={add}>
            <input dir="ltr" value={name} onChange={(e) => (setName(e.target.value), setResult(null))} placeholder={t('Enter a username')} autoFocus maxLength={33} />
            <button className="btn primary" disabled={!name.trim()}>
              {t('Send Friend Request')}
            </button>
          </form>
          {result && <div className={result.ok ? 'form-ok' : 'form-error'}>{result.text}</div>}
        </div>
      ) : (
        <div className="friends-body">
          <div className="search-box">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} />
            <Search size={18} />
          </div>
          <div className="list-title">
            {t(titles[tab])} — {num(shown.length)}
          </div>
          {shown.length === 0 && (
            <div className="empty">
              <Compass size={64} />
              <p>
                {tab === 'online'
                  ? t("No one's around to play with right now.")
                  : tab === 'all'
                  ? t("You don't have any friends yet. Add one with their username!")
                  : tab === 'pending'
                  ? t('There are no pending friend requests.')
                  : t("You haven't blocked anyone.")}
              </p>
            </div>
          )}
          {shown.map((id) => {
            const u = get().users[id];
            const type = rels[id];
            return (
              <div key={id} className="friend-row" onClick={() => (type === REL.FRIEND ? openDm(id) : openModal('profile', { userId: id }))}>
                <Avatar userId={id} size={36} status={type === REL.FRIEND} />
                <div className="friend-text">
                  <b>
                    {displayName(id)} <small dir="ltr">{u?.username}</small>
                  </b>
                  <small>
                    {type === REL.INCOMING
                      ? t('Incoming Friend Request')
                      : type === REL.OUTGOING
                      ? t('Outgoing Friend Request')
                      : type === REL.BLOCKED
                      ? t('Blocked')
                      : u?.customStatus || t(STATUS_LABEL[presences[id] || 'offline'])}
                  </small>
                </div>
                <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
                  {type === REL.FRIEND && (
                    <>
                      <button className="round" title={t('Message')} onClick={() => openDm(id)}>
                        <MessageCircle size={20} />
                      </button>
                      <button className="round" title={t('Start Voice Call')} onClick={() => startCall(id)}>
                        <Phone size={20} />
                      </button>
                      <button
                        className="round"
                        title={t('More')}
                        onClick={(e) =>
                          openMenu(
                            e,
                            [
                              { label: t('Profile'), onClick: () => openModal('profile', { userId: id }) },
                              { label: t('Start Video Call'), onClick: () => startCall(id, true) },
                              { sep: true },
                              { label: t('Remove Friend'), danger: true, onClick: () => remove(id) },
                              { label: t('Block'), danger: true, onClick: () => act(api('PUT', '/api/blocks/' + id)) },
                            ],
                            true
                          )
                        }
                      >
                        <MoreVertical size={20} />
                      </button>
                    </>
                  )}
                  {type === REL.INCOMING && (
                    <button className="round ok" title={t('Accept')} onClick={() => act(api('PUT', '/api/friends/' + id))}>
                      <Check size={20} />
                    </button>
                  )}
                  {(type === REL.INCOMING || type === REL.OUTGOING) && (
                    <button className="round no" title={type === REL.INCOMING ? t('Ignore') : t('Cancel')} onClick={() => act(api('DELETE', '/api/friends/' + id))}>
                      <X size={20} />
                    </button>
                  )}
                  {type === REL.BLOCKED && (
                    <button className="round no" title={t('Unblock')} onClick={() => act(api('DELETE', '/api/blocks/' + id))}>
                      <X size={20} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- member list
function MemberRow({ userId, serverId, owner }: any) {
  const presence = useStore((s: any) => s.presences[userId] || 'offline');
  const user = useStore((s: any) => s.users[userId]);
  const hasActivity = useStore((s: any) => !!s.activities[userId]);
  const member = useStore((s: any) => (serverId ? s.servers[serverId]?.members[userId] : null));
  return (
    <div className={'member' + (presence === 'offline' ? ' offline' : '')} onClick={() => openModal('profile', { userId, serverId })} onContextMenu={(e) => memberMenu(e, userId, serverId)}>
      <Avatar userId={userId} size={32} status />
      <div className="member-text">
        <b style={{ color: roleColor(userId, serverId) }}>
          {displayName(userId, serverId)} {owner && <Crown size={14} className="crown" />}
          {member?.timeoutUntil > Date.now() && <Clock size={13} className="red" />}
        </b>
        {hasActivity ? <ActivityLine userId={userId} /> : user?.customStatus && <small>{user.customStatus}</small>}
      </div>
    </div>
  );
}

function MemberList({ serverId, channel }: any) {
  const server = useStore((s: any) => (serverId ? s.servers[serverId] : null));
  const presences = useStore((s: any) => s.presences);
  useStore((s: any) => s.users);
  const groups = useMemo(() => {
    const out: { name: string; ids: string[] }[] = [];
    const sort = (ids: string[]) => ids.sort((a, b) => displayName(a, serverId).localeCompare(displayName(b, serverId)));
    if (!server) {
      out.push({ name: t('Members'), ids: sort([...(channel?.recipients || [])]) });
      return out;
    }
    const online = Object.keys(server.members).filter((i) => presences[i] && presences[i] !== 'offline');
    const offline = Object.keys(server.members).filter((i) => !presences[i] || presences[i] === 'offline');
    const used = new Set<string>();
    for (const r of server.roles.filter((r: any) => r.hoist && r.id !== server.id)) {
      const ids = online.filter((i) => !used.has(i) && server.members[i].roles.includes(r.id));
      ids.forEach((i) => used.add(i));
      if (ids.length) out.push({ name: r.name, ids: sort(ids) });
    }
    const rest = online.filter((i) => !used.has(i));
    if (rest.length) out.push({ name: t('Online'), ids: sort(rest) });
    if (offline.length) out.push({ name: t('Offline'), ids: sort(offline) });
    return out;
  }, [server, presences, channel]);
  return (
    <aside className="members">
      {groups.map((g) => (
        <React.Fragment key={g.name}>
          <div className="list-title">
            {g.name} — {num(g.ids.length)}
          </div>
          {g.ids.map((id) => (
            <MemberRow key={id} userId={id} serverId={serverId} owner={(server?.ownerId || channel?.ownerId) === id} />
          ))}
        </React.Fragment>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------- main area
function MobileNavButton() {
  return (
    <button className="icon-btn mobile-only" onClick={() => set({ mobileNav: true })} aria-label={t('Menu')}>
      <MenuIcon size={22} />
    </button>
  );
}

function SearchBox({ channelId, serverId }: any) {
  const [q, setQ] = useState('');
  return (
    <form
      className="search-box small"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim().length < 2) return toast('Type at least 2 characters');
        openModal('search', { q: q.trim(), channelId: serverId ? undefined : channelId, serverId });
      }}
    >
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} />
      <Search size={16} />
    </form>
  );
}

function ChannelView({ channelId }: { channelId: string }) {
  const meId = useStore((s: any) => s.me.id);
  const showMembers = useStore((s: any) => s.showMembers);
  const inVoice = useStore((s: any) => s.voice.channelId === channelId);
  useStore((s: any) => s.servers);
  useStore((s: any) => s.dms);
  useStore((s: any) => s.users);
  const callActive = useStore((s: any) => Object.values(s.voiceStates).some((v: any) => v.channelId === channelId));
  const [voiceChat, setVoiceChat] = useState(false);
  const [nsfwOk, setNsfwOk] = useState<Record<string, boolean>>({});
  const ch = findChannel(channelId);
  if (!ch) return <div className="main-col" />;
  const serverId = ch.serverId || null;
  const isDm = !serverId;
  const other = ch.type === CH.DM ? ch.recipients.find((r: string) => r !== meId) : null;
  const isVoice = ch.type === CH.VOICE || ch.type === CH.STAGE;
  const isThread = ch.type === CH.THREAD;
  const isForum = ch.type === CH.FORUM;
  const parent = isThread ? findChannel(ch.parentId) : null;
  const hasMembers = !isVoice && !isForum && (serverId || ch.type === CH.GROUP);
  const canManageThread = isThread && (ch.ownerId === meId || canIn(ch, P.MANAGE_THREADS));
  const nsfwGate = ch.nsfw && !nsfwOk[ch.id] && !get().settings.nsfwOk;
  return (
    <div className="main-col">
      <header className="main-head">
        <MobileNavButton />
        {isThread && parent && (
          <>
            <span className="crumb clickable" onClick={() => navigate(serverId, parent.id)}>
              <ChannelIcon ch={parent} size={20} /> {parent.name}
            </span>
            <ChevronRight size={16} className="muted" />
          </>
        )}
        {serverId ? <ChannelIcon ch={ch} size={22} /> : ch.type === CH.DM ? <Avatar userId={other} size={24} status /> : <Users size={22} />}
        <b className={'head-title' + (other ? ' clickable' : '')} onClick={() => other && openModal('profile', { userId: other })}>
          {serverId ? ch.name : dmName(ch)}
        </b>
        {isThread && ch.archived && <span className="tag">{t('Archived')}</span>}
        {ch.topic && !isForum && (
          <span className="topic" title={ch.topic} dir="auto">
            {plain(ch.topic, serverId)}
          </span>
        )}
        <div className="spacer" />
        {isDm && !inVoice && (
          <>
            <button className="icon-btn" title={callActive ? t('Join Call') : t('Start Voice Call')} onClick={() => voice.join(channelId)}>
              <Phone size={22} className={callActive ? 'green' : ''} />
            </button>
            <button className="icon-btn" title={t('Start Video Call')} onClick={() => voice.join(channelId).then(() => voice.setVideo(true))}>
              <Video size={22} />
            </button>
          </>
        )}
        {ch.type === CH.GROUP && (
          <>
            <button className="icon-btn" title={t('Add Friends to Group')} onClick={() => openModal('newDm', { groupId: ch.id })}>
              <UserPlus size={22} />
            </button>
            <button className="icon-btn" title={t('Rename Group')} onClick={() => openModal('editChannel', { channelId: ch.id })}>
              <Pencil size={20} />
            </button>
          </>
        )}
        {[CH.TEXT, CH.ANNOUNCEMENT].includes(ch.type) && (
          <button className="icon-btn" title={t('Threads')} onClick={() => openModal('threads', { channelId })}>
            <MessageSquareText size={22} />
          </button>
        )}
        {isThread && canManageThread && (
          <button className="icon-btn" title={ch.archived ? t('Unarchive Thread') : t('Archive Thread')} onClick={() => act(api('PATCH', '/api/channels/' + ch.id, { archived: !ch.archived }))}>
            {ch.archived ? <ArchiveRestore size={20} /> : <Archive size={20} />}
          </button>
        )}
        {isThread && (
          <button className="icon-btn" title={t('More')} onClick={(e) => openMenu(e, threadMenuItems(ch), true)}>
            <MoreVertical size={20} />
          </button>
        )}
        {isVoice && (
          <button className={'icon-btn' + (voiceChat ? ' on' : '')} title={t('Show Chat')} onClick={() => setVoiceChat(!voiceChat)}>
            <MessagesSquare size={22} />
          </button>
        )}
        {serverId && !isForum && canIn(ch, P.MANAGE_CHANNELS) && !isThread && (
          <button className="icon-btn" title={t('Edit Channel')} onClick={() => openModal('editChannel', { channelId })}>
            <Settings size={20} />
          </button>
        )}
        {!isForum && (
          <button className="icon-btn" title={t('Pinned Messages')} onClick={() => openModal('pins', { channelId })}>
            <Pin size={22} />
          </button>
        )}
        {hasMembers && (
          <button className={'icon-btn' + (showMembers ? ' on' : '')} title={t('Member List')} onClick={() => set({ showMembers: !showMembers })}>
            <Users size={22} />
          </button>
        )}
        <SearchBox channelId={channelId} serverId={serverId} />
        <button className="icon-btn" title={t('Inbox')} onClick={() => openModal('inbox')}>
          <Inbox size={22} />
        </button>
      </header>
      <div className="main-body">
        {nsfwGate ? (
          <div className="empty nsfw-gate">
            <ShieldAlert size={72} />
            <h2>{t('Age-Restricted Channel')}</h2>
            <p>{t('This channel contains content marked as age-restricted. Do you wish to proceed?')}</p>
            <div className="row-actions">
              <button className="btn" onClick={() => navigate(null, null)}>
                {t('Nope')}
              </button>
              <button className="btn danger" onClick={() => setNsfwOk({ ...nsfwOk, [ch.id]: true })}>
                {t('Continue')}
              </button>
            </div>
          </div>
        ) : isForum ? (
          <ForumView channelId={channelId} />
        ) : isVoice ? (
          <>
            <VoiceStage channelId={channelId} serverId={serverId} />
            {voiceChat && (
              <div className="voice-chat">
                <ChatPane key={channelId} channelId={channelId} serverId={serverId} />
              </div>
            )}
          </>
        ) : (
          <>
            <div className="chat-col">
              {isDm && callActive && (
                <div className="dm-call">
                  <VoiceStage channelId={channelId} serverId={null} />
                </div>
              )}
              <ChatPane key={channelId} channelId={channelId} serverId={serverId} />
            </div>
            {hasMembers && showMembers && <MemberList serverId={serverId} channel={ch} />}
          </>
        )}
      </div>
    </div>
  );
}

function NoChannel() {
  return (
    <div className="main-col">
      <header className="main-head">
        <MobileNavButton />
      </header>
      <div className="empty">
        <AtSign size={64} />
        <p>{t('There are no text channels here yet.')}</p>
      </div>
    </div>
  );
}

function ExtraModals() {
  const m = useStore((s: any) => s.modal);
  if (m?.type === 'folder') return <FolderSettings folderId={m.folderId} />;
  return null;
}

/** Keyboard navigation between channels and servers (Alt+Up/Down, Ctrl+Alt+Up/Down, Alt+Left). */
function stepChannel(d: number, unreadOnly = false) {
  const s = get();
  const sid = s.route.serverId;
  const list = sid && s.servers[sid] ? orderedChannels(s.servers[sid]).filter((c: any) => c.type !== CH.CATEGORY) : sortedDms();
  if (!list.length) return;
  let i = list.findIndex((c: any) => c.id === s.route.channelId);
  for (let n = 0; n < list.length; n++) {
    i = (i + d + list.length) % list.length;
    if (!unreadOnly || isUnread(list[i])) return navigate(sid || null, list[i].id);
  }
}
function stepServer(d: number) {
  const ids = [null, ...railOrder()];
  const i = ids.indexOf(get().route.serverId);
  navigate(ids[(i + d + ids.length) % ids.length] as any);
}

function Shell() {
  const route = useStore((s: any) => s.route);
  const status = useStore((s: any) => s.status);
  const mobileNav = useStore((s: any) => s.mobileNav);
  const pendingInvite = useStore((s: any) => s.pendingInvite);
  useEffect(() => {
    if (pendingInvite) {
      set({ pendingInvite: null });
      openModal('join', { code: pendingInvite });
    }
  }, [pendingInvite]);
  return (
    <div className={'app' + (mobileNav ? ' nav-open' : '')}>
      {status === 'reconnecting' && <div className="reconnect">{t('Connection lost. Reconnecting…')}</div>}
      <UpdateBanner />
      <div className="nav-cols">
        <ServerRail />
        <div className="sidebar">
          {route.serverId === '@ts' ? <TsSidebar /> : route.serverId ? <ServerSidebar serverId={route.serverId} /> : <HomeSidebar />}
          <UserPanel />
        </div>
      </div>
      <div className="nav-scrim" onClick={() => set({ mobileNav: false })} />
      {route.serverId === '@ts' ? <TsMain /> : route.channelId ? <ChannelView channelId={route.channelId} /> : route.serverId ? <NoChannel /> : <Friends />}
      <ModalHost />
      <ExtraModals />
      <IncomingCall />
      <ImportProgress />
    </div>
  );
}

export default function App() {
  const token = useStore((s: any) => s.token);
  const status = useStore((s: any) => s.status);
  const me = useStore((s: any) => s.me);
  const settings = useStore((s: any) => s.settings);
  useEffect(() => {
    if (token) connect();
  }, [token]);
  // The unread count in the title also drives the taskbar badge of the desktop app.
  const badge = useStore((s: any) => (s.status === 'ready' ? totalBadge() : 0));
  useEffect(() => {
    const base = settings.lang === 'fa' ? 'همصحبت' : 'Hamsohbat';
    document.title = badge ? `(${badge}) ${base}` : base;
  }, [badge, settings.lang]);
  useEffect(() => {
    if (status === 'ready') resendPresenceExtras();
  }, [status]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (get().status !== 'ready') return;
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
      if (e.ctrlKey && e.shiftKey && !e.altKey) {
        if (e.code === 'KeyM') voice.setMute(!get().voice.mute);
        else if (e.code === 'KeyD') voice.setDeaf(!get().voice.deaf);
        else return;
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === 'KeyK' || e.code === 'KeyT')) {
        if (get().modal?.type === 'switcher') closeModal();
        else openModal('switcher');
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyI') openModal('inbox');
      else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        const el = document.querySelector<HTMLInputElement>('.main-head .search-box input');
        if (!el) return;
        el.focus();
      } else if (e.altKey && !e.ctrlKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) stepChannel(e.code === 'ArrowUp' ? -1 : 1, e.shiftKey);
      else if (e.altKey && e.ctrlKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) stepServer(e.code === 'ArrowUp' ? -1 : 1);
      else if (e.altKey && !e.ctrlKey && e.code === (document.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft')) {
        const prev = history_.pop();
        if (!prev) return;
        navigate(prev.serverId, prev.channelId);
        history_.pop();
      } else if (e.key === 'Escape' && !typing && !get().modal) {
        const ch = findChannel(get().route.channelId);
        if (!ch) return;
        markRead(ch);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    // Re-keying on the language re-renders every translated string.
    <React.Fragment key={settings.lang}>
      <TitleBar />
      {!token ? (
        <Auth />
      ) : !me || (status !== 'ready' && status !== 'reconnecting') ? (
        <div className="splash">
          <img src="/favicon.svg" alt="" width={72} height={72} />
          <p>{t('Connecting…')}</p>
        </div>
      ) : (
        <Shell />
      )}
      <MenuHost />
      <Toasts />
    </React.Fragment>
  );
}
