// Real WebRTC test: several browsers talk to each other through the app.
// Audio comes from the browser's fake microphone. Camera and screen capture are replaced by an animated
// canvas, because the browser's fake camera proved unreliable in headless mode.
// Run `npm run dev` first, then `npm run test:voice`. Uses the locally installed Chrome (or Edge).
import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};

async function api(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
const mkUser = async (name) => (await api(null, 'POST', '/api/auth/register', { username: name + '_' + run, password: 'voice-test-pw', displayName: name })).token;

const ta = await mkUser('anna');
const tb = await mkUser('ben');
const tc = await mkUser('cyrus');
const { id: serverId } = await api(ta, 'POST', '/api/servers', { name: 'Voice Test' });
const { code } = await api(ta, 'POST', `/api/servers/${serverId}/invites`, {});
await api(tb, 'POST', '/api/invites/' + code);
await api(tc, 'POST', '/api/invites/' + code);

let browser;
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true, args });
    break;
  } catch {}
}
if (!browser) {
  console.log('No Edge or Chrome found; skipping.');
  process.exit(0);
}

async function open(token) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem('token', t);
    if (!localStorage.getItem('settings')) localStorage.setItem('settings', JSON.stringify({ lang: 'en' }));
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const canvasStream = (color) => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d');
      let x = 0;
      setInterval(() => {
        g.fillStyle = color;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.fillRect((x += 7) % 640, 120, 80, 80);
      }, 50);
      return c.captureStream(20);
    };
    navigator.mediaDevices.getUserMedia = async (c) => (c.video && !c.audio ? canvasStream('#224466') : realGUM(c));
    navigator.mediaDevices.getDisplayMedia = async () => canvasStream('#664422');
  }, token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && console.log('  [CSP VIOLATION]', m.text()));
  await page.goto(BASE + '/channels/' + serverId);
  await page.waitForSelector('.channel');
  return page;
}
const joinVoice = (page) => page.locator('.channel', { has: page.locator('svg.lucide-volume-2') }).first().click();
/** Polls a predicate evaluated in the page. */
async function until(page, fn, arg, ms = 15000) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
    return true;
  } catch {
    return false;
  }
}
const bytesIn = (page, kind) =>
  page.evaluate(async (kind) => {
    let total = 0;
    for (const p of window.__voice.peers.values()) (await p.pc.getStats()).forEach((s) => s.type === 'inbound-rtp' && s.kind === kind && (total += s.bytesReceived));
    return total;
  }, kind);

