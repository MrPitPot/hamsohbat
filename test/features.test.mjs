// Tests the Discord-style features: private channels, threads, forums, polls, events, expressions, soundboard,
// audit log, mentions inbox, forwarding, notes, webhooks, AutoMod, slowmode, timeouts, 2FA, voice moderation,
// stage channels, presence, search filters, account changes and template import.
// Run `npm run dev` first, then: node test/features.test.mjs [baseUrl]
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else {
    failures.push(name);
    console.log('  FAIL: ' + name);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (s) => console.log('• ' + s);

class Client {
  constructor(name) {
    this.name = name + '_' + run;
    this.events = [];
  }
  async api(method, path, body, raw) {
    const headers = {};
    if (this.token) headers.authorization = 'Bearer ' + this.token;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = raw;
    const res = await fetch(BASE + path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  async register() {
    const r = await this.api('POST', '/api/auth/register', { username: this.name, password: 'secret123', displayName: this.name });
    this.token = r.data.token;
    return this;
  }
  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=' + this.token);
      this.ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        const ev = JSON.parse(e.data);
        this.events.push(ev);
        if (ev.op === 'READY') {
          this.ready = ev;
          this.id = ev.me.id;
          this.sid = ev.sid;
          resolve(ev);
        }
      };
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  async wait(op, pred = () => true, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.events.findIndex((e) => e.op === op && pred(e));
      if (i >= 0) return this.events.splice(i, 1)[0];
      await sleep(20);
    }
    return null;
  }
  clear() {
    this.events.length = 0;
  }
}
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const wav = new Uint8Array(44 + 800);
const totp = (secret, t = Math.floor(Date.now() / 30000)) => {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const c of secret) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits - 8)) & 255), (bits -= 8);
  }
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(t / 2 ** 32), 0);
  msg.writeUInt32BE(t >>> 0, 4);
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
};

const owner = await new Client('own').register();
const mod = await new Client('mod').register();
const user = await new Client('usr').register();
const out = await new Client('out').register();
for (const c of [owner, mod, user, out]) await c.connect();
await owner.api('POST', '/api/servers', { name: 'Features' });
const S = (await owner.wait('SERVER_CREATE')).server;
const general = S.channels.find((c) => c.type === 0);
const voice = S.channels.find((c) => c.type === 2);
ok(S.roles[0].permissions & 65536, '@everyone can view channels by default');
const inv = (await owner.api('POST', `/api/servers/${S.id}/invites`, {})).data.code;
for (const c of [mod, user]) await c.api('POST', '/api/invites/' + inv);
const modRole = (await owner.api('POST', `/api/servers/${S.id}/roles`, { name: 'Mod' })).data.id;
const MODP = 64 | 4 | 8 | 131072 | 262144 | 32768 | 1048576 | 2097152 | 4194304 | 67108864 | 268435456 | 524288;
await owner.api('PATCH', '/api/roles/' + modRole, { permissions: MODP });
await owner.api('PATCH', `/api/servers/${S.id}/members/${mod.id}`, { roles: [modRole] });

section('private channels and permission overrides');
const priv = (await owner.api('POST', `/api/servers/${S.id}/channels`, { name: 'staff', type: 0, private: true, roles: [modRole] })).data.id;
await sleep(200);
const chansFor = async (c) => (await c.wait('CHANNELS', (e) => e.serverId === S.id, 1500))?.channels || null;
ok((await user.api('GET', `/api/channels/${priv}/messages`)).status === 404, 'a private channel is hidden from regular members');
ok((await mod.api('GET', `/api/channels/${priv}/messages`)).status === 200, 'the allowed role can read it');
const uc = await chansFor(user);
ok(uc && !uc.some((c) => c.id === priv), 'the channel list sent to regular members leaves it out');
user.clear();
await owner.api('POST', `/api/channels/${priv}/messages`, { content: 'staff only' });
ok(!(await user.wait('MESSAGE_CREATE', (e) => e.message.channelId === priv, 600)), 'messages in it are not delivered to others');
await owner.api('PATCH', '/api/channels/' + general.id, { overwrites: [{ id: S.id, type: 0, allow: 0, deny: 256 }] });
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'x' })).status === 403, 'denying Send Messages on a channel works');
ok((await mod.api('POST', `/api/channels/${general.id}/messages`, { content: 'mods can still talk' })).status === 403, 'role without an allow is also denied');
await owner.api('PATCH', '/api/channels/' + general.id, { overwrites: [{ id: S.id, type: 0, allow: 0, deny: 256 }, { id: modRole, type: 0, allow: 256, deny: 0 }] });
ok((await mod.api('POST', `/api/channels/${general.id}/messages`, { content: 'now I can' })).status === 200, 'a role allow beats the @everyone deny');
await owner.api('PATCH', '/api/channels/' + general.id, { overwrites: [] });
ok((await user.api('PATCH', '/api/channels/' + general.id, { overwrites: [] })).status === 403, 'only managers can edit overrides');

