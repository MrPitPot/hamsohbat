// Tests the Windows app's interface in Chrome with a simulated app shell (window.chrome.webview):
// the custom title bar, desktop behaviour (no browser menus), noise cancellation, and the TeamSpeak screen
// driven end to end by the real hs-teamspeak bridge against a local TeamSpeak 3 server.
// Run `npm run dev` and start a TeamSpeak 3 server on this machine, then:
//   node test/desktop-ui.test.mjs [server url]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const BRIDGE = path.resolve('desktop/teamspeak/target/release/hs-teamspeak.exe');
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const pageErrors = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(token, method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const token = (await api(null, 'POST', '/api/auth/register', { username: 'desk_ui_' + run, password: 'desk-ui-pw', displayName: 'Desk' })).token;
await api(token, 'POST', '/api/servers', { name: 'Desk UI ' + run });

let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    break;
  } catch {}
}
if (!browser) {
  console.log('No Edge or Chrome found; skipping.');
  process.exit(0);
}
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['microphone'] });
// The simulated shell: messages from the page go to Node, Node answers through __nativeSend.
await ctx.addInitScript((t) => {
  localStorage.setItem('token', t);
  if (!localStorage.getItem('settings')) localStorage.setItem('settings', JSON.stringify({ lang: 'en', reducedMotion: 'on' }));
  const listeners = [];
  window.__native = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: (m) => {
      window.__native.push(m);
      window.__toNative?.(JSON.stringify(m));
    },
    addEventListener: (_t, f) => listeners.push(f),
    removeEventListener: () => {},
  };
  window.__nativeSend = (data) => listeners.forEach((f) => f({ data }));
}, token);
const page = await ctx.newPage();
page.on('pageerror', (e) => (pageErrors.push(e.message), console.log('  [page error]', e.message)));

// The real TeamSpeak bridge, connected to the page like the desktop app does it.
const bridge = spawn(BRIDGE, [], { env: { ...process.env, HS_TS_TEST_AUDIO: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
readline.createInterface({ input: bridge.stdout }).on('line', (l) => {
  if (!l.startsWith('{')) return;
  page.evaluate((line) => window.__nativeSend({ type: 'ts', event: JSON.parse(line) }), l).catch(() => {});
});
await page.exposeFunction('__toNative', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'ts') bridge.stdin.write(JSON.stringify(m.payload) + '\n');
});
const until = async (fn, arg, ms = 15000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 150 });
    return true;
  } catch {
    return false;
  }
};
const sent = (pred) => page.evaluate((src) => window.__native.some(new Function('m', 'return ' + src)), pred);

