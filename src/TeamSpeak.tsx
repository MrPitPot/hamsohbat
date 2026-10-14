// TeamSpeak 3 inside Hamsohbat (Windows app only): the desktop shell runs hs-teamspeak.exe, which speaks
// the TeamSpeak protocol; this module shows its channel tree, info panel, log, chat and voice controls.
import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  Headphones, HeadphoneOff, Lock, MessageSquare, Mic, MicOff, PhoneOff, Plus, Server, Trash2, Volume2, X, Hash, Moon, ScrollText, Info, Pencil, Hand, Shield,
  Signal, UserRound, FolderPlus, Ban, BellRing, Copy, LogOut, Crown, Clock, Globe, Monitor,
} from 'lucide-react';
import { useStore, get, toast, navigate } from './store';
import { sfx } from './voice';
import { t } from './i18n';
import { isDesktop, sendNative } from './desktop';
import { Field, Modal, openMenu, colorFor, fmtTime, fmtDate, num } from './ui';

type TsChannel = {
  id: number; parent: number; order: number; name: string; topic?: string; maxClients: number; hasPassword: boolean; isDefault: boolean;
  neededTalkPower: number; type: string; codec: string; codecQuality: number; description: string; silenced: boolean;
};
type TsClient = {
  id: number; channel: number; name: string; inputMuted: boolean; outputMuted: boolean; inputHardware: boolean; outputHardware: boolean; away: string | null;
  recording: boolean; talkPower: number; isMe: boolean; description: string; uid: string; serverGroups: number[]; channelGroup: number; country: string;
  talker: boolean; prioritySpeaker: boolean; talkRequest: string | null; version?: string | null; platform?: string | null; created?: number | null;
  connections?: number | null; ping?: number | null; connectedFor?: number | null; idleFor?: number | null; loss?: number | null; dbId: number;
};
type TsGroup = { id: number; name: string; sort: number };
type TsMessage = { id: number; from: { id: number; name: string }; text: string; at: number; mine?: boolean };
type TsLog = { id: number; at: number; text: string; kind: string };
type Bookmark = { name: string; address: string; nickname: string; password?: string; channel?: string };
type Selection = { kind: 'server' } | { kind: 'channel'; id: number } | { kind: 'client'; id: number };

const empty = () => ({
  status: 'idle' as 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected',
  reason: '',
  server: null as null | Record<string, any>,
  own: 0,
  channels: [] as TsChannel[],
  clients: [] as TsClient[],
  serverGroups: [] as TsGroup[],
  channelGroups: [] as TsGroup[],
  talking: [] as number[],
  level: 0,
  tx: false,
  stats: null as null | { ping: number; pingDev: number; loss: number; bytesIn: number; bytesOut: number },
  connectedAt: 0,
  selected: { kind: 'server' } as Selection,
  dialog: null as null | { kind: string; [k: string]: any },
});

export const useTs = create<any>(() => ({
  ...empty(),
  chat: { channel: [] as TsMessage[], server: [] as TsMessage[] } as Record<string, TsMessage[]>,
  log: [] as TsLog[],
  tab: 'log',
  unread: {} as Record<string, number>,
  muted: false,
  deaf: false,
  away: false,
  volumes: {} as Record<number, number>,
  bookmarks: load('tsBookmarks', [] as Bookmark[]),
}));
const setTs = useTs.setState;
const getTs = useTs.getState;

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') ?? fallback;
  } catch {
    return fallback;
  }
}
let msgId = 0;
const ts = (payload: any) => sendNative({ type: 'ts', payload });
export const tsConnected = () => getTs().status === 'connected' || getTs().status === 'reconnecting';
const me = (): TsClient | undefined => getTs().clients.find((c: TsClient) => c.isMe);
const channelName = (id: number) => getTs().channels.find((c: TsChannel) => c.id === id)?.name || '';

/** Sends our voice-activation / push-to-talk / noise settings to the bridge. */
function syncVoice(pttDown = false) {
  const st = get().settings;
  ts({ cmd: 'voice', mode: st.voiceMode, threshold: st.vadThreshold, ptt: pttDown });
  ts({ cmd: 'noise', value: (st.noiseCancel || 'ai') !== 'off' });
}

// ---------------------------------------------------------------- events from the bridge
function addChat(key: string, m: TsMessage) {
  setTs((s: any) => ({
    chat: { ...s.chat, [key]: [...(s.chat[key] || []), m].slice(-500) },
    unread: s.tab === key && get().route.serverId === '@ts' ? s.unread : { ...s.unread, [key]: (s.unread[key] || 0) + 1 },
  }));
}
function addLog(kind: string, text: string) {
  setTs((s: any) => ({ log: [...s.log, { id: ++msgId, at: Date.now(), kind, text }].slice(-1000) }));
}

const REASONS: Record<string, string> = {
  timeout: 'connection lost',
  kickChannel: 'kicked from the channel',
  kickServer: 'kicked from the server',
  ban: 'banned',
  serverStop: 'server stopped',
};
function logText(e: any): string {
  const by = e.by ? t(' (by {name})', { name: e.by }) : '';
  switch (e.kind) {
    case 'connected':
      return t('Connected to {name}', { name: e.name });
    case 'join':
      return t('{name} connected to channel {channel}', { name: e.name, channel: e.channel });
    case 'leave':
      return e.reason && REASONS[e.reason] ? t('{name} left the server: {reason}', { name: e.name, reason: t(REASONS[e.reason]) }) + by : t('{name} disconnected', { name: e.name });
    case 'move':
      if (e.me) return t('You switched to channel {to}', { to: e.to }) + by;
      return (e.reason === 'kickChannel' ? t('{name} was kicked from {from}', { name: e.name, from: e.from }) : t('{name} switched from {from} to {to}', { name: e.name, from: e.from, to: e.to })) + by;
    case 'rename':
      return t('{from} is now known as {name}', { from: e.from, name: e.name });
    case 'channelCreate':
      return t('Channel {name} was created', { name: e.name }) + by;
    case 'channelDelete':
      return t('Channel {name} was deleted', { name: e.name }) + by;
    case 'channelRename':
      return t('Channel {from} was renamed to {name}', { from: e.from, name: e.name }) + by;
    case 'groupAdd':
      return t('{name} was added to the group {group}', { name: e.name, group: e.group || '?' }) + by;
    case 'groupRemove':
      return t('{name} was removed from the group {group}', { name: e.name, group: e.group || '?' }) + by;
    case 'error':
      return t('Error: {text}', { text: e.text });
  }
  return e.kind;
}