section('slowmode and AutoMod');
await owner.api('PATCH', '/api/channels/' + general.id, { rateLimit: 30 });
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'one' })).status === 200, 'first message passes slowmode');
const slow = await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'two' });
ok(slow.status === 429 && slow.data.wait > 0, 'second message is held back by slowmode');
ok((await mod.api('POST', `/api/channels/${general.id}/messages`, { content: 'mods skip slowmode' })).status === 200, 'moderators are exempt from slowmode');
await owner.api('PATCH', '/api/channels/' + general.id, { rateLimit: 0 });
await owner.api('PATCH', `/api/servers/${S.id}/automod`, { enabled: true, words: ['badword', 'spam*'], blockInvites: true });
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'this has a BadWord in it' })).status === 403, 'AutoMod blocks a listed word');
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'spammy stuff' })).status === 403, 'AutoMod wildcards work');
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'join discord.gg/abc' })).status === 403, 'AutoMod blocks invite links');
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'a perfectly fine message' })).status === 200, 'clean messages go through');
await owner.api('PATCH', `/api/servers/${S.id}/automod`, { enabled: false });

section('threads and forums');
const starter = (await user.api('POST', `/api/channels/${general.id}/messages`, { content: 'let us discuss' })).data;
const th = await user.api('POST', `/api/channels/${general.id}/threads`, { name: 'Discussion', messageId: starter.id });
ok(th.status === 200, 'start a thread from a message');
const thread = th.data.id;
ok((await owner.api('POST', `/api/channels/${thread}/messages`, { content: 'reply in thread' })).status === 200, 'send in a thread');
const after = (await user.api('GET', `/api/channels/${general.id}/messages`)).data.messages.find((m) => m.id === starter.id);
ok(after.thread?.id === thread && after.thread.messageCount === 1, 'the starter message shows the thread and its size');
ok((await user.api('POST', `/api/channels/${general.id}/threads`, { name: 'again', messageId: starter.id })).status === 400, 'one thread per message');
await user.api('PATCH', '/api/channels/' + thread, { archived: true });
const list = (await owner.api('GET', `/api/channels/${general.id}/threads`)).data.threads;
ok(list.find((t) => t.id === thread)?.archived === true, 'thread owner archives it');
await owner.api('POST', `/api/channels/${thread}/messages`, { content: 'wake up' });
ok((await owner.api('GET', `/api/channels/${general.id}/threads`)).data.threads.find((t) => t.id === thread).archived === false, 'a new message un-archives a thread');
ok((await out.api('GET', `/api/channels/${thread}/messages`)).status === 404, 'outsiders cannot read threads');
const forum = (await owner.api('POST', `/api/servers/${S.id}/channels`, { name: 'Help Forum', type: 15 })).data.id;
ok((await user.api('POST', `/api/channels/${forum}/messages`, { content: 'x' })).status === 400, 'forums only accept posts');
const post = await user.api('POST', `/api/channels/${forum}/threads`, { name: 'How do I?', content: 'question body' });
ok(post.status === 200, 'create a forum post');
const posts = (await mod.api('GET', `/api/channels/${forum}/threads`)).data.threads;
ok(posts[0]?.firstMessage?.content === 'question body', 'forum lists posts with their first message');
ok((await mod.api('DELETE', '/api/channels/' + post.data.id)).status === 200, 'moderators can delete threads');

