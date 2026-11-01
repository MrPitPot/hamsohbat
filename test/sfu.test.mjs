// Voice through the media server (LiveKit SFU): several real browsers join one server voice channel.
// Needs a LiveKit server and the Hub configured for it (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET,
// e.g. in .dev.vars). Skips itself when the Hub reports no media server.
// Run `npm run dev`, then `node test/sfu.test.mjs [baseUrl] [people]`. Uses the locally installed Chrome (or Edge).
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const N = Math.max(3, Number(process.argv[3]) || 3);
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
async function api(token, method, path, body, ip) {
  const r = await fetch(BASE + path, {
    method,
    // Registration is limited to 10 per hour and address; a different (local test) address per user avoids that.
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
let nextIp = 1;
const mkUser = async (name) => (await api(null, 'POST', '/api/auth/register', { username: name + '_' + run, password: 'voice-test-pw', displayName: name }, '10.9.' + Math.floor(nextIp / 250) + '.' + (nextIp++ % 250))).token;

const tokens = [];
for (let i = 0; i < N; i++) tokens.push(await mkUser('user' + i));
const { id: serverId } = await api(tokens[0], 'POST', '/api/servers', { name: 'SFU Test' });
const { code } = await api(tokens[0], 'POST', `/api/servers/${serverId}/invites`, {});
for (const t of tokens.slice(1)) await api(t, 'POST', '/api/invites/' + code);
const voiceId = (await api(tokens[0], 'POST', `/api/servers/${serverId}/channels`, { name: 'room', type: 2 })).id;

let browser;
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
for (const opt of [{ executablePath: '/opt/pw-browsers/chromium' }, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try {
    browser = await chromium.launch({ ...opt, headless: true, args });
    break;
  } catch {}
}
if (!browser) {
  console.log('No Edge or Chrome found; skipping.');
  process.exit(0);
}
async function open(token) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1000, height: 700 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem('token', t);
    if (!localStorage.getItem('settings')) localStorage.setItem('settings', JSON.stringify({ lang: 'en', noiseCancel: 'off' })); // no AI noise filter: 100 browsers on one test machine would not keep up
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const canvasStream = (color) => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d');
      let x = 0;
      setInterval(() => {
        g.fillStyle = color;
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.fillRect((x += 9) % 1280, 300, 120, 120);
      }, 50);
      return c.captureStream(30);
    };
    navigator.mediaDevices.getUserMedia = async (c) => (c.video && !c.audio ? canvasStream('#224466') : realGUM(c));
    navigator.mediaDevices.getDisplayMedia = async () => canvasStream('#664422');
  }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  await page.goto(BASE + '/channels/' + serverId + '/' + voiceId);
  await page.waitForSelector('.channel');
  return page;
}
const until = async (page, fn, arg, ms = 20000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
    return true;
  } catch {
    return false;
  }
};
const joinVoice = (page) => page.evaluate((id) => window.__voice.join(id), voiceId);

try {
  const cfg = await api(tokens[0], 'GET', '/api/config');
  const pages = [];
  for (const t of tokens) pages.push(await open(t));
  for (const p of pages) await joinVoice(p);
  console.log(`• ${N} people join through the media server`);
  const sfuOn = await until(pages[0], () => !!window.__voice.sfu, null, 15000);
  if (!sfuOn) {
    console.log('  The Hub has no media server configured (or it is unreachable); skipping.');
    process.exit(0);
  }
  ok(true, 'the Hub sends people to the media server');
  ok(await until(pages[0], (n) => window.__voice.peers.size === n - 1 && [...window.__voice.peers.values()].every((p) => p.sfu && p.streams.has('sfu-audio')), N, 60000), 'everyone hears everyone else (one audio track each)');
  ok(await pages[0].evaluate(() => [...window.__voice.peers.values()].every((p) => !p.pc)), 'no peer-to-peer connections are made');
  ok(await until(pages[N - 1], () => [...window.__voice.peers.values()].every((p) => [...p.audios.values()].some((el) => !el.paused && !el.muted))), 'remote audio is playing');
  ok(await until(pages[1], () => !!document.querySelector('.voice-users .avatar.speaking, .tile.speaking'), null, 10000), 'speaking indicator lights up');

  console.log('• camera and screen share');
  await pages[0].evaluate(() => window.__voice.setVideo(true));
  ok(await until(pages[1], (uid) => !!window.__voice.media(uid).camera, await ids(tokens[0]), 45000), "others see the first user's camera");
  await pages[0].evaluate(() => window.__voice.setScreen(true));
  ok(await until(pages[1], (uid) => !!window.__voice.media(uid).screen, await ids(tokens[0]), 45000), "others see the first user's screen");
  const maxFps = await pages[0].evaluate(() => window.__voice.screenStream.getVideoTracks()[0].getSettings().frameRate);
  ok(maxFps <= 30.5, 'screen share is capped at 30 FPS');
  await pages[0].evaluate(() => window.__voice.setScreen(false));
  ok(await until(pages[1], (uid) => !window.__voice.media(uid).screen, await ids(tokens[0]), 15000), 'screen share stops for others');

  console.log('• leaving');
  await pages[N - 1].evaluate(() => window.__voice.leave());
  ok(await until(pages[0], (n) => window.__voice.peers.size === n - 2, N, 15000), 'the others see them leave');
  ok(await pages[N - 1].evaluate(() => !window.__voice.sfu && window.__voice.peers.size === 0), 'the leaver is fully disconnected');
} catch (e) {
  ok(false, 'test crashed: ' + e.message);
}
async function ids(token) {
  return (await api(token, 'PATCH', '/api/users/me', {})).id;
}
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