function handle(e: any) {
  const s = getTs();
  switch (e.type) {
    case 'identity':
      localStorage.setItem('tsIdentity', e.value);
      break;
    case 'status': {
      const was = s.status;
      setTs({ status: e.state, reason: e.reason || '' });
      if (e.state === 'connected' && was !== 'connected') {
        sfx('join');
        setTs({ connectedAt: Date.now() });
        syncVoice();
        if (s.muted) ts({ cmd: 'mute', value: true });
        if (s.deaf) ts({ cmd: 'deaf', value: true });
      }
      if (e.state === 'reconnecting') addLog('warn', t('Connection lost. Reconnecting…'));
      if (e.state === 'disconnected') {
        if (was === 'connected' || was === 'reconnecting') {
          sfx('leave');
          addLog('warn', e.reason ? t('Disconnected: {r}', { r: e.reason }) : t('Disconnected from the server'));
        } else if (was === 'connecting' && e.reason) toast(t('Could not connect to the TeamSpeak server: {r}', { r: e.reason }));
        setTs({ ...empty(), status: 'disconnected', reason: e.reason || '' });
      }
      (window as any).__syncPtt?.();
      break;
    }
    case 'state': {
      const meBefore = s.clients.find((c: TsClient) => c.isMe);
      const meNow = e.clients.find((c: TsClient) => c.isMe);
      // Sounds for people entering or leaving our channel, like Discord.
      if (meBefore && meNow && meBefore.channel === meNow.channel) {
        const before = new Set(s.clients.filter((c: TsClient) => c.channel === meNow.channel).map((c: TsClient) => c.id));
        const now = new Set(e.clients.filter((c: TsClient) => c.channel === meNow.channel).map((c: TsClient) => c.id));
        if ([...now].some((id) => !before.has(id))) sfx('userJoin');
        else if ([...before].some((id) => !now.has(id))) sfx('userLeave');
      } else if (meBefore && meNow && meBefore.channel !== meNow.channel) sfx('join');
      setTs({ server: e.server, own: e.own, channels: e.channels, clients: e.clients, serverGroups: e.serverGroups || [], channelGroups: e.channelGroups || [] });
      break;
    }
    case 'log':
      addLog(e.kind, logText(e));
      if (e.kind === 'move' && e.me) addChat('channel', { id: ++msgId, from: { id: 0, name: '' }, text: '— ' + t('You switched to channel {to}', { to: e.to }) + ' —', at: Date.now() });
      break;
    case 'stats':
      setTs({ stats: e });
      break;
    case 'talking':
      setTs({ talking: e.ids });
      break;
    case 'level':
      setTs({ level: e.level, tx: e.tx });
      break;
    case 'message': {
      const mine = e.from.id === s.own;
      const key = e.target === 'client' ? 'dm:' + (mine ? e.client : e.from.id) : e.target;
      addChat(key, { id: ++msgId, from: e.from, text: e.text, at: Date.now(), mine });
      if (!mine) sfx(e.target === 'client' ? 'mention' : 'message');
      break;
    }
    case 'poke':
      sfx('mention');
      addLog('poke', t('{name} poked you: {text}', { name: e.from.name, text: e.text || '…' }));
      setTs({ dialog: { kind: 'poked', from: e.from, text: e.text } });
      if (get().route.serverId !== '@ts') toast(t('{name} poked you: {text}', { name: e.from.name, text: e.text || '…' }), 'ok');
      break;
    case 'error':
      toast(e.message);
      addLog('error', t('Error: {text}', { text: e.message }));
      break;
  }
}

if (isDesktop) {
  (window as any).chrome.webview.addEventListener('message', (m: any) => m.data?.type === 'ts' && handle(m.data.event));
  window.addEventListener('hs-ptt', (e: any) => tsConnected() && get().settings.voiceMode === 'ptt' && syncVoice(e.detail));
  useStore.subscribe((st: any, prev: any) => {
    if (tsConnected() && (st.settings.voiceMode !== prev.settings.voiceMode || st.settings.vadThreshold !== prev.settings.vadThreshold || st.settings.noiseCancel !== prev.settings.noiseCancel)) syncVoice();
  });
  (window as any).__tsConnected = tsConnected;
  (window as any).__tsTray = () => {
    const s = getTs();
    if (!tsConnected()) return null;
    if (s.deaf) return { state: 'deafened', level: 0 };
    if (s.muted) return { state: 'muted', level: 0 };
    return { state: 'voice', level: s.tx ? s.level : 0 };
  };
  // The global mute/deafen shortcuts control TeamSpeak while you are not in a Hamsohbat call.
  const origMute = (window as any).__toggleMute;
  const origDeaf = (window as any).__toggleDeafen;
  (window as any).__toggleMute = () => (tsConnected() && !get().voice.channelId ? setMuted(!getTs().muted) : origMute?.());
  (window as any).__toggleDeafen = () => (tsConnected() && !get().voice.channelId ? setDeaf(!getTs().deaf) : origDeaf?.());
}
// For tests: feed bridge events without the desktop app.
(window as any).__tsEvent = handle;

// ---------------------------------------------------------------- actions
export function tsConnect(b: Bookmark) {
  const parsed = parseAddress(b.address);
  setTs({ ...empty(), status: 'connecting', log: [...getTs().log, { id: ++msgId, at: Date.now(), kind: 'info', text: t('Connecting to {address}…', { address: parsed.address }) }] });
  ts({
    cmd: 'connect',
    address: parsed.address,
    nickname: b.nickname || parsed.nickname || get().me?.displayName || 'Hamsohbat',
    password: b.password || parsed.password || '',
    channel: b.channel || parsed.channel || '',
    identity: localStorage.getItem('tsIdentity') || '',
    muted: getTs().muted,
    deaf: getTs().deaf,
  });
}
export const tsDisconnect = () => ts({ cmd: 'disconnect' });
function setMuted(v: boolean) {
  setTs({ muted: v, deaf: v ? getTs().deaf : false });
  ts({ cmd: 'mute', value: v });
  if (!v && getTs().deaf) ts({ cmd: 'deaf', value: false });
  sfx(v ? 'mute' : 'unmute');
}
function setDeaf(v: boolean) {
  setTs({ deaf: v });
  ts({ cmd: 'deaf', value: v });
  sfx(v ? 'deafen' : 'undeafen');
}
const dialog = (kind: string, props: any = {}) => setTs({ dialog: { kind, ...props } });
function joinChannel(c: TsChannel) {
  if (me()?.channel === c.id) return;
  if (c.hasPassword) return dialog('channelPassword', { channel: c });
  ts({ cmd: 'join', channel: c.id });
}
function openPrivate(c: TsClient) {
  setTs((s: any) => ({ tab: 'dm:' + c.id, chat: { ...s.chat, ['dm:' + c.id]: s.chat['dm:' + c.id] || [] } }));
}
function sendText(target: string, text: string) {
  if (!text.trim()) return;
  if (target.startsWith('dm:')) ts({ cmd: 'message', target: 'client', client: Number(target.slice(3)), text });
  else ts({ cmd: 'message', target: target === 'log' ? 'channel' : target, text });
}
function selectClient(c: TsClient) {
  setTs({ selected: { kind: 'client', id: c.id } });
  if (!c.isMe || !c.version) ts({ cmd: 'info', client: c.id });
}

