import { DurableObject } from 'cloudflare:workers';
import { P, ALL_PERMS, DEFAULT_PERMS, CH, REL, MAX_FILE_SIZE, MAX_MESSAGE_LENGTH, TIMEOUT_REMOVES, computeChannelPerms, VOICE_LIKE } from '../shared/perms';
import { HttpError, fail, json, randHex, str, hashPassword, verifyTotp } from './util';
import { registerFeatureRoutes, handleFeatureSocket } from './features';

interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  REGISTRATION_CODE?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  ICE_SERVERS?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      // Uploaded files are immutable, so they are served from the edge cache when possible.
      const isFile = req.method === 'GET' && url.pathname.startsWith('/api/files/');
      const cache = (caches as any).default as Cache;
      if (isFile) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      const res = await env.HUB.get(env.HUB.idFromName('main')).fetch(req);
      if (isFile && res.status === 200) ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    }
    return env.ASSETS.fetch(req);
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT, pass_hash TEXT, pass_salt TEXT,
  avatar TEXT, banner_color TEXT, bio TEXT DEFAULT '', status_pref TEXT DEFAULT 'online', custom_status TEXT DEFAULT '', created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS relationships(user_id TEXT, target_id TEXT, type INTEGER, PRIMARY KEY(user_id, target_id));
CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY, name TEXT, icon TEXT, owner_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS members(server_id TEXT, user_id TEXT, nickname TEXT, joined_at INTEGER, PRIMARY KEY(server_id, user_id));
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY, server_id TEXT, name TEXT, color TEXT, permissions INTEGER, position INTEGER, hoist INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS member_roles(server_id TEXT, user_id TEXT, role_id TEXT, PRIMARY KEY(server_id, user_id, role_id));
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, server_id TEXT, type INTEGER, name TEXT, topic TEXT DEFAULT '', parent_id TEXT,
  position INTEGER DEFAULT 0, owner_id TEXT, last_message_id TEXT);
CREATE INDEX IF NOT EXISTS channels_server ON channels(server_id);
CREATE TABLE IF NOT EXISTS dm_members(channel_id TEXT, user_id TEXT, closed INTEGER DEFAULT 0, PRIMARY KEY(channel_id, user_id));
CREATE INDEX IF NOT EXISTS dm_members_user ON dm_members(user_id);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, channel_id TEXT, author_id TEXT, content TEXT, created_at INTEGER, edited_at INTEGER,
  reply_to TEXT, attachments TEXT, pinned INTEGER DEFAULT 0, type INTEGER DEFAULT 0, mentions TEXT, mention_everyone INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions(message_id TEXT, emoji TEXT, user_id TEXT, PRIMARY KEY(message_id, emoji, user_id));
