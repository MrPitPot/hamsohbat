// Tests the experimental store: coins, daily reward, test coin packs, buying, equipping, gifts, Plus and the upload limit.
// Run `npm run dev` first, then: node test/store.test.mjs [baseUrl]
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
const section = (s) => console.log('• ' + s);

class Client {
  constructor(name) {
    this.name = name + '_' + run;
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
    this.id = (await this.api('PATCH', '/api/users/me', {})).data?.id;
    return this;
  }
}

const a = await new Client('shopper').register();
const b = await new Client('friend').register();

section('balance and catalog');
let s = (await a.api('GET', '/api/store')).data;
ok(s.coins === 1000, 'new users start with 1000 welcome coins');
ok(s.items.length >= 15 && s.items.some((i) => i.kind === 'plus'), 'catalog has items and the Plus subscription');
ok(s.packs.length === 3, 'three test coin packs');
ok(s.owned.length === 0 && s.uploadLimit === 25 * 1024 * 1024, 'nothing owned, 25 MB uploads');
ok((await new Client('anon').api('GET', '/api/store')).status === 401, 'store needs login');

section('daily reward');
s = (await a.api('POST', '/api/store/daily')).data;
ok(s.coins === 1100, 'daily reward adds 100 coins');
ok((await a.api('POST', '/api/store/daily')).status === 400, 'daily reward only once per day');

section('buying');
let r = await a.api('POST', '/api/store/items/color_saffron/buy');
ok(r.status === 200 && r.data.coins === 800 && r.data.owned.includes('color_saffron'), 'buy a name colour');
ok(r.data.equipped.color === 'color_saffron', 'new cosmetic is worn right away');
ok((await a.api('POST', '/api/store/items/color_saffron/buy')).status === 400, 'cannot buy twice');
ok((await a.api('POST', '/api/store/items/nope/buy')).status === 404, 'unknown item');
ok((await a.api('POST', '/api/store/items/frame_rainbow/buy')).status === 400, 'Plus-only item needs Plus');
ok((await a.api('POST', '/api/store/items/boost_upload/buy')).status === 400, 'not enough coins');
const pub = (await a.api('PATCH', '/api/users/me', {})).data;
ok(pub.cosmetics?.color === 'color_saffron' && pub.cosmetics.plus === false, 'public profile carries the worn colour');

section('test coin packs');
s = (await a.api('POST', '/api/store/packs/pack_l/buy')).data;
ok(s.coins === 3800, 'test pack adds coins without payment');
ok(s.log[0].reason === 'pack:pack_l' && s.log[0].amount === 3000, 'coin history records it');

section('equip');
r = await a.api('POST', '/api/store/items/color_turquoise/buy');
ok(r.data.equipped.color === 'color_saffron', 'second colour does not replace the worn one');
r = await a.api('PUT', '/api/store/equip', { kind: 'color', itemId: 'color_turquoise' });
ok(r.status === 200 && r.data.equipped.color === 'color_turquoise', 'equip another owned colour');
ok((await a.api('PUT', '/api/store/equip', { kind: 'frame', itemId: 'frame_gold' })).status === 404, 'cannot equip what you do not own');
ok((await a.api('PUT', '/api/store/equip', { kind: 'frame', itemId: 'color_saffron' })).status === 404, 'item must match the slot');
r = await a.api('PUT', '/api/store/equip', { kind: 'color', itemId: null });
ok(r.status === 200 && !r.data.equipped.color, 'unequip');

section('upload boost');
r = await a.api('POST', '/api/store/items/boost_upload/buy');
ok(r.status === 200 && r.data.uploadLimit === 50 * 1024 * 1024, 'boost raises upload limit to 50 MB');
const big = new Uint8Array(26 * 1024 * 1024);
ok((await a.api('POST', '/api/files?name=big.bin', big, 'application/octet-stream')).status === 200, 'boosted user can upload 26 MB');
// (Rejecting a 26 MB body early makes the local dev proxy drop the connection, so check the limit itself.)
ok((await b.api('GET', '/api/store')).data.uploadLimit === 25 * 1024 * 1024, 'normal user still limited to 25 MB');

section('Plus');
await a.api('POST', '/api/store/packs/pack_l/buy');
r = await a.api('POST', '/api/store/items/plus_month/buy');
ok(r.status === 200 && r.data.plusUntil > Date.now() + 29 * 864e5 && r.data.equipped.plus, 'Plus is active for 30 days');
const coins = r.data.coins;
r = await a.api('POST', '/api/store/items/frame_neon/buy');
ok(r.data.coins === coins - 480, 'Plus gives 20% off');
r = await a.api('POST', '/api/store/items/frame_rainbow/buy');
ok(r.status === 200, 'Plus members can buy Plus-only items');

section('gifts');
ok((await a.api('POST', '/api/store/items/color_aurora/gift', { userId: b.id })).status === 403, 'gifts only to friends');
await a.api('POST', '/api/friends', { username: b.name });
await b.api('PUT', '/api/friends/' + a.id);
r = await a.api('POST', '/api/store/items/effect_snow/gift', { userId: b.id });
ok(r.status === 200, 'gift an effect to a friend' + (r.status === 200 ? '' : ` (${r.status} ${r.data?.error})`));
const bs = (await b.api('GET', '/api/store')).data;
ok(bs.owned.includes('effect_snow') && bs.coins === 1000, 'friend owns the gift and paid nothing');
ok((await a.api('POST', '/api/store/items/effect_snow/gift', { userId: b.id })).status === 400, 'cannot gift what they already own');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