section('polls');
const poll = (await user.api('POST', `/api/channels/${general.id}/messages`, { poll: { question: 'Pizza?', answers: ['Yes', 'No', 'Maybe'], hours: 1 } })).data;
ok(poll.poll?.answers.length === 3, 'create a poll');
await owner.api('PUT', `/api/messages/${poll.id}/poll/1`);
await mod.api('PUT', `/api/messages/${poll.id}/poll/1`);
await mod.api('PUT', `/api/messages/${poll.id}/poll/2`);
let pv = (await user.api('GET', `/api/channels/${general.id}/messages`)).data.messages.find((m) => m.id === poll.id).poll.votes;
ok(pv[1]?.length === 1 && pv[2]?.length === 1, 'single-choice polls keep one vote per person');
await user.api('POST', `/api/messages/${poll.id}/poll/end`);
ok((await owner.api('PUT', `/api/messages/${poll.id}/poll/3`)).status === 400, 'ended polls refuse votes');
ok((await user.api('POST', `/api/channels/${general.id}/messages`, { poll: { question: 'x', answers: ['only one'] } })).status === 400, 'a poll needs two answers');

section('events');
const ev = await mod.api('POST', `/api/servers/${S.id}/events`, { name: 'Game night', startAt: Date.now() + 3600000, channelId: voice.id, description: 'bring snacks' });
ok(ev.status === 200, 'moderator schedules an event');
ok(!!(await user.wait('SERVER_DATA', (e) => e.events?.some((x) => x.name === 'Game night'))), 'members are told about the event');
await user.api('PUT', `/api/events/${ev.data.id}/interest`);
ok((await user.wait('SERVER_DATA', (e) => e.events?.find((x) => x.id === ev.data.id)?.interested.includes(user.id))) !== null, 'mark as interested');
ok((await user.api('POST', `/api/servers/${S.id}/events`, { name: 'x', startAt: Date.now() })).status === 403, 'members cannot create events');
await mod.api('PATCH', `/api/events/${ev.data.id}`, { status: 2 });
ok((await user.wait('SERVER_DATA', (e) => e.events?.find((x) => x.id === ev.data.id)?.status === 2)) !== null, 'start the event');

section('emoji, stickers and soundboard');
const img = (await mod.api('POST', '/api/files?name=e.png', png, 'image/png')).data;
const emo = await mod.api('POST', `/api/servers/${S.id}/emojis`, { name: 'party_parrot', fileId: img.id });
ok(emo.status === 200 && emo.data.id === img.id, 'upload a custom emoji');
ok((await user.wait('SERVER_DATA', (e) => e.emojis?.some((x) => x.name === 'party_parrot'))) !== null, 'members get the new emoji');
ok((await user.api('PUT', `/api/messages/${starter.id}/reactions/${encodeURIComponent('party_parrot:' + img.id)}`)).status === 200, 'react with a custom emoji');
const img2 = (await mod.api('POST', '/api/files?name=s.png', png, 'image/png')).data;
const sticker = (await mod.api('POST', `/api/servers/${S.id}/stickers`, { name: 'wave', fileId: img2.id })).data;
const sm = await user.api('POST', `/api/channels/${general.id}/messages`, { sticker: sticker.id });
ok(sm.status === 200 && sm.data.sticker?.name === 'wave', 'send a sticker');
ok((await user.api('POST', `/api/servers/${S.id}/emojis`, { name: 'nope', fileId: img.id })).status === 403, 'members cannot upload emoji');
const snd = (await mod.api('POST', '/api/files?name=s.wav', wav, 'audio/wav')).data;
const sound = await mod.api('POST', `/api/servers/${S.id}/sounds`, { name: 'ding', emoji: '🔔', fileId: snd.id, volume: 0.5 });
ok(sound.status === 200, 'add a soundboard sound');
user.send({ op: 'voice_join', channelId: voice.id });
await user.wait('VOICE_READY');
mod.send({ op: 'voice_join', channelId: voice.id });
await mod.wait('VOICE_READY');
mod.clear();
user.send({ op: 'soundboard', sound: sound.data.id });
const sb = await mod.wait('SOUNDBOARD');
ok(sb?.sound.name === 'ding' && sb.userId === user.id, 'soundboard sounds play for everyone in the channel');
user.send({ op: 'soundboard', sound: 'builtin:airhorn' });
ok(!(await mod.wait('SOUNDBOARD', () => true, 600)), 'soundboard spam is limited');