/** Accepts host, host:port and ts3server:// links (the "connect" links TeamSpeak uses). */
export function parseAddress(input: string) {
  const out = { address: input.trim(), nickname: '', password: '', channel: '' };
  const m = input.trim().match(/^ts3server:\/\/([^/?]+)\/?\??(.*)$/i);
  if (m) {
    const q = new URLSearchParams(m[2]);
    out.address = m[1] + (q.get('port') ? ':' + q.get('port') : '');
    out.nickname = q.get('nickname') || '';
    out.password = q.get('password') || '';
    out.channel = q.get('channel') || '';
  }
  return out;
}
function saveBookmarks(list: Bookmark[]) {
  localStorage.setItem('tsBookmarks', JSON.stringify(list));
  setTs({ bookmarks: list });
}

/** TeamSpeak keeps sibling order as "the channel above me"; this rebuilds the visual order. */
function orderedChildren(channels: TsChannel[], parent: number) {
  const kids = channels.filter((c) => c.parent === parent);
  const out: TsChannel[] = [];
  let prev = 0;
  const left = new Set(kids);
  for (let i = 0; i < kids.length; i++) {
    const next = kids.find((c) => left.has(c) && c.order === prev);
    if (!next) break;
    out.push(next);
    left.delete(next);
    prev = next.id;
  }
  return [...out, ...[...left].sort((a, b) => a.id - b.id)];
}

/** TeamSpeak's formatting (BBCode): bold, italic, underline, colours and links. */
function BBText({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /\[(b|i|u|s|color=([^\]]+)|url(?:=([^\]]+))?)\]([\s\S]*?)\[\/(?:b|i|u|s|color|url)\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const strip = (s: string) => s.replace(/\[\/?(size(=[^\]]*)?|center|left|right|img|hr|list|\*|table|tr|td|th)\]/gi, '');
  let k = 0;
  while ((m = re.exec(text))) {
    out.push(strip(text.slice(last, m.index)));
    const tag = m[1].toLowerCase();
    const inner = <BBText text={m[4]} />;
    if (tag === 'b') out.push(<b key={k++}>{inner}</b>);
    else if (tag === 'i') out.push(<i key={k++}>{inner}</i>);
    else if (tag === 'u') out.push(<u key={k++}>{inner}</u>);
    else if (tag === 's') out.push(<s key={k++}>{inner}</s>);
    else if (tag.startsWith('color')) out.push(<span key={k++} style={{ color: m[2] }}>{inner}</span>);
    else {
      const href = m[3] || m[4];
      out.push(
        <a key={k++} href={/^https?:\/\//i.test(href) ? href : 'https://' + href} target="_blank" rel="noopener noreferrer">
          {strip(m[4])}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  out.push(strip(text.slice(last)));
  // Bare links become clickable too.
  return (
    <>
      {out.map((p, i) =>
        typeof p === 'string'
          ? p.split(/(https?:\/\/[^\s<>\]]+)/g).map((x, j) =>
              /^https?:\/\//.test(x) ? (
                <a key={i + '-' + j} href={x} target="_blank" rel="noopener noreferrer">
                  {x}
                </a>
              ) : (
                x
              )
            )
          : p
      )}
    </>
  );
}

const fmtDuration = (secs?: number | null) => {
  if (secs == null) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? t('{d}d {h}h', { d: num(d), h: num(h) }) : h ? t('{h}h {m}m', { h: num(h), m: num(m) }) : t('{m}m', { m: num(m) });
};
const fmtBytes = (n: number) => (n < 1024 ? n + ' B/s' : (n / 1024).toFixed(1) + ' KB/s');
const flag = (cc: string) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const groupNames = (c: TsClient) => {
  const s = getTs();
  return [
    ...c.serverGroups.map((id) => s.serverGroups.find((g: TsGroup) => g.id === id)).filter(Boolean).sort((a: TsGroup, b: TsGroup) => a.sort - b.sort),
  ] as TsGroup[];
};
/** Groups worth showing as badges (not the default "Guest"/"Normal" ones). */
const badgeGroups = (c: TsClient) => groupNames(c).filter((g) => !/^(guest|normal)$/i.test(g.name)).slice(0, 2);

// ---------------------------------------------------------------- UI
const TsLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
    <rect x="2" y="14" width="5" height="7" rx="2" />
    <rect x="17" y="14" width="5" height="7" rx="2" />
  </svg>
);

export function TsRailItem() {
  const active = useStore((s: any) => s.route.serverId === '@ts');
  const status = useTs((s: any) => s.status);
  if (!isDesktop) return null;
  return (
    <div className={'rail-item ts' + (active ? ' active' : '') + (status === 'connected' ? ' unread' : '')} title="TeamSpeak">
      <span className="pill" />
      <button onClick={() => navigate('@ts')} aria-label="TeamSpeak">
        <TsLogo />
      </button>
      {status === 'connected' && <span className="ts-live" />}
    </div>
  );
}

/** Ping bars like the official client's connection indicator. */
function PingBadge({ onClick }: { onClick?: (e: React.MouseEvent) => void }) {
  const stats = useTs((s: any) => s.stats);
  if (!stats) return null;
  const ping = Math.round(stats.ping);
  const q = ping < 60 ? 'good' : ping < 150 ? 'ok' : 'bad';
  return (
    <button className={'ts-ping ' + q} onClick={onClick} title={t('Ping {ms} ms • Packet loss {loss}%', { ms: num(ping), loss: num(Math.round(stats.loss * 1000) / 10) })}>
      <Signal size={16} /> {num(ping)} ms
    </button>
  );
}