try {
  await page.goto(BASE + '/channels/@me');
  await page.waitForSelector('.user-panel');

  console.log('• title bar and window controls');
  ok(await page.evaluate(() => document.documentElement.classList.contains('desktop-app') && !!document.querySelector('.titlebar')), 'the app draws its own title bar');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('app-region') === 'drag' || getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region') === 'drag'), 'the title bar is a window drag area');
  ok(await page.evaluate(() => document.querySelector('.titlebar').getBoundingClientRect().bottom <= document.querySelector('.rail').getBoundingClientRect().top + 1), 'content starts below the title bar');
  await page.click('.tb-buttons button[title="Maximize"]');
  ok(await sent("m.type === 'window' && m.action === 'maximize'"), 'maximize button asks the window to maximize');
  await page.evaluate(() => window.__nativeSend({ type: 'window', maximized: true }));
  ok(await until(() => !!document.querySelector('.tb-buttons button[title="Restore"]')), 'button turns into "Restore" when maximized');
  await page.click('.tb-buttons button[title="Minimize"]');
  ok(await sent("m.action === 'minimize'"), 'minimize button works');
  await page.evaluate(() => window.__nativeSend({ type: 'window', fullscreen: true }));
  ok(await until(() => !document.querySelector('.titlebar')), 'title bar hides in fullscreen');
  await page.evaluate(() => window.__nativeSend({ type: 'window', fullscreen: false }));

  console.log('• feels like an app, not a web page');
  ok(await page.evaluate(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('.rail').dispatchEvent(e);
    return e.defaultPrevented;
  }), 'no browser context menu on the interface');
  ok(await page.evaluate(() => getComputedStyle(document.body).userSelect === 'none'), 'interface text is not selectable like a web page');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')).direction === 'ltr'), 'window buttons stay on the right');

  console.log('• noise cancellation');
  const noise = await page.evaluate(async () => {
    // Background noise in, measure what comes out of each canceller.
    const ac = new AudioContext({ sampleRate: 48000 });
    const buf = ac.createBuffer(1, 48000 * 3, 48000);
    const d = buf.getChannelData(0);
    // Fan-like rumble plus mains hum: the kind of noise a real room has.
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      lp = lp * 0.97 + (Math.random() * 2 - 1) * 0.03;
      d[i] = lp * 1.5 + Math.sin((i / 48000) * 50 * 2 * Math.PI) * 0.01;
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    const measure = async (stream) => {
      const mc = new AudioContext({ sampleRate: 48000 });
      const an = mc.createAnalyser();
      an.fftSize = 2048;
      mc.createMediaStreamSource(stream).connect(an);
      const b = new Float32Array(an.fftSize);
      await new Promise((r) => setTimeout(r, 1500));
      let sum = 0;
      for (let k = 0; k < 20; k++) {
        an.getFloatTimeDomainData(b);
        for (const x of b) sum += x * x;
        await new Promise((r) => setTimeout(r, 25));
      }
      mc.close();
      return Math.sqrt(sum / (20 * b.length));
    };
    const raw = await measure(dest.stream);
    const out = {};
    for (const mode of ['ai', 'rnnoise']) {
      const p = await window.__noise.processMic(dest.stream.clone(), mode);
      out[mode] = { mode: p.mode, rms: await measure(p.stream) };
      p.stop();
    }
    return { raw, ...out };
  });
  ok(noise.ai.mode === 'ai' && noise.rnnoise.mode === 'rnnoise', 'both noise models load (WebAssembly in an AudioWorklet)');
  ok(noise.ai.rms < noise.raw * 0.2, `AI noise cancellation removes background noise (${(noise.raw * 1000).toFixed(1)} → ${(noise.ai.rms * 1000).toFixed(1)})`);
  ok(noise.rnnoise.rms < noise.raw * 0.3, `RNNoise removes background noise (${(noise.raw * 1000).toFixed(1)} → ${(noise.rnnoise.rms * 1000).toFixed(1)})`);
  // Real speech (Windows text-to-speech) has to come through.
  const wav = fs.readFileSync(path.resolve('test/fixtures/speech.wav')).toString('base64');
  const speech = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ac = new AudioContext({ sampleRate: 48000 });
    const buf = await ac.decodeAudioData(bytes.buffer);
    const play = () => {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      return dest.stream;
    };
    const measure = async (stream) => {
      const mc = new AudioContext({ sampleRate: 48000 });
      const an = mc.createAnalyser();
      an.fftSize = 2048;
      mc.createMediaStreamSource(stream).connect(an);
      const b = new Float32Array(an.fftSize);
      await new Promise((r) => setTimeout(r, 1000));
      let sum = 0;
      for (let k = 0; k < 120; k++) {
        an.getFloatTimeDomainData(b);
        for (const x of b) sum += x * x;
        await new Promise((r) => setTimeout(r, 30));
      }
      mc.close();
      return Math.sqrt(sum / (120 * b.length));
    };
    const raw = await measure(play());
    const out = {};
    for (const mode of ['ai', 'rnnoise']) {
      const p = await window.__noise.processMic(play(), mode);
      out[mode] = await measure(p.stream);
      p.stop();
    }
    return { raw, ...out };
  }, wav);
  ok(speech.ai > speech.raw * 0.4, `speech passes through AI noise cancellation (${(speech.raw * 1000).toFixed(1)} → ${(speech.ai * 1000).toFixed(1)})`);
  ok(speech.rnnoise > speech.raw * 0.4, `speech passes through RNNoise (${(speech.raw * 1000).toFixed(1)} → ${(speech.rnnoise * 1000).toFixed(1)})`);
  await page.click('.user-panel button[title="User Settings"]');
  await page.locator('.settings-nav button', { hasText: 'Voice & Video' }).click();
  ok(await until(() => document.querySelector('.settings-body .type-choice.active')?.textContent.includes('AI Noise Cancellation')), 'AI noise cancellation is the default in Voice settings');
  await page.keyboard.press('Escape');

  console.log('• TeamSpeak');
  await page.goto(BASE + '/teamspeak');
  await page.waitForSelector('.ts-connect');
  await page.fill('.ts-form input[placeholder="ts.example.com:9987"]', '127.0.0.1');
  await page.locator('.ts-form .field', { hasText: 'Nickname' }).locator('input').fill('Desk' + run.slice(-4));
  await page.click('.ts-form .btn.primary');
  ok(await until(() => [...document.querySelectorAll('.ts-log-line')].some((l) => /Connecting to/.test(l.textContent))), 'connect attempt shows in the log');
  ok(await until(() => !!document.querySelector('.ts-layout'), null, 30000), 'connects to the TeamSpeak server');
  ok(await until(() => document.querySelectorAll('.sidebar .channel').length > 0), 'channel tree is shown');
  ok(await until(() => /\d+ ms/.test(document.querySelector('.main-head .ts-ping')?.textContent || '')), 'ping is shown in the header');
  ok(await until(() => /Users Online/.test(document.querySelector('.ts-info')?.textContent || '') && /Packet Loss/.test(document.querySelector('.ts-info').textContent)), 'server info panel with users, ping and packet loss');
  ok(await until(() => [...document.querySelectorAll('.ts-log-line')].some((l) => /Connected to/.test(l.textContent))), 'server log shows the connection');

  // A second TeamSpeak user, so there is somebody to chat with and look at.
  const other = spawn(BRIDGE, [], { env: { ...process.env, HS_TS_TEST_AUDIO: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const otherName = 'Mate' + run.slice(-4);
  other.stdin.write(JSON.stringify({ cmd: 'connect', address: '127.0.0.1', nickname: otherName }) + '\n');
  ok(await until((n) => [...document.querySelectorAll('.ts-log-line')].some((l) => l.textContent.includes(n + ' connected')), otherName, 30000), 'log: another user connecting');
  await page.locator('.ts-user', { hasText: otherName }).click();
  ok(await until(() => /Version/.test(document.querySelector('.ts-info')?.textContent || '') && !/Version…/.test(document.querySelector('.ts-info').textContent)), 'clicking a user shows their info (version, groups, ping)');
  await page.locator('.ts-tabs button', { hasText: 'Default Channel' }).first().click().catch(() => {});
  await page.locator('.ts-tabs button').nth(2).click();
  await page.fill('.ts-input', 'hello teamspeak');
  await page.keyboard.press('Enter');
  ok(await until(() => [...document.querySelectorAll('.ts-msg')].some((m) => m.textContent.includes('hello teamspeak'))), 'your own channel message shows in the chat');
  other.stdin.write(JSON.stringify({ cmd: 'message', target: 'channel', text: 'hi back' }) + '\n');
  ok(await until(() => [...document.querySelectorAll('.ts-msg')].some((m) => m.textContent.includes('hi back'))), 'messages from others arrive in the chat');
  await page.locator('.ts-user', { hasText: otherName }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Send Private Message' }).click();
  await page.fill('.ts-input', 'private hello');
  await page.keyboard.press('Enter');
  ok(await until(() => [...document.querySelectorAll('.ts-msg')].some((m) => m.textContent.includes('private hello'))), 'private chat tab works');
  await page.locator('.ts-user', { hasText: otherName }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Poke' }).click();
  ok(await until(() => !!document.querySelector('.modal input')), 'poke opens a proper dialog (no browser prompt)');
  await page.fill('.modal input', 'wake up');
  await page.click('.modal .btn.primary');
  ok(await sent("m.type === 'ts' && m.payload.cmd === 'poke' && m.payload.text === 'wake up'"), 'poke is sent');
  await page.locator('.sidebar .channel').first().click({ button: 'right' });
  ok(await until(() => [...document.querySelectorAll('.menu .menu-item')].some((b) => /Create Sub-Channel/.test(b.textContent))), 'channel menu offers channel management');
  await page.keyboard.press('Escape');
  await page.click('.sidebar-head button[title="Set Away"]');
  await page.fill('.modal input', 'lunch');
  await page.click('.modal .btn.primary');
  ok(await until(() => !!document.querySelector('.ts-user .lucide-moon')), 'away status shows in the tree');
  await page.locator('.ts-tabs button', { hasText: 'Server Log' }).click();
  other.stdin.write(JSON.stringify({ cmd: 'disconnect' }) + '\n');
  ok(await until((n) => [...document.querySelectorAll('.ts-log-line')].some((l) => l.textContent.includes(n + ' disconnected')), otherName), 'log: user disconnecting');
  other.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
  await page.click('.main-head .btn', { timeout: 5000 });
  ok(await until(() => !!document.querySelector('.ts-connect')), 'disconnect returns to the connect screen');
  setTimeout(() => other.kill(), 1000);
} catch (e) {
  failures.push('crashed: ' + e.message);
  console.log(e);
}
ok(pageErrors.length === 0, 'no JavaScript errors');
bridge.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
await sleep(500);
bridge.kill();
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n  - ' + failures.join('\n  - '));
process.exit(failures.length ? 1 : 0);