section('voice moderation');
owner.clear();
ok((await mod.api('PATCH', `/api/servers/${S.id}/voice/${user.id}`, { mute: true })).status === 200, 'moderator server-mutes a member');
ok((await owner.wait('VOICE_STATE', (e) => e.state.userId === user.id && e.state.serverMute)) !== null, 'everyone sees the server mute');
user.send({ op: 'voice_leave' });
await sleep(150);
user.send({ op: 'voice_join', channelId: voice.id });
ok((await user.wait('VOICE_READY'))?.states.find((s) => s.userId === user.id)?.serverMute === true, 'server mute sticks after rejoining');
await mod.api('PATCH', `/api/servers/${S.id}/voice/${user.id}`, { mute: false });
const voice2 = (await owner.api('POST', `/api/servers/${S.id}/channels`, { name: 'Room 2', type: 2 })).data.id;
await sleep(150);
user.clear();
await mod.api('PATCH', `/api/servers/${S.id}/voice/${user.id}`, { channelId: voice2 });
ok((await user.wait('VOICE_MOVE'))?.channelId === voice2, 'moderator moves a member to another voice channel');
ok((await user.api('PATCH', `/api/servers/${S.id}/voice/${mod.id}`, { mute: true })).status === 403, 'members cannot server-mute');
await owner.api('PATCH', '/api/channels/' + voice2, { userLimit: 1 });
user.send({ op: 'voice_join', channelId: voice2 });
await user.wait('VOICE_READY');
out.api('POST', '/api/invites/' + inv);
const u3 = await new Client('u3').register();
await u3.connect();
await u3.api('POST', '/api/invites/' + inv);
await sleep(200);
u3.send({ op: 'voice_join', channelId: voice2 });
ok((await u3.wait('VOICE_KICK'))?.reason === 'This voice channel is full', 'voice channel user limit');
const stage = (await owner.api('POST', `/api/servers/${S.id}/channels`, { name: 'Town Hall', type: 13 })).data.id;
await sleep(150);
u3.clear();
u3.send({ op: 'voice_join', channelId: stage });
ok((await u3.wait('VOICE_READY'))?.states.find((s) => s.userId === u3.id)?.suppress === true, 'stage audience joins suppressed');
mod.send({ op: 'voice_join', channelId: stage });
ok((await mod.wait('VOICE_READY'))?.states.find((s) => s.userId === mod.id)?.suppress === false, 'stage moderators join as speakers');
u3.send({ op: 'stage_hand', raise: true });
ok((await mod.wait('VOICE_STATE', (e) => e.state.userId === u3.id && e.state.hand > 0)) !== null, 'audience raises a hand');
await mod.api('PATCH', `/api/servers/${S.id}/voice/${u3.id}`, { suppress: false });
ok((await u3.wait('VOICE_STATE', (e) => e.state.userId === u3.id && !e.state.suppress)) !== null, 'moderator invites them to speak');
ok((await u3.api('PATCH', `/api/servers/${S.id}/voice/@me`, { suppress: true })).status === 200, 'speakers can step down themselves');

section('timeouts');
ok((await mod.api('PATCH', `/api/servers/${S.id}/members/${u3.id}`, { timeout: 60, reason: 'cool down' })).status === 200, 'time out a member');
ok((await u3.api('POST', `/api/channels/${general.id}/messages`, { content: 'hi' })).status === 403, 'timed-out members cannot talk');
ok(!!(await u3.wait('VOICE_KICK')), 'timed-out members leave voice');
await mod.api('PATCH', `/api/servers/${S.id}/members/${u3.id}`, { timeout: 0 });
ok((await u3.api('POST', `/api/channels/${general.id}/messages`, { content: 'back' })).status === 200, 'removing the timeout restores them');

section('audit log');
const log = await mod.api('GET', `/api/servers/${S.id}/audit-log`);
const actions = log.data.entries.map((e) => e.action);
ok(log.status === 200 && ['member_timeout', 'voice_move', 'voice_mute', 'emoji_create', 'event_create', 'channel_create', 'role_create', 'automod_block'].every((a) => actions.includes(a)), 'audit log records moderation actions');
ok((await user.api('GET', `/api/servers/${S.id}/audit-log`)).status === 403, 'audit log needs permission');

