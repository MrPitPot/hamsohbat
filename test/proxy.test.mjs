// Discord-through-proxy screen, end to end with the real Mihomo core (hs-proxy.exe / desktop/.deps/mihomo).
// A local HTTP server plays the VPN panel's subscription link; the simulated app shell starts the core like the
// desktop app does, and the page drives it. Run `npx wrangler dev --port 8787` first, then:
//   node test/proxy.test.mjs [server url]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const CORE = [path.resolve('desktop/build/hs-proxy.exe'), path.resolve('desktop/.deps/mihomo/mihomo.exe')].find((p) => fs.existsSync(p));
if (!CORE) {
  console.log('No proxy core found (run node scripts/setup-desktop.mjs); skipping.');
  process.exit(0);
}
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the "panel": a subscription in Clash format with two direct exits
const SUB = `proxies:\n  - {name: "Node A", type: direct, udp: true}\n  - {name: "Node B", type: direct, udp: true}\n`;
const panel = http.createServer((req, res) => {
  if (req.url.startsWith('/sub/ok')) {
    res.setHeader('content-type', 'text/yaml');
    res.end(SUB);
  } else {
    res.statusCode = 404;
    res.end('no');
  }
});
await new Promise((r) => panel.listen(0, '127.0.0.1', r));
const subUrl = `http://127.0.0.1:${panel.address().port}/sub/ok`;

const token = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'proxy_ui_' + run, password: 'proxy-ui-pw', displayName: 'Proxy' }) })).json()).token;

let browser;
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    break;
  } catch {}
}
if (!browser) {
  console.log('No Edge or Chrome found; skipping.');
  process.exit(0);
}
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
await ctx.addInitScript((t) => {
  localStorage.setItem('token', t);
  localStorage.setItem('settings', JSON.stringify({ lang: 'en', reducedMotion: 'on' }));
  window.__native = [];
  const listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: (m) => (window.__native.push(m), window.__toNative?.(JSON.stringify(m))),
    addEventListener: (_t, f) => listeners.push(f),
    removeEventListener: () => {},
  };
  window.__nativeSend = (data) => listeners.forEach((f) => f({ data }));
}, token);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => (errors.push(e.message), console.log('  [page error]', e.message)));
page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && (errors.push(m.text()), console.log('  [CSP]', m.text())));

// ---- the shell: writes the config and runs the core, exactly like ProxyStart() in app.cpp
let core = null;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-proxy-'));
await page.exposeFunction('__toNative', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'proxy' && m.cmd === 'start') {
    core?.kill();
    fs.writeFileSync(path.join(dir, 'config.yaml'), m.yaml);
    core = spawn(CORE, ['-d', dir], { stdio: 'ignore' });
  } else if (m.type === 'proxy' && m.cmd === 'stop') {
    core?.kill();
    core = null;
  }
});
const until = async (fn, arg, ms = 30000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
    return true;
  } catch {
    return false;
  }
};