function clientMenu(e: React.MouseEvent, c: TsClient) {
  const s = getTs();
  const volume = s.volumes[c.id] ?? 100;
  openMenu(e, [
    { label: t('Client Info'), icon: <Info size={16} />, onClick: () => selectClient(c) },
    { label: t('Send Private Message'), icon: <MessageSquare size={16} />, hidden: c.isMe, onClick: () => openPrivate(c) },
    { label: t('Poke'), icon: <BellRing size={16} />, hidden: c.isMe, onClick: () => dialog('poke', { client: c }) },
    { label: t('Change Nickname'), icon: <Pencil size={16} />, hidden: !c.isMe, onClick: () => dialog('nickname', { client: c }) },
    { label: t('Change Description'), icon: <Pencil size={16} />, onClick: () => dialog('description', { client: c }) },
    {
      hidden: c.isMe,
      custom: (
        <label className="volume">
          <span>
            {t('User Volume')} — {volume}%
          </span>
          <input
            type="range"
            min={0}
            max={200}
            defaultValue={volume}
            onChange={(ev) => {
              const v = Number(ev.target.value);
              setTs((st: any) => ({ volumes: { ...st.volumes, [c.id]: v } }));
              ts({ cmd: 'volume', client: c.id, value: v / 100 });
            }}
          />
        </label>
      ),
    },
    { label: t('Copy Unique ID'), icon: <Copy size={16} />, hidden: !c.uid, onClick: () => navigator.clipboard?.writeText(c.uid) },
    { sep: true },
    { label: t('Kick from Channel'), danger: true, hidden: c.isMe, onClick: () => dialog('kick', { client: c, server: false }) },
    { label: t('Kick from Server'), danger: true, hidden: c.isMe, onClick: () => dialog('kick', { client: c, server: true }) },
    { label: t('Ban'), icon: <Ban size={16} />, danger: true, hidden: c.isMe, onClick: () => dialog('ban', { client: c }) },
  ]);
}

function channelMenu(e: React.MouseEvent, c: TsChannel) {
  openMenu(e, [
    { label: t('Join Channel'), icon: <Volume2 size={16} />, hidden: me()?.channel === c.id, onClick: () => joinChannel(c) },
    { label: t('Channel Info'), icon: <Info size={16} />, onClick: () => setTs({ selected: { kind: 'channel', id: c.id } }) },
    { sep: true },
    { label: t('Create Sub-Channel'), icon: <FolderPlus size={16} />, onClick: () => dialog('channelCreate', { parent: c }) },
    { label: t('Edit Channel'), icon: <Pencil size={16} />, onClick: () => dialog('channelEdit', { channel: c }) },
    { label: t('Delete Channel'), icon: <Trash2 size={16} />, danger: true, onClick: () => dialog('channelDelete', { channel: c }) },
  ]);
}

function TsUser({ c }: { c: TsClient }) {
  const talking = useTs((s: any) => s.talking.includes(c.id) || (c.isMe && s.tx));
  const selected = useTs((s: any) => s.selected.kind === 'client' && s.selected.id === c.id);
  useTs((s: any) => s.serverGroups);
  const badges = badgeGroups(c);
  return (
    <div
      className={'voice-user ts-user' + (selected ? ' selected' : '')}
      onClick={() => selectClient(c)}
      onContextMenu={(e) => clientMenu(e, c)}
      onDoubleClick={() => !c.isMe && openPrivate(c)}
      title={c.description || c.name}
    >
      <div className={'avatar' + (talking ? ' speaking' : '')} style={{ width: 24, height: 24, fontSize: 10 }}>
        <div className="avatar-fallback" style={{ background: colorFor(String(c.id) + c.name) }}>
          {[...c.name][0]?.toUpperCase()}
        </div>
      </div>
      <span className="vu-name" style={c.isMe ? { color: 'var(--text-strong)', fontWeight: 600 } : undefined}>
        {c.name}
      </span>
      {badges.map((g) => (
        <span key={g.id} className="ts-badge" title={g.name}>
          {g.name}
        </span>
      ))}
      {c.prioritySpeaker && <Crown size={13} className="yellow" />}
      {c.talkRequest != null && <Hand size={13} className="yellow" />}
      {c.recording && <span className="live">REC</span>}
      {c.away && <Moon size={14} className="yellow" />}
      {(c.inputMuted || !c.inputHardware) && <MicOff size={14} />}
      {(c.outputMuted || !c.outputHardware) && <HeadphoneOff size={14} />}
    </div>
  );
}

function TsChannelNode({ c, depth }: { c: TsChannel; depth: number }) {
  const channels = useTs((s: any) => s.channels);
  const clients = useTs((s: any) => s.clients);
  const selected = useTs((s: any) => s.selected.kind === 'channel' && s.selected.id === c.id);
  const mine = clients.find((x: TsClient) => x.isMe);
  const users = clients.filter((x: TsClient) => x.channel === c.id).sort((a: TsClient, b: TsClient) => b.talkPower - a.talkPower || a.name.localeCompare(b.name));
  const kids = orderedChildren(channels, c.id);
  const spacer = c.name.match(/^\[(c|l|r|\*)?spacer[^\]]*\](.*)$/i);
  const full = c.maxClients >= 0 && users.length >= c.maxClients;
  return (
    <>
      {spacer ? (
        <div className={'ts-spacer ' + (spacer[1] || 'l').toLowerCase()} style={{ paddingInlineStart: depth * 12 }} onContextMenu={(e) => channelMenu(e, c)}>
          {spacer[1] === '*' ? <span className="ts-spacer-line">{spacer[2].repeat(40).slice(0, 80)}</span> : spacer[2]}
        </div>
      ) : (
        <div
          className={'channel' + (mine?.channel === c.id ? ' active' : '') + (selected ? ' selected' : '') + (full ? ' full' : '')}
          style={{ paddingInlineStart: 8 + depth * 12 }}
          onClick={() => setTs({ selected: { kind: 'channel', id: c.id } })}
          onDoubleClick={() => joinChannel(c)}
          onContextMenu={(e) => channelMenu(e, c)}
          title={(c.topic || c.name) + '\n' + t('Double-click to join')}
        >
          <Volume2 size={18} />
          <span className="ch-name">{c.name}</span>
          {c.isDefault && <span className="ts-badge">{t('Default')}</span>}
          {c.neededTalkPower > 0 && <Hand size={12} />}
          {c.hasPassword && <Lock size={13} />}
          {c.maxClients >= 0 && (
            <small className="ts-count">
              {users.length}/{c.maxClients}
            </small>
          )}
        </div>
      )}
      {users.length > 0 && (
        <div className="voice-users" style={{ paddingInlineStart: 28 + depth * 12 }}>
          {users.map((u: TsClient) => (
            <TsUser key={u.id} c={u} />
          ))}
        </div>
      )}
      {kids.map((k) => (
        <TsChannelNode key={k.id} c={k} depth={depth + 1} />
      ))}
    </>
  );
}