CREATE TABLE IF NOT EXISTS read_states(user_id TEXT, channel_id TEXT, last_read_id TEXT DEFAULT '0', mentions INTEGER DEFAULT 0, PRIMARY KEY(user_id, channel_id));
CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, server_id TEXT, creator_id TEXT, created_at INTEGER, expires_at INTEGER, max_uses INTEGER DEFAULT 0, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS bans(server_id TEXT, user_id TEXT, reason TEXT, PRIMARY KEY(server_id, user_id));
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, width INTEGER, height INTEGER, uploader_id TEXT, ref TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS file_chunks(file_id TEXT, idx INTEGER, data BLOB, PRIMARY KEY(file_id, idx));
CREATE TABLE IF NOT EXISTS embeds(url TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS channel_overwrites(channel_id TEXT, target_id TEXT, type INTEGER, allow INTEGER DEFAULT 0, deny INTEGER DEFAULT 0, PRIMARY KEY(channel_id, target_id));
CREATE TABLE IF NOT EXISTS poll_votes(message_id TEXT, answer_id INTEGER, user_id TEXT, PRIMARY KEY(message_id, answer_id, user_id));
CREATE TABLE IF NOT EXISTS emojis(id TEXT PRIMARY KEY, server_id TEXT, name TEXT, creator_id TEXT, animated INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS stickers(id TEXT PRIMARY KEY, server_id TEXT, name TEXT, creator_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sounds(id TEXT PRIMARY KEY, server_id TEXT, name TEXT, emoji TEXT, volume REAL DEFAULT 1, creator_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, server_id TEXT, channel_id TEXT, name TEXT, description TEXT, location TEXT, start_at INTEGER, end_at INTEGER, status INTEGER DEFAULT 1, creator_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS event_users(event_id TEXT, user_id TEXT, PRIMARY KEY(event_id, user_id));
CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY, server_id TEXT, user_id TEXT, action TEXT, target_id TEXT, changes TEXT, reason TEXT, created_at INTEGER);
CREATE INDEX IF NOT EXISTS audit_server ON audit_log(server_id, id);
CREATE TABLE IF NOT EXISTS notes(user_id TEXT, target_id TEXT, note TEXT, PRIMARY KEY(user_id, target_id));
CREATE TABLE IF NOT EXISTS webhooks(id TEXT PRIMARY KEY, server_id TEXT, channel_id TEXT, name TEXT, avatar TEXT, token TEXT, creator_id TEXT, created_at INTEGER);
`;

const CHUNK = 1024 * 1024;
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/[\w.+-]+)$/;

export interface Att {
  uid: string;
  sid: string;
  /** voice: channel, self mute/deaf, camera, screen stream, server mute/deaf, stage audience, raised hand */
  v?: { c: string; m: boolean; d: boolean; vid: boolean; scr: string | null; sm?: boolean; sd?: boolean; sup?: boolean; hand?: number };
  idle?: boolean;
  act?: { name: string; type: number; since: number } | null;
}
interface Ctx {
  me: any;
  p: Record<string, string>;
  q: URLSearchParams;
  body: any;
  req: Request;
}
export type Handler = (c: Ctx) => any;

/** Refuses obviously internal addresses so link previews cannot be used to probe a private network. */
function isPrivateHost(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') || h.includes(':')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function fetchEmbed(url: URL) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url.href, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; HamsohbatBot/1.0; +link-preview)', accept: 'text/html,image/*;q=0.8,*/*;q=0.5' },
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('image/')) {
      res.body?.cancel();
      return { type: 'image', url: url.href, image: url.href };
    }
    if (!type.includes('html') || !res.body) {
      res.body?.cancel();
      return null;
    }
    // Only the <head> matters; stop reading after 512 KB.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 512 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (new TextDecoder().decode(value).includes('</head>')) break;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder().decode(chunks.reduce((a, c) => { const n = new Uint8Array(a.length + c.length); n.set(a); n.set(c, a.length); return n; }, new Uint8Array()));
    const meta = (name: string) => {
      for (const tag of html.match(/<meta[^>]*>/gi) || []) {
        const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
        if (key !== name) continue;
        const content = tag.match(/content\s*=\s*("([^"]*)"|'([^']*)')/i);
        if (content) return decodeEntities((content[2] ?? content[3] ?? '').trim());
      }
      return '';
    };
    const title = meta('og:title') || meta('twitter:title') || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '');
    if (!title) return null;
    let image = meta('og:image') || meta('twitter:image');
    if (image) {
      try {
        image = new URL(image, res.url || url.href).href;
      } catch {
        image = '';
      }
    }
    return {
      type: 'link',
      url: url.href,
      title: title.slice(0, 200),
      description: (meta('og:description') || meta('twitter:description') || meta('description')).slice(0, 350),
      siteName: (meta('og:site_name') || url.hostname).slice(0, 100),
      image: image || null,
      color: /^#[0-9a-f]{3,8}$/i.test(meta('theme-color')) ? meta('theme-color') : null,
    };
  } finally {
    clearTimeout(timer);
  }
}


export class Hub extends DurableObject<Env> {
  sql: SqlStorage;
  routes: { method: string; re: RegExp; keys: string[]; h: Handler; open: boolean }[] = [];
  lastMs = 0;
  seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.defineRoutes();
    registerFeatureRoutes(this);
  }

  /** Adds columns introduced after the first release and upgrades old data. */
  migrate() {
    const add = (table: string, defs: [string, string][]) => {
      const have = new Set(this.all(`PRAGMA table_info(${table})`).map((c) => c.name));
      for (const [col, def] of defs) if (!have.has(col)) this.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add('channels', [
      ['rate_limit', 'INTEGER DEFAULT 0'],
      ['user_limit', 'INTEGER DEFAULT 0'],
      ['bitrate', 'INTEGER DEFAULT 64'],
      ['nsfw', 'INTEGER DEFAULT 0'],
      ['archived', 'INTEGER DEFAULT 0'],
      ['thread_msg_id', 'TEXT'],
      ['message_count', 'INTEGER DEFAULT 0'],
      ['created_at', 'INTEGER'],
    ]);
    add('messages', [
      ['poll', 'TEXT'],
      ['forwarded', 'TEXT'],
      ['webhook', 'TEXT'],
      ['embeds', 'TEXT'],
      ['sticker', 'TEXT'],
      ['thread_id', 'TEXT'],
    ]);
    add('servers', [
      ['automod', "TEXT DEFAULT '{}'"],
      ['banner', 'TEXT'],
      ['description', "TEXT DEFAULT ''"],
    ]);
    add('members', [
      ['timeout_until', 'INTEGER DEFAULT 0'],
      ['server_mute', 'INTEGER DEFAULT 0'],
      ['server_deaf', 'INTEGER DEFAULT 0'],
    ]);
    add('users', [
      ['pronouns', "TEXT DEFAULT ''"],
      ['totp_secret', 'TEXT'],
      ['totp_pending', 'TEXT'],
      ['deleted', 'INTEGER DEFAULT 0'],
    ]);
    const version = Number(this.one("SELECT value FROM meta WHERE key='version'")?.value || 0);
    if (version < 2) {
      // Version 2 introduced channel visibility: give @everyone the new default permissions so nothing disappears.
      this.run(
        'UPDATE roles SET permissions = permissions | ? WHERE id = server_id',
        P.VIEW_CHANNEL | P.CREATE_THREADS | P.SEND_IN_THREADS | P.USE_SOUNDBOARD | P.REQUEST_TO_SPEAK
      );
      this.run("INSERT OR REPLACE INTO meta(key, value) VALUES('version', '2')");
    }
  }

  // ---------- small helpers ----------
  all<T = any>(q: string, ...p: any[]): T[] {
    return this.sql.exec(q, ...p).toArray() as T[];
  }
  one<T = any>(q: string, ...p: any[]): T | undefined {
    return this.all<T>(q, ...p)[0];
  }
  run(q: string, ...p: any[]) {
    this.sql.exec(q, ...p);
  }
  /** Time-sortable id; all ids have the same length so string comparison orders them. */
  id() {
    const now = Date.now();
    if (now <= this.lastMs) {
      if (++this.seq > 999) {
        this.lastMs++;
        this.seq = 0;
      }
    } else {
      this.lastMs = now;
      this.seq = 0;
    }
    return String(this.lastMs * 1000 + this.seq);
  }
  /** Durable Object SQL allows at most 100 bound parameters, so IN-lists are chunked. */
  byIds<T = any>(q: (ph: string) => string, ids: string[]): T[] {
    const out: T[] = [];
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 90) {
      const part = uniq.slice(i, i + 90);
      out.push(...this.all<T>(q(part.map(() => '?').join(',')), ...part));
    }
    return out;
  }
  on(method: string, path: string, h: Handler, open = false) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$'
    );
    this.routes.push({ method, re, keys, h, open });
  }

  // ---------- realtime ----------
  sockets(): [WebSocket, Att][] {
    const out: [WebSocket, Att][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Att | null;
      if (att) out.push([ws, att]);
    }
    return out;
  }
  /** Send an event to the given users (null = everyone connected). */
  send(uids: Iterable<string> | null, ev: any, exceptSid?: string) {
    const set = uids ? new Set(uids) : null;
    const data = JSON.stringify(ev);
    for (const [ws, att] of this.sockets()) {
      if (att.sid === exceptSid) continue;
      if (set && !set.has(att.uid)) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }
  onlineSet(exclude?: WebSocket) {
    const s = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const att = ws.deserializeAttachment() as Att | null;
      if (att) s.add(att.uid);
    }
    return s;
  }
  statusOf(uid: string, exclude?: WebSocket) {
    if (!this.onlineSet(exclude).has(uid)) return 'offline';
    const pref = this.one('SELECT status_pref FROM users WHERE id=?', uid)?.status_pref || 'online';
    return this.effectiveStatus(uid, pref, exclude);
  }
  /** "Online" turns into "Idle" when every open session of the user has been inactive for a while. */
  effectiveStatus(uid: string, pref: string, exclude?: WebSocket) {
    if (pref === 'invisible') return 'offline';
    if (pref !== 'online') return pref;
    const mine = this.sockets().filter(([ws, a]) => a.uid === uid && ws !== exclude);
    return mine.length && mine.every(([, a]) => a.idle) ? 'idle' : 'online';
  }
  activityOf(uid: string) {
    for (const [, a] of this.sockets()) if (a.uid === uid && a.act) return a.act;
    return null;
  }
  voiceStates(filter?: (a: Att) => boolean) {
    return this.sockets()
      .filter(([, a]) => a.v && (!filter || filter(a)))
      .map(([, a]) => this.voiceObj(a));
  }
  voiceObj(a: Att, left = false) {
    return {
      userId: a.uid,
      sid: a.sid,
      channelId: left ? null : a.v!.c,
      mute: !!a.v?.m,
      deaf: !!a.v?.d,
      video: !!a.v?.vid,
      screen: a.v?.scr || null,
      serverMute: !!a.v?.sm,
      serverDeaf: !!a.v?.sd,
      suppress: !!a.v?.sup,
      hand: a.v?.hand || 0,
    };
  }
  /** Disconnect matching sockets from voice and tell everybody who can see the channel. */
  dropVoice(match: (a: Att) => boolean, kicked = true) {
    for (const [ws, att] of this.sockets()) {
      if (!att.v || !match(att)) continue;
      const ch = this.one('SELECT * FROM channels WHERE id=?', att.v.c);
      const ev = { op: 'VOICE_STATE', state: this.voiceObj(att, true), prevChannelId: att.v.c };
      const aud = ch ? this.audience(ch) : new Set<string>();
      aud.add(att.uid);
      ws.serializeAttachment({ uid: att.uid, sid: att.sid });
      this.send(aud, ev);
      if (kicked)
        try {
          ws.send(JSON.stringify({ op: 'VOICE_KICK' }));
        } catch {}
    }
  }

  // ---------- data shaping ----------
  pubUser(u: any) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatar: u.avatar,
      bannerColor: u.banner_color,
      bio: u.bio,
      customStatus: u.custom_status,
      pronouns: u.pronouns || '',
      createdAt: u.created_at,
      deleted: !!u.deleted,
    };
  }
  users(ids: string[]) {
    return this.byIds((ph) => `SELECT * FROM users WHERE id IN (${ph})`, ids).map((u) => this.pubUser(u));
  }
  user(id: string) {
    const u = this.one('SELECT * FROM users WHERE id=?', id);
    return u ? this.pubUser(u) : null;
  }
  presences(ids: string[]) {
    const online = this.onlineSet();
    const out: Record<string, string> = {};
    const want = ids.filter((i) => online.has(i));
    for (const u of this.byIds((ph) => `SELECT id, status_pref FROM users WHERE id IN (${ph})`, want))
      out[u.id] = this.effectiveStatus(u.id, u.status_pref);
    return out;
  }
  chanObj(c: any) {
    return {
      id: c.id,
      serverId: c.server_id,
      type: c.type,
      name: c.name,
      topic: c.topic,
      parentId: c.parent_id,
      position: c.position,
      lastMessageId: c.last_message_id,
      rateLimit: c.rate_limit || 0,
      userLimit: c.user_limit || 0,
      bitrate: c.bitrate || 64,
      nsfw: !!c.nsfw,
      archived: !!c.archived,
      threadMessageId: c.thread_msg_id || null,
      ownerId: c.owner_id || null,
      messageCount: c.message_count || 0,
      createdAt: c.created_at || null,
    };
  }
  dmObj(id: string) {
    const c = this.one('SELECT * FROM channels WHERE id=?', id)!;
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      ownerId: c.owner_id,
      lastMessageId: c.last_message_id,
      recipients: this.all('SELECT user_id FROM dm_members WHERE channel_id=? ORDER BY rowid', id).map((r) => r.user_id),
    };
  }
  roleObj(r: any) {
    return { id: r.id, name: r.name, color: r.color, permissions: r.permissions, position: r.position, hoist: !!r.hoist };
  }
  rolesOf(sid: string) {
    return this.all('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC', sid).map((r) => this.roleObj(r));
  }
  /** A server's channels with their permission overrides; with `uid`, only the ones that user can see. */
  channelsOf(sid: string, uid?: string) {
    const rows = this.all('SELECT * FROM channels WHERE server_id=? ORDER BY position, id', sid);
    const ows: Record<string, any[]> = {};
    for (const o of this.all(
      'SELECT o.channel_id, o.target_id AS id, o.type, o.allow, o.deny FROM channel_overwrites o JOIN channels c ON c.id=o.channel_id WHERE c.server_id=?',
      sid
    ))
      (ows[o.channel_id] ||= []).push({ id: o.id, type: o.type, allow: o.allow, deny: o.deny });
    let list = rows;
    if (uid) {
      const base = this.perms(sid, uid);
      const roles = this.memberRoleIds(sid, uid);
      const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.id, r]));
      const eff = (c: any): any[] =>
        c.type === CH.THREAD && c.parent_id && byId[c.parent_id] ? eff(byId[c.parent_id]) : ows[c.id]?.length || !c.parent_id ? ows[c.id] || [] : ows[c.parent_id] || [];
      list = rows.filter((c) => computeChannelPerms(base, !!(base & P.ADMIN), sid, roles, uid, eff(c)) & P.VIEW_CHANNEL);
    }
    return list.map((c) => ({ ...this.chanObj(c), overwrites: ows[c.id] || [] }));
  }
  memberRoleIds(sid: string, uid: string): string[] {
    return this.all('SELECT role_id FROM member_roles WHERE server_id=? AND user_id=?', sid, uid).map((r) => r.role_id);
  }
  overwritesOf(cid: string) {
    return this.all('SELECT target_id AS id, type, allow, deny FROM channel_overwrites WHERE channel_id=?', cid);
  }
  /** Threads use their parent's overrides; channels without their own follow their category (Discord's "synced"). */
  effectiveOverwrites(ch: any): any[] {
    if (ch.type === CH.THREAD && ch.parent_id) {
      const parent = this.one('SELECT * FROM channels WHERE id=?', ch.parent_id);
      return parent ? this.effectiveOverwrites(parent) : [];
    }
    const own = this.overwritesOf(ch.id);
    if (own.length || !ch.parent_id) return own;
    return this.overwritesOf(ch.parent_id);
  }
  /** The user's permissions inside one server channel (0 when they cannot see it). */
  channelPerms(ch: any, uid: string, ow?: any[]): number {
    const base = this.perms(ch.server_id, uid);
    if (!base) return 0;
    let p = computeChannelPerms(base, !!(base & P.ADMIN), ch.server_id, this.memberRoleIds(ch.server_id, uid), uid, ow || this.effectiveOverwrites(ch));
    if (p && !(base & P.ADMIN) && this.timedOut(ch.server_id, uid)) p &= ~TIMEOUT_REMOVES;
    return p;
  }
  timedOut(sid: string, uid: string) {
    return (this.one('SELECT timeout_until FROM members WHERE server_id=? AND user_id=?', sid, uid)?.timeout_until || 0) > Date.now();
  }
  /** Writes an entry into the server's audit log. */
  audit(sid: string, uid: string, action: string, targetId: string | null = null, changes: any = null, reason = '') {
    this.run(
      'INSERT INTO audit_log(id, server_id, user_id, action, target_id, changes, reason, created_at) VALUES(?,?,?,?,?,?,?,?)',
      this.id(),
      sid,
      uid,
      action,
      targetId,
      changes ? JSON.stringify(changes) : null,
      reason || '',
      Date.now()
    );
  }
  memberObj(sid: string, uid: string) {
    const m = this.one('SELECT * FROM members WHERE server_id=? AND user_id=?', sid, uid);
    if (!m) return null;
    return {
      userId: uid,
      nickname: m.nickname,
      joinedAt: m.joined_at,
      roles: this.all('SELECT role_id FROM member_roles WHERE server_id=? AND user_id=?', sid, uid).map((r) => r.role_id),
      timeoutUntil: m.timeout_until || 0,
      serverMute: !!m.server_mute,
      serverDeaf: !!m.server_deaf,
    };
  }
  serverObj(sid: string, uid?: string) {
    const s = this.one('SELECT * FROM servers WHERE id=?', sid)!;
    const roleMap: Record<string, string[]> = {};
    for (const r of this.all('SELECT user_id, role_id FROM member_roles WHERE server_id=?', sid))
      (roleMap[r.user_id] ||= []).push(r.role_id);
    return {
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.owner_id,
      banner: s.banner || null,
      description: s.description || '',
      automod: JSON.parse(s.automod || '{}'),
      channels: this.channelsOf(sid, uid),
      roles: this.rolesOf(sid),
      members: this.all('SELECT * FROM members WHERE server_id=? ORDER BY joined_at', sid).map((m) => ({
        userId: m.user_id,
        nickname: m.nickname,
        joinedAt: m.joined_at,
        roles: roleMap[m.user_id] || [],
        timeoutUntil: m.timeout_until || 0,
        serverMute: !!m.server_mute,
        serverDeaf: !!m.server_deaf,
      })),
      emojis: this.all('SELECT id, name, animated FROM emojis WHERE server_id=? ORDER BY name', sid).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated })),
      stickers: this.all('SELECT id, name FROM stickers WHERE server_id=? ORDER BY name', sid),
      sounds: this.all('SELECT id, name, emoji, volume FROM sounds WHERE server_id=? ORDER BY name', sid),
      events: this.eventsOf(sid),
    };
  }
  eventsOf(sid: string) {
    return this.all('SELECT * FROM events WHERE server_id=? AND status<>3 ORDER BY start_at', sid).map((e) => ({
      id: e.id,
      serverId: e.server_id,
      channelId: e.channel_id,
      name: e.name,
      description: e.description,
      location: e.location,
      startAt: e.start_at,
      endAt: e.end_at,
      status: e.status,
      creatorId: e.creator_id,
      interested: this.all('SELECT user_id FROM event_users WHERE event_id=?', e.id).map((r) => r.user_id),
    }));
  }
  memberIds(sid: string) {
    return this.all('SELECT user_id FROM members WHERE server_id=?', sid).map((r) => r.user_id as string);
  }
  /** Everybody who can see this channel. */
  audience(ch: any): Set<string> {
    if (!ch.server_id) return new Set(this.all('SELECT user_id FROM dm_members WHERE channel_id=?', ch.id).map((r) => r.user_id as string));
    const ids = this.memberIds(ch.server_id);
    const ow = this.effectiveOverwrites(ch);
    if (!ow.length) return new Set(ids);
    return new Set(ids.filter((u) => this.channelPerms(ch, u, ow) & P.VIEW_CHANNEL));
  }
  hydrate(rows: any[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const reacts: Record<string, { emoji: string; users: string[] }[]> = {};
    for (const r of this.byIds(
      (ph) => `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ph}) ORDER BY rowid`,
      ids
    )) {
      const list = (reacts[r.message_id] ||= []);
      let e = list.find((x) => x.emoji === r.emoji);
      if (!e) list.push((e = { emoji: r.emoji, users: [] }));
      e.users.push(r.user_id);
    }
    const polls: Record<string, Record<number, string[]>> = {};
    const withPoll = rows.filter((r) => r.poll).map((r) => r.id);
    for (const v of this.byIds((ph) => `SELECT message_id, answer_id, user_id FROM poll_votes WHERE message_id IN (${ph})`, withPoll))
      ((polls[v.message_id] ||= {})[v.answer_id] ||= []).push(v.user_id);
    const threads: Record<string, any> = {};
    for (const t of this.byIds((ph) => `SELECT id, name, message_count, archived, last_message_id FROM channels WHERE id IN (${ph})`, rows.map((r) => r.thread_id).filter(Boolean)))
      threads[t.id] = { id: t.id, name: t.name, messageCount: t.message_count || 0, archived: !!t.archived, lastMessageId: t.last_message_id };
    const replies: Record<string, any> = {};
    for (const r of this.byIds(
      (ph) => `SELECT id, author_id, content, attachments FROM messages WHERE id IN (${ph})`,
      rows.map((r) => r.reply_to).filter(Boolean)
    ))
      replies[r.id] = {
        id: r.id,
        authorId: r.author_id,
        content: (r.content || '').slice(0, 200),
        hasAttachments: r.attachments && r.attachments !== '[]',
      };
    return rows.map((m) => ({
      id: m.id,
      channelId: m.channel_id,
      authorId: m.author_id,
      content: m.content,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      replyTo: m.reply_to,
      reply: m.reply_to ? replies[m.reply_to] || { id: m.reply_to, deleted: true } : null,
      attachments: JSON.parse(m.attachments || '[]'),
      pinned: !!m.pinned,
      type: m.type,
      mentions: JSON.parse(m.mentions || '[]'),
      mentionEveryone: !!m.mention_everyone,
      reactions: reacts[m.id] || [],
      poll: m.poll ? { ...JSON.parse(m.poll), votes: polls[m.id] || {} } : null,
      forwarded: m.forwarded ? JSON.parse(m.forwarded) : null,
      webhook: m.webhook ? JSON.parse(m.webhook) : null,
      embeds: m.embeds ? JSON.parse(m.embeds) : [],
      sticker: m.sticker ? JSON.parse(m.sticker) : null,
      thread: m.thread_id ? threads[m.thread_id] || null : null,
    }));
  }
  msg(id: string) {
    return this.hydrate(this.all('SELECT * FROM messages WHERE id=?', id))[0];
  }

  // ---------- permissions ----------
  perms(sid: string, uid: string): number {
    const s = this.one('SELECT owner_id FROM servers WHERE id=?', sid);
    if (!s) return 0;
    if (!this.one('SELECT 1 FROM members WHERE server_id=? AND user_id=?', sid, uid)) return 0;
    if (s.owner_id === uid) return ALL_PERMS;
    let p = this.one('SELECT permissions FROM roles WHERE id=?', sid)?.permissions || 0;
    for (const r of this.all(
      'SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=? AND mr.user_id=?',
      sid,
      uid
    ))
      p |= r.permissions;
    if (p & P.ADMIN) return ALL_PERMS;
    if (this.timedOut(sid, uid)) p &= ~TIMEOUT_REMOVES;
    return p;
  }
  need(sid: string, uid: string, perm: number) {
    const p = this.perms(sid, uid);
    if (!p) fail('Not found', 404);
    if (!(p & perm)) fail('You do not have permission to do that', 403);
    return p;
  }
  topPos(sid: string, uid: string): number {
    if (this.one('SELECT owner_id FROM servers WHERE id=?', sid)?.owner_id === uid) return Infinity;
    return (
      this.one(
        'SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=? AND mr.user_id=?',
        sid,
        uid
      )?.p || 0
    );
  }
  outranks(sid: string, actor: string, target: string) {
    if (actor === target) return false;
    return this.topPos(sid, actor) > this.topPos(sid, target);
  }
  /** Returns the channel and the caller's permissions in it, or throws 404. */
  access(uid: string, cid: string): { ch: any; perms: number } {
    const ch = this.one('SELECT * FROM channels WHERE id=?', cid);
    if (!ch) return fail('Not found', 404);
    if (ch.server_id) {
      const perms = this.channelPerms(ch, uid);
      if (!perms) fail('Not found', 404);
      return { ch, perms };
    }
    if (!this.one('SELECT 1 FROM dm_members WHERE channel_id=? AND user_id=?', cid, uid)) fail('Not found', 404);
    return { ch, perms: ALL_PERMS & ~(P.ADMIN | P.MENTION_EVERYONE) };
  }
  rel(a: string, b: string): number {
    return this.one('SELECT type FROM relationships WHERE user_id=? AND target_id=?', a, b)?.type || 0;
  }
  setRel(a: string, b: string, type: number) {
    if (type) this.run('INSERT OR REPLACE INTO relationships(user_id, target_id, type) VALUES(?,?,?)', a, b, type);
    else this.run('DELETE FROM relationships WHERE user_id=? AND target_id=?', a, b);
    this.send([a], { op: 'RELATIONSHIP', id: b, type, user: this.user(b), presence: this.statusOf(b) });
  }

  // ---------- files ----------
  deleteFiles(ids: string[]) {
    for (const id of ids) {
      this.run('DELETE FROM file_chunks WHERE file_id=?', id);
      this.run('DELETE FROM files WHERE id=?', id);
    }
  }
  fileIdFromUrl(url: string | null) {
    return url?.match(/^\/api\/files\/([0-9a-f]+)/)?.[1];
  }
  /** Validates that an avatar/icon url points at a file the caller uploaded. */
  ownImage(uid: string, url: any, previous: string | null): string | null {
    if (url === null || url === '') {
      const old = this.fileIdFromUrl(previous);
      if (old) this.deleteFiles([old]);
      return null;
    }
    if (url === previous) return previous;
    const id = this.fileIdFromUrl(String(url));
    const f = id && this.one('SELECT * FROM files WHERE id=? AND uploader_id=?', id, uid);
    if (!f || !/^image\//.test(f.type)) return fail('Invalid image');
    const old = this.fileIdFromUrl(previous);
    if (old) this.deleteFiles([old]);
    this.run("UPDATE files SET ref='profile' WHERE id=?", id);
    return `/api/files/${id}`;
  }

  // ---------- membership ----------
  removeMember(sid: string, uid: string) {
    this.dropVoice((a) => a.uid === uid && !!this.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', a.v!.c, sid));
    this.run('DELETE FROM members WHERE server_id=? AND user_id=?', sid, uid);
    this.run('DELETE FROM member_roles WHERE server_id=? AND user_id=?', sid, uid);
    this.run(
      'DELETE FROM read_states WHERE user_id=? AND channel_id IN (SELECT id FROM channels WHERE server_id=?)',
      uid,
      sid
    );
    this.send(this.memberIds(sid), { op: 'MEMBER_REMOVE', serverId: sid, userId: uid });
    this.send([uid], { op: 'SERVER_DELETE', id: sid });
  }
  addMember(sid: string, uid: string) {
    this.run('INSERT INTO members(server_id, user_id, joined_at) VALUES(?,?,?)', sid, uid, Date.now());
    this.send(
      this.memberIds(sid).filter((i) => i !== uid),
      { op: 'MEMBER_ADD', serverId: sid, member: this.memberObj(sid, uid), user: this.user(uid), presence: this.statusOf(uid) }
    );
    this.sendServer(uid, sid);
    const first = this.one('SELECT id FROM channels WHERE server_id=? AND type=? ORDER BY position, id LIMIT 1', sid, CH.TEXT);
    if (first) this.createMessage(first.id, uid, { type: 1 });
  }
  sendServer(uid: string, sid: string) {
    const ids = this.memberIds(sid);
    this.send([uid], {
      op: 'SERVER_CREATE',
      server: this.serverObj(sid, uid),
      users: this.users(ids),
      presences: this.presences(ids),
      voiceStates: this.voiceStates((a) => !!this.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', a.v!.c, sid)),
    });
  }
  deleteChannelData(cid: string) {
    this.dropVoice((a) => a.v!.c === cid);
    this.run('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id=?)', cid);
    this.run('DELETE FROM poll_votes WHERE message_id IN (SELECT id FROM messages WHERE channel_id=?)', cid);
    this.run('DELETE FROM messages WHERE channel_id=?', cid);
    this.run('DELETE FROM read_states WHERE channel_id=?', cid);
    this.run('DELETE FROM channel_overwrites WHERE channel_id=?', cid);
    this.run('DELETE FROM webhooks WHERE channel_id=?', cid);
    // Threads go with their channel.
    for (const t of this.all('SELECT id FROM channels WHERE parent_id=? AND type=?', cid, CH.THREAD)) this.deleteChannelData(t.id);
    this.deleteFiles(this.all('SELECT id FROM files WHERE ref=?', cid).map((f) => f.id));
    this.run('DELETE FROM dm_members WHERE channel_id=?', cid);
    this.run('DELETE FROM channels WHERE id=?', cid);
  }
  /** Everyone gets the channel list they are allowed to see. */
  pushChannels(sid: string) {
    for (const uid of this.memberIds(sid)) this.send([uid], { op: 'CHANNELS', serverId: sid, channels: this.channelsOf(sid, uid) });
  }
  pushServerData(sid: string) {
    const s = this.serverObj(sid);
    this.send(this.memberIds(sid), {
      op: 'SERVER_DATA',
      serverId: sid,
      emojis: s.emojis,
      stickers: s.stickers,
      sounds: s.sounds,
      events: s.events,
      automod: s.automod,
      banner: s.banner,
      description: s.description,
    });
  }
  pushRoles(sid: string) {
    this.send(this.memberIds(sid), { op: 'ROLES', serverId: sid, roles: this.rolesOf(sid) });
  }
  pushMember(sid: string, uid: string) {
    this.send(this.memberIds(sid), { op: 'MEMBER_UPDATE', serverId: sid, member: this.memberObj(sid, uid) });
  }
  pushDm(cid: string, only?: string[]) {
    const channel = this.dmObj(cid);
    this.send(only || channel.recipients, { op: 'DM_UPDATE', channel, users: this.users(channel.recipients) });
  }

  createMessage(
    cid: string,
    authorId: string,
    o: {
      content?: string;
      replyTo?: string | null;
      attachments?: any[];
      type?: number;
      mentions?: string[];
      everyone?: boolean;
      nonce?: string;
      poll?: any;
      forwarded?: any;
      webhook?: any;
      embeds?: any[];
      sticker?: any;
      createdAt?: number;
    }
  ) {
    const ch = this.one('SELECT * FROM channels WHERE id=?', cid)!;
    const id = o.createdAt ? this.idAt(o.createdAt) : this.id();
    const mentions = [...new Set(o.mentions || [])];
    this.run(
      'INSERT INTO messages(id, channel_id, author_id, content, created_at, reply_to, attachments, type, mentions, mention_everyone) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      cid,
      authorId,
      o.content || '',
      Date.now(),
      o.replyTo || null,
      JSON.stringify(o.attachments || []),
      o.type || 0,
      JSON.stringify(mentions),
      o.everyone ? 1 : 0
    );
    if (o.poll || o.forwarded || o.webhook || o.embeds?.length || o.sticker)
      this.run(
        'UPDATE messages SET poll=?, forwarded=?, webhook=?, embeds=?, sticker=? WHERE id=?',
        o.poll ? JSON.stringify(o.poll) : null,
        o.forwarded ? JSON.stringify(o.forwarded) : null,
        o.webhook ? JSON.stringify(o.webhook) : null,
        o.embeds?.length ? JSON.stringify(o.embeds) : null,
        o.sticker ? JSON.stringify(o.sticker) : null,
        id
      );
    this.run(
      'UPDATE channels SET last_message_id=CASE WHEN last_message_id IS NULL OR last_message_id<? THEN ? ELSE last_message_id END, message_count=COALESCE(message_count,0)+1 WHERE id=?',
      id,
      id,
      cid
    );
    if (ch.type === CH.THREAD) {
      // A new message revives an archived thread, and the message it started from shows the new count.
      if (ch.archived) {
        this.run('UPDATE channels SET archived=0 WHERE id=?', cid);
        this.pushChannels(ch.server_id);
      }
      if (ch.thread_msg_id) {
        const starter = this.one('SELECT * FROM messages WHERE id=?', ch.thread_msg_id);
        const parent = starter && this.one('SELECT * FROM channels WHERE id=?', starter.channel_id);
        if (parent) this.send(this.audience(parent), { op: 'MESSAGE_UPDATE', message: this.msg(starter.id) });
      }
    }
    const aud = this.audience(ch);
    if (!ch.server_id) {
      // A closed DM pops back open for its recipients when a new message arrives.
      const closed = this.all('SELECT user_id FROM dm_members WHERE channel_id=? AND closed=1', cid).map((r) => r.user_id);
      if (closed.length) {
        this.run('UPDATE dm_members SET closed=0 WHERE channel_id=?', cid);
        this.pushDm(cid, closed);
      }
    }
    if (!o.type) {
      const notify = !ch.server_id || o.everyone ? [...aud] : mentions.filter((m) => aud.has(m));
      for (const uid of notify)
        if (uid !== authorId)
          this.run(
            "INSERT INTO read_states(user_id, channel_id, last_read_id, mentions) VALUES(?,?,'0',1) ON CONFLICT(user_id, channel_id) DO UPDATE SET mentions=mentions+1",
            uid,
            cid
          );
    }
    this.run(
      'INSERT INTO read_states(user_id, channel_id, last_read_id, mentions) VALUES(?,?,?,0) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id=excluded.last_read_id, mentions=0',
      authorId,
      cid,
      id
    );
    const message = this.msg(id);
    this.send(aud, { op: 'MESSAGE_CREATE', message, serverId: ch.server_id, nonce: o.nonce });
    return message;
  }
  /** Id for a message from the past (imports): ordered by its original time. */
  idAt(ms: number) {
    let n = ms * 1000;
    while (this.one('SELECT 1 FROM messages WHERE id=?', String(n))) n++;
    return String(n);
  }

  // ---------- http ----------
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.openSocket(req, url);
    try {
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const p: Record<string, string> = {};
        r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
        let me: any = null;
        if (!r.open) {
          me = this.auth(req.headers.get('authorization')?.replace(/^Bearer /, '') || '');
          if (!me) return json({ error: 'Unauthorized' }, 401);
        }
        let body: any = {};
        if ((req.headers.get('content-type') || '').includes('application/json') && !url.pathname.startsWith('/api/files'))
          body = (await req.json().catch(() => ({}))) || {};
        const out = await r.h({ me, p, q: url.searchParams, body, req });
        return out instanceof Response ? out : json(out ?? { ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  }
  auth(token: string) {
    if (!token) return null;
    return this.one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', token) || null;
  }

  openSocket(req: Request, url: URL): Response {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    const me = this.auth(url.searchParams.get('token') || '');
    if (!me) {
      server.accept();
      server.close(4001, 'unauthorized');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.attachSocket(server, me);
    return new Response(null, { status: 101, webSocket: client });
  }
  /** Registers an authenticated socket (also used by the self-hosted Node server). */
  attachSocket(ws: WebSocket, me: any) {
    const wasOnline = this.onlineSet().has(me.id);
    const sid = randHex(8);
    this.ctx.acceptWebSocket(ws, [me.id]);
    ws.serializeAttachment({ uid: me.id, sid } as Att);
    ws.send(JSON.stringify(this.ready(me, sid)));
    if (!wasOnline && me.status_pref !== 'invisible')
      this.send(null, { op: 'PRESENCE', userId: me.id, status: me.status_pref }, sid);
  }

  ready(me: any, sid: string) {
    const uid = me.id;
    const serverIds = this.all('SELECT server_id FROM members WHERE user_id=? ORDER BY joined_at', uid).map((r) => r.server_id);
    const dmIds = this.all(
      'SELECT dm.channel_id FROM dm_members dm WHERE dm.user_id=? AND dm.closed=0',
      uid
    ).map((r) => r.channel_id);
    const relevant = this.all(
      `SELECT user_id AS id FROM members WHERE server_id IN (SELECT server_id FROM members WHERE user_id=?)
       UNION SELECT target_id FROM relationships WHERE user_id=?
       UNION SELECT user_id FROM dm_members WHERE channel_id IN (SELECT channel_id FROM dm_members WHERE user_id=?)`,
      uid,
      uid,
      uid
    ).map((r) => r.id as string);
    if (!relevant.includes(uid)) relevant.push(uid);
    const servers = serverIds.map((s) => this.serverObj(s, uid));
    const visible = new Set<string>([...dmIds, ...servers.flatMap((s) => s.channels.map((c: any) => c.id))]);
    const activities: Record<string, any> = {};
    for (const [, a] of this.sockets()) if (a.act && relevant.includes(a.uid)) activities[a.uid] = a.act;
    return {
      op: 'READY',
      sid,
      me: { ...this.pubUser(me), statusPref: me.status_pref, mfa: !!me.totp_secret },
      notes: Object.fromEntries(this.all('SELECT target_id, note FROM notes WHERE user_id=?', uid).map((n) => [n.target_id, n.note])),
      activities,
      users: this.users(relevant),
      presences: this.presences(relevant),
      relationships: this.all('SELECT target_id AS id, type FROM relationships WHERE user_id=?', uid),
      servers,
      dms: dmIds.map((d) => this.dmObj(d)),
      readStates: this.all('SELECT channel_id AS channelId, last_read_id AS lastReadId, mentions FROM read_states WHERE user_id=?', uid),
      voiceStates: this.voiceStates((a) => visible.has(a.v!.c)),
    };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;
    try {
      const m = JSON.parse(raw);
      const att = ws.deserializeAttachment() as Att;
      if (!att) return;
      if (m.op === 'typing') {
        const { ch } = this.access(att.uid, String(m.channelId));
        this.send(this.audience(ch), { op: 'TYPING', channelId: ch.id, userId: att.uid }, att.sid);
      } else if (m.op === 'voice_join') {
        const { ch, perms } = this.access(att.uid, String(m.channelId));
        if (!VOICE_LIKE.includes(ch.type)) return;
        if (!(perms & P.CONNECT)) return ws.send(JSON.stringify({ op: 'VOICE_KICK', reason: 'You do not have permission to do that' }));
        if (ch.user_limit && !(perms & P.MOVE_MEMBERS)) {
          const here = this.voiceStates((a) => a.v!.c === ch.id && a.uid !== att.uid).length;
          if (here >= ch.user_limit) return ws.send(JSON.stringify({ op: 'VOICE_KICK', reason: 'This voice channel is full' }));
        }
        // One voice connection per user: joining elsewhere replaces the old one.
        this.dropVoice((a) => a.uid === att.uid && a.sid !== att.sid);
        if (att.v && att.v.c !== ch.id) this.dropVoice((a) => a.sid === att.sid, false);
        const mem = ch.server_id ? this.one('SELECT server_mute, server_deaf FROM members WHERE server_id=? AND user_id=?', ch.server_id, att.uid) : null;
        // On stage channels everybody starts in the audience except moderators.
        const stageMod = ch.type === CH.STAGE && !!(perms & (P.MUTE_MEMBERS | P.MOVE_MEMBERS));
        att.v = {
          c: ch.id,
          m: !!m.mute,
          d: !!m.deaf,
          vid: false,
          scr: null,
          sm: !!mem?.server_mute,
          sd: !!mem?.server_deaf,
          sup: ch.type === CH.STAGE && !stageMod,
          hand: 0,
        };
        if (!ch.server_id) {
          // Calling someone re-opens the conversation on their side so they can see the call.
          const closed = this.all('SELECT user_id FROM dm_members WHERE channel_id=? AND closed=1', ch.id).map((r) => r.user_id);
          if (closed.length) {
            this.run('UPDATE dm_members SET closed=0 WHERE channel_id=?', ch.id);
            this.pushDm(ch.id, closed);
          }
        }
        ws.serializeAttachment(att);
        // The joiner gets the authoritative list first, then everybody learns about the joiner.
        ws.send(JSON.stringify({ op: 'VOICE_READY', channelId: ch.id, bitrate: ch.bitrate || 64, states: this.voiceStates((a) => a.v!.c === ch.id) }));
        this.send(this.audience(ch), { op: 'VOICE_STATE', state: this.voiceObj(att), serverId: ch.server_id }, att.sid);
      } else if (m.op === 'voice_leave') {
        this.dropVoice((a) => a.sid === att.sid, false);
      } else if (m.op === 'voice_state') {
        if (!att.v) return;
        const ch = this.one('SELECT * FROM channels WHERE id=?', att.v.c);
        if (!ch) return;
        const canVideo = !ch.server_id || !!(this.perms(ch.server_id, att.uid) & P.VIDEO);
        att.v = {
          ...att.v,
          m: !!m.mute,
          d: !!m.deaf,
          vid: canVideo && !!m.video && !att.v.sup,
          scr: canVideo && !att.v.sup && typeof m.screen === 'string' ? m.screen.slice(0, 64) : null,
        };
        ws.serializeAttachment(att);
        this.send(this.audience(ch), { op: 'VOICE_STATE', state: this.voiceObj(att), serverId: ch.server_id });
      } else if (handleFeatureSocket(this, ws, att, m)) {
        // handled by a feature module (soundboard, stage hands, idle, activity)
      } else if (m.op === 'signal') {
        if (!att.v) return;
        for (const [peer, pa] of this.sockets())
          if (pa.sid === m.to && pa.v?.c === att.v.c)
            peer.send(JSON.stringify({ op: 'SIGNAL', from: att.sid, userId: att.uid, data: m.data }));
      }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }
  async webSocketError(ws: WebSocket) {
    this.gone(ws);
  }
  gone(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Att | null;
    if (!att) return;
    if (att.v) {
      const ch = this.one('SELECT * FROM channels WHERE id=?', att.v.c);
      if (ch) this.send(this.audience(ch), { op: 'VOICE_STATE', state: this.voiceObj(att, true), prevChannelId: att.v.c }, att.sid);
    }
    ws.serializeAttachment(null);
    if (!this.onlineSet(ws).has(att.uid)) this.send(null, { op: 'PRESENCE', userId: att.uid, status: 'offline', activity: null }, att.sid);
    else if (att.idle !== undefined || att.act) this.send(null, { op: 'PRESENCE', userId: att.uid, status: this.statusOf(att.uid, ws), activity: this.activityOf(att.uid) }, att.sid);
  }

  // ---------- routes ----------
  defineRoutes() {
    const validName = (v: any, max = 100) => str(v, max) || fail('Name is required');

    this.on('GET', '/api/config', () => ({ needsCode: !!this.env.REGISTRATION_CODE }), true);

    this.on(
      'POST',
      '/api/auth/register',
      async ({ body }) => {
        const username = str(body.username, 32).toLowerCase();
        const password = typeof body.password === 'string' ? body.password : '';
        if (this.env.REGISTRATION_CODE && body.code !== this.env.REGISTRATION_CODE) fail('Invalid registration code', 403);
        if (!/^[\p{L}\p{N}_.]{2,32}$/u.test(username)) fail('Username must be 2-32 letters, numbers, dots or underscores');
        if (password.length < 6 || password.length > 200) fail('Password must be at least 6 characters');
        if (this.one('SELECT 1 FROM users WHERE username=?', username)) fail('Username is already taken', 409);
        const id = this.id();
        const salt = randHex(16);
        const hash = await hashPassword(password, salt);
        // Re-check after the await: another request may have taken the name meanwhile.
        if (this.one('SELECT 1 FROM users WHERE username=?', username)) fail('Username is already taken', 409);
        this.run(
          'INSERT INTO users(id, username, display_name, pass_hash, pass_salt, created_at) VALUES(?,?,?,?,?,?)',
          id,
          username,
          str(body.displayName, 32) || username,
          hash,
          salt,
          Date.now()
        );
        const token = randHex(32);
        this.run('INSERT INTO sessions(token, user_id, created_at) VALUES(?,?,?)', token, id, Date.now());
        return { token };
      },
      true
    );

    this.on(
      'POST',
      '/api/auth/login',
      async ({ body }) => {
        const u = this.one('SELECT * FROM users WHERE username=?', str(body.username, 32).toLowerCase());
        const hash = await hashPassword(String(body.password || ''), u?.pass_salt || 'x');
        if (!u || u.deleted || hash !== u.pass_hash) return fail('Wrong username or password', 401);
        if (u.totp_secret) {
          if (!body.code) return json({ error: 'Two-factor code required', mfa: true }, 401);
          if (!(await verifyTotp(u.totp_secret, String(body.code)))) return fail('Invalid two-factor code', 401);
        }
        const token = randHex(32);
        this.run('INSERT INTO sessions(token, user_id, created_at) VALUES(?,?,?)', token, u.id, Date.now());
        return { token };
      },
      true
    );

    this.on('POST', '/api/auth/logout', ({ req }) => {
      this.run('DELETE FROM sessions WHERE token=?', req.headers.get('authorization')!.replace(/^Bearer /, ''));
    });

    this.on('PATCH', '/api/users/me', async ({ me, body }) => {
      if (body.username !== undefined && str(body.username, 32).toLowerCase() !== me.username) {
        const username = str(body.username, 32).toLowerCase();
        if (!/^[\p{L}\p{N}_.]{2,32}$/u.test(username)) fail('Username must be 2-32 letters, numbers, dots or underscores');
        if ((await hashPassword(String(body.password || ''), me.pass_salt)) !== me.pass_hash) fail('Current password is wrong', 403);
        if (this.one('SELECT 1 FROM users WHERE username=? AND id<>?', username, me.id)) fail('Username is already taken', 409);
        this.run('UPDATE users SET username=? WHERE id=?', username, me.id);
        me = this.one('SELECT * FROM users WHERE id=?', me.id);
      }
      if (body.pronouns !== undefined) this.run('UPDATE users SET pronouns=? WHERE id=?', str(body.pronouns, 40), me.id);
      const statusChanged = body.status !== undefined && body.status !== me.status_pref;
      if (body.status !== undefined && !['online', 'idle', 'dnd', 'invisible'].includes(body.status)) fail('Invalid status');
      const avatar = body.avatar !== undefined ? this.ownImage(me.id, body.avatar, me.avatar) : me.avatar;
      this.run(
        'UPDATE users SET display_name=?, bio=?, avatar=?, banner_color=?, custom_status=?, status_pref=? WHERE id=?',
        body.displayName !== undefined ? str(body.displayName, 32) || me.username : me.display_name,
        body.bio !== undefined ? str(body.bio, 300) : me.bio,
        avatar,
        body.bannerColor !== undefined ? str(body.bannerColor, 9) || null : me.banner_color,
        body.customStatus !== undefined ? str(body.customStatus, 100) : me.custom_status,
        body.status ?? me.status_pref,
        me.id
      );
      const u = this.one('SELECT * FROM users WHERE id=?', me.id)!;
      this.send(null, { op: 'USER_UPDATE', user: this.pubUser(u) });
      this.send([me.id], { op: 'ME_UPDATE', statusPref: u.status_pref, mfa: !!u.totp_secret });
      if (statusChanged) this.send(null, { op: 'PRESENCE', userId: me.id, status: this.statusOf(me.id), activity: this.activityOf(me.id) });
      return { ...this.pubUser(u), statusPref: u.status_pref, mfa: !!u.totp_secret };
    });

    this.on('POST', '/api/users/me/password', async ({ me, body, req }) => {
      if ((await hashPassword(String(body.oldPassword || ''), me.pass_salt)) !== me.pass_hash) fail('Current password is wrong', 403);
      const pw = String(body.newPassword || '');
      if (pw.length < 6 || pw.length > 200) fail('Password must be at least 6 characters');
      const salt = randHex(16);
      this.run('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?', await hashPassword(pw, salt), salt, me.id);
      // Every other device is signed out.
      this.run('DELETE FROM sessions WHERE user_id=? AND token<>?', me.id, req.headers.get('authorization')!.replace(/^Bearer /, ''));
    });

    // ----- friends -----
    this.on('POST', '/api/friends', ({ me, body }) => {
      const t = this.one('SELECT * FROM users WHERE username=?', str(body.username, 32).toLowerCase());
      if (!t) return fail('No user with that username was found', 404);
      if (t.id === me.id) fail('You cannot add yourself');
      const mine = this.rel(me.id, t.id);
      if (mine === REL.FRIEND) fail('You are already friends');
      if (mine === REL.BLOCKED) fail('Unblock this user first');
      if (mine === REL.OUTGOING) fail('Friend request already sent');
      if (this.rel(t.id, me.id) === REL.BLOCKED) fail('This user is not accepting friend requests', 403);
      if (mine === REL.INCOMING) {
        this.setRel(me.id, t.id, REL.FRIEND);
        this.setRel(t.id, me.id, REL.FRIEND);
      } else {
        this.setRel(me.id, t.id, REL.OUTGOING);
        this.setRel(t.id, me.id, REL.INCOMING);
      }
    });
    this.on('PUT', '/api/friends/:id', ({ me, p }) => {
      if (this.rel(me.id, p.id) !== REL.INCOMING) fail('No pending request', 404);
      this.setRel(me.id, p.id, REL.FRIEND);
      this.setRel(p.id, me.id, REL.FRIEND);
    });
    this.on('DELETE', '/api/friends/:id', ({ me, p }) => {
      if (this.rel(me.id, p.id) !== REL.BLOCKED && this.rel(me.id, p.id)) this.setRel(me.id, p.id, 0);
      if (this.rel(p.id, me.id) !== REL.BLOCKED && this.rel(p.id, me.id)) this.setRel(p.id, me.id, 0);
    });
    this.on('PUT', '/api/blocks/:id', ({ me, p }) => {
      if (p.id === me.id || !this.user(p.id)) fail('Not found', 404);
      if (this.rel(p.id, me.id) !== REL.BLOCKED && this.rel(p.id, me.id)) this.setRel(p.id, me.id, 0);
      this.setRel(me.id, p.id, REL.BLOCKED);
    });
    this.on('DELETE', '/api/blocks/:id', ({ me, p }) => {
      if (this.rel(me.id, p.id) === REL.BLOCKED) this.setRel(me.id, p.id, 0);
    });

    // ----- direct messages -----
    this.on('POST', '/api/dms', ({ me, body }) => {
      const ids: string[] = [...new Set((Array.isArray(body.recipients) ? body.recipients : []).map(String))].filter(
        (i) => i !== me.id
      ) as string[];
      if (!ids.length || ids.length > 9) fail('Pick between 1 and 9 people');
      if (this.users(ids).length !== ids.length) fail('Not found', 404);
      if (ids.length === 1) {
        const ex = this.one(
          'SELECT a.channel_id AS id FROM dm_members a JOIN dm_members b ON a.channel_id=b.channel_id JOIN channels c ON c.id=a.channel_id WHERE a.user_id=? AND b.user_id=? AND c.type=?',
          me.id,
          ids[0],
          CH.DM
        );
        if (ex) {
          this.run('UPDATE dm_members SET closed=0 WHERE channel_id=? AND user_id=?', ex.id, me.id);
          this.pushDm(ex.id, [me.id]);
          return this.dmObj(ex.id);
        }
        const id = this.id();
        this.run('INSERT INTO channels(id, type) VALUES(?,?)', id, CH.DM);
        this.run('INSERT INTO dm_members(channel_id, user_id, closed) VALUES(?,?,0)', id, me.id);
        this.run('INSERT INTO dm_members(channel_id, user_id, closed) VALUES(?,?,1)', id, ids[0]);
        this.pushDm(id, [me.id]);
        return this.dmObj(id);
      }
      for (const i of ids) if (this.rel(me.id, i) !== REL.FRIEND) fail('You can only add friends to a group');
      const id = this.id();
      this.run('INSERT INTO channels(id, type, name, owner_id) VALUES(?,?,?,?)', id, CH.GROUP, str(body.name, 100) || null, me.id);
      for (const i of [me.id, ...ids]) this.run('INSERT INTO dm_members(channel_id, user_id) VALUES(?,?)', id, i);
      this.pushDm(id);
      return this.dmObj(id);
    });
    this.on('PUT', '/api/channels/:id/recipients/:uid', ({ me, p }) => {
      const { ch } = this.access(me.id, p.id);
      if (ch.type !== CH.GROUP) fail('Not a group');
      if (this.rel(me.id, p.uid) !== REL.FRIEND) fail('You can only add friends to a group');
      if (this.audience(ch).size >= 10) fail('This group is full');
      this.run('INSERT OR IGNORE INTO dm_members(channel_id, user_id) VALUES(?,?)', ch.id, p.uid);
      this.pushDm(ch.id);
    });
    this.on('DELETE', '/api/channels/:id/recipients/:uid', ({ me, p }) => {
      const { ch } = this.access(me.id, p.id);
      if (ch.type !== CH.GROUP) fail('Not a group');
      if (p.uid !== me.id && ch.owner_id !== me.id) fail('You do not have permission to do that', 403);
      this.leaveGroup(ch, p.uid);
    });

    // ----- servers -----
    this.on('POST', '/api/servers', ({ me, body }) => {
      const id = this.id();
      const fa = body.locale === 'fa';
      this.run('INSERT INTO servers(id, name, icon, owner_id, created_at) VALUES(?,?,?,?,?)', id, validName(body.name), null, me.id, Date.now());
      if (body.icon) this.run('UPDATE servers SET icon=? WHERE id=?', this.ownImage(me.id, body.icon, null), id);
      this.run('INSERT INTO roles(id, server_id, name, color, permissions, position) VALUES(?,?,?,?,?,0)', id, id, '@everyone', null, DEFAULT_PERMS);
      const mk = (type: number, name: string, parent: string | null, pos: number) => {
        const cid = this.id();
        this.run('INSERT INTO channels(id, server_id, type, name, parent_id, position) VALUES(?,?,?,?,?,?)', cid, id, type, name, parent, pos);
        return cid;
      };
      const c1 = mk(CH.CATEGORY, fa ? 'کانال‌های متنی' : 'Text Channels', null, 0);
      mk(CH.TEXT, fa ? 'عمومی' : 'general', c1, 0);
      const c2 = mk(CH.CATEGORY, fa ? 'کانال‌های صوتی' : 'Voice Channels', null, 1);
      mk(CH.VOICE, fa ? 'گفتگو' : 'General', c2, 0);
      this.run('INSERT INTO members(server_id, user_id, joined_at) VALUES(?,?,?)', id, me.id, Date.now());
      this.sendServer(me.id, id);
      return { id };
    });
    this.on('PATCH', '/api/servers/:id', ({ me, p, body }) => {
      this.need(p.id, me.id, P.MANAGE_SERVER);
      const s = this.one('SELECT * FROM servers WHERE id=?', p.id)!;
      let owner = s.owner_id;
      if (body.ownerId !== undefined && body.ownerId !== owner) {
        if (s.owner_id !== me.id) fail('Only the owner can transfer the server', 403);
        if (!this.memberObj(p.id, String(body.ownerId))) fail('Not found', 404);
        owner = String(body.ownerId);
      }
      this.run(
        'UPDATE servers SET name=?, icon=?, owner_id=?, banner=?, description=? WHERE id=?',
        body.name !== undefined ? validName(body.name) : s.name,
        body.icon !== undefined ? this.ownImage(me.id, body.icon, s.icon) : s.icon,
        owner,
        body.banner !== undefined ? this.ownImage(me.id, body.banner, s.banner) : s.banner,
        body.description !== undefined ? str(body.description, 300) : s.description,
        p.id
      );
      const n = this.one('SELECT * FROM servers WHERE id=?', p.id)!;
      const changes: any = {};
      for (const k of ['name', 'icon', 'banner', 'description', 'owner_id']) if (s[k] !== n[k]) changes[k] = [s[k], n[k]];
      if (Object.keys(changes).length) this.audit(p.id, me.id, 'server_update', p.id, changes);
      this.send(this.memberIds(p.id), { op: 'SERVER_UPDATE', id: p.id, name: n.name, icon: n.icon, ownerId: n.owner_id, banner: n.banner, description: n.description });
    });
    this.on('DELETE', '/api/servers/:id', ({ me, p }) => {
      const s = this.one('SELECT * FROM servers WHERE id=?', p.id);
      if (!s || !this.perms(p.id, me.id)) return fail('Not found', 404);
      if (s.owner_id !== me.id) fail('Only the owner can delete the server', 403);
      const ids = this.memberIds(p.id);
      for (const c of this.all('SELECT id FROM channels WHERE server_id=?', p.id)) this.deleteChannelData(c.id);
      for (const t of ['members', 'member_roles', 'roles', 'invites', 'bans', 'emojis', 'stickers', 'sounds', 'events', 'audit_log', 'webhooks'])
        this.run(`DELETE FROM ${t} WHERE server_id=?`, p.id);
      const icon = this.fileIdFromUrl(s.icon);
      if (icon) this.deleteFiles([icon]);
      this.run('DELETE FROM servers WHERE id=?', p.id);
      this.send(ids, { op: 'SERVER_DELETE', id: p.id });
    });

    // ----- members -----
    this.on('DELETE', '/api/servers/:id/members/:uid', ({ me, p }) => {
      const uid = p.uid === '@me' ? me.id : p.uid;
      const s = this.one('SELECT * FROM servers WHERE id=?', p.id);
      if (!s || !this.perms(p.id, me.id)) return fail('Not found', 404);
      if (uid === me.id) {
        if (s.owner_id === me.id) fail('Transfer ownership or delete the server before leaving');
      } else {
        this.need(p.id, me.id, P.KICK_MEMBERS);
        if (!this.memberObj(p.id, uid)) fail('Not found', 404);
        if (!this.outranks(p.id, me.id, uid)) fail('You cannot do that to someone with an equal or higher role', 403);
        this.audit(p.id, me.id, 'member_kick', uid);
      }
      this.removeMember(p.id, uid);
    });
    this.on('PATCH', '/api/servers/:id/members/:uid', ({ me, p, body }) => {
      const uid = p.uid === '@me' ? me.id : p.uid;
      const perms = this.perms(p.id, me.id);
      if (!perms || !this.memberObj(p.id, uid)) fail('Not found', 404);
      if (body.nickname !== undefined) {
        if (uid !== me.id && (!(perms & P.MANAGE_SERVER) || !this.outranks(p.id, me.id, uid)))
          fail('You do not have permission to do that', 403);
        this.run('UPDATE members SET nickname=? WHERE server_id=? AND user_id=?', str(body.nickname, 32) || null, p.id, uid);
        if (uid !== me.id) this.audit(p.id, me.id, 'member_nick', uid, { nick: str(body.nickname, 32) || null });
      }
      if (body.timeout !== undefined) {
        // Discord-style "time out": no chatting, reacting or talking until the time is up.
        if (!(perms & P.MODERATE_MEMBERS)) fail('You do not have permission to do that', 403);
        if (!this.outranks(p.id, me.id, uid)) fail('You cannot do that to someone with an equal or higher role', 403);
        const secs = Math.max(0, Math.min(28 * 86400, Number(body.timeout) || 0));
        this.run('UPDATE members SET timeout_until=? WHERE server_id=? AND user_id=?', secs ? Date.now() + secs * 1000 : 0, p.id, uid);
        this.audit(p.id, me.id, secs ? 'member_timeout' : 'member_timeout_remove', uid, secs ? { seconds: secs } : null, str(body.reason, 200));
        if (secs) this.dropVoice((a) => a.uid === uid && !!this.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', a.v!.c, p.id));
      }
      if (Array.isArray(body.roles)) {
        if (!(perms & P.MANAGE_ROLES)) fail('You do not have permission to do that', 403);
        const top = this.topPos(p.id, me.id);
        const all = this.all('SELECT id, position FROM roles WHERE server_id=? AND id<>?', p.id, p.id);
        const cur = new Set(this.memberObj(p.id, uid)!.roles);
        const want = new Set(body.roles.map(String));
        for (const r of all) {
          if (cur.has(r.id) === want.has(r.id)) continue;
          if (r.position >= top) fail('You cannot manage a role equal to or higher than your own', 403);
          if (want.has(r.id)) this.run('INSERT OR IGNORE INTO member_roles(server_id, user_id, role_id) VALUES(?,?,?)', p.id, uid, r.id);
          else this.run('DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?', p.id, uid, r.id);
          this.audit(p.id, me.id, want.has(r.id) ? 'member_role_add' : 'member_role_remove', uid, { role: r.id });
        }
        // Roles can change which channels someone sees.
        this.send([uid], { op: 'CHANNELS', serverId: p.id, channels: this.channelsOf(p.id, uid) });
      }
      this.pushMember(p.id, uid);
    });
    this.on('GET', '/api/servers/:id/bans', ({ me, p }) => {
      this.need(p.id, me.id, P.BAN_MEMBERS);
      const bans = this.all('SELECT user_id, reason FROM bans WHERE server_id=?', p.id);
      const users = this.users(bans.map((b) => b.user_id));
      return bans.map((b) => ({ user: users.find((u) => u.id === b.user_id), reason: b.reason }));
    });
    this.on('PUT', '/api/servers/:id/bans/:uid', ({ me, p, body }) => {
      this.need(p.id, me.id, P.BAN_MEMBERS);
      if (p.uid === me.id || !this.user(p.uid)) fail('Not found', 404);
      if (this.memberObj(p.id, p.uid)) {
        if (!this.outranks(p.id, me.id, p.uid)) fail('You cannot do that to someone with an equal or higher role', 403);
        this.removeMember(p.id, p.uid);
      }
      this.run('INSERT OR REPLACE INTO bans(server_id, user_id, reason) VALUES(?,?,?)', p.id, p.uid, str(body.reason, 200));
      this.audit(p.id, me.id, 'member_ban', p.uid, null, str(body.reason, 200));
    });
    this.on('DELETE', '/api/servers/:id/bans/:uid', ({ me, p }) => {
      this.need(p.id, me.id, P.BAN_MEMBERS);
      this.run('DELETE FROM bans WHERE server_id=? AND user_id=?', p.id, p.uid);
      this.audit(p.id, me.id, 'member_unban', p.uid);
    });

    // ----- roles -----
    this.on('POST', '/api/servers/:id/roles', ({ me, p, body }) => {
      this.need(p.id, me.id, P.MANAGE_ROLES);
      // New roles are inserted just above @everyone so they never outrank their creator.
      this.run('UPDATE roles SET position=position+1 WHERE server_id=? AND position>0', p.id);
      const id = this.id();
      this.run(
        'INSERT INTO roles(id, server_id, name, color, permissions, position) VALUES(?,?,?,?,0,1)',
        id,
        p.id,
        str(body.name, 50) || 'new role',
        str(body.color, 9) || null
      );
      this.audit(p.id, me.id, 'role_create', id, { name: str(body.name, 50) || 'new role' });
      this.pushRoles(p.id);
      return { id };
    });
    this.on('PATCH', '/api/roles/:id', ({ me, p, body }) => {
      const r = this.one('SELECT * FROM roles WHERE id=?', p.id);
      if (!r) return fail('Not found', 404);
      const mine = this.need(r.server_id, me.id, P.MANAGE_ROLES);
      if (r.position >= this.topPos(r.server_id, me.id)) fail('You cannot manage a role equal to or higher than your own', 403);
      let perms = r.permissions;
      if (body.permissions !== undefined) {
        perms = Number(body.permissions) & ALL_PERMS;
        // Nobody can hand out a permission they do not hold themselves.
        if ((perms ^ r.permissions) & ~mine) fail('You cannot grant a permission you do not have', 403);
      }
      const everyone = r.id === r.server_id;
      this.run(
        'UPDATE roles SET name=?, color=?, permissions=?, hoist=? WHERE id=?',
        !everyone && body.name !== undefined ? str(body.name, 50) || r.name : r.name,
        body.color !== undefined ? str(body.color, 9) || null : r.color,
        perms,
        body.hoist !== undefined ? (body.hoist ? 1 : 0) : r.hoist,
        r.id
      );
      this.audit(r.server_id, me.id, 'role_update', r.id, { name: r.name, permissions: perms !== r.permissions ? [r.permissions, perms] : undefined });
      this.pushRoles(r.server_id);
      if (perms !== r.permissions) this.pushChannels(r.server_id);
    });
    this.on('DELETE', '/api/roles/:id', ({ me, p }) => {
      const r = this.one('SELECT * FROM roles WHERE id=?', p.id);
      if (!r) return fail('Not found', 404);
      this.need(r.server_id, me.id, P.MANAGE_ROLES);
      if (r.id === r.server_id) fail('The @everyone role cannot be deleted');
      if (r.position >= this.topPos(r.server_id, me.id)) fail('You cannot manage a role equal to or higher than your own', 403);
      this.run('DELETE FROM member_roles WHERE role_id=?', r.id);
      this.run('DELETE FROM channel_overwrites WHERE target_id=?', r.id);
      this.run('DELETE FROM roles WHERE id=?', r.id);
      this.audit(r.server_id, me.id, 'role_delete', r.id, { name: r.name });
      this.pushRoles(r.server_id);
      const s = this.serverObj(r.server_id);
      this.send(this.memberIds(r.server_id), { op: 'MEMBERS', serverId: r.server_id, members: s.members });
    });
    this.on('PUT', '/api/servers/:id/roles/order', ({ me, p, body }) => {
      this.need(p.id, me.id, P.MANAGE_ROLES);
      const top = this.topPos(p.id, me.id);
      const roles = this.all('SELECT id, position FROM roles WHERE server_id=? AND id<>?', p.id, p.id);
      const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).map(String);
      if (ids.length !== roles.length || roles.some((r) => !ids.includes(r.id))) fail('Invalid role order');
      // ids are listed from highest to lowest.
      ids.forEach((id, i) => {
        const pos = ids.length - i;
        const old = roles.find((r) => r.id === id)!.position;
        if (pos !== old && (old >= top || pos >= top)) fail('You cannot manage a role equal to or higher than your own', 403);
      });
      ids.forEach((id, i) => this.run('UPDATE roles SET position=? WHERE id=?', ids.length - i, id));
      this.pushRoles(p.id);
    });

    // ----- channels -----
    this.on('POST', '/api/servers/:id/channels', ({ me, p, body }) => {
      this.need(p.id, me.id, P.MANAGE_CHANNELS);
      const type = Number(body.type);
      if (![CH.TEXT, CH.VOICE, CH.CATEGORY, CH.ANNOUNCEMENT, CH.STAGE, CH.FORUM].includes(type as any)) fail('Invalid channel type');
      let parent: string | null = null;
      if (type !== CH.CATEGORY && body.parentId) {
        if (!this.one('SELECT 1 FROM channels WHERE id=? AND server_id=? AND type=?', String(body.parentId), p.id, CH.CATEGORY))
          fail('Invalid category');
        parent = String(body.parentId);
      }
      const pos = (this.one('SELECT MAX(position) AS m FROM channels WHERE server_id=?', p.id)?.m ?? -1) + 1;
      const id = this.id();
      this.run(
        'INSERT INTO channels(id, server_id, type, name, parent_id, position, topic, created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        p.id,
        type,
        this.channelName(body.name, type),
        parent,
        pos,
        str(body.topic, 1024),
        Date.now()
      );
      // "Private channel": only the chosen roles and members (and admins) can see it.
      if (body.private) {
        this.setOverwrite(id, p.id, 0, 0, P.VIEW_CHANNEL);
        for (const rid of (Array.isArray(body.roles) ? body.roles : []).map(String))
          if (this.one('SELECT 1 FROM roles WHERE id=? AND server_id=?', rid, p.id)) this.setOverwrite(id, rid, 0, P.VIEW_CHANNEL, 0);
        for (const uid of (Array.isArray(body.members) ? body.members : []).map(String))
          if (this.memberObj(p.id, uid)) this.setOverwrite(id, uid, 1, P.VIEW_CHANNEL, 0);
        this.setOverwrite(id, me.id, 1, P.VIEW_CHANNEL, 0);
      }
      this.audit(p.id, me.id, 'channel_create', id, { name: this.channelName(body.name, type), type });
      this.pushChannels(p.id);
      return { id };
    });
    this.on('PUT', '/api/servers/:id/channels/order', ({ me, p, body }) => {
      this.need(p.id, me.id, P.MANAGE_CHANNELS);
      const chans = this.all('SELECT id, type FROM channels WHERE server_id=?', p.id);
      for (const it of Array.isArray(body.items) ? body.items : []) {
        const c = chans.find((x) => x.id === String(it.id));
        if (!c) continue;
        const parent = it.parentId ? chans.find((x) => x.id === String(it.parentId) && x.type === CH.CATEGORY) : null;
        this.run(
          'UPDATE channels SET position=?, parent_id=? WHERE id=?',
          Number(it.position) | 0,
          c.type === CH.CATEGORY ? null : parent?.id || null,
          c.id
        );
      }
      this.pushChannels(p.id);
    });
    this.on('PATCH', '/api/channels/:id', ({ me, p, body }) => {
      const { ch, perms } = this.access(me.id, p.id);
      if (ch.type === CH.THREAD) {
        // Thread owners can rename and archive their own threads; moderators any thread.
        if (ch.owner_id !== me.id && !(perms & (P.MANAGE_THREADS | P.MANAGE_CHANNELS))) fail('You do not have permission to do that', 403);
        this.run(
          'UPDATE channels SET name=?, archived=? WHERE id=?',
          body.name !== undefined ? this.channelName(body.name, ch.type) : ch.name,
          body.archived !== undefined ? (body.archived ? 1 : 0) : ch.archived,
          ch.id
        );
        this.pushChannels(ch.server_id);
      } else if (ch.server_id) {
        if (!(perms & P.MANAGE_CHANNELS)) fail('You do not have permission to do that', 403);
        const num = (v: any, lo: number, hi: number, d: number) => (v === undefined ? d : Math.max(lo, Math.min(hi, Number(v) || 0)));
        this.run(
          'UPDATE channels SET name=?, topic=?, rate_limit=?, user_limit=?, bitrate=?, nsfw=? WHERE id=?',
          body.name !== undefined ? this.channelName(body.name, ch.type) : ch.name,
          body.topic !== undefined ? str(body.topic, 1024) : ch.topic,
          num(body.rateLimit, 0, 21600, ch.rate_limit || 0),
          num(body.userLimit, 0, 99, ch.user_limit || 0),
          num(body.bitrate, 8, 128, ch.bitrate || 64),
          body.nsfw !== undefined ? (body.nsfw ? 1 : 0) : ch.nsfw || 0,
          ch.id
        );
        if (Array.isArray(body.overwrites)) {
          // Replace the channel's permission overrides (needs Manage Roles, like Discord).
          if (!(perms & P.MANAGE_ROLES)) fail('You do not have permission to do that', 403);
          this.run('DELETE FROM channel_overwrites WHERE channel_id=?', ch.id);
          for (const o of body.overwrites.slice(0, 100)) {
            const type = Number(o.type) === 1 ? 1 : 0;
            const id = String(o.id);
            if (type === 0 && !this.one('SELECT 1 FROM roles WHERE id=? AND server_id=?', id, ch.server_id)) continue;
            if (type === 1 && !this.memberObj(ch.server_id, id)) continue;
            this.setOverwrite(ch.id, id, type, (Number(o.allow) || 0) & ALL_PERMS, (Number(o.deny) || 0) & ALL_PERMS);
          }
          // Whoever edits keeps seeing the channel.
          if (!(this.channelPerms(ch, me.id) & P.VIEW_CHANNEL)) this.setOverwrite(ch.id, me.id, 1, P.VIEW_CHANNEL, 0);
          this.audit(ch.server_id, me.id, 'channel_overwrites', ch.id, { count: body.overwrites.length });
        }
        if (body.syncPermissions && ch.parent_id) this.run('DELETE FROM channel_overwrites WHERE channel_id=?', ch.id);
        this.audit(ch.server_id, me.id, 'channel_update', ch.id, { name: ch.name });
        this.pushChannels(ch.server_id);
      } else {
        if (ch.type !== CH.GROUP) fail('Not a group');
        this.run('UPDATE channels SET name=? WHERE id=?', str(body.name, 100) || null, ch.id);
        this.pushDm(ch.id);
      }
    });
    this.on('DELETE', '/api/channels/:id', ({ me, p }) => {
      const { ch, perms } = this.access(me.id, p.id);
      if (ch.type === CH.THREAD) {
        if (ch.owner_id !== me.id && !(perms & (P.MANAGE_THREADS | P.MANAGE_CHANNELS))) fail('You do not have permission to do that', 403);
        if (ch.thread_msg_id) this.run('UPDATE messages SET thread_id=NULL WHERE id=?', ch.thread_msg_id);
        this.deleteChannelData(ch.id);
        this.audit(ch.server_id, me.id, 'thread_delete', ch.id, { name: ch.name });
        this.pushChannels(ch.server_id);
      } else if (ch.server_id) {
        if (!(perms & P.MANAGE_CHANNELS)) fail('You do not have permission to do that', 403);
        if (ch.type === CH.CATEGORY) this.run('UPDATE channels SET parent_id=NULL WHERE parent_id=?', ch.id);
        this.deleteChannelData(ch.id);
        this.audit(ch.server_id, me.id, 'channel_delete', ch.id, { name: ch.name });
        this.pushChannels(ch.server_id);
      } else if (ch.type === CH.GROUP) {
        this.leaveGroup(ch, me.id);
      } else {
        this.run('UPDATE dm_members SET closed=1 WHERE channel_id=? AND user_id=?', ch.id, me.id);
        this.send([me.id], { op: 'DM_DELETE', id: ch.id });
      }
    });

    // ----- invites -----
    this.on('POST', '/api/servers/:id/invites', ({ me, p, body }) => {
      this.need(p.id, me.id, P.CREATE_INVITE);
      const code = [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55])
        .join('');
      const age = Math.max(0, Number(body.maxAge) || 0);
      this.run(
        'INSERT INTO invites(code, server_id, creator_id, created_at, expires_at, max_uses) VALUES(?,?,?,?,?,?)',
        code,
        p.id,
        me.id,
        Date.now(),
        age ? Date.now() + age * 1000 : 0,
        Math.max(0, Number(body.maxUses) || 0)
      );
      this.audit(p.id, me.id, 'invite_create', code);
      return { code };
    });
    this.on('GET', '/api/servers/:id/invites', ({ me, p }) => {
      this.need(p.id, me.id, P.MANAGE_SERVER);
      const rows = this.all('SELECT * FROM invites WHERE server_id=? ORDER BY created_at DESC', p.id);
      const users = this.users(rows.map((r) => r.creator_id));
      return rows.map((r) => ({
        code: r.code,
        creator: users.find((u) => u.id === r.creator_id),
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        maxUses: r.max_uses,
        uses: r.uses,
      }));
    });
    this.on('DELETE', '/api/invites/:code', ({ me, p }) => {
      const inv = this.one('SELECT * FROM invites WHERE code=?', p.code);
      if (!inv) return fail('Not found', 404);
      if (inv.creator_id !== me.id) this.need(inv.server_id, me.id, P.MANAGE_SERVER);
      this.run('DELETE FROM invites WHERE code=?', p.code);
      this.audit(inv.server_id, me.id, 'invite_delete', p.code);
    });
    const liveInvite = (code: string) => {
      const inv = this.one('SELECT * FROM invites WHERE code=?', code);
      if (!inv || (inv.expires_at && inv.expires_at < Date.now()) || (inv.max_uses && inv.uses >= inv.max_uses))
        return fail('This invite is invalid or has expired', 404);
      return inv;
    };
    this.on('GET', '/api/invites/:code', ({ me, p }) => {
      const inv = liveInvite(p.code);
      const s = this.one('SELECT * FROM servers WHERE id=?', inv.server_id)!;
      return {
        code: inv.code,
        server: { id: s.id, name: s.name, icon: s.icon, memberCount: this.memberIds(s.id).length },
        inviter: this.user(inv.creator_id),
        joined: !!this.memberObj(s.id, me.id),
      };
    });
    this.on('POST', '/api/invites/:code', ({ me, p }) => {
      const inv = liveInvite(p.code);
      if (this.memberObj(inv.server_id, me.id)) return { id: inv.server_id };
      if (this.one('SELECT 1 FROM bans WHERE server_id=? AND user_id=?', inv.server_id, me.id)) fail('You are banned from this server', 403);
      this.run('UPDATE invites SET uses=uses+1 WHERE code=?', p.code);
      this.addMember(inv.server_id, me.id);
      return { id: inv.server_id };
    });

    // ----- messages -----
    this.on('GET', '/api/channels/:id/messages', ({ me, p, q }) => {
      const { ch } = this.access(me.id, p.id);
      const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 50));
      let rows: any[];
      if (q.get('around')) {
        const half = limit >> 1;
        rows = [
          ...this.all('SELECT * FROM messages WHERE channel_id=? AND id<=? ORDER BY id DESC LIMIT ?', ch.id, q.get('around'), half).reverse(),
          ...this.all('SELECT * FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?', ch.id, q.get('around'), half),
        ];
      } else if (q.get('after')) {
        rows = this.all('SELECT * FROM messages WHERE channel_id=? AND id>? ORDER BY id LIMIT ?', ch.id, q.get('after'), limit);
      } else {
        rows = this.all(
          'SELECT * FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT ?',
          ch.id,
          q.get('before') || '9999999999999999999',
          limit
        ).reverse();
      }
      return { messages: this.hydrate(rows), users: this.users(rows.map((r) => r.author_id)) };
    });
    this.on('POST', '/api/channels/:id/messages', ({ me, p, body }) => {
      const { ch, perms } = this.access(me.id, p.id);
      if (ch.type === CH.CATEGORY) fail('Not found', 404);
      if (ch.type === CH.FORUM) fail('Post in this forum by creating a new post');
      if (!(perms & (ch.type === CH.THREAD ? P.SEND_IN_THREADS : P.SEND_MESSAGES))) fail('You do not have permission to do that', 403);
      if (ch.type === CH.ANNOUNCEMENT && !(perms & P.MANAGE_MESSAGES)) fail('Only moderators can post in announcement channels', 403);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (content.length > MAX_MESSAGE_LENGTH) fail('Message is too long');
      const fileIds: string[] = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10).map(String);
      const poll = body.poll ? this.makePoll(body.poll) : null;
      const sticker = body.sticker ? this.findSticker(me.id, String(body.sticker)) : null;
      if (!content && !fileIds.length && !poll && !sticker) fail('Message is empty');
      if (ch.server_id) {
        const mod = !!(perms & (P.MANAGE_MESSAGES | P.MANAGE_CHANNELS));
        if (ch.rate_limit && !mod) {
          const last = this.one('SELECT created_at FROM messages WHERE channel_id=? AND author_id=? AND type=0 ORDER BY id DESC LIMIT 1', ch.id, me.id);
          const wait = last ? Math.ceil((last.created_at + ch.rate_limit * 1000 - Date.now()) / 1000) : 0;
          if (wait > 0) return json({ error: 'Slowmode is on. Wait {n} seconds.', wait }, 429);
        }
        if (!mod) this.checkAutomod(ch.server_id, me.id, content);
      }
      if (fileIds.length && !(perms & P.ATTACH_FILES)) fail('You do not have permission to do that', 403);
      if (ch.type === CH.DM) {
        const other = [...this.audience(ch)].find((u) => u !== me.id);
        if (other && (this.rel(other, me.id) === REL.BLOCKED || this.rel(me.id, other) === REL.BLOCKED))
          fail('You cannot message this user', 403);
      }
      const attachments = fileIds.map((fid) => {
        const f = this.one('SELECT * FROM files WHERE id=? AND uploader_id=? AND ref IS NULL', fid, me.id);
        if (!f) return fail('Invalid attachment');
        this.run('UPDATE files SET ref=? WHERE id=?', ch.id, fid);
        return { id: f.id, name: f.name, type: f.type, size: f.size, width: f.width, height: f.height, url: `/api/files/${f.id}` };
      });
      const mentions = [...content.matchAll(/<@(\d+)>/g)].map((m) => m[1]);
      let replyTo: string | null = null;
      if (body.replyTo) {
        const r = this.one('SELECT author_id FROM messages WHERE id=? AND channel_id=?', String(body.replyTo), ch.id);
        if (r) {
          replyTo = String(body.replyTo);
          if (body.replyMention !== false) mentions.push(r.author_id);
        }
      }
      // Mentioned roles notify their members.
      if (ch.server_id)
        for (const m of content.matchAll(/<@&(\d+)>/g))
          for (const r of this.all('SELECT user_id FROM member_roles WHERE server_id=? AND role_id=?', ch.server_id, m[1])) mentions.push(r.user_id);
      return this.createMessage(ch.id, me.id, {
        content,
        replyTo,
        attachments,
        mentions,
        everyone: !!(perms & P.MENTION_EVERYONE) && /@(everyone|here)\b/.test(content),
        nonce: str(body.nonce, 40) || undefined,
        poll,
        sticker,
      });
    });
    const ownMessage = (uid: string, mid: string) => {
      const m = this.one('SELECT * FROM messages WHERE id=?', mid);
      if (!m) return fail('Not found', 404);
      return { m, ...this.access(uid, m.channel_id) };
    };
    const pushMessage = (ch: any, mid: string) => {
      const message = this.msg(mid);
      this.send(this.audience(ch), { op: 'MESSAGE_UPDATE', message });
      return message;
    };
    this.on('PATCH', '/api/messages/:id', ({ me, p, body }) => {
      const { m, ch } = ownMessage(me.id, p.id);
      if (m.author_id !== me.id || m.type) fail('You can only edit your own messages', 403);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (content.length > MAX_MESSAGE_LENGTH) fail('Message is too long');
      if (!content && m.attachments === '[]' && !m.poll && !m.sticker) fail('Message is empty');
      if (ch.server_id && !(this.channelPerms(ch, me.id) & P.MANAGE_MESSAGES)) this.checkAutomod(ch.server_id, me.id, content);
      this.run('UPDATE messages SET content=?, edited_at=? WHERE id=?', content, Date.now(), m.id);
      return pushMessage(ch, m.id);
    });
    this.on('DELETE', '/api/messages/:id', ({ me, p }) => {
      const { m, ch, perms } = ownMessage(me.id, p.id);
      if (m.author_id !== me.id && !(ch.server_id && perms & P.MANAGE_MESSAGES)) fail('You do not have permission to do that', 403);
      if (m.author_id !== me.id && ch.server_id) this.audit(ch.server_id, me.id, 'message_delete', m.author_id, { channel: ch.id });
      this.deleteFiles(JSON.parse(m.attachments || '[]').map((a: any) => a.id));
      this.run('DELETE FROM reactions WHERE message_id=?', m.id);
      this.run('DELETE FROM poll_votes WHERE message_id=?', m.id);
      this.run('DELETE FROM messages WHERE id=?', m.id);
      if (ch.last_message_id === m.id)
        this.run(
          'UPDATE channels SET last_message_id=(SELECT MAX(id) FROM messages WHERE channel_id=?) WHERE id=?',
          ch.id,
          ch.id
        );
      this.send(this.audience(ch), { op: 'MESSAGE_DELETE', id: m.id, channelId: ch.id });
    });
    this.on('PUT', '/api/messages/:id/reactions/:emoji', ({ me, p }) => {
      const { m, ch, perms } = ownMessage(me.id, p.id);
      if (!(perms & P.ADD_REACTIONS)) fail('You do not have permission to do that', 403);
      if (p.emoji.length > 64) fail('Invalid emoji');
      const count = this.one('SELECT COUNT(DISTINCT emoji) AS c FROM reactions WHERE message_id=?', m.id)!.c;
      if (count >= 20 && !this.one('SELECT 1 FROM reactions WHERE message_id=? AND emoji=?', m.id, p.emoji)) fail('Too many reactions');
      this.run('INSERT OR IGNORE INTO reactions(message_id, emoji, user_id) VALUES(?,?,?)', m.id, p.emoji, me.id);
      pushMessage(ch, m.id);
    });
    this.on('DELETE', '/api/messages/:id/reactions/:emoji', ({ me, p }) => {
      const { m, ch } = ownMessage(me.id, p.id);
      this.run('DELETE FROM reactions WHERE message_id=? AND emoji=? AND user_id=?', m.id, p.emoji, me.id);
      pushMessage(ch, m.id);
    });
    const setPin = (uid: string, mid: string, pinned: boolean) => {
      const { m, ch, perms } = ownMessage(uid, mid);
      if (ch.server_id && !(perms & P.MANAGE_MESSAGES)) fail('You do not have permission to do that', 403);
      if (m.type) fail('This message cannot be pinned');
      if (!!m.pinned === pinned) return;
      if (pinned && this.one('SELECT COUNT(*) AS c FROM messages WHERE channel_id=? AND pinned=1', ch.id)!.c >= 50)
        fail('This channel has reached the pin limit');
      this.run('UPDATE messages SET pinned=? WHERE id=?', pinned ? 1 : 0, m.id);
      pushMessage(ch, m.id);
      if (pinned) this.createMessage(ch.id, uid, { type: 2, replyTo: m.id });
    };
    this.on('PUT', '/api/messages/:id/pin', ({ me, p }) => setPin(me.id, p.id, true));
    this.on('DELETE', '/api/messages/:id/pin', ({ me, p }) => setPin(me.id, p.id, false));
    this.on('GET', '/api/channels/:id/pins', ({ me, p }) => {
      const { ch } = this.access(me.id, p.id);
      const rows = this.all('SELECT * FROM messages WHERE channel_id=? AND pinned=1 ORDER BY id DESC LIMIT 50', ch.id);
      return { messages: this.hydrate(rows), users: this.users(rows.map((r) => r.author_id)) };
    });
    this.on('POST', '/api/channels/:id/ack', ({ me, p, body }) => {
      const { ch } = this.access(me.id, p.id);
      const last = String(body.messageId || ch.last_message_id || '0');
      this.run(
        'INSERT INTO read_states(user_id, channel_id, last_read_id, mentions) VALUES(?,?,?,0) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id=excluded.last_read_id, mentions=0',
        me.id,
        ch.id,
        last
      );
      this.send([me.id], { op: 'READ_STATE', channelId: ch.id, lastReadId: last, mentions: 0 });
    });
    this.on('GET', '/api/search', ({ me, q }) => {
      // Supports from:username, has:link|image|file|video|poll, before:YYYY-MM-DD, after:YYYY-MM-DD, pinned:true.
      let text = (q.get('q') || '').trim();
      const filters: string[] = [];
      const args: any[] = [];
      text = text.replace(/\b(from|has|before|after|pinned):(\S+)/gi, (_all, k: string, v: string) => {
        k = k.toLowerCase();
        if (k === 'from') {
          const u = this.one('SELECT id FROM users WHERE username=?', v.replace(/^@/, '').toLowerCase());
          filters.push('author_id=?');
          args.push(u?.id || '-');
        } else if (k === 'has') {
          const h = v.toLowerCase();
          if (h === 'link') filters.push("content LIKE '%http%'");
          else if (h === 'image') filters.push("attachments LIKE '%\"type\":\"image/%'");
          else if (h === 'video') filters.push("attachments LIKE '%\"type\":\"video/%'");
          else if (h === 'file') filters.push("attachments <> '[]'");
          else if (h === 'poll') filters.push('poll IS NOT NULL');
        } else if (k === 'before' || k === 'after') {
          const t = Date.parse(v);
          if (!isNaN(t)) {
            filters.push(k === 'before' ? 'created_at<?' : 'created_at>?');
            args.push(t);
          }
        } else if (k === 'pinned') filters.push('pinned=1');
        return '';
      }).trim();
      if (text.length < 2 && !filters.length) fail('Type at least 2 characters');
      if (text) {
        filters.push("content LIKE ? ESCAPE '\\'");
        args.push('%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
      }
      const where = filters.join(' AND ');
      let rows: any[];
      if (q.get('channelId')) {
        const { ch } = this.access(me.id, q.get('channelId')!);
        rows = this.all(`SELECT * FROM messages WHERE channel_id=? AND type=0 AND ${where} ORDER BY id DESC LIMIT 50`, ch.id, ...args);
      } else if (q.get('serverId')) {
        const sid = q.get('serverId')!;
        if (!this.perms(sid, me.id)) fail('Not found', 404);
        const visible = this.channelsOf(sid, me.id).map((c: any) => c.id);
        rows = this.all(
          `SELECT * FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE server_id=?) AND type=0 AND ${where} ORDER BY id DESC LIMIT 200`,
          sid,
          ...args
        )
          .filter((r) => visible.includes(r.channel_id))
          .slice(0, 50);
      } else {
        rows = this.all(
          `SELECT * FROM messages WHERE channel_id IN (SELECT channel_id FROM dm_members WHERE user_id=?) AND type=0 AND ${where} ORDER BY id DESC LIMIT 50`,
          me.id,
          ...args
        );
      }
      return { messages: this.hydrate(rows), users: this.users(rows.map((r) => r.author_id)) };
    });
    // ----- files -----
    this.on('POST', '/api/files', async ({ me, q, req }) => {
      const declared = Number(req.headers.get('content-length') || 0);
      if (declared > MAX_FILE_SIZE) fail('File is too large', 413);
      const buf = new Uint8Array(await req.arrayBuffer());
      if (!buf.length) fail('File is empty');
      if (buf.length > MAX_FILE_SIZE) fail('File is too large', 413);
      const id = randHex(16);
      const name = (q.get('name') || 'file').replace(/[\\/\x00-\x1f"]/g, '_').slice(0, 200) || 'file';
      const type = (req.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
      this.run(
        'INSERT INTO files(id, name, type, size, width, height, uploader_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        name,
        type,
        buf.length,
        Number(q.get('w')) || null,
        Number(q.get('h')) || null,
        me.id,
        Date.now()
      );
      for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++)
        this.run('INSERT INTO file_chunks(file_id, idx, data) VALUES(?,?,?)', id, n, buf.slice(i, i + CHUNK).buffer);
      return { id, name, type, size: buf.length, url: `/api/files/${id}` };
    });
    const serveFile: Handler = ({ p }) => {
      const f = this.one('SELECT * FROM files WHERE id=?', p.id);
      if (!f) return json({ error: 'Not found' }, 404);
      const out = new Uint8Array(f.size);
      let off = 0;
      for (const c of this.sql.exec('SELECT data FROM file_chunks WHERE file_id=? ORDER BY idx', f.id)) {
        out.set(new Uint8Array(c.data as ArrayBuffer), off);
        off += (c.data as ArrayBuffer).byteLength;
      }
      // Only known-safe media types are rendered inline; everything else downloads.
      const inline = INLINE_TYPES.test(f.type);
      return new Response(out, {
        headers: {
          'content-type': inline ? f.type : 'application/octet-stream',
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    };
    this.on('GET', '/api/files/:id', serveFile, true);
    this.on('GET', '/api/files/:id/:name', serveFile, true);

    // ----- voice -----
    this.on('DELETE', '/api/servers/:id/voice/:uid', ({ me, p }) => {
      if (p.uid !== me.id) {
        this.need(p.id, me.id, P.MOVE_MEMBERS);
        if (!this.outranks(p.id, me.id, p.uid)) fail('You cannot do that to someone with an equal or higher role', 403);
      }
      this.dropVoice((a) => a.uid === p.uid && !!this.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', a.v!.c, p.id));
    });

    // ----- link previews -----
    this.on('GET', '/api/embed', async ({ q }) => {
      const raw = q.get('url') || '';
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return fail('Invalid link');
      }
      if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) fail('Invalid link');
      const key = url.href.slice(0, 2000);
      const cached = this.one('SELECT data, fetched_at FROM embeds WHERE url=?', key);
      if (cached && Date.now() - cached.fetched_at < (cached.data ? 86400000 : 3600000)) return { embed: JSON.parse(cached.data || 'null') };
      const embed = await fetchEmbed(url).catch(() => null);
      this.run('INSERT OR REPLACE INTO embeds(url, data, fetched_at) VALUES(?,?,?)', key, embed ? JSON.stringify(embed) : null, Date.now());
      return { embed };
    });

    this.on('GET', '/api/ice', async () => {
      // Self-hosters can point at their own STUN/TURN (e.g. coturn) with a JSON list.
      if (this.env.ICE_SERVERS) {
        try {
          return { iceServers: JSON.parse(this.env.ICE_SERVERS) };
        } catch {}
      }
      // Without a TURN key of our own, use the public Open Relay servers so calls still connect behind strict NATs.
      const fallback = {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
          {
            urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'],
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      };
      if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) return fallback;
      try {
        const r = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ttl: 86400 }),
          }
        );
        if (!r.ok) return fallback;
        return await r.json();
      } catch {
        return fallback;
      }
    });
  }

  setOverwrite(cid: string, target: string, type: number, allow: number, deny: number) {
    this.run(
      'INSERT OR REPLACE INTO channel_overwrites(channel_id, target_id, type, allow, deny) VALUES(?,?,?,?,?)',
      cid,
      target,
      type,
      allow,
      deny
    );
  }
  makePoll(b: any) {
    const question = str(b.question, 300);
    const answers = (Array.isArray(b.answers) ? b.answers : [])
      .map((a: any, i: number) => ({ id: i + 1, text: str(typeof a === 'string' ? a : a?.text, 55), emoji: str(a?.emoji, 64) || null }))
      .filter((a: any) => a.text)
      .slice(0, 10);
    if (!question || answers.length < 2) fail('A poll needs a question and at least two answers');
    const hours = Math.max(1, Math.min(24 * 14, Number(b.hours) || 24));
    return { question, answers, multi: !!b.multi, expiresAt: Date.now() + hours * 3600000 };
  }
  findSticker(uid: string, id: string) {
    const st = this.one('SELECT * FROM stickers WHERE id=?', id);
    if (!st || !this.perms(st.server_id, uid)) return fail('Unknown sticker');
    return { id: st.id, name: st.name };
  }
  checkAutomod(sid: string, uid: string, content: string) {
    const rules = JSON.parse(this.one('SELECT automod FROM servers WHERE id=?', sid)?.automod || '{}');
    if (!content || !rules.enabled) return;
    const roles = this.memberRoleIds(sid, uid);
    if ((rules.exemptRoles || []).some((r: string) => roles.includes(r))) return;
    const lower = content.toLowerCase();
    const hit =
      (rules.words || []).some((w: string) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '\\S*')}($|[^\\p{L}\\p{N}])`, 'u').test(lower)) ||
      (rules.blockLinks && /https?:\/\//i.test(content)) ||
      (rules.blockInvites && /(discord\.gg|discord\.com\/invite|\/invite\/)/i.test(content)) ||
      (rules.maxMentions && (content.match(/<@!?&?\d+>/g) || []).length > rules.maxMentions);
    if (hit) {
      this.audit(sid, uid, 'automod_block', uid, { content: content.slice(0, 200) });
      fail('Your message was blocked by this server\'s AutoMod', 403);
    }
  }

  channelName(v: any, type: number) {
    let name = str(v, 100);
    if (type === CH.TEXT || type === CH.ANNOUNCEMENT || type === CH.FORUM) name = name.toLowerCase().replace(/\s+/g, '-');
    return name || fail('Name is required');
  }

  leaveGroup(ch: any, uid: string) {
    this.dropVoice((a) => a.uid === uid && a.v!.c === ch.id);
    this.run('DELETE FROM dm_members WHERE channel_id=? AND user_id=?', ch.id, uid);
    this.run('DELETE FROM read_states WHERE channel_id=? AND user_id=?', ch.id, uid);
    this.send([uid], { op: 'DM_DELETE', id: ch.id });
    const rest = this.all('SELECT user_id FROM dm_members WHERE channel_id=? ORDER BY rowid', ch.id);
    if (!rest.length) return this.deleteChannelData(ch.id);
    if (ch.owner_id === uid) this.run('UPDATE channels SET owner_id=? WHERE id=?', rest[0].user_id, ch.id);
    this.pushDm(ch.id);
  }
}
