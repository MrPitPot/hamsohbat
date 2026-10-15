import { create } from 'zustand';
import { api, setUnauthorizedHandler } from './api';
import { P, ALL_PERMS, CH, REL, computeChannelPerms, TIMEOUT_REMOVES } from '../shared/perms';
import { loadLang, setLang, t } from './i18n';
import { voice, sfx } from './voice';
import { setSoundVolume, playBuiltin, soundCtx, BUILTIN_EMOJI } from './sfx';
import { appearanceDefaults, applyAppearance } from './appearance';

const defaultSettings = {
  ...appearanceDefaults,
  lang: 'fa',
  inputDevice: '',
  outputDevice: '',
  noiseSuppression: true,
  noiseCancel: 'ai' as 'ai' | 'rnnoise' | 'standard' | 'off',
  echoCancellation: true,
  autoGain: true,
  sounds: true,
  soundVolume: 60,
  desktopNotif: false,
  volumes: {} as Record<string, number>,
  collapsed: {} as Record<string, boolean>,
  muted: {} as Record<string, boolean>, // servers, channels and DMs with notifications muted
  voiceMode: 'vad' as 'vad' | 'ptt',
  pttKey: 'Backquote',
  shareActivity: true,
  notifyLevel: {} as Record<string, string>,
  folders: [] as { id: string; name: string; color: string; servers: string[]; open?: boolean }[],
  serverOrder: [] as string[],
  streamQuality: '720p30',
  sbVolume: 80,
  autoIdle: 10,
  vadThreshold: -55, // dB; the microphone stays silent below this level
  vadAuto: true, // automatic sensitivity
};

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return defaultSettings;
  }
}

const initial = () => ({
  status: 'idle' as 'idle' | 'connecting' | 'ready' | 'reconnecting',
  sid: '',
  me: null as any,
  users: {} as Record<string, any>,
  presences: {} as Record<string, string>,
  relationships: {} as Record<string, number>,
  servers: {} as Record<string, any>,
  serverOrder: [] as string[],
  dms: {} as Record<string, any>,
  readStates: {} as Record<string, { lastReadId: string; mentions: number }>,
  messages: {} as Record<string, { list: any[]; hasMore: boolean; hasNewer: boolean; loading?: boolean }>,
  typing: {} as Record<string, Record<string, number>>,
  voiceStates: {} as Record<string, any>,
  speaking: {} as Record<string, boolean>,
  ringing: null as null | { channelId: string; from: string },
  jump: null as null | { channelId: string; messageId: string; n: number },
  replyTo: {} as Record<string, any>,
  notes: {} as Record<string, string>,
  activities: {} as Record<string, any>,
  imports: {} as Record<string, any>,
  sbFlash: {} as Record<string, { emoji: string; until: number }>,
});

export const useStore = create<any>(() => ({
  token: localStorage.getItem('token'),
  settings: loadSettings(),
  route: { serverId: null as string | null, channelId: null as string | null },
  pendingInvite: null as string | null,
  modal: null as null | { type: string; [k: string]: any },
  toasts: [] as { id: number; text: string; kind: string }[],
  showMembers: true,
  mobileNav: false,
  voice: { channelId: null as string | null, connecting: false, mute: false, deaf: false, video: false, screen: false, noMic: false },
  voiceTick: 0,
  desktop: null as any, // set by the Windows app: version, autostart, closeToTray, server
  update: { state: 'idle' } as any,
  ...initial(),
}));

export const get = useStore.getState;
export const set = useStore.setState;
setLang(get().settings.lang);
applyAppearance(get().settings);
setSoundVolume(get().settings.soundVolume / 100);

// ---------- small utilities ----------
let toastId = 0;
export function toast(text: string, kind = 'error') {
  const id = ++toastId;
  set((s: any) => ({ toasts: [...s.toasts, { id, text: t(text), kind }] }));
  setTimeout(() => set((s: any) => ({ toasts: s.toasts.filter((x: any) => x.id !== id) })), 4000);
}
/** Runs an API action and shows the error as a toast instead of throwing. */
export async function act<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e: any) {
    toast(e.message);
    return undefined;
  }
}
export const openModal = (type: string, props: any = {}) => set({ modal: { type, ...props } });
/** Closes the modal after its exit animation. */
export const closeModal = () => {
  const m = get().modal;
  if (!m || m.closing) return;
  set({ modal: { ...m, closing: true } });
  setTimeout(() => get().modal?.closing && set({ modal: null }), 140);
};