try {
  await page.goto(BASE + '/channels/@me');
  await page.waitForSelector('.user-panel');

  console.log('• screen');
  await page.click('.rail-item.dc button');
  ok(await until(() => location.pathname === '/discord' && !!document.querySelector('.dc-main')), 'the Discord item in the rail opens the proxy screen');
  ok(await page.locator('button', { hasText: 'Start proxy' }).isDisabled(), 'starting needs a subscription first');
  await page.fill('.dc-add input[dir="ltr"]', 'not a link');
  ok(await page.locator('.dc-add .btn').isDisabled(), 'a non-URL cannot be added');
  await page.fill('.dc-add input:not([dir])', 'My panel');
  await page.fill('.dc-add input[dir="ltr"]', subUrl);
  await page.click('.dc-add .btn');
  ok(await page.locator('.ts-bookmark', { hasText: 'My panel' }).count() === 1, 'the subscription is added and listed');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('hsSubs') || '[]').length === 1), 'it is remembered');

  console.log('• core');
  await page.click('button:has-text("Start proxy")');
  ok(await until(() => document.querySelectorAll('.dc-nodes .ts-bookmark').length === 2, null, 40000), 'the core starts and the subscription\'s servers are listed');
  const cfg = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
  ok(/bind-address: 127\.0\.0\.1/.test(cfg) && /allow-lan: false/.test(cfg) && /external-controller: 127\.0\.0\.1:/.test(cfg), 'the proxy only listens on this computer');
  ok(/secret: "[0-9a-f]{32}"/.test(cfg), 'the control API is protected by a random secret');
  const unauth = await fetch('http://127.0.0.1:17891/proxies').then((r) => r.status).catch(() => 0);
  ok(unauth === 401, 'the control API rejects requests without the secret');

  console.log('• ping and selection');
  {
    const sec = /secret: "([0-9a-f]+)"/.exec(cfg)[1];
    const r = await fetch('http://127.0.0.1:17891/providers/proxies/sub/' + encodeURIComponent('Node A') + '/healthcheck?url=' + encodeURIComponent('https://www.gstatic.com/generate_204') + '&timeout=6000', { headers: { authorization: 'Bearer ' + sec } });
    console.log('   delay api:', r.status, await r.text());
  }
  await page.click('button:has-text("Test all")');
  await sleep(8000);
  console.log('   pings:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.dc-nodes small')].map((s) => s.textContent))));
  ok(await until(() => [...document.querySelectorAll('.dc-nodes small')].every((s) => /\d+ ms/.test(s.textContent)), null, 40000), 'every server shows its ping');
  await page.click('button:has-text("Pick the fastest")');
  ok(await until(() => document.querySelectorAll('.dc-nodes .ts-bookmark.selected').length === 1, null, 40000), 'the fastest server gets selected');
  await page.locator('.dc-nodes .ts-bookmark', { hasText: 'Node B' }).click();
  ok(await until(() => document.querySelector('.dc-nodes .ts-bookmark.selected span')?.textContent === 'Node B'), 'a server can be chosen by hand');
  const secret = /secret: "([0-9a-f]+)"/.exec(cfg)[1];
  const group = await (await fetch('http://127.0.0.1:17891/proxies/PROXY', { headers: { authorization: 'Bearer ' + secret } })).json();
  ok(group.now === 'Node B', 'the core really switched to it');

  console.log('• traffic through the proxy');
  const viaProxy = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 17890, method: 'GET', path: 'http://www.gstatic.com/generate_204', headers: { host: 'www.gstatic.com' } }, (r) => resolve(r.statusCode));
    req.on('error', () => resolve(0));
    req.setTimeout(15000, () => (req.destroy(), resolve(0)));
    req.end();
  });
  ok(viaProxy === 204, 'a request through the local proxy port reaches the internet');
  await page.click('button:has-text("Open Discord")');
  ok(await page.evaluate(() => window.__native.some((m) => m.type === 'discord' && m.cmd === 'show' && m.port === 17890 && m.w > 300 && m.h > 300)), 'Discord is placed inside the window on the proxy port');

  ok(await page.locator('.dc-view').count() === 1 && (await page.evaluate(() => document.querySelector('.dc-view').getBoundingClientRect().width > 300)), 'the Discord area fills the main part of the window');
  await page.click('button:has-text("Servers and settings")');
  ok(await page.evaluate(() => window.__native.at(-1).cmd === 'hide'), 'leaving the Discord view hides it again');
  console.log('• stop');
  await page.click('button:has-text("Stop proxy")');
  await sleep(1500);
  const down = await fetch('http://127.0.0.1:17891/proxies', { headers: { authorization: 'Bearer ' + secret } }).then(() => false).catch(() => true);
  ok(down, 'stopping shuts the core down');
  ok(await page.locator('button:has-text("Open Discord")').isDisabled(), '"Open Discord" is disabled while the proxy is off');
  ok(errors.length === 0, 'no JavaScript or CSP errors');
} catch (e) {
  failures.push('crashed: ' + e.message);
  console.log('  FAIL crashed:', e.message);
} finally {
  core?.kill();
  panel.close();
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(' - ' + f);
process.exit(failures.length ? 1 : 0);

