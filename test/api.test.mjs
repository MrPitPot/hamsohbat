// End-to-end API test. Run `npm run dev` first, then `npm test`.
// Usage: node test/api.test.mjs [baseUrl]
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
let passed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) passed++;
  else {
    failures.push(name);
    console.log('  FAIL: ' + name);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.frames = [];
  }
  async api(method, path, body, raw) {
    const headers = {};
    if (this.token) headers.authorization = 'Bearer ' + this.token;
    if (body && !raw) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = raw;
    const res = await fetch(BASE + path, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  async register() {
    const r = await this.api('POST', '/api/auth/register', { username: this.name, password: 'secret123', displayName: this.name.toUpperCase() });
    if (r.data.token) this.token = r.data.token;
    return r;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=' + this.token);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) return void this.frames.push(new Uint8Array(e.data));
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
      this.ws.onerror = reject;
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  /** Waits for an event matching the predicate (also looks at already received ones). */
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

const section = (s) => console.log('• ' + s);

const a = new Client('alice_' + run);
const b = new Client('bob_' + run);
const c = new Client('carol_' + run);

section('auth');
ok((await a.register()).status === 200, 'register alice');
await b.register();
await c.register();
ok((await a.register()).status === 409, 'duplicate username rejected');
ok((await new Client('x').api('POST', '/api/auth/register', { username: 'a b', password: 'secret123' })).status === 400, 'bad username rejected');
ok((await new Client('x').api('POST', '/api/auth/register', { username: 'short_' + run, password: '123' })).status === 400, 'short password rejected');
ok((await new Client('x').api('POST', '/api/auth/login', { username: a.name, password: 'nope' })).status === 401, 'wrong password rejected');
const login = await new Client('x').api('POST', '/api/auth/login', { username: a.name.toUpperCase(), password: 'secret123' });
ok(login.status === 200 && login.data.token, 'login (case-insensitive username)');
ok((await new Client('x').api('GET', '/api/ice')).status === 401, 'unauthenticated request rejected');

section('gateway');
await a.connect();
await b.connect();
await c.connect();
ok(a.ready.me.username === a.name && a.ready.servers.length === 0, 'READY payload');
ok(!!(await a.wait('PRESENCE', (e) => e.userId === b.id && e.status === 'online')), 'presence broadcast on connect');
const badWs = await new Promise((res) => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=bad');
  ws.onclose = (e) => res(e.code);
});
ok(badWs === 4001, 'bad token closes socket with 4001');

section('friends');
ok((await a.api('POST', '/api/friends', { username: 'nobody_' + run })).status === 404, 'unknown user');
ok((await a.api('POST', '/api/friends', { username: a.name })).status === 400, 'cannot add self');
ok((await a.api('POST', '/api/friends', { username: b.name })).status === 200, 'send request');
ok((await b.wait('RELATIONSHIP', (e) => e.id === a.id))?.type === 3, 'bob sees incoming request');
ok((await a.wait('RELATIONSHIP', (e) => e.id === b.id))?.type === 4, 'alice sees outgoing request');
ok((await a.api('POST', '/api/friends', { username: b.name })).status === 400, 'duplicate request rejected');
ok((await b.api('PUT', '/api/friends/' + a.id)).status === 200, 'accept');
ok((await a.wait('RELATIONSHIP', (e) => e.id === b.id))?.type === 1, 'alice sees friendship');
// mutual add = accept
await c.api('POST', '/api/friends', { username: a.name });
await a.api('POST', '/api/friends', { username: c.name });
ok((await c.wait('RELATIONSHIP', (e) => e.id === a.id && e.type === 1)) !== null, 'adding someone who added you accepts');
// remove + block
await a.api('DELETE', '/api/friends/' + c.id);
ok((await c.wait('RELATIONSHIP', (e) => e.id === a.id && e.type === 0)) !== null, 'remove friend notifies both');
await c.api('PUT', '/api/blocks/' + a.id);
ok((await a.api('POST', '/api/friends', { username: c.name })).status === 403, 'blocked user cannot send request');
await c.api('DELETE', '/api/blocks/' + a.id);
await a.api('POST', '/api/friends', { username: c.name });
await c.api('PUT', '/api/friends/' + a.id);

section('direct messages');
const dm = await a.api('POST', '/api/dms', { recipients: [b.id] });
ok(dm.status === 200 && dm.data.type === 1 && dm.data.recipients.length === 2, 'create DM');
ok((await a.api('POST', '/api/dms', { recipients: [b.id] })).data.id === dm.data.id, 'DM is reused');
ok(!(await b.wait('DM_UPDATE', () => true, 300)), 'recipient does not see an empty DM');
const m1 = await a.api('POST', `/api/channels/${dm.data.id}/messages`, { content: 'hello bob', nonce: 'n1' });
ok(m1.status === 200 && m1.data.content === 'hello bob', 'send DM message');
ok(!!(await b.wait('DM_UPDATE', (e) => e.channel.id === dm.data.id)), 'DM opens for recipient on first message');
ok((await b.wait('MESSAGE_CREATE', (e) => e.message.id === m1.data.id))?.message.authorId === a.id, 'recipient receives message');
ok((await a.wait('MESSAGE_CREATE', (e) => e.nonce === 'n1')) !== null, 'sender gets echo with nonce');
ok((await c.api('GET', `/api/channels/${dm.data.id}/messages`)).status === 404, 'outsider cannot read DM');
ok((await c.api('POST', `/api/channels/${dm.data.id}/messages`, { content: 'x' })).status === 404, 'outsider cannot write DM');
ok((await a.api('POST', `/api/channels/${dm.data.id}/messages`, { content: '   ' })).status === 400, 'empty message rejected');
ok((await a.api('POST', `/api/channels/${dm.data.id}/messages`, { content: 'x'.repeat(4001) })).status === 400, 'too long message rejected');
// unread state persisted
const b2 = new Client(b.name);
b2.token = b.token;
await b2.connect();
ok(b2.ready.readStates.find((r) => r.channelId === dm.data.id)?.mentions === 1, 'DM counts as a mention for the recipient');
await b.api('POST', `/api/channels/${dm.data.id}/ack`, { messageId: m1.data.id });
ok((await b2.wait('READ_STATE', (e) => e.channelId === dm.data.id))?.mentions === 0, 'ack syncs to other sessions');
b2.ws.close();
await sleep(100);
ok(!(await a.wait('PRESENCE', (e) => e.userId === b.id && e.status === 'offline', 300)), 'user stays online while another session is open');
// typing
a.send({ op: 'typing', channelId: dm.data.id });
ok(!!(await b.wait('TYPING', (e) => e.userId === a.id)), 'typing indicator relayed');
// edit / delete
const ed = await a.api('PATCH', '/api/messages/' + m1.data.id, { content: 'hello bob (edited)' });
ok(ed.data.editedAt && (await b.wait('MESSAGE_UPDATE', (e) => e.message.content.includes('edited'))), 'edit message');
ok((await b.api('PATCH', '/api/messages/' + m1.data.id, { content: 'hax' })).status === 403, "cannot edit someone else's message");
ok((await b.api('DELETE', '/api/messages/' + m1.data.id)).status === 403, "cannot delete someone else's DM message");
// reply + reactions + pin
const m2 = await b.api('POST', `/api/channels/${dm.data.id}/messages`, { content: 'hi alice', replyTo: m1.data.id });
ok(m2.data.reply?.id === m1.data.id && m2.data.mentions.includes(a.id), 'reply references and mentions the author');
await a.api('PUT', `/api/messages/${m2.data.id}/reactions/${encodeURIComponent('👍')}`);
await b.api('PUT', `/api/messages/${m2.data.id}/reactions/${encodeURIComponent('👍')}`);
const afterReact = (await a.api('GET', `/api/channels/${dm.data.id}/messages`)).data.messages.find((m) => m.id === m2.data.id);
ok(afterReact.reactions[0].emoji === '👍' && afterReact.reactions[0].users.length === 2, 'reactions aggregate');
await a.api('DELETE', `/api/messages/${m2.data.id}/reactions/${encodeURIComponent('👍')}`);
ok((await a.api('GET', `/api/channels/${dm.data.id}/messages`)).data.messages.find((m) => m.id === m2.data.id).reactions[0].users.length === 1, 'remove reaction');
ok((await a.api('PUT', `/api/messages/${m2.data.id}/pin`)).status === 200, 'pin in DM');
const pins = await b.api('GET', `/api/channels/${dm.data.id}/pins`);
ok(pins.data.messages.length === 1 && pins.data.messages[0].id === m2.data.id, 'list pins');
ok(!!(await b.wait('MESSAGE_CREATE', (e) => e.message.type === 2)), 'pin system message');
await a.api('DELETE', `/api/messages/${m2.data.id}/pin`);
ok((await b.api('GET', `/api/channels/${dm.data.id}/pins`)).data.messages.length === 0, 'unpin');
// search
const s1 = await a.api('GET', `/api/search?channelId=${dm.data.id}&q=${encodeURIComponent('hi ali')}`);
ok(s1.data.messages.length === 1 && s1.data.messages[0].id === m2.data.id, 'search in channel');
ok((await a.api('GET', `/api/search?q=${encodeURIComponent('100%')}`)).data.messages.length === 0, 'search escapes wildcards');
// block prevents DM
await b.api('PUT', '/api/blocks/' + a.id);
ok((await a.api('POST', `/api/channels/${dm.data.id}/messages`, { content: 'still there?' })).status === 403, 'blocked user cannot DM');
await b.api('DELETE', '/api/blocks/' + a.id);
await a.api('POST', '/api/friends', { username: b.name });
await b.api('PUT', '/api/friends/' + a.id);
// close DM
await a.api('DELETE', '/api/channels/' + dm.data.id);
ok(!!(await a.wait('DM_DELETE', (e) => e.id === dm.data.id)), 'close DM');

section('group DM');
const g = await a.api('POST', '/api/dms', { recipients: [b.id, c.id], name: 'the gang' });
ok(g.status === 200 && g.data.type === 3 && g.data.recipients.length === 3, 'create group');
ok(!!(await c.wait('DM_UPDATE', (e) => e.channel.id === g.data.id)), 'group members notified');
await a.api('PATCH', '/api/channels/' + g.data.id, { name: 'renamed' });
ok((await b.wait('DM_UPDATE', (e) => e.channel.name === 'renamed')) !== null, 'rename group');
ok((await b.api('DELETE', `/api/channels/${g.data.id}/recipients/${c.id}`)).status === 403, 'only owner can remove from group');
await a.api('DELETE', '/api/channels/' + g.data.id);
ok((await b.wait('DM_UPDATE', (e) => e.channel.id === g.data.id && e.channel.ownerId === b.id)) !== null, 'ownership passes on when the owner leaves');
ok((await a.api('GET', `/api/channels/${g.data.id}/messages`)).status === 404, 'left group is inaccessible');

section('servers');
a.clear();
const srv = await a.api('POST', '/api/servers', { name: 'Test Server' });
ok(srv.status === 200, 'create server');
const sc = await a.wait('SERVER_CREATE');
const S = sc.server;
ok(S.channels.length === 4 && S.roles.length === 1 && S.members.length === 1 && S.ownerId === a.id, 'server has default channels and @everyone role');
const text = S.channels.find((x) => x.type === 0);
const voice = S.channels.find((x) => x.type === 2);
ok((await b.api('GET', `/api/channels/${text.id}/messages`)).status === 404, 'non-member cannot read channel');
ok((await b.api('POST', `/api/servers/${S.id}/invites`, {})).status === 404, 'non-member cannot create invite');
const inv = await a.api('POST', `/api/servers/${S.id}/invites`, { maxUses: 2 });
ok(inv.status === 200 && inv.data.code.length === 8, 'create invite');
const prev = await b.api('GET', '/api/invites/' + inv.data.code);
ok(prev.data.server.name === 'Test Server' && prev.data.server.memberCount === 1 && !prev.data.joined, 'invite preview');
ok((await b.api('POST', '/api/invites/' + inv.data.code)).data.id === S.id, 'join via invite');
ok((await b.wait('SERVER_CREATE', (e) => e.server.id === S.id))?.server.members.length === 2, 'joiner receives the server');
ok((await a.wait('MEMBER_ADD', (e) => e.member.userId === b.id))?.user.username === b.name, 'members notified of join');
ok((await a.wait('MESSAGE_CREATE', (e) => e.message.type === 1 && e.message.authorId === b.id)) !== null, 'join system message');
await b.api('POST', '/api/invites/' + inv.data.code);
await c.api('POST', '/api/invites/' + inv.data.code);
ok((await new Client('x').api('GET', '/api/invites/' + inv.data.code)).status === 401, 'invite needs auth');
const d = new Client('dave_' + run);
await d.register();
await d.connect();
ok((await d.api('POST', '/api/invites/' + inv.data.code)).status === 404, 'invite max uses enforced (rejoin does not consume)');
ok((await a.api('GET', `/api/servers/${S.id}/invites`)).data[0].uses === 2, 'invite use count');

section('server messages & mentions');
b.clear();
c.clear();
const sm = await a.api('POST', `/api/channels/${text.id}/messages`, { content: `hey <@${b.id}> look` });
ok(sm.data.mentions.includes(b.id), 'mention parsed');
ok((await c.wait('MESSAGE_CREATE', (e) => e.message.id === sm.data.id))?.serverId === S.id, 'server message broadcast');
const b3 = new Client(b.name);
b3.token = b.token;
await b3.connect();
ok(b3.ready.readStates.find((r) => r.channelId === text.id)?.mentions === 1, 'mention count for mentioned user');
const c3 = new Client(c.name);
c3.token = c.token;
await c3.connect();
ok(!c3.ready.readStates.find((r) => r.channelId === text.id)?.mentions, 'no mention count for others');
ok(c3.ready.servers[0].channels.find((x) => x.id === text.id).lastMessageId === sm.data.id, 'lastMessageId tracked');
b3.ws.close();
c3.ws.close();
const ev = await b.api('POST', `/api/channels/${text.id}/messages`, { content: '@everyone party' });
ok(ev.data.mentionEveryone === false, '@everyone ignored without permission');
const ev2 = await a.api('POST', `/api/channels/${text.id}/messages`, { content: '@everyone party' });
ok(ev2.data.mentionEveryone === true, '@everyone works for the owner');
// pagination
for (let i = 0; i < 60; i++) await a.api('POST', `/api/channels/${text.id}/messages`, { content: 'bulk ' + i });
const page1 = (await a.api('GET', `/api/channels/${text.id}/messages`)).data.messages;
const page2 = (await a.api('GET', `/api/channels/${text.id}/messages?before=${page1[0].id}`)).data.messages;
ok(page1.length === 50 && page1[49].content === 'bulk 59' && page2.length > 10 && page2[page2.length - 1].id < page1[0].id, 'pagination (before)');
const around = (await a.api('GET', `/api/channels/${text.id}/messages?around=${page1[0].id}&limit=10`)).data.messages;
ok(around.length === 10 && around[4].id === page1[0].id, 'pagination (around)');
const after = (await a.api('GET', `/api/channels/${text.id}/messages?after=${page1[47].id}`)).data.messages;
ok(after.length === 2 && after[1].content === 'bulk 59', 'pagination (after)');
ok((await a.api('GET', `/api/search?serverId=${S.id}&q=bulk%205`)).data.messages.length === 11, 'search in server');
ok((await d.api('GET', `/api/search?serverId=${S.id}&q=bulk`)).status === 404, 'search requires membership');

section('permissions & roles');
ok((await b.api('POST', `/api/servers/${S.id}/channels`, { name: 'nope', type: 0 })).status === 403, 'member cannot create channel');
ok((await b.api('PATCH', `/api/servers/${S.id}`, { name: 'hax' })).status === 403, 'member cannot rename server');
ok((await b.api('DELETE', `/api/servers/${S.id}`)).status === 403, 'member cannot delete server');
ok((await b.api('DELETE', '/api/messages/' + sm.data.id)).status === 403, 'member cannot delete others messages');
ok((await b.api('PUT', `/api/messages/${sm.data.id}/pin`)).status === 403, 'member cannot pin');
ok((await b.api('DELETE', `/api/servers/${S.id}/members/${c.id}`)).status === 403, 'member cannot kick');
const role = await a.api('POST', `/api/servers/${S.id}/roles`, { name: 'Mod', color: '#ff0000' });
const role2 = await a.api('POST', `/api/servers/${S.id}/roles`, { name: 'Helper' });
await a.api('PUT', `/api/servers/${S.id}/roles/order`, { ids: [role.data.id, role2.data.id] });
ok((await b.wait('ROLES', (e) => e.roles.length === 3 && e.roles[0].id === role.data.id && e.roles[0].position === 2)) !== null, 'create and order roles');
// Mod: manage messages + kick + manage roles + manage channels
await a.api('PATCH', '/api/roles/' + role.data.id, { permissions: 64 | 16 | 8 | 4, hoist: true });
await a.api('PATCH', `/api/servers/${S.id}/members/${b.id}`, { roles: [role.data.id] });
ok((await c.wait('MEMBER_UPDATE', (e) => e.member.userId === b.id))?.member.roles[0] === role.data.id, 'assign role');
ok((await b.api('PUT', `/api/messages/${sm.data.id}/pin`)).status === 200, 'mod can pin');
ok((await b.api('POST', `/api/servers/${S.id}/channels`, { name: 'Mod Chat', type: 0 })).status === 200, 'mod can create channel');
ok((await b.wait('CHANNELS', (e) => e.channels.some((x) => x.name === 'mod-chat'))) !== null, 'text channel name normalised');
ok((await b.api('PATCH', '/api/roles/' + role.data.id, { name: 'x' })).status === 403, 'cannot edit own highest role');
ok((await b.api('PATCH', '/api/roles/' + role2.data.id, { permissions: 1 })).status === 403, 'cannot grant a permission you lack (admin)');
ok((await b.api('PATCH', '/api/roles/' + role2.data.id, { permissions: 64 })).status === 200, 'can grant a permission you have');
ok((await b.api('PATCH', `/api/servers/${S.id}/members/${c.id}`, { roles: [role.data.id] })).status === 403, 'cannot assign a role equal to your own');
ok((await b.api('PATCH', `/api/servers/${S.id}/members/${c.id}`, { roles: [role2.data.id] })).status === 200, 'can assign a lower role');
ok((await b.api('PUT', `/api/servers/${S.id}/roles/order`, { ids: [role2.data.id, role.data.id] })).status === 403, 'cannot reorder above yourself');
ok((await b.api('DELETE', `/api/servers/${S.id}/members/${a.id}`)).status === 403, 'cannot kick the owner');
ok((await c.api('DELETE', `/api/servers/${S.id}/members/${b.id}`)).status === 403, 'lower role cannot kick');
ok((await b.api('PUT', `/api/servers/${S.id}/bans/${c.id}`, {})).status === 403, 'kick permission does not allow banning');
ok((await b.api('PATCH', `/api/servers/${S.id}/members/@me`, { nickname: 'Bobby' })).status === 200, 'change own nickname');
ok((await c.api('PATCH', `/api/servers/${S.id}/members/${b.id}`, { nickname: 'x' })).status === 403, 'cannot change others nickname');
ok((await b.api('PATCH', `/api/servers/${S.id}`, { ownerId: b.id })).status === 403, 'only owner transfers ownership');
// channel management
const chans = (await b.wait('CHANNELS', () => true, 200)) || {};
const newCh = await a.api('POST', `/api/servers/${S.id}/channels`, { name: 'temp', type: 0 });
await a.api('PATCH', '/api/channels/' + newCh.data.id, { name: 'Renamed Chan', topic: 'a topic' });
ok((await c.wait('CHANNELS', (e) => e.channels.some((x) => x.name === 'renamed-chan' && x.topic === 'a topic'))) !== null, 'edit channel');
await a.api('PUT', `/api/servers/${S.id}/channels/order`, { items: [{ id: newCh.data.id, position: 0, parentId: text.parentId }] });
ok((await c.wait('CHANNELS', (e) => e.channels.find((x) => x.id === newCh.data.id)?.parentId === text.parentId)) !== null, 'move channel');
await a.api('POST', `/api/channels/${newCh.data.id}/messages`, { content: 'doomed' });
await a.api('DELETE', '/api/channels/' + newCh.data.id);
ok((await a.api('GET', `/api/channels/${newCh.data.id}/messages`)).status === 404, 'delete channel');
ok((await a.api('POST', `/api/servers/${S.id}/channels`, { name: '', type: 0 })).status === 400, 'channel needs a name');

section('files');
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
const up = await a.api('POST', '/api/files?name=dot.png&w=1&h=1', png, 'image/png');
ok(up.status === 200 && up.data.size === png.length, 'upload file');
const dl = await fetch(BASE + up.data.url);
ok(dl.headers.get('content-type') === 'image/png' && new Uint8Array(await dl.arrayBuffer()).length === png.length, 'download file');
const html = await a.api('POST', '/api/files?name=evil.html', '<script>alert(1)</script>', 'text/html');
const dlHtml = await fetch(BASE + html.data.url);
ok(dlHtml.headers.get('content-type') === 'application/octet-stream' && dlHtml.headers.get('content-disposition').startsWith('attachment'), 'html is never served inline');
const big = new Uint8Array(3 * 1024 * 1024 + 123);
for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
const upBig = await a.api('POST', '/api/files?name=big.bin', big, 'application/octet-stream');
const dlBig = new Uint8Array(await (await fetch(BASE + upBig.data.url)).arrayBuffer());
ok(dlBig.length === big.length && dlBig[4096 * 700] === big[4096 * 700], 'multi-chunk file round-trips');
ok((await b.api('POST', `/api/channels/${text.id}/messages`, { attachments: [up.data.id] })).status === 400, "cannot attach someone else's upload");
const withFile = await a.api('POST', `/api/channels/${text.id}/messages`, { attachments: [up.data.id, upBig.data.id] });
ok(withFile.data.attachments.length === 2 && withFile.data.attachments[0].width === 1, 'message with attachments');
ok((await a.api('POST', `/api/channels/${text.id}/messages`, { attachments: [up.data.id] })).status === 400, 'attachment cannot be reused');
await a.api('PATCH', '/api/users/me', { avatar: html.data.url }).then((r) => ok(r.status === 400, 'avatar must be an image'));
const av = await a.api('POST', '/api/files?name=av.png', png, 'image/png');
const prof = await a.api('PATCH', '/api/users/me', { avatar: av.data.url, bio: 'hi', customStatus: 'coding', displayName: 'Alice A' });
ok(prof.data.avatar === av.data.url && prof.data.bio === 'hi', 'update profile');
ok((await b.wait('USER_UPDATE', (e) => e.user.id === a.id && e.user.displayName === 'Alice A')) !== null, 'profile update broadcast');
await b.api('DELETE', '/api/messages/' + withFile.data.id);
ok((await fetch(BASE + upBig.data.url + '?nocache=1')).status === 404, 'deleting a message deletes its files (mod delete)');

section('presence');
a.clear();
await b.api('PATCH', '/api/users/me', { status: 'dnd' });
ok((await a.wait('PRESENCE', (e) => e.userId === b.id))?.status === 'dnd', 'status change broadcast');
await b.api('PATCH', '/api/users/me', { status: 'invisible' });
ok((await a.wait('PRESENCE', (e) => e.userId === b.id))?.status === 'offline', 'invisible shows as offline');
await b.api('PATCH', '/api/users/me', { status: 'online' });
ok((await a.api('PATCH', '/api/users/me', { status: 'bogus' })).status === 400, 'invalid status rejected');

section('voice');
a.clear();
b.clear();
c.clear();
a.send({ op: 'voice_join', channelId: voice.id });
const vr = await a.wait('VOICE_READY');
ok(vr?.states.length === 1 && vr.states[0].userId === a.id, 'join voice');
ok((await b.wait('VOICE_STATE', (e) => e.state.userId === a.id))?.state.channelId === voice.id, 'voice state broadcast');
b.send({ op: 'voice_join', channelId: voice.id });
ok((await b.wait('VOICE_READY'))?.states.length === 2, 'second user sees first in VOICE_READY');
b.send({ op: 'signal', to: a.sid, data: { sdp: 'offer' } });
const sig = await a.wait('SIGNAL');
ok(sig?.from === b.sid && sig.userId === b.id && sig.data.sdp === 'offer', 'signalling relayed');
// Binary relay frame: [kind][sidLen][target sid][payload] → peer gets [kind][sidLen][sender sid][payload].
const relayFrame = (from, to, payload) => {
  const t = new TextEncoder().encode(to);
  const f = new Uint8Array(2 + t.length + payload.length);
  f[0] = 1;
  f[1] = t.length;
  f.set(t, 2);
  f.set(payload, 2 + t.length);
  from.ws.send(f);
};
relayFrame(b, a.sid, new Uint8Array([7, 8, 9, 10]));
let got = null;
for (let i = 0; i < 30 && !got; i++, await sleep(100)) got = a.frames[0];
const gotSid = got && new TextDecoder().decode(got.subarray(2, 2 + got[1]));
ok(got?.[0] === 1 && gotSid === b.sid && got.subarray(2 + got[1]).join() === '7,8,9,10', 'binary media relayed through the server');
relayFrame(c, a.sid, new Uint8Array([1, 2, 3, 4]));
await sleep(300);
ok(a.frames.length === 1, 'binary relay refused from outside the call');
c.send({ op: 'signal', to: a.sid, data: { sdp: 'evil' } });
ok(!(await a.wait('SIGNAL', () => true, 300)), 'signalling refused from outside the call');
b.send({ op: 'voice_state', mute: true, deaf: false, video: true, screen: 'stream-1' });
const vs = await a.wait('VOICE_STATE', (e) => e.state.userId === b.id && e.state.mute);
ok(vs?.state.video === true && vs.state.screen === 'stream-1', 'mute / video / screen state');
d.send({ op: 'voice_join', channelId: voice.id });
ok(!(await d.wait('VOICE_READY', () => true, 300)), 'non-member cannot join voice');
// same user joins from a second session → first one is kicked
const b4 = new Client(b.name);
b4.token = b.token;
await b4.connect();
ok(b4.ready.voiceStates.length === 2, 'READY includes voice states');
b4.send({ op: 'voice_join', channelId: voice.id });
ok(!!(await b.wait('VOICE_KICK')), 'joining elsewhere disconnects the old session');
await b4.wait('VOICE_READY');
a.clear();
b4.ws.close();
ok((await a.wait('VOICE_STATE', (e) => e.state.userId === b.id))?.state.channelId === null, 'disconnect leaves voice');
a.send({ op: 'voice_leave' });
ok((await c.wait('VOICE_STATE', (e) => e.state.userId === a.id && e.state.channelId === null)) !== null, 'leave voice');
// DM call rings a closed DM
const dm2 = await c.api('POST', '/api/dms', { recipients: [d.id] });
c.send({ op: 'voice_join', channelId: dm2.data.id });
ok(!!(await d.wait('DM_UPDATE', (e) => e.channel.id === dm2.data.id)), 'call opens the DM for the callee');
ok(!!(await d.wait('VOICE_STATE', (e) => e.state.channelId === dm2.data.id)), 'callee sees the call');
c.send({ op: 'voice_leave' });

section('kick / ban / leave / delete');
c.send({ op: 'voice_join', channelId: voice.id });
await c.wait('VOICE_READY');
c.clear();
ok((await b.api('DELETE', `/api/servers/${S.id}/voice/${c.id}`)).status === 403, 'disconnecting from voice needs a permission');
ok((await a.api('DELETE', `/api/servers/${S.id}/voice/${c.id}`)).status === 200, 'owner disconnects a member from voice');
ok(!!(await c.wait('VOICE_KICK')), 'disconnected member is told to leave');
ok((await a.wait('VOICE_STATE', (e) => e.state.userId === c.id && e.state.channelId === null)) !== null, 'everyone sees the disconnect');
c.send({ op: 'voice_join', channelId: voice.id });
await c.wait('VOICE_READY');
c.clear();
ok((await b.api('DELETE', `/api/servers/${S.id}/members/${c.id}`)).status === 200, 'mod can kick lower member');
ok(!!(await c.wait('SERVER_DELETE', (e) => e.id === S.id)), 'kicked user loses the server');
ok(!!(await c.wait('VOICE_KICK')), 'kicked user is removed from voice');
ok((await a.wait('MEMBER_REMOVE', (e) => e.userId === c.id)) !== null, 'members notified of kick');
ok((await c.api('GET', `/api/channels/${text.id}/messages`)).status === 404, 'kicked user loses access');
const inv2 = await a.api('POST', `/api/servers/${S.id}/invites`, {});
await c.api('POST', '/api/invites/' + inv2.data.code);
ok((await a.api('PUT', `/api/servers/${S.id}/bans/${c.id}`, { reason: 'test' })).status === 200, 'ban');
ok((await c.api('POST', '/api/invites/' + inv2.data.code)).status === 403, 'banned user cannot rejoin');
ok((await a.api('GET', `/api/servers/${S.id}/bans`)).data[0].user.id === c.id, 'list bans');
await a.api('DELETE', `/api/servers/${S.id}/bans/${c.id}`);
ok((await c.api('POST', '/api/invites/' + inv2.data.code)).status === 200, 'unbanned user can rejoin');
ok((await a.api('DELETE', `/api/servers/${S.id}/members/@me`)).status === 400, 'owner cannot leave');
ok((await c.api('DELETE', `/api/servers/${S.id}/members/@me`)).status === 200, 'member can leave');
await a.api('DELETE', '/api/roles/' + role.data.id);
ok((await b.wait('MEMBERS', (e) => e.members.find((m) => m.userId === b.id).roles.length === 0)) !== null, 'deleting a role removes it from members');
ok((await a.api('DELETE', '/api/roles/' + S.id)).status === 400, '@everyone cannot be deleted');
ok((await a.api('PATCH', `/api/servers/${S.id}`, { ownerId: b.id })).status === 200, 'transfer ownership');
ok((await a.api('DELETE', `/api/servers/${S.id}`)).status === 403, 'old owner cannot delete');
ok((await b.api('DELETE', `/api/servers/${S.id}`)).status === 200, 'new owner deletes server');
ok(!!(await a.wait('SERVER_DELETE', (e) => e.id === S.id)), 'members notified of deletion');
ok((await a.api('GET', '/api/invites/' + inv2.data.code)).status === 404, 'invites die with the server');

section('account');
ok((await a.api('POST', '/api/users/me/password', { oldPassword: 'bad', newPassword: 'newsecret1' })).status === 403, 'password change needs the old password');
ok((await a.api('POST', '/api/users/me/password', { oldPassword: 'secret123', newPassword: 'newsecret1' })).status === 200, 'change password');
ok((await new Client('x').api('POST', '/api/auth/login', { username: a.name, password: 'newsecret1' })).status === 200, 'login with new password');
const tmp = new Client('x');
tmp.token = login.data.token;
ok((await tmp.api('GET', '/api/ice')).status === 401, 'other sessions are signed out after a password change');
ok((await a.api('GET', '/api/ice')).data.iceServers.length > 0, 'ice servers');
for (const bad of ['http://127.0.0.1:8787/', 'http://localhost/', 'http://192.168.1.1/', 'ftp://example.com/', 'http://[::1]/', 'nonsense'])
  ok((await a.api('GET', '/api/embed?url=' + encodeURIComponent(bad))).status === 400, 'link preview refuses ' + bad);
const emb = await a.api('GET', '/api/embed?url=' + encodeURIComponent('https://example.com/'));
ok(emb.status === 200, 'link preview endpoint answers');
console.log('  (example.com preview: ' + JSON.stringify(emb.data?.embed) + ')');
await a.api('POST', '/api/auth/logout');
ok((await a.api('GET', '/api/ice')).status === 401, 'logout invalidates the token');
a.clear();
b.ws.close();
ok((await c.wait('PRESENCE', (e) => e.userId === b.id && e.status === 'offline')) !== null, 'offline presence on disconnect');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