export function updateSettings(patch: any) {
  // Switching to Persian waits for its dictionary so the re-render shows translated text.
  if (patch.lang && patch.lang !== get().settings.lang) {
    loadLang(patch.lang)
      .catch(() => {})
      .then(() => applySettings(patch));
    return;
  }
  applySettings(patch);
}
function applySettings(patch: any) {
  const settings = { ...get().settings, ...patch };
  localStorage.setItem('settings', JSON.stringify(settings));
  setLang(settings.lang);
  setSoundVolume(settings.soundVolume / 100);
  applyAppearance(settings);
  set({ settings });
}

// ---------- selectors ----------
export function permsIn(server: any, userId: string): number {
  if (!server) return 0;
  const m = server.members[userId];
  if (!m) return 0;
  if (server.ownerId === userId) return ALL_PERMS;
  let p = 0;
  for (const r of server.roles) if (r.id === server.id || m.roles.includes(r.id)) p |= r.permissions;
  return p & P.ADMIN ? ALL_PERMS : p;
}
export function topPos(server: any, userId: string): number {
  if (server.ownerId === userId) return Infinity;
  const m = server.members[userId];
  return Math.max(0, ...server.roles.filter((r: any) => m?.roles.includes(r.id)).map((r: any) => r.position));
}
export function can(serverId: string | null | undefined, perm: number) {
  const s = get();
  if (!serverId) return true;
  return !!(permsIn(s.servers[serverId], s.me.id) & perm);
}
export function timedOut(server: any, userId: string) {
  return (server?.members[userId]?.timeoutUntil || 0) > Date.now();
}
/** Overrides that apply to a channel: threads use their parent's, unsynced channels follow their category. */
export function effectiveOverwrites(server: any, ch: any): any[] {
  if (!ch) return [];
  const byId = (id: string) => server.channels.find((c: any) => c.id === id);
  if (ch.type === CH.THREAD && ch.parentId && byId(ch.parentId)) return effectiveOverwrites(server, byId(ch.parentId));
  if (ch.overwrites?.length || !ch.parentId) return ch.overwrites || [];
  return byId(ch.parentId)?.overwrites || [];
}
/** A user's permissions in a channel (Discord's algorithm, mirrors the server). */
export function channelPermsOf(ch: any, userId?: string): number {
  const s = get();
  if (!ch) return 0;
  if (!ch.serverId) return ALL_PERMS & ~(P.ADMIN | P.MENTION_EVERYONE);
  const server = s.servers[ch.serverId];
  const uid = userId || s.me.id;
  let base = permsIn(server, uid);
  if (!base) return 0;
  const admin = base === ALL_PERMS;
  if (!admin && timedOut(server, uid)) base &= ~TIMEOUT_REMOVES;
  return computeChannelPerms(base, admin, server.id, server.members[uid]?.roles || [], uid, effectiveOverwrites(server, ch));
}
export const canIn = (ch: any, perm: number) => !!(channelPermsOf(ch) & perm);
export function threadsOf(server: any, parentId: string, archived = false): any[] {
  return server.channels
    .filter((c: any) => c.type === CH.THREAD && c.parentId === parentId && !!c.archived === archived)
    .sort((a: any, b: any) => ((b.lastMessageId || b.id) > (a.lastMessageId || a.id) ? 1 : -1));
}
/** Server order as shown in the rail (the user's own order first, then the rest). */
export function railOrder(): string[] {
  const s = get();
  const pref = (s.settings.serverOrder || []).filter((id: string) => s.servers[id]);
  return [...pref, ...s.serverOrder.filter((id: string) => !pref.includes(id))];
}
export function displayName(userId: string, serverId?: string | null): string {
  const s = get();
  const nick = serverId ? s.servers[serverId]?.members[userId]?.nickname : null;
  const u = s.users[userId];
  return nick || u?.displayName || u?.username || t('Unknown user');
}
export function roleColor(userId: string, serverId?: string | null): string | undefined {
  const server = serverId ? get().servers[serverId] : null;
  const m = server?.members[userId];
  if (!m) return undefined;
  return server.roles.find((r: any) => r.color && m.roles.includes(r.id))?.color;
}
export function findChannel(channelId: string | null): any {
  if (!channelId) return null;
  const s = get();
  if (s.dms[channelId]) return s.dms[channelId];
  for (const id of s.serverOrder) {
    const c = s.servers[id].channels.find((c: any) => c.id === channelId);
    if (c) return c;
  }
  return null;
}
export function dmName(dm: any): string {
  const s = get();
  const others = dm.recipients.filter((r: string) => r !== s.me.id);
  if (dm.type === CH.DM) return displayName(others[0]);
  return dm.name || others.map((r: string) => displayName(r)).join('، ') || t('Empty group');
}
export function isUnread(ch: any): boolean {
  if (!ch?.lastMessageId || ch.type === CH.CATEGORY) return false;
  const s = get();
  const rs = s.readStates[ch.id];
  if (rs) return ch.lastMessageId > rs.lastReadId;
  if (!ch.serverId) return true;
  // Never opened: only messages sent after joining count as unread.
  const joined = s.servers[ch.serverId]?.members[s.me.id]?.joinedAt || 0;
  return ch.lastMessageId > String(joined * 1000);
}
export const mentionsIn = (channelId: string) => get().readStates[channelId]?.mentions || 0;
export const isMuted = (id: string | null | undefined) => !!id && !!get().settings.muted[id];
/** Notifications are off for this channel, its server or this conversation. */
export const channelMuted = (ch: any) => !!ch && (isMuted(ch.id) || isMuted(ch.serverId));
/** Unread marker to show in the UI: muted places stay quiet unless you were mentioned. */
export const showUnread = (ch: any) => isUnread(ch) && !channelMuted(ch);
export function toggleMute(id: string) {
  const muted = { ...get().settings.muted };
  if (muted[id]) delete muted[id];
  else muted[id] = true;
  updateSettings({ muted });
}
export const notifyLevel = (serverId: string) => get().settings.notifyLevel?.[serverId] || 'all';
export function setNotifyLevel(serverId: string, level: string) {
  updateSettings({ notifyLevel: { ...get().settings.notifyLevel, [serverId]: level } });
}
export function serverUnread(server: any) {
  let unread = false;
  let mentions = 0;
  for (const c of server.channels) {
    if (showUnread(c)) unread = true;
    mentions += mentionsIn(c.id);
  }
  return { unread, mentions };
}
/** Mentions + pending friend requests, for the window title and the desktop app. */
export function totalBadge() {
  const s = get();
  let n = Object.values(s.relationships).filter((x) => x === REL.INCOMING).length;
  for (const [cid, rs] of Object.entries<any>(s.readStates)) if (rs.mentions && findChannel(cid)) n += rs.mentions;
  return n;
}
export function sortedDms(): any[] {
  return Object.values(get().dms).sort((a: any, b: any) => ((b.lastMessageId || b.id) > (a.lastMessageId || a.id) ? 1 : -1));
}
export function voiceIn(channelId: string): any[] {
  return Object.values(get().voiceStates).filter((v: any) => v.channelId === channelId);
}