try {
  const A = await open(ta);
  const B = await open(tb);

  console.log('• two people in a voice channel');
  await joinVoice(A);
  ok(await until(A, () => document.querySelector('.voice-status')?.textContent.includes('Voice Connected')), 'A joins voice');
  await joinVoice(B);
  ok(await until(B, () => document.querySelectorAll('.voice-stage .tile').length === 2), 'B sees both participants');
  ok(await until(A, () => document.querySelectorAll('.voice-stage .tile').length === 2), 'A sees B arrive');
  const connected = () => [...window.__voice.peers.values()].length > 0 && [...window.__voice.peers.values()].every((p) => ['connected', 'completed'].includes(p.pc.iceConnectionState));
  ok(await until(A, connected), 'A: peer connection established');
  ok(await A.evaluate(() => window.__voice.mic?.mode === 'ai'), 'the microphone goes through AI noise cancellation');
  ok(await until(B, connected), 'B: peer connection established');
  await A.waitForTimeout(1500);
  const a1 = await bytesIn(A, 'audio');
  const b1 = await bytesIn(B, 'audio');
  await A.waitForTimeout(1500);
  ok((await bytesIn(A, 'audio')) > a1 && a1 > 0, 'A receives audio from B');
  ok((await bytesIn(B, 'audio')) > b1 && b1 > 0, 'B receives audio from A');
  ok(await B.evaluate(() => [...window.__voice.peers.values()].every((p) => [...p.audios.values()].some((el) => !el.paused && !el.muted))), 'B is playing the remote audio');
  ok(await until(B, () => !!document.querySelector('.voice-users .avatar.speaking, .tile.speaking'), null, 8000), 'speaking indicator lights up');

  console.log('• mute / deafen');
  await A.locator('.voice-controls button[title="Mute"]').click();
  ok(await until(B, () => document.querySelectorAll('.voice-user .lucide-mic-off').length === 1), "B sees A's mute icon");
  ok(await A.evaluate(() => window.__voice.userStream.getAudioTracks()[0].enabled === false), "A's microphone track is disabled");
  await A.locator('.voice-controls button[title="Unmute"]').click();
  ok(await until(B, () => document.querySelectorAll('.voice-user .lucide-mic-off').length === 0), 'unmute propagates');
  await B.locator('.voice-controls button[title="Deafen"]').click();
  ok(await B.evaluate(() => [...window.__voice.peers.values()].every((p) => [...p.audios.values()].every((el) => el.muted))), 'deafen silences incoming audio');
  ok(await until(A, () => document.querySelectorAll('.voice-user .lucide-headphone-off').length === 1), 'A sees B deafened');
  await B.locator('.voice-controls button[title="Undeafen"]').click();

  console.log('• camera');
  await A.locator('.voice-controls button[title="Turn On Camera"]').click();
  const remoteVideo = () => [...document.querySelectorAll('.tile video')].some((v) => !v.classList.contains('mirror') && v.videoWidth > 0 && v.readyState >= 2);
  ok(await until(B, remoteVideo), "B sees A's camera");
  ok(await until(A, () => !!document.querySelector('.tile video.mirror')), 'A sees own mirrored preview');
  const v1 = await bytesIn(B, 'video');
  await B.waitForTimeout(1000);
  ok((await bytesIn(B, 'video')) > v1, 'video keeps flowing');
  // both sides turning cameras on at once exercises glare handling
  await Promise.all([B.locator('.voice-controls button[title="Turn On Camera"]').click(), A.locator('.voice-controls button[title="Turn Off Camera"]').click()]);
  ok(await until(A, remoteVideo), "A sees B's camera after simultaneous renegotiation");
  ok(await until(B, () => ![...document.querySelectorAll('.tile video')].some((v) => !v.classList.contains('mirror'))), "A's camera tile disappears for B");

  console.log('• screen share');
  await A.locator('.voice-controls button[title="Share Your Screen"]').click();
  {
    ok(await until(A, () => window.__voice.screenStream !== null, null, 5000), 'A starts sharing');
    ok(await until(B, () => document.querySelectorAll('.voice-stage .tile').length === 3), 'B gets a separate screen tile');
    ok(await until(B, () => [...document.querySelectorAll('.tile video')].filter((v) => !v.classList.contains('mirror') && v.videoWidth > 0).length >= 1), "B receives A's screen");
    ok(await until(B, () => !!document.querySelector('.voice-user .live')), 'LIVE badge shown');
    await A.locator('.voice-controls button[title="Stop Sharing"]').click();
    ok(await until(B, () => document.querySelectorAll('.voice-stage .tile').length === 2), 'screen tile disappears when sharing stops');
  }

  console.log('• third participant (mesh)');
  const C = await open(tc);
  await joinVoice(C);
  ok(await until(C, () => window.__voice.peers.size === 2 && [...window.__voice.peers.values()].every((p) => ['connected', 'completed'].includes(p.pc.iceConnectionState))), 'C connects to both A and B');
  ok(await until(A, () => window.__voice.peers.size === 2), 'A now has two peers');
  await C.waitForTimeout(1500);
  ok((await bytesIn(C, 'audio')) > 0, 'C receives audio');
  ok(await until(C, remoteVideo), "late joiner C sees B's camera");

  console.log('• leaving and reconnecting');
  await C.locator('.voice-controls button[title="Disconnect"]').click();
  ok(await until(A, () => window.__voice.peers.size === 1 && document.querySelectorAll('.voice-stage .tile').length === 2), 'A drops C when C leaves');
  // B loses its gateway connection: the app must rejoin voice on its own.
  await B.evaluate(() => {
    const s = window.__voice;
    s.__before = [...s.peers.keys()][0];
  });
  await B.context().setOffline(true);
  await B.waitForTimeout(500);
  await B.context().setOffline(false);
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  const rejoined = await until(B, () => window.__voice.peers.size === 1 && [...window.__voice.peers.values()].every((p) => ['connected', 'completed'].includes(p.pc.iceConnectionState)), null, 20000);
  ok(rejoined, 'B is (still or again) connected after a network blip');
  await B.close();
  ok(await until(A, () => document.querySelectorAll('.voice-stage .tile').length === 1), 'closing the tab removes B from the channel');
  await A.locator('.voice-controls button[title="Disconnect"]').click();
  ok(await until(A, () => !document.querySelector('.voice-status')), 'A disconnects');

  console.log('• direct call');
  const B2 = await open(tb);
  await api(ta, 'POST', '/api/friends', { username: 'ben_' + run });
  await api(tb, 'POST', '/api/friends', { username: 'anna_' + run });
  await A.locator('.rail-item.home button').click();
  await A.locator('.tabs button', { hasText: 'All' }).click();
  await A.locator('.friend-row button[title="Start Voice Call"]').click();
  ok(await until(B2, () => !!document.querySelector('.call-modal')), 'B gets an incoming call');
  await B2.locator('.call-modal button[title="Accept"]').click();
  ok(await until(B2, () => window.__voice.peers.size === 1 && [...window.__voice.peers.values()].every((p) => ['connected', 'completed'].includes(p.pc.iceConnectionState))), 'call connects');
  await B2.waitForTimeout(1500);
  ok((await bytesIn(B2, 'audio')) > 0, 'audio flows in the direct call');
  ok(await until(A, () => document.querySelectorAll('.dm-call .tile').length === 2), 'call panel shows both people');
  await A.locator('.dm-call button[title="Disconnect"]').click();
  ok(await until(B2, () => document.querySelectorAll('.dm-call .tile').length === 1), 'B sees A hang up');

  console.log('• push-to-talk and voice activity');
  await B2.locator('.dm-call button[title="Disconnect"]').click();
  await A.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings'));
    localStorage.setItem('settings', JSON.stringify({ ...s, voiceMode: 'ptt', pttKey: 'Backquote' }));
  });
  await A.reload();
  await A.waitForSelector('.user-panel');
  await A.locator('.dm-row:not(.nav)').first().click();
  await A.locator('.main-head button[title="Start Voice Call"], .main-head button[title="Join Call"]').first().click();
  ok(await until(A, () => window.__voice.userStream?.getAudioTracks()[0]?.enabled === false), 'push-to-talk: silent until the key is held');
  await A.keyboard.down('Backquote');
  ok(await until(A, () => window.__voice.userStream.getAudioTracks()[0].enabled === true, null, 3000), 'push-to-talk: key down opens the mic');
  await A.keyboard.up('Backquote');
  ok(await until(A, () => window.__voice.userStream.getAudioTracks()[0].enabled === false, null, 3000), 'push-to-talk: key up closes it');
  await A.evaluate(() => window.__ptt(true));
  ok(await until(A, () => window.__voice.userStream.getAudioTracks()[0].enabled === true, null, 3000), 'desktop global push-to-talk hook works');
  await A.evaluate(() => window.__ptt(false));
  await A.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('settings'));
    localStorage.setItem('settings', JSON.stringify({ ...s, voiceMode: 'vad', vadThreshold: 0, vadAuto: false }));
  });
  await A.reload();
  await A.waitForSelector('.user-panel');
  await A.locator('.dm-row:not(.nav)').first().click();
  await A.locator('.main-head button[title="Start Voice Call"], .main-head button[title="Join Call"]').first().click();
  await A.waitForTimeout(2500);
  ok(await A.evaluate(() => window.__voice.userStream.getAudioTracks()[0].enabled === false), 'voice gate stays closed below the sensitivity threshold');
  ok(await A.evaluate(() => window.__voice.level > -100 && window.__voice.level < 0), 'microphone level is measured while gated');
  await A.locator('.dm-call button[title="Disconnect"]').click();

  console.log('• voice messages, link previews, markdown');
  await A.locator('.composer button[title="Record a voice message"]').click();
  ok(await until(A, () => !!document.querySelector('.recorder')), 'recorder opens');
  await A.waitForTimeout(1600);
  await A.locator('.recorder button[title="Send"]').click();
  ok(await until(B2, () => !!document.querySelector('.voice-msg')), 'voice message arrives as a player');
  const vmName = await B2.evaluate(() => document.querySelector('.voice-msg audio').src);
  ok(/voice-message-\d+\.(webm|ogg|m4a)$/.test(vmName), 'voice message carries its duration');
  ok(await B2.evaluate(async () => {
    const a = document.querySelector('.voice-msg audio');
    await a.play();
    await new Promise((r) => setTimeout(r, 600));
    return a.currentTime > 0;
  }), 'voice message plays');
  await A.locator('.composer textarea').fill('# Title\n- one\n- two\nsee https://example.com/ ok');
  await A.keyboard.press('Enter');
  ok(await until(B2, () => !!document.querySelector('.msg-content h1') && document.querySelectorAll('.msg-content li').length === 2), 'headings and lists render');
  ok(await until(B2, () => [...document.querySelectorAll('.embed-title')].some((e) => e.textContent.includes('Example Domain'))), 'link preview appears');
} catch (e) {
  failures.push('exception: ' + e.message);
  console.log(e);
} finally {
  console.log('• no direct connection: media goes through the server');
  const relayId = await api(ta, 'POST', `/api/servers/${serverId}/channels`, { name: 'relay-room', type: 2 });
  const R1 = await open(ta);
  const R2 = await open(tb);
  for (const pg of [R1, R2]) await pg.evaluate(() => (window.__forceRelay = true));
  await R1.evaluate((id) => window.__voice.join(id), relayId.id);
  await R2.evaluate((id) => window.__voice.join(id), relayId.id);
  const relayAudio = () => [...window.__voice.peers.values()].some((p) => p.streams.has('relay-audio') && p.streams.get('relay-audio').getAudioTracks().some((t) => t.readyState === 'live'));
  ok(await until(R2, relayAudio, null, 30000), 'the other person receives audio through the server relay');
  ok(await until(R1, relayAudio, null, 30000), 'and so do you');
  ok(await until(R2, () => !!document.querySelector('.voice-user .avatar.speaking, .tile.speaking'), null, 15000), 'speaking indicator works over the relay');
  await R2.locator('.sidebar .channel', { hasText: 'relay-room' }).click();
  await R1.locator('.sidebar .channel', { hasText: 'relay-room' }).click();
  await R1.evaluate(() => window.__voice.setVideo(true));
  ok(await until(R2, () => [...document.querySelectorAll('.tile video')].some((v) => !v.classList.contains('mirror') && v.videoWidth > 0), null, 30000), 'camera is visible to the other person through the relay');
  await R1.evaluate(() => window.__voice.setScreen(true));
  ok(await until(R2, () => [...document.querySelectorAll('.tile video')].filter((v) => !v.classList.contains('mirror') && v.videoWidth > 0).length >= 2, null, 30000), 'screen share is visible through the relay');
  await R1.evaluate(() => window.__voice.leave());
  await R2.evaluate(() => window.__voice.leave());
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