section('mentions, forwarding, notes, search');
await owner.api('POST', `/api/channels/${general.id}/messages`, { content: `hey <@${user.id}> check this` });
await owner.api('POST', `/api/channels/${general.id}/messages`, { content: `<@&${modRole}> mods please look` });
const inbox = (await user.api('GET', '/api/mentions')).data.messages;
ok(inbox[0]?.content.includes('check this'), 'mentions inbox lists recent mentions');
ok((await mod.api('GET', '/api/mentions')).data.messages.some((m) => m.content.includes('mods please')), 'role mentions reach the role members');
const dm = (await user.api('POST', '/api/dms', { recipients: [owner.id] })).data;
const fwd = await user.api('POST', `/api/messages/${starter.id}/forward`, { channelId: dm.id, comment: 'look' });
ok(fwd.status === 200 && fwd.data.forwarded?.content === 'let us discuss', 'forward a message into a DM');
ok((await out.api('POST', `/api/messages/${starter.id}/forward`, { channelId: dm.id })).status === 404, 'cannot forward what you cannot see');
await user.api('PUT', `/api/users/${owner.id}/note`, { note: 'server owner, likes pizza' });
ok((await user.wait('NOTE'))?.note === 'server owner, likes pizza', 'save a private note about someone');
const reconnect = new Client('x');
reconnect.token = user.token;
await reconnect.connect();
ok(reconnect.ready.notes[owner.id] === 'server owner, likes pizza', 'notes come back on login');
reconnect.ws.close();
ok((await mod.api('GET', `/api/search?serverId=${S.id}&q=${encodeURIComponent('from:' + owner.name + ' check')}`)).data.messages.length === 1, 'search from: filter');
ok((await owner.api('GET', `/api/search?serverId=${S.id}&q=${encodeURIComponent('has:poll')}`)).data.messages.length === 1, 'search has:poll filter');
ok((await user.api('GET', `/api/search?serverId=${S.id}&q=${encodeURIComponent('staff only')}`)).data.messages.length === 0, 'search never reveals hidden channels');