// ---------- routing ----------
const lastChannel: Record<string, string> = {};
/** Channels visited before, for Alt+Left. */
export const history_: { serverId: string | null; channelId: string | null }[] = [];

function defaultChannel(serverId: string): string | null {
  const server = get().servers[serverId];
  if (!server) return null;
  const remembered = lastChannel[serverId];
  if (remembered && server.channels.some((c: any) => c.id === remembered)) return remembered;
  const list = orderedChannels(server);
  return (list.find((c: any) => c.type === CH.TEXT) || list.find((c: any) => c.type === CH.ANNOUNCEMENT || c.type === CH.FORUM))?.id || null;
}
const VOICE_TYPES = [CH.VOICE, CH.STAGE];
/** Channels in display order: uncategorised first, then each category followed by its children. */
export function orderedChannels(server: any): any[] {
  const byPos = (a: any, b: any) => a.position - b.position || (a.id > b.id ? 1 : -1);
  const out: any[] = [];
  const cats = server.channels.filter((c: any) => c.type === CH.CATEGORY).sort(byPos);
  const kids = (parent: string | null) =>
    server.channels
      .filter((c: any) => c.type !== CH.CATEGORY && c.type !== CH.THREAD && (c.parentId || null) === parent)
      .sort((a: any, b: any) => (VOICE_TYPES.includes(a.type) ? 1 : 0) - (VOICE_TYPES.includes(b.type) ? 1 : 0) || byPos(a, b));
  out.push(...kids(null));
  for (const c of cats) out.push(c, ...kids(c.id));
  return out;
}

