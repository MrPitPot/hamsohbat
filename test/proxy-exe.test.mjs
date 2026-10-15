// The real Windows exe + the real proxy core: starts the app from desktop/build, drives it through DevTools,
// asks it to start the core and to open the Discord window, and checks the processes/windows that result.
//   npx wrangler dev --port 8787   (server the app talks to), then: node test/proxy-exe.test.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const EXE = path.resolve('desktop/build/Hamsohbat.exe');
if (!fs.existsSync(path.resolve('desktop/build/hs-proxy.exe'))) {
  console.log('desktop/build/hs-proxy.exe is missing (node scripts/setup-desktop.mjs, then release); skipping.');
  process.exit(0);
}
let passed = 0;
const failures = [];
const ok = (c, n) => ((c ? passed++ : failures.push(n)), console.log((c ? '  ok   ' : '  FAIL ') + n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim();
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(300);
  }
  return false;
};

const YAML = [
  'mixed-port: 17890', 'allow-lan: false', 'bind-address: 127.0.0.1', 'external-controller: 127.0.0.1:17891', 'secret: "exe-test"',
  'external-controller-cors:', "  allow-origins: ['*']", '  allow-private-network: true',
  'proxies:', '  - {name: Local, type: direct}',
  'proxy-groups:', '  - {name: PROXY, type: select, proxies: [Local]}', 'rules:', '  - MATCH,PROXY', '',
].join('\n');

const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9334' };
const app = spawn(EXE, [`--server=${BASE}`], { env, stdio: 'ignore', detached: true });
let browser;
try {
  for (let i = 0; i < 40 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
    } catch {
      await sleep(500);
    }
  }
  ok(!!browser, 'the app starts');
  const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(BASE)) || browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.chrome?.webview, null, { timeout: 20000 });

  console.log('• proxy core');
  await page.evaluate((yaml) => window.chrome.webview.postMessage({ type: 'proxy', cmd: 'start', yaml }), YAML);
  ok(await until(() => ps('(Get-Process hs-proxy -ErrorAction SilentlyContinue | Measure-Object).Count') === '1'), 'hs-proxy.exe is started by the app');
  const up = await until(async () => (await fetch('http://127.0.0.1:17891/proxies/PROXY', { headers: { authorization: 'Bearer exe-test' } }).then((r) => r.status).catch(() => 0)) === 200);
  ok(up, 'its control API answers on 127.0.0.1');
  ok(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Hamsohbat', 'proxy', 'config.yaml')), 'the config was written to the app data folder');

  console.log('• Discord window');
  await page.evaluate(() => window.chrome.webview.postMessage({ type: 'discord', cmd: 'open', port: 17890 }));
  ok(await until(() => ps("(Get-Process | Where-Object { $_.MainWindowTitle -eq 'Discord (via proxy)' } | Measure-Object).Count") === '1'), 'a separate "Discord (via proxy)" window opens');
  ok(await until(() => ps("(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'proxy-server=http://127.0.0.1:17890' } | Measure-Object).Count") !== '0', 20000), 'its browser runs with the local proxy only');
  ok(await until(() => ps("(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'DiscordWebView2' } | Measure-Object).Count") !== '0', 20000), 'it uses its own profile folder');
  ok(ps("(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'proxy-server' -and $_.CommandLine -notmatch 'DiscordWebView2' } | Measure-Object).Count") === '0', 'the main app window is not routed through the proxy');

  console.log('• stop');
  await page.evaluate(() => window.chrome.webview.postMessage({ type: 'proxy', cmd: 'stop' }));
  ok(await until(() => ps('(Get-Process hs-proxy -ErrorAction SilentlyContinue | Measure-Object).Count') === '0'), 'stopping ends the core process');
} catch (e) {
  failures.push('crashed: ' + e.message);
  console.log('  FAIL crashed:', e.message);
} finally {
  await browser?.close().catch(() => {});
  spawnSync('taskkill', ['/F', '/T', '/IM', 'Hamsohbat.exe']);
  spawnSync('taskkill', ['/F', '/IM', 'hs-proxy.exe']);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(' - ' + f);
process.exit(failures.length ? 1 : 0);