section('webhooks');
const hook = await mod.api('POST', `/api/channels/${general.id}/webhooks`, { name: 'GitHub' });
ok(hook.status === 200 && hook.data.token, 'create a webhook');
user.clear();
const ex = await fetch(BASE + hook.data.url + '?wait=true', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: 'build passed', username: 'CI Bot', embeds: [{ title: 'Build #42', description: 'all green', color: 3066993, fields: [{ name: 'time', value: '2m' }] }] }),
});
const exd = await ex.json();
ok(ex.status === 200 && exd.webhook?.name === 'CI Bot' && exd.embeds[0]?.title === 'Build #42', 'Discord-compatible webhook execute with embeds');
ok(!!(await user.wait('MESSAGE_CREATE', (e) => e.message.webhook?.name === 'CI Bot')), 'webhook messages are delivered live');
ok((await fetch(BASE + `/api/webhooks/${hook.data.id}/wrongtoken`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' })).status === 404, 'wrong webhook token is refused');
ok((await user.api('GET', `/api/servers/${S.id}/webhooks`)).status === 403, 'listing webhooks needs permission');

section('presence: idle and activities');
const watcher = owner;
watcher.clear();
user.send({ op: 'idle', idle: true });
ok((await watcher.wait('PRESENCE', (e) => e.userId === user.id))?.status === 'idle', 'inactive users show as idle');
user.send({ op: 'idle', idle: false });
ok((await watcher.wait('PRESENCE', (e) => e.userId === user.id))?.status === 'online', 'and online again when back');
user.send({ op: 'activity', activity: { name: 'Minecraft', type: 0 } });
ok((await watcher.wait('PRESENCE', (e) => e.userId === user.id && e.activity))?.activity.name === 'Minecraft', 'game activity is shared');

section('two-factor authentication and account');
ok((await user.api('POST', '/api/users/me/2fa/setup', { password: 'wrong' })).status === 403, '2FA setup needs the password');
const setup = (await user.api('POST', '/api/users/me/2fa/setup', { password: 'secret123' })).data;
ok(setup.uri.startsWith('otpauth://totp/'), '2FA setup gives an authenticator link');
ok((await user.api('POST', '/api/users/me/2fa/enable', { code: '000000' })).status === 400, 'wrong code does not enable 2FA');
ok((await user.api('POST', '/api/users/me/2fa/enable', { code: totp(setup.secret) })).status === 200, 'enable 2FA');
const l1 = await new Client('x').api('POST', '/api/auth/login', { username: user.name, password: 'secret123' });
ok(l1.status === 401 && l1.data.mfa === true, 'login now asks for the code');
ok((await new Client('x').api('POST', '/api/auth/login', { username: user.name, password: 'secret123', code: totp(setup.secret) })).status === 200, 'login with the code');
await user.api('POST', '/api/users/me/2fa/disable', { code: totp(setup.secret) });
ok((await new Client('x').api('POST', '/api/auth/login', { username: user.name, password: 'secret123' })).status === 200, 'disable 2FA');
const newName = 'renamed_' + run;
ok((await user.api('PATCH', '/api/users/me', { username: newName, password: 'secret123', pronouns: 'they/them' })).data.username === newName, 'change username and pronouns');
ok((await owner.api('POST', '/api/users/me/delete', { password: 'secret123' })).status === 400, 'owners must hand over servers before deleting their account');
const del = await new Client('del').register();
await del.connect();
await del.api('POST', '/api/invites/' + inv);
ok((await del.api('POST', '/api/users/me/delete', { password: 'secret123' })).status === 200, 'delete account');
ok((await new Client('x').api('POST', '/api/auth/login', { username: del.name, password: 'secret123' })).status === 401, 'deleted accounts cannot log in');
ok((await owner.api('GET', `/api/servers/${S.id}/audit-log`)).status === 200 && !(await owner.wait('MEMBER_REMOVE', (e) => e.userId === del.id, 1500)) === false, 'deleted users leave their servers');

section('import from a Discord template');
const template = {
  name: 'Gaming',
  source_guild_id: '1',
  serialized_source_guild: {
    name: 'Gaming Hub',
    roles: [
      { id: 0, name: '@everyone', permissions: String((1n << 10n) | (1n << 11n) | (1n << 20n) | (1n << 21n)), color: 0, hoist: false },
      { id: 1, name: 'Admin', permissions: '8', color: 15158332, hoist: true },
      { id: 2, name: 'VIP', permissions: String(1n << 15n), color: 3447003, hoist: false },
    ],
    channels: [
      { id: 10, type: 4, name: 'Text', position: 0, parent_id: null, permission_overwrites: [] },
      { id: 11, type: 0, name: 'General Chat', position: 0, parent_id: 10, topic: 'hello', permission_overwrites: [] },
      { id: 12, type: 0, name: 'vip lounge', position: 1, parent_id: 10, permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: String(1n << 10n) }, { id: 2, type: 0, allow: String(1n << 10n), deny: '0' }] },
      { id: 13, type: 2, name: 'Voice', position: 2, parent_id: null, bitrate: 96000, user_limit: 5, permission_overwrites: [] },
      { id: 14, type: 15, name: 'Help', position: 3, parent_id: null, permission_overwrites: [] },
      { id: 15, type: 13, name: 'Stage', position: 4, parent_id: null, permission_overwrites: [] },
    ],
  },
};
const imp = await owner.api('POST', '/api/servers/import/template', { template });
ok(imp.status === 200, 'import a Discord template');
const IS = (await owner.wait('SERVER_CREATE', (e) => e.server.id === imp.data.id)).server;
ok(IS.name === 'Gaming Hub' && IS.roles.some((r) => r.name === 'Admin' && r.permissions & 1 && r.hoist), 'roles with permissions are imported');
ok(IS.channels.some((c) => c.name === 'general-chat' && c.topic === 'hello' && c.parentId), 'channels land in their categories');
ok(IS.channels.find((c) => c.name === 'voice')?.userLimit === 5 || IS.channels.find((c) => c.type === 2)?.userLimit === 5, 'voice settings are imported');
ok(IS.channels.some((c) => c.type === 15) && IS.channels.some((c) => c.type === 13), 'forum and stage channels are imported');
ok(IS.channels.find((c) => c.name === 'vip-lounge')?.overwrites.length === 2, 'private channel overrides are imported');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