export function navigate(serverId: string | null, channelId?: string | null, replace = false) {
  const s = get();
  // The TeamSpeak view (Windows app) is a pseudo-server in the rail.
  if (serverId === '@ts') {
    if (location.pathname !== '/teamspeak') history[replace ? 'replaceState' : 'pushState'](null, '', '/teamspeak');
    set({ route: { serverId: '@ts', channelId: null }, mobileNav: false });
    return;
  }
  if (serverId && !s.servers[serverId]) serverId = null;
  if (serverId && channelId === undefined) channelId = defaultChannel(serverId);
  if (channelId && !findChannel(channelId)) channelId = serverId ? defaultChannel(serverId) : null;
  channelId = channelId || null;
  if (serverId && channelId) lastChannel[serverId] = channelId;
  if (channelId !== s.route.channelId) {
    heldUnread.clear();
    if (s.route.channelId) history_.push(s.route);
  }
  const path = '/channels/' + (serverId || '@me') + (channelId ? '/' + channelId : '');
  if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  set({ route: { serverId, channelId }, mobileNav: false });
  if (channelId) {
    if (!get().messages[channelId]) loadMessages(channelId);
    ackSoon(channelId);
  }
}
export function syncRoute() {
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'invite' && parts[1]) {
    set({ pendingInvite: parts[1] });
    return navigate(null, null, true);
  }
  if (parts[0] === 'teamspeak') return navigate('@ts', null, true);
  if (parts[0] === 'channels') {
    navigate(parts[1] === '@me' ? null : parts[1], parts[2] || (parts[1] === '@me' ? null : undefined), true);
    // Message links: /channels/<server>/<channel>/<message>
    if (parts[2] && parts[3] && findChannel(parts[2])) jumpTo(parts[2], parts[3]);
    return;
  }
  navigate(null, null, true);
}
window.addEventListener('popstate', () => get().status === 'ready' && syncRoute());

// ---------- messages ----------
export async function loadMessages(channelId: string, mode: 'initial' | 'older' | 'newer' | { around: string } = 'initial') {
  const cur = get().messages[channelId];
  if (cur?.loading) return;
  const patch = (v: any) => set((s: any) => ({ messages: { ...s.messages, [channelId]: { ...(s.messages[channelId] || { list: [], hasMore: true, hasNewer: false }), ...v } } }));
  patch({ loading: true });
  try {
    let q = '';
    if (mode === 'older' && cur?.list.length) q = '?before=' + cur.list[0].id;
    else if (mode === 'newer' && cur?.list.length) q = '?after=' + cur.list[cur.list.length - 1].id;
    else if (typeof mode === 'object') q = '?around=' + mode.around;
    const r = await api('GET', `/api/channels/${channelId}/messages${q}`);
    addUsers(r.users);
    const now = get().messages[channelId];
    if (mode === 'older') patch({ list: [...r.messages, ...now.list], hasMore: r.messages.length >= 50, loading: false });
    else if (mode === 'newer') patch({ list: [...now.list, ...r.messages], hasNewer: r.messages.length >= 50, loading: false });
    else if (typeof mode === 'object') {
      const ch = findChannel(channelId);
      const last = r.messages[r.messages.length - 1];
      patch({ list: r.messages, hasMore: true, hasNewer: !!last && !!ch?.lastMessageId && last.id < ch.lastMessageId, loading: false });
    } else patch({ list: r.messages, hasMore: r.messages.length >= 50, hasNewer: false, loading: false });
  } catch (e: any) {
    patch({ loading: false });
    toast(e.message);
  }
}
export async function jumpTo(channelId: string, messageId: string) {
  const ch = findChannel(channelId);
  if (!ch) return;
  if (get().route.channelId !== channelId) navigate(ch.serverId || null, channelId);
  if (!get().messages[channelId]?.list.some((m: any) => m.id === messageId)) await loadMessages(channelId, { around: messageId });
  set((s: any) => ({ jump: { channelId, messageId, n: (s.jump?.n || 0) + 1 } }));
}
function addUsers(list: any[]) {
  if (!list?.length) return;
  set((s: any) => {
    const users = { ...s.users };
    for (const u of list) users[u.id] = u;
    return { users };
  });
}