export function TsSidebar() {
  const status = useTs((s: any) => s.status);
  const server = useTs((s: any) => s.server);
  const channels = useTs((s: any) => s.channels);
  const muted = useTs((s: any) => s.muted);
  const deaf = useTs((s: any) => s.deaf);
  const away = useTs((s: any) => s.away);
  const meNow = useTs((s: any) => s.clients.find((x: TsClient) => x.isMe));
  const meChannel = useTs((s: any) => s.channels.find((c: TsChannel) => c.id === s.clients.find((x: TsClient) => x.isMe)?.channel));
  const connected = status === 'connected' || status === 'reconnecting';
  const needsTalk = meChannel && meChannel.neededTalkPower > (meNow?.talkPower || 0) && !meNow?.talker;
  return (
    <>
      <div className="sidebar-head">
        <span className="clickable" onClick={() => setTs({ selected: { kind: 'server' } })}>
          {server?.name || 'TeamSpeak'}
        </span>
        {connected && (
          <>
            <button className="icon-btn" title={t('Create Channel')} onClick={() => dialog('channelCreate', {})}>
              <Plus size={16} />
            </button>
            <button className="icon-btn" title={away ? t('Back') : t('Set Away')} onClick={() => (away ? (setTs({ away: false }), ts({ cmd: 'away', value: false })) : dialog('away'))}>
              <Moon size={16} className={away ? 'yellow' : ''} />
            </button>
          </>
        )}
      </div>
      <div className="sidebar-scroll">
        {connected ? (
          <>
            <div className={'ts-server-row' + (useTs.getState().selected.kind === 'server' ? ' selected' : '')} onClick={() => setTs({ selected: { kind: 'server' } })}>
              <Server size={16} /> <span>{server?.name}</span>
            </div>
            {orderedChildren(channels, 0).map((c) => (
              <TsChannelNode key={c.id} c={c} depth={0} />
            ))}
          </>
        ) : (
          <div className="muted ts-hint">{status === 'connecting' ? t('Connecting…') : t('Not connected to a TeamSpeak server.')}</div>
        )}
      </div>
      <div className="user-area">
        {connected && (
          <div className="voice-status">
            <div className="vs-info" onClick={() => meNow && selectClient(meNow)}>
              <b className={status === 'reconnecting' ? 'yellow' : 'green'}>
                <TsLogo size={16} /> {status === 'reconnecting' ? t('Reconnecting…') : t('TeamSpeak Connected')}
              </b>
              <small>{meChannel ? `${meChannel.name} / ${server?.name || ''}` : server?.name}</small>
            </div>
            {needsTalk && (
              <button className={'icon-btn' + (meNow?.talkRequest != null ? ' on' : '')} title={meNow?.talkRequest != null ? t('Cancel Talk Request') : t('Request Talk Power')} onClick={() => (meNow?.talkRequest != null ? ts({ cmd: 'talkRequest', value: false }) : dialog('talkRequest'))}>
                <Hand size={18} />
              </button>
            )}
            <button className="icon-btn danger" title={t('Disconnect')} onClick={tsDisconnect}>
              <PhoneOff size={20} />
            </button>
          </div>
        )}
        <div className="user-panel">
          <div className="me">
            <div className="me-text">
              <b>{meNow?.name || get().me?.displayName}</b>
              <small>{connected ? <PingBadge /> : 'TeamSpeak'}</small>
            </div>
          </div>
          <button className={'icon-btn' + (muted ? ' danger' : '')} title={muted ? t('Unmute') : t('Mute')} onClick={() => setMuted(!muted)}>
            {muted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button className={'icon-btn' + (deaf ? ' danger' : '')} title={deaf ? t('Undeafen') : t('Deafen')} onClick={() => setDeaf(!deaf)}>
            {deaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
        </div>
      </div>
      <TsDialogs />
    </>
  );
}

function ConnectForm() {
  const bookmarks: Bookmark[] = useTs((s: any) => s.bookmarks);
  const status = useTs((s: any) => s.status);
  const reason = useTs((s: any) => s.reason);
  const meUser = useStore((s: any) => s.me);
  const [f, setF] = useState<Bookmark>({ name: '', address: '', nickname: meUser?.displayName || '', password: '', channel: '' });
  const [save, setSave] = useState(true);
  const up = (k: keyof Bookmark) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.address.trim()) return;
    if (save) {
      const p = parseAddress(f.address);
      const entry = { ...f, name: f.name || p.address };
      saveBookmarks([entry, ...bookmarks.filter((b) => b.address !== f.address)].slice(0, 20));
    }
    tsConnect(f);
  };
  return (
    <div className="ts-connect">
      <div className="ts-hero">
        <TsLogo size={48} />
        <h2>{t('Connect to a TeamSpeak server')}</h2>
        <p className="muted">{t('Join your TeamSpeak 3 server right here, no TeamSpeak client needed. Paste the address or a ts3server:// link.')}</p>
      </div>
      <form onSubmit={submit} className="ts-form">
        <Field label={t('Server Address')}>
          <input
            dir="ltr"
            value={f.address}
            onChange={(e) => {
              const p = parseAddress(e.target.value);
              setF({ ...f, address: e.target.value, nickname: p.nickname || f.nickname, password: p.password || f.password, channel: p.channel || f.channel });
            }}
            placeholder="ts.example.com:9987"
            required
            autoFocus
          />
        </Field>
        <div className="two-col">
          <Field label={t('Nickname')}>
            <input dir="auto" value={f.nickname} onChange={up('nickname')} maxLength={30} required />
          </Field>
          <Field label={t('Server Password')}>
            <input dir="ltr" type="password" value={f.password} onChange={up('password')} placeholder={t('Optional')} />
          </Field>
        </div>
        <div className="two-col">
          <Field label={t('Default Channel')}>
            <input dir="auto" value={f.channel} onChange={up('channel')} placeholder={t('Optional')} />
          </Field>
          <Field label={t('Bookmark Name')}>
            <input dir="auto" value={f.name} onChange={up('name')} placeholder={t('Optional')} />
          </Field>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {t('Save as bookmark')}
        </label>
        {status === 'disconnected' && reason && <div className="form-error">{reason}</div>}
        <button className="btn primary wide" disabled={status === 'connecting'}>
          {status === 'connecting' ? t('Connecting…') : t('Connect')}
        </button>
      </form>
      {bookmarks.length > 0 && (
        <div className="ts-bookmarks">
          <div className="list-title">{t('Bookmarks')}</div>
          {bookmarks.map((b, i) => (
            <div key={i} className="list-row clickable" onClick={() => tsConnect(b)}>
              <Server size={20} />
              <div className="grow">
                <b>{b.name}</b>
                <small dir="ltr">
                  {b.nickname} @ {parseAddress(b.address).address}
                </small>
              </div>
              <button className="icon-btn danger" title={t('Remove')} onClick={(e) => (e.stopPropagation(), saveBookmarks(bookmarks.filter((_, j) => j !== i)))}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <TsLogView compact />
    </div>
  );
}

// ---------------------------------------------------------------- info panel (server, channel or user)
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ts-info-row">
      <span>{label}</span>
      <b dir="auto">{children}</b>
    </div>
  );
}

function TsInfo() {
  const selected: Selection = useTs((s: any) => s.selected);
  const server = useTs((s: any) => s.server);
  const clients: TsClient[] = useTs((s: any) => s.clients);
  const channels: TsChannel[] = useTs((s: any) => s.channels);
  const stats = useTs((s: any) => s.stats);
  const connectedAt = useTs((s: any) => s.connectedAt);
  useTs((s: any) => s.serverGroups);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  // Refresh a selected user's ping and connection time now and then.
  useEffect(() => {
    if (selected.kind !== 'client') return;
    const id = setInterval(() => ts({ cmd: 'info', client: selected.id }), 10000);
    return () => clearInterval(id);
  }, [selected.kind, (selected as any).id]);

  if (selected.kind === 'client') {
    const c = clients.find((x) => x.id === selected.id);
    if (!c) return <TsServerInfo server={server} stats={stats} connectedAt={connectedAt} clients={clients} />;
    const cg = getTs().channelGroups.find((g: TsGroup) => g.id === c.channelGroup);
    return (
      <div className="ts-info">
        <div className="ts-info-head">
          <div className="avatar" style={{ width: 56, height: 56, fontSize: 22 }}>
            <div className="avatar-fallback" style={{ background: colorFor(String(c.id) + c.name) }}>
              {[...c.name][0]?.toUpperCase()}
            </div>
          </div>
          <div className="grow">
            <h2 dir="auto">
              {c.name} {flag(c.country)}
            </h2>
            {c.away && (
              <div className="yellow">
                <Moon size={14} /> {c.away || t('Away')}
              </div>
            )}
          </div>
          {!c.isMe && (
            <div className="row-actions">
              <button className="btn small" onClick={() => openPrivate(c)}>
                <MessageSquare size={14} /> {t('Message')}
              </button>
              <button className="btn small" onClick={() => dialog('poke', { client: c })}>
                <BellRing size={14} /> {t('Poke')}
              </button>
            </div>
          )}
        </div>
        {c.description && (
          <p className="ts-desc" dir="auto">
            <BBText text={c.description} />
          </p>
        )}
        <div className="ts-info-grid">
          <InfoRow label={t('Server Groups')}>{groupNames(c).map((g) => g.name).join('، ') || '—'}</InfoRow>
          <InfoRow label={t('Channel Group')}>{cg?.name || '—'}</InfoRow>
          <InfoRow label={t('Channel')}>{channelName(c.channel)}</InfoRow>
          <InfoRow label={t('Version')}>{c.version ? `${c.version.replace(/ \[Build.*\]/, '')} (${c.platform})` : '…'}</InfoRow>
          <InfoRow label={t('Ping')}>{c.isMe && stats ? `${num(Math.round(stats.ping))} ms` : c.ping != null ? `${num(c.ping)} ms` : '…'}</InfoRow>
          <InfoRow label={t('Connected For')}>{c.isMe && connectedAt ? fmtDuration(Math.round((Date.now() - connectedAt) / 1000)) : fmtDuration(c.connectedFor)}</InfoRow>
          <InfoRow label={t('Idle For')}>{fmtDuration(c.idleFor)}</InfoRow>
          <InfoRow label={t('Packet Loss')}>{c.loss != null ? num(Math.round(c.loss * 1000) / 10) + '%' : '—'}</InfoRow>
          <InfoRow label={t('First Connected')}>{c.created ? fmtDate(c.created * 1000) : '…'}</InfoRow>
          <InfoRow label={t('Total Connections')}>{c.connections != null ? num(c.connections) : '…'}</InfoRow>
          <InfoRow label={t('Talk Power')}>{num(c.talkPower)}</InfoRow>
          <InfoRow label={t('Unique ID')}>
            <span dir="ltr" className="ts-uid">
              {c.uid || '—'}
            </span>
          </InfoRow>
        </div>
        {c.talkRequest != null && (
          <div className="notice">
            <Hand size={14} /> {t('Requests talk power: {msg}', { msg: c.talkRequest || '…' })}
          </div>
        )}
      </div>
    );
  }
  if (selected.kind === 'channel') {
    const c = channels.find((x) => x.id === selected.id);
    if (!c) return <TsServerInfo server={server} stats={stats} connectedAt={connectedAt} clients={clients} />;
    const here = clients.filter((x) => x.channel === c.id);
    return (
      <div className="ts-info">
        <div className="ts-info-head">
          <Volume2 size={40} />
          <div className="grow">
            <h2 dir="auto">{c.name}</h2>
            {c.topic && (
              <div className="muted" dir="auto">
                {c.topic}
              </div>
            )}
          </div>
          {me()?.channel !== c.id && (
            <button className="btn primary small" onClick={() => joinChannel(c)}>
              {t('Join Channel')}
            </button>
          )}
        </div>
        {c.description && (
          <div className="ts-desc" dir="auto">
            <BBText text={c.description} />
          </div>
        )}
        <div className="ts-info-grid">
          <InfoRow label={t('Users')}>{num(here.length) + (c.maxClients >= 0 ? ' / ' + num(c.maxClients) : '')}</InfoRow>
          <InfoRow label={t('Channel Type')}>{t(c.type === 'permanent' ? 'Permanent' : c.type === 'semi' ? 'Semi-Permanent' : 'Temporary')}</InfoRow>
          <InfoRow label={t('Codec')}>{`${c.codec.replace('Opus', 'Opus ')} • ${num(c.codecQuality)}`}</InfoRow>
          <InfoRow label={t('Needed Talk Power')}>{num(c.neededTalkPower)}</InfoRow>
          <InfoRow label={t('Password')}>{c.hasPassword ? t('Yes') : t('No')}</InfoRow>
        </div>
      </div>
    );
  }
  return <TsServerInfo server={server} stats={stats} connectedAt={connectedAt} clients={clients} />;
}

function TsServerInfo({ server, stats, connectedAt, clients }: any) {
  if (!server) return null;
  return (
    <div className="ts-info">
      {server.banner && (
        <a className="ts-banner" href={server.bannerUrl || undefined} target="_blank" rel="noopener noreferrer">
          <img src={server.banner} alt="" onError={(e) => ((e.target as HTMLElement).style.display = 'none')} />
        </a>
      )}
      <div className="ts-info-head">
        <Server size={40} />
        <div className="grow">
          <h2 dir="auto">{server.name}</h2>
          <div className="muted">
            {server.version?.replace(/ \[Build.*\]/, '')} • {server.platform}
          </div>
        </div>
      </div>
      {server.hostMessage && (
        <div className="notice" dir="auto">
          <BBText text={server.hostMessage} />
        </div>
      )}
      {server.welcome && (
        <div className="ts-desc" dir="auto">
          <BBText text={server.welcome} />
        </div>
      )}
      <div className="ts-info-grid">
        <InfoRow label={t('Users Online')}>{`${num(clients.length)} / ${num(server.maxClients || 0)}`}</InfoRow>
        <InfoRow label={t('Ping')}>{stats ? `${num(Math.round(stats.ping))} ms (± ${num(Math.round(stats.pingDev))})` : '…'}</InfoRow>
        <InfoRow label={t('Packet Loss')}>{stats ? num(Math.round(stats.loss * 1000) / 10) + '%' : '…'}</InfoRow>
        <InfoRow label={t('Bandwidth')}>{stats ? `↓ ${fmtBytes(stats.bytesIn)} • ↑ ${fmtBytes(stats.bytesOut)}` : '…'}</InfoRow>
        <InfoRow label={t('Connected For')}>{connectedAt ? fmtDuration(Math.round((Date.now() - connectedAt) / 1000)) : '—'}</InfoRow>
        <InfoRow label={t('Server Uptime')}>{fmtDuration(server.uptime)}</InfoRow>
        <InfoRow label={t('Created')}>{server.created ? fmtDate(server.created * 1000) : '—'}</InfoRow>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- log & chat
function TsLogView({ compact }: { compact?: boolean }) {
  const log: TsLog[] = useTs((s: any) => s.log);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.length]);
  if (compact && !log.length) return null;
  return (
    <div className={'ts-log' + (compact ? ' compact' : '')} ref={ref}>
      {log.map((l) => (
        <div key={l.id} className={'ts-log-line ' + l.kind}>
          <time>{fmtTime(l.at)}</time>
          <span dir="auto">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function TsChat() {
  const tab = useTs((s: any) => s.tab);
  const chat = useTs((s: any) => s.chat);
  const clients = useTs((s: any) => s.clients);
  const server = useTs((s: any) => s.server);
  const unread = useTs((s: any) => s.unread);
  const meChannel = useTs((s: any) => s.channels.find((c: TsChannel) => c.id === s.clients.find((x: TsClient) => x.isMe)?.channel));
  const [text, setText] = useState('');
  const list: TsMessage[] = chat[tab] || [];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
    if (unread[tab]) setTs((s: any) => ({ unread: { ...s.unread, [tab]: 0 } }));
  }, [list.length, tab]);
  const tabs = ['log', 'server', 'channel', ...Object.keys(chat).filter((k) => k.startsWith('dm:'))];
  const label = (k: string) =>
    k === 'log'
      ? t('Server Log')
      : k === 'channel'
      ? meChannel?.name || t('Channel')
      : k === 'server'
      ? server?.name || t('Server')
      : clients.find((c: TsClient) => c.id === Number(k.slice(3)))?.name || t('Private chat');
  return (
    <div className="ts-chat-area">
      <div className="ts-tabs">
        {tabs.map((k) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTs({ tab: k })}>
            {k === 'log' ? <ScrollText size={14} /> : k === 'channel' ? <Hash size={14} /> : k === 'server' ? <Server size={14} /> : <UserRound size={14} />}
            <span>{label(k)}</span>
            {unread[k] > 0 && tab !== k && <span className="badge">{unread[k]}</span>}
            {k.startsWith('dm:') && (
              <X
                size={12}
                onClick={(e) => {
                  e.stopPropagation();
                  setTs((s: any) => {
                    const c = { ...s.chat };
                    delete c[k];
                    return { chat: c, tab: s.tab === k ? 'channel' : s.tab };
                  });
                }}
              />
            )}
          </button>
        ))}
      </div>
      {tab === 'log' ? (
        <TsLogView />
      ) : (
        <div className="ts-chat" ref={ref}>
          {list.length === 0 && <p className="muted center ts-empty">{t('No messages yet. Say hi!')}</p>}
          {list.map((m) =>
            !m.from.name ? (
              <div key={m.id} className="ts-msg system">
                <span>{m.text}</span>
              </div>
            ) : (
              <div key={m.id} className={'ts-msg' + (m.mine ? ' mine' : '')}>
                <time>{fmtTime(m.at)}</time>
                <b style={{ color: colorFor(String(m.from.id) + m.from.name) }}>{m.from.name}:</b>
                <span dir="auto">
                  <BBText text={m.text} />
                </span>
              </div>
            )
          )}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          sendText(tab, text);
          setText('');
          if (tab === 'log') setTs({ tab: 'channel' });
        }}
      >
        <div className="composer-row">
          <input className="ts-input" dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Message {name}', { name: tab === 'log' ? label('channel') : label(tab) })} maxLength={1024} />
        </div>
      </form>
    </div>
  );
}

function TsConnected() {
  const server = useTs((s: any) => s.server);
  return (
    <div className="main-col">
      <header className="main-head">
        <TsLogo size={22} />
        <b className="head-title">{server?.name || 'TeamSpeak'}</b>
        <div className="spacer" />
        <PingBadge onClick={() => setTs({ selected: { kind: 'server' } })} />
        <button className="btn small" onClick={tsDisconnect}>
          <LogOut size={14} /> {t('Disconnect')}
        </button>
      </header>
      <div className="ts-layout">
        <TsInfo />
        <TsChat />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs (instead of browser prompts)
function TsDialogs() {
  const d = useTs((s: any) => s.dialog);
  const [v, setV] = useState<any>({});
  useEffect(() => setV({}), [d]);
  if (!d) return null;
  const close = () => setTs({ dialog: null });
  const form = (title: string, body: React.ReactNode, action: string, onOk: () => void, danger = false) => (
    <Modal title={title} onClose={close} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onOk();
          close();
        }}
      >
        <div className="modal-body">{body}</div>
        <div className="modal-foot">
          <button type="button" className="btn link" onClick={close}>
            {t('Cancel')}
          </button>
          <button className={'btn ' + (danger ? 'danger' : 'primary')}>{action}</button>
        </div>
      </form>
    </Modal>
  );
  const input = (key: string, label: string, props: any = {}) => (
    <Field label={label}>
      <input dir="auto" value={v[key] ?? props.defaultValue ?? ''} onChange={(e) => setV({ ...v, [key]: e.target.value })} {...props} defaultValue={undefined} />
    </Field>
  );
  switch (d.kind) {
    case 'poked':
      return (
        <Modal title={t('You were poked')} onClose={close} width={380}>
          <div className="modal-body">
            <p>
              <b>{d.from.name}</b>: {d.text || '…'}
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={close} autoFocus>
              {t('OK')}
            </button>
          </div>
        </Modal>
      );
    case 'poke':
      return form(t('Poke {name}', { name: d.client.name }), input('text', t('Message'), { autoFocus: true, maxLength: 100 }), t('Poke'), () => ts({ cmd: 'poke', client: d.client.id, text: v.text || '' }));
    case 'channelPassword':
      return form(t('Password for {name}', { name: d.channel.name }), input('pw', t('Password'), { type: 'password', autoFocus: true, dir: 'ltr' }), t('Join Channel'), () =>
        ts({ cmd: 'join', channel: d.channel.id, password: v.pw || '' })
      );
    case 'nickname':
      return form(t('Change Nickname'), input('name', t('Nickname'), { autoFocus: true, maxLength: 30, defaultValue: d.client.name }), t('Save'), () => ts({ cmd: 'nickname', value: v.name ?? d.client.name }));
    case 'description':
      return form(t('Change Description'), input('text', t('Description'), { autoFocus: true, maxLength: 200, defaultValue: d.client.description }), t('Save'), () =>
        ts({ cmd: 'description', client: d.client.id, value: v.text ?? d.client.description })
      );
    case 'away':
      return form(t('Set Away'), input('msg', t('Away Message'), { autoFocus: true, maxLength: 80, placeholder: t('Away') }), t('Set Away'), () => {
        setTs({ away: true });
        ts({ cmd: 'away', value: true, message: v.msg || t('Away') });
      });
    case 'talkRequest':
      return form(t('Request Talk Power'), input('msg', t('Message'), { autoFocus: true, maxLength: 50 }), t('Request'), () => ts({ cmd: 'talkRequest', value: true, message: v.msg || '' }));
    case 'kick':
      return form(
        d.server ? t('Kick {name} from the server', { name: d.client.name }) : t('Kick {name} from the channel', { name: d.client.name }),
        input('reason', t('Reason'), { autoFocus: true, maxLength: 80 }),
        t('Kick'),
        () => ts({ cmd: 'kick', client: d.client.id, server: d.server, reason: v.reason || '' }),
        true
      );
    case 'ban':
      return form(
        t('Ban {name}', { name: d.client.name }),
        <>
          {input('reason', t('Reason'), { autoFocus: true, maxLength: 80 })}
          <Field label={t('Duration')}>
            <select value={v.secs ?? 3600} onChange={(e) => setV({ ...v, secs: Number(e.target.value) })}>
              <option value={600}>{t('10 minutes')}</option>
              <option value={3600}>{t('1 hour')}</option>
              <option value={86400}>{t('1 day')}</option>
              <option value={604800}>{t('1 week')}</option>
              <option value={0}>{t('Permanent')}</option>
            </select>
          </Field>
        </>,
        t('Ban'),
        () => ts({ cmd: 'ban', client: d.client.id, reason: v.reason || '', seconds: v.secs ?? 3600 }),
        true
      );
    case 'channelCreate':
      return form(
        d.parent ? t('Create Sub-Channel in {name}', { name: d.parent.name }) : t('Create Channel'),
        <>
          {input('name', t('Channel Name'), { autoFocus: true, required: true, maxLength: 40 })}
          {input('topic', t('Topic'), { maxLength: 255 })}
          <div className="two-col">
            {input('password', t('Password'), { type: 'password', dir: 'ltr', placeholder: t('Optional') })}
            {input('max', t('Max Users'), { type: 'number', min: 0, placeholder: '∞' })}
          </div>
          <Field label={t('Channel Type')}>
            <select value={v.kind || 'temporary'} onChange={(e) => setV({ ...v, kind: e.target.value })}>
              <option value="temporary">{t('Temporary')}</option>
              <option value="semi">{t('Semi-Permanent')}</option>
              <option value="permanent">{t('Permanent')}</option>
            </select>
          </Field>
        </>,
        t('Create'),
        () => ts({ cmd: 'channelCreate', name: v.name || '', topic: v.topic || '', password: v.password || '', maxClients: Number(v.max) || 0, kind: v.kind || 'temporary', parent: d.parent?.id || 0 })
      );
    case 'channelEdit':
      return form(
        t('Edit Channel'),
        <>
          {input('name', t('Channel Name'), { autoFocus: true, required: true, maxLength: 40, defaultValue: d.channel.name })}
          {input('topic', t('Topic'), { maxLength: 255, defaultValue: d.channel.topic || '' })}
        </>,
        t('Save'),
        () => ts({ cmd: 'channelEdit', channel: d.channel.id, name: v.name ?? d.channel.name, topic: v.topic ?? d.channel.topic ?? '' })
      );
    case 'channelDelete':
      return form(t('Delete Channel'), <p>{t('Are you sure you want to delete {name}? This cannot be undone.', { name: d.channel.name })}</p>, t('Delete'), () => ts({ cmd: 'channelDelete', channel: d.channel.id, force: true }), true);
  }
  return null;
}

export function TsMain() {
  const status = useTs((s: any) => s.status);
  if (!isDesktop)
    return (
      <div className="main-col">
        <div className="empty">
          <TsLogo size={64} />
          <p>{t('TeamSpeak servers can be joined from the Hamsohbat Windows app.')}</p>
          <button className="btn primary" onClick={() => useStore.setState({ modal: { type: 'userSettings', tab: 'updates' } })}>
            <Plus size={16} /> {t('Get the App')}
          </button>
        </div>
      </div>
    );
  return status === 'connected' || status === 'reconnecting' ? <TsConnected /> : <ConnectForm />;
}
export { Shield, Clock, Globe, Monitor };