const ackTimers: Record<string, any> = {};
const heldUnread = new Set<string>();
/** "Mark Unread": moves the read marker back and keeps it there until you leave the channel. */
export function markUnread(channelId: string, beforeId: string) {
  heldUnread.add(channelId);
  set((s: any) => ({ readStates: { ...s.readStates, [channelId]: { lastReadId: beforeId, mentions: 0 } } }));
  api('POST', `/api/channels/${channelId}/ack`, { messageId: beforeId }).catch(() => {});
}
/** Marks a channel as read shortly after it is looked at. */
export function ackSoon(channelId: string) {
  clearTimeout(ackTimers[channelId]);
  ackTimers[channelId] = setTimeout(() => {
    const s = get();
    const ch = findChannel(channelId);
    if (!ch || s.route.channelId !== channelId || !document.hasFocus() || heldUnread.has(channelId)) return;
    if (!isUnread(ch) && !mentionsIn(channelId)) return;
    markRead(ch);
  }, 400);
}
export function markRead(ch: any) {
  if (!ch.lastMessageId) return;
  set((s: any) => ({ readStates: { ...s.readStates, [ch.id]: { lastReadId: ch.lastMessageId, mentions: 0 } } }));
  api('POST', `/api/channels/${ch.id}/ack`, { messageId: ch.lastMessageId }).catch(() => {});
}
window.addEventListener('focus', () => {
  const id = get().route?.channelId;
  if (id && get().status === 'ready') ackSoon(id);
});

// ---------- auth ----------
export function login(token: string) {
  localStorage.setItem('token', token);
  set({ token });
  connect();
}
export function logout(silent = false) {
  if (!silent) api('POST', '/api/auth/logout').catch(() => {});
  voice.cleanup();
  localStorage.removeItem('token');
  set({ token: null, modal: null, ...initial() });
  try {
    ws?.close();
  } catch {}
}
setUnauthorizedHandler(() => logout(true));

// ---------- gateway ----------
let ws: WebSocket | null = null;
let pingTimer: any;
let retry = 0;

export function connect() {
  if (!get().token) return;
  if (ws && ws.readyState <= 1) return;
  set((s: any) => ({ status: s.status === 'idle' ? 'connecting' : s.status }));
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${get().token}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return void voice.onRelayFrame(e.data);
    if (e.data === 'pong' || sock !== ws) return;
    try {
      handle(JSON.parse(e.data));
    } catch (err) {
      console.error('gateway event failed', err);
    }
  };
  sock.onopen = () => {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === 1 && sock.send('ping'), 25000);
  };
  sock.onclose = (e) => {
    if (sock !== ws) return;
    clearInterval(pingTimer);
    ws = null;
    if (e.code === 4001) return logout(true);
    if (!get().token) return;
    set((s: any) => ({ status: s.status === 'ready' ? 'reconnecting' : s.status }));
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}
export function wsSendBinary(buf: ArrayBuffer) {
  if (ws?.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(buf);
}
export function wsSend(o: any) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(o));
}
window.addEventListener('online', () => connect());

function patchServer(id: string, fn: (s: any) => any) {
  set((s: any) => (s.servers[id] ? { servers: { ...s.servers, [id]: { ...s.servers[id], ...fn(s.servers[id]) } } } : {}));
}
const shapeServer = (sv: any) => ({ ...sv, members: Object.fromEntries(sv.members.map((m: any) => [m.userId, m])) });

function notify(msg: any, serverId: string | null) {
  const s = get();
  if (s.me.statusPref === 'dnd') return;
  // Muted places only notify for direct @mentions of you.
  if (channelMuted(findChannel(msg.channelId)) && !msg.mentions.includes(s.me.id)) return;
  if (serverId && notifyLevel(serverId) === 'none') return;
  sfx(!serverId || msg.mentions.includes(s.me.id) || msg.mentionEveryone ? 'mention' : 'message');
  if (s.settings.desktopNotif && 'Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) {
    const ch = findChannel(msg.channelId);
    const where = serverId ? ` (#${ch?.name})` : '';
    const n = new Notification(displayName(msg.authorId, serverId) + where, {
      body: msg.content.replace(/<@(\d+)>/g, (_: string, id: string) => '@' + displayName(id, serverId)) || t('Sent an attachment'),
      icon: s.users[msg.authorId]?.avatar || '/favicon.svg',
      tag: msg.channelId,
    });
    n.onclick = () => {
      window.focus();
      navigate(serverId, msg.channelId);
    };
  }
}

function handle(ev: any) {
  const s = get();
  switch (ev.op) {
    case 'READY': {
      retry = 0;
      const users: any = {};
      for (const u of ev.users) users[u.id] = u;
      const voiceStates: any = {};
      for (const v of ev.voiceStates) voiceStates[v.userId] = v;
      const wasReady = s.status === 'reconnecting';
      set({
        ...initial(),
        status: 'ready',
        sid: ev.sid,
        me: ev.me,
        users,
        presences: ev.presences,
        relationships: Object.fromEntries(ev.relationships.map((r: any) => [r.id, r.type])),
        servers: Object.fromEntries(ev.servers.map((sv: any) => [sv.id, shapeServer(sv)])),
        serverOrder: ev.servers.map((sv: any) => sv.id),
        dms: Object.fromEntries(ev.dms.map((d: any) => [d.id, d])),
        readStates: Object.fromEntries(ev.readStates.map((r: any) => [r.channelId, { lastReadId: r.lastReadId, mentions: r.mentions }])),
        voiceStates,
        replyTo: s.replyTo,
        notes: ev.notes || {},
        activities: ev.activities || {},
        imports: s.imports,
      });
      if (wasReady) navigate(s.route.serverId, s.route.channelId, true);
      else syncRoute();
      voice.onGatewayReady();
      break;
    }
    case 'PRESENCE': {
      const activities = { ...s.activities };
      if (ev.activity) activities[ev.userId] = ev.activity;
      else if ('activity' in ev) delete activities[ev.userId];
      set({ presences: { ...s.presences, [ev.userId]: ev.status }, activities });
      break;
    }
    case 'USER_UPDATE':
      if (s.users[ev.user.id]) set({ users: { ...s.users, [ev.user.id]: ev.user } });
      if (ev.user.id === s.me.id) set({ me: { ...s.me, ...ev.user } });
      break;
    case 'ME_UPDATE':
      set({ me: { ...s.me, statusPref: ev.statusPref, ...('mfa' in ev ? { mfa: ev.mfa } : {}) } });
      break;
    case 'RELATIONSHIP': {
      const relationships = { ...s.relationships };
      if (ev.type) relationships[ev.id] = ev.type;
      else delete relationships[ev.id];
      set({
        relationships,
        users: ev.user ? { ...s.users, [ev.id]: ev.user } : s.users,
        presences: { ...s.presences, [ev.id]: ev.presence },
      });
      if (ev.type === REL.INCOMING) sfx('friend');
      break;
    }
    case 'SERVER_CREATE': {
      const users = { ...s.users };
      for (const u of ev.users) users[u.id] = u;
      const voiceStates = { ...s.voiceStates };
      for (const v of ev.voiceStates || []) voiceStates[v.userId] = v;
      set({
        users,
        voiceStates,
        presences: { ...s.presences, ...ev.presences },
        servers: { ...s.servers, [ev.server.id]: shapeServer(ev.server) },
        serverOrder: s.serverOrder.includes(ev.server.id) ? s.serverOrder : [...s.serverOrder, ev.server.id],
      });
      break;
    }
    case 'SERVER_UPDATE':
      patchServer(ev.id, () => ({ name: ev.name, icon: ev.icon, ownerId: ev.ownerId, banner: ev.banner ?? null, description: ev.description ?? '' }));
      break;
    case 'SERVER_DATA': {
      const { op, serverId, ...rest } = ev;
      patchServer(serverId, () => rest);
      break;
    }
    case 'NOTE':
      set({ notes: { ...s.notes, [ev.userId]: ev.note } });
      break;
    case 'IMPORT_PROGRESS':
      set({ imports: { ...s.imports, [ev.job]: { ...s.imports[ev.job], ...ev } } });
      if (ev.done) {
        if (ev.error) toast(ev.error);
        else toast(t('Import finished: {n} messages', { n: ev.messages || 0 }), 'success');
      }
      break;
    case 'SOUNDBOARD':
      playSoundboard(ev);
      break;
    case 'VOICE_MOVE':
      if (s.voice.channelId && s.voice.channelId !== ev.channelId) voice.join(ev.channelId);
      break;
    case 'SERVER_DELETE': {
      if (!s.servers[ev.id]) break;
      const servers = { ...s.servers };
      delete servers[ev.id];
      set({ servers, serverOrder: s.serverOrder.filter((i: string) => i !== ev.id) });
      if (s.route.serverId === ev.id) navigate(null, null, true);
      if (s.modal?.serverId === ev.id) closeModal();
      break;
    }
    case 'MEMBER_ADD':
      set({ users: { ...s.users, [ev.user.id]: ev.user }, presences: { ...s.presences, [ev.user.id]: ev.presence } });
      patchServer(ev.serverId, (sv) => ({ members: { ...sv.members, [ev.member.userId]: ev.member } }));
      break;
    case 'MEMBER_UPDATE':
      patchServer(ev.serverId, (sv) => ({ members: { ...sv.members, [ev.member.userId]: ev.member } }));
      break;
    case 'MEMBER_REMOVE':
      patchServer(ev.serverId, (sv) => {
        const members = { ...sv.members };
        delete members[ev.userId];
        return { members };
      });
      break;
    case 'MEMBERS':
      patchServer(ev.serverId, () => ({ members: Object.fromEntries(ev.members.map((m: any) => [m.userId, m])) }));
      break;
    case 'ROLES':
      patchServer(ev.serverId, () => ({ roles: ev.roles }));
      break;
    case 'CHANNELS': {
      patchServer(ev.serverId, () => ({ channels: ev.channels }));
      const r = get().route;
      if (r.serverId === ev.serverId && r.channelId && !ev.channels.some((c: any) => c.id === r.channelId)) navigate(ev.serverId, undefined, true);
      break;
    }
    case 'DM_UPDATE':
      addUsers(ev.users);
      set((st: any) => ({ dms: { ...st.dms, [ev.channel.id]: ev.channel } }));
      break;
    case 'DM_DELETE': {
      const dms = { ...s.dms };
      delete dms[ev.id];
      set({ dms });
      if (s.route.channelId === ev.id) navigate(null, null, true);
      break;
    }
    case 'TYPING':
      set({ typing: { ...s.typing, [ev.channelId]: { ...s.typing[ev.channelId], [ev.userId]: Date.now() + 8000 } } });
      break;
    case 'READ_STATE':
      set({ readStates: { ...s.readStates, [ev.channelId]: { lastReadId: ev.lastReadId, mentions: ev.mentions } } });
      break;
    case 'MESSAGE_CREATE': {
      const m = ev.message;
      const cid = m.channelId;
      if (ev.serverId) patchServer(ev.serverId, (sv) => ({ channels: sv.channels.map((c: any) => (c.id === cid ? { ...c, lastMessageId: m.id } : c)) }));
      else if (s.dms[cid]) set({ dms: { ...s.dms, [cid]: { ...s.dms[cid], lastMessageId: m.id } } });
      const box = s.messages[cid];
      if (box && !box.hasNewer && !box.list.some((x: any) => x.id === m.id)) set({ messages: { ...s.messages, [cid]: { ...box, list: [...box.list, m] } } });
      if (s.typing[cid]?.[m.authorId]) {
        const tp = { ...s.typing[cid] };
        delete tp[m.authorId];
        set({ typing: { ...s.typing, [cid]: tp } });
      }
      if (m.authorId === s.me.id) {
        set((st: any) => ({ readStates: { ...st.readStates, [cid]: { lastReadId: m.id, mentions: 0 } } }));
      } else {
        const sv = ev.serverId && s.servers[ev.serverId];
        const myRoles = sv ? sv.members[s.me.id]?.roles || [] : [];
        const roleHit = (m.content || '').match(/<@&(\d+)>/g)?.some((x: string) => myRoles.includes(x.slice(3, -1)));
        const mentioned = !m.type && (!ev.serverId || m.mentionEveryone || m.mentions.includes(s.me.id) || !!roleHit);
        const viewing = s.route.channelId === cid && document.hasFocus() && !box?.hasNewer;
        if (viewing) ackSoon(cid);
        else if (mentioned) {
          set((st: any) => {
            const rs = st.readStates[cid] || { lastReadId: '0', mentions: 0 };
            return { readStates: { ...st.readStates, [cid]: { ...rs, mentions: rs.mentions + 1 } } };
          });
          notify(m, ev.serverId);
        }
      }
      break;
    }
    case 'MESSAGE_UPDATE': {
      const m = ev.message;
      const box = s.messages[m.channelId];
      if (box) set({ messages: { ...s.messages, [m.channelId]: { ...box, list: box.list.map((x: any) => (x.id === m.id ? m : x)) } } });
      window.dispatchEvent(new CustomEvent('message-update', { detail: m }));
      break;
    }
    case 'MESSAGE_DELETE': {
      const box = s.messages[ev.channelId];
      if (box) set({ messages: { ...s.messages, [ev.channelId]: { ...box, list: box.list.filter((x: any) => x.id !== ev.id) } } });
      window.dispatchEvent(new CustomEvent('message-delete', { detail: ev.id }));
      break;
    }
    case 'VOICE_READY': {
      const voiceStates = { ...s.voiceStates };
      for (const k of Object.keys(voiceStates)) if (voiceStates[k].channelId === ev.channelId) delete voiceStates[k];
      for (const v of ev.states) voiceStates[v.userId] = v;
      set({ voiceStates, ringing: s.ringing?.channelId === ev.channelId ? null : s.ringing });
      voice.onReady(ev);
      break;
    }
    case 'VOICE_STATE': {
      const v = ev.state;
      if (v.userId === s.me.id && v.sid === s.sid && v.channelId) voice.applyServerState(v);
      const voiceStates = { ...s.voiceStates };
      const before = s.voiceStates[v.userId];
      if (v.channelId) voiceStates[v.userId] = v;
      else if (before?.sid === v.sid) delete voiceStates[v.userId];
      set({ voiceStates });
      const mine = s.voice.channelId;
      if (v.userId !== s.me.id && mine && s.settings.sounds) {
        if (v.channelId === mine && before?.channelId !== mine) sfx('userJoin');
        else if (!v.channelId && before?.channelId === mine && before.sid === v.sid) sfx('userLeave');
        else if (v.channelId === mine && v.screen && !before?.screen) sfx('userStream');
      }
      // A call starting in a DM rings its recipients.
      if (v.channelId && s.dms[v.channelId] && v.userId !== s.me.id && !before && mine !== v.channelId) {
        const already = Object.values(s.voiceStates).some((x: any) => x.channelId === v.channelId);
        if (!already && s.me.statusPref !== 'dnd') set({ ringing: { channelId: v.channelId, from: v.userId } });
      }
      const ring = get().ringing;
      if (ring && !Object.values(voiceStates).some((x: any) => x.channelId === ring.channelId)) set({ ringing: null });
      voice.onVoiceState(v);
      break;
    }
    case 'VOICE_KICK':
      voice.cleanup();
      sfx('disconnected');
      if (ev.reason) toast(ev.reason);
      break;
    case 'SIGNAL':
      voice.onSignal(ev);
      break;
  }
}

// ---------- soundboard ----------
const sbCache: Record<string, AudioBuffer> = {};
async function playSoundboard(ev: any) {
  const s = get();
  const snd = ev.sound;
  set((st: any) => ({ sbFlash: { ...st.sbFlash, [ev.userId]: { emoji: snd.emoji || BUILTIN_EMOJI[snd.id] || '🔊', until: Date.now() + 2500 } } }));
  setTimeout(
    () =>
      set((st: any) => {
        const f = { ...st.sbFlash };
        if (f[ev.userId]?.until <= Date.now()) delete f[ev.userId];
        return { sbFlash: f };
      }),
    2600
  );
  if (s.voice.deaf) return;
  const vol = ((s.settings.sbVolume ?? 80) / 100) * (snd.volume ?? 1);
  if (snd.builtin) return playBuiltin(snd.id.slice(8), vol);
  try {
    const ctx = soundCtx();
    let buf = sbCache[snd.id];
    if (!buf) {
      const data = await fetch(snd.url).then((r) => r.arrayBuffer());
      buf = sbCache[snd.id] = await ctx.decodeAudioData(data);
    }
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    src.start();
  } catch {}
}
export function sendSoundboard(sound: string) {
  wsSend({ op: 'soundboard', sound });
}

// Typing indicators expire on their own.
setInterval(() => {
  const s = get();
  const now = Date.now();
  let changed = false;
  const typing: any = {};
  for (const [cid, users] of Object.entries<any>(s.typing)) {
    const keep: any = {};
    for (const [uid, until] of Object.entries<number>(users)) {
      if (until > now) keep[uid] = until;
      else changed = true;
    }
    if (Object.keys(keep).length) typing[cid] = keep;
  }
  if (changed) set({ typing });
}, 1000);

// ---------- common actions ----------
export async function openDm(userId: string) {
  const dm = await act(api('POST', '/api/dms', { recipients: [userId] }));
  if (!dm) return;
  set((s: any) => ({ dms: { ...s.dms, [dm.id]: dm } }));
  navigate(null, dm.id);
  return dm;
}
export async function startCall(userId: string, video = false) {
  const dm = await openDm(userId);
  if (!dm) return;
  await voice.join(dm.id);
  if (video) voice.setVideo(true);
}
export { P, CH, REL };

// Handy for tests and debugging.
(window as any).__store = useStore;
