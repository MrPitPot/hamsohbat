// End-to-end test of the Windows app: launches the real exe against a local self-hosted server,
// drives its WebView2 over the DevTools protocol and checks the native features and the updater.
// Run `npm run release` first. Usage: node test/desktop.test.mjs
import { chromium } from 'playwright-core';
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const EXE = path.join(root, 'desktop/build/Hamsohbat.exe');
const PORT = 3200;
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-desktop-'));
const appData = path.join(process.env.APPDATA, 'Hamsohbat');
const localData = path.join(process.env.LOCALAPPDATA, 'Hamsohbat');
const hadConfig = fs.existsSync(appData) || fs.existsSync(localData);
let passed = 0;
const failures = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const appProcs = () => ps("@(Get-Process Hamsohbat -ErrorAction SilentlyContinue).Count");
const windowTitle = () => ps("(Get-Process Hamsohbat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowTitle");
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// If Hamsohbat is installed for this Windows user, keep their settings and shortcuts safe and restore them afterwards.
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-backup-'));
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const ARP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hamsohbat';
const keep = [
  path.join(appData, 'config.ini'),
  path.join(process.env.USERPROFILE, 'Desktop', 'Hamsohbat.lnk'),
  path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hamsohbat.lnk'),
];
const kept = keep.filter((f) => fs.existsSync(f));
kept.forEach((f, i) => fs.copyFileSync(f, path.join(backupDir, String(i))));
const arpBackup = path.join(backupDir, 'arp.reg');
try {
  execSync(`reg export "${ARP_KEY}" "${arpBackup}" /y`, { stdio: 'ignore' });
} catch {}
let runBefore = '';
try {
  runBefore = execSync(`reg query "${RUN_KEY}" /v Hamsohbat`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/REG_SZ\s+(.*)/)?.[1].trim() || '';
} catch {}
if (appProcs() !== '0') {
  console.log('Hamsohbat is running; close it before running this test.');
  process.exit(1);
}
function restore() {
  kept.forEach((f, i) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(path.join(backupDir, String(i)), f);
  });
  if (fs.existsSync(arpBackup)) execSync(`reg import "${arpBackup}"`, { stdio: 'ignore' });
  try {
    if (runBefore) execSync(`reg add "${RUN_KEY}" /v Hamsohbat /t REG_SZ /d "${runBefore.replace(/"/g, '\\"')}" /f`, { stdio: 'ignore' });
    else execSync(`reg delete "${RUN_KEY}" /v Hamsohbat /f`, { stdio: 'ignore' });
  } catch {}
  fs.rmSync(backupDir, { recursive: true, force: true });
}

// A copy of the self-hosted server whose update manifest announces a newer version.
const serverDir = path.join(tmp, 'server');
fs.cpSync(path.join(root, 'release/hamsohbat-server'), serverDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(serverDir, 'public/downloads/latest.json'), 'utf8'));
fs.writeFileSync(path.join(serverDir, 'public/downloads/latest.json'), JSON.stringify({ ...manifest, version: '9.9.9' }));
const server = spawn(process.execPath, ['server.mjs'], { cwd: serverDir, env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data') }, stdio: 'ignore' });
await until(() => fetch(BASE + '/api/config').then((r) => r.ok));

const api = async (token, method, p, body) =>
  (await fetch(BASE + p, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const ta = (await api(null, 'POST', '/api/auth/register', { username: 'desk_a', password: 'desktop-pw' })).token;
const tb = (await api(null, 'POST', '/api/auth/register', { username: 'desk_b', password: 'desktop-pw' })).token;
await api(ta, 'POST', '/api/friends', { username: 'desk_b' });
await api(tb, 'POST', '/api/friends', { username: 'desk_a' });

const installDir = path.join(tmp, 'installed');
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333', HAMSOHBAT_SETUP_EXTRA: `NOLAUNCH=1 INSTALLFOLDER_SET=1 INSTALLFOLDER="${installDir}\\"` };
const launch = () => spawn(EXE, [`--server=${BASE}`], { env, detached: true, stdio: 'ignore' });
let browser;
try {
  console.log('• startup');
  launch();
  ok(await until(() => fetch('http://127.0.0.1:9333/json/version').then((r) => r.ok), 20000), 'app starts with WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const findPage = () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(BASE));
  ok(await until(() => !!findPage()), 'app opens the configured server');
  let page = findPage();
  await page.evaluate((t) => {
    localStorage.setItem('token', t);
    localStorage.setItem('settings', JSON.stringify({ lang: 'en' }));
  }, ta);
  await page.reload();
  ok(await until(() => page.evaluate(() => !!document.querySelector('.user-panel'))), 'signed-in UI loads inside the app');
  ok(await page.evaluate(() => !!window.chrome?.webview), 'desktop bridge is available');
  ok(await page.evaluate(async () => (await fetch('/index.html')).headers.get('x-hamsohbat-bundled') === '1'), 'interface is served from inside the installed app, not downloaded');
  ok(await page.evaluate(async () => !(await fetch('/api/config')).headers.get('x-hamsohbat-bundled')), 'data still comes from the server');

  console.log('• a real desktop window');
  const geomScript = path.join(tmp, 'geom.ps1');
  fs.writeFileSync(
    geomScript,
    `Add-Type -Name G -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool ClientToScreen(System.IntPtr h, ref POINT p); [DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr h); public struct RECT { public int L, T, R, B; } public struct POINT { public int X, Y; }'
$h = (Get-Process Hamsohbat | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
$w = New-Object U.G+RECT; [U.G]::GetWindowRect($h, [ref]$w) | Out-Null
$p = New-Object U.G+POINT; [U.G]::ClientToScreen($h, [ref]$p) | Out-Null
"$($p.Y - $w.T) $([U.G]::IsZoomed($h))"`
  );
  const geom = () => execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${geomScript}"`, { encoding: 'utf8' }).trim().split(' ');
  // Start from a normal (not maximized) window.
  if (await page.evaluate(() => !!document.querySelector('.tb-buttons button[title="Restore"]'))) await page.click('.tb-buttons button[title="Restore"]');
  await until(() => geom()[1] === 'False');
  const [captionPx] = geom();
  ok(Number(captionPx) <= 2, 'no Windows caption bar: the window uses its own title bar (' + captionPx + ' px)');
  ok(await page.evaluate(() => !!document.querySelector('.titlebar')), 'custom title bar is shown');
  await page.click('.tb-buttons button[title="Maximize"]');
  ok(await until(() => geom()[1] === 'True'), 'title bar button maximizes the window');
  await page.click('.tb-buttons button[title="Restore"]');
  ok(await until(() => geom()[1] === 'False'), 'and restores it');
  const mode = await page.evaluate(async () => {
    const ac = new AudioContext({ sampleRate: 48000 });
    const o = ac.createOscillator();
    const d = ac.createMediaStreamDestination();
    o.connect(d);
    o.start();
    const p = await window.__noise.processMic(d.stream, 'ai');
    p.stop();
    return p.mode;
  });
  ok(mode === 'ai', 'AI noise cancellation runs inside the installed app');
  ok(
    await page.evaluate(() => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('.rail').dispatchEvent(e);
      return e.defaultPrevented;
    }),
    'no browser context menu'
  );

  console.log('• settings and updates');
  await page.click('.user-panel button[title="User Settings"]');
  ok(await until(() => page.evaluate(() => [...document.querySelectorAll('.settings-nav button')].some((b) => b.textContent === 'Windows Settings'))), 'Windows Settings tab exists');
  await page.locator('.settings-nav button', { hasText: 'Updates' }).click();
  ok(await until(() => page.evaluate((v) => document.querySelector('.update-card')?.textContent.includes('Installed version: ' + v), VERSION)), 'native app reports its version');
  await page.locator('.settings-nav button', { hasText: 'Windows Settings' }).click();
  ok(await until(() => page.evaluate(() => document.querySelector('.settings-body input')?.value === location.origin)), 'server address shown');

  console.log('• unread badge');
  await page.click('.settings-close');
  const dm = await api(tb, 'POST', '/api/dms', { recipients: [(await api(ta, 'PATCH', '/api/users/me', {})).id] });
  await api(tb, 'POST', `/api/channels/${dm.id}/messages`, { content: 'ping from b' });
  ok(await until(() => windowTitle().startsWith('(1)')), 'window title shows the unread count: ' + windowTitle());

  console.log('• single instance and tray');
  const second = spawn(EXE, [], { env, stdio: 'ignore' });
  const exited = await new Promise((r) => {
    second.on('exit', () => r(true));
    setTimeout(() => r(false), 8000);
  });
  ok(exited && appProcs() === '1', 'a second launch hands over to the running app');
  const closeScript = path.join(tmp, 'close.ps1');
  fs.writeFileSync(
    closeScript,
    `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
$h = (Get-Process Hamsohbat | Where-Object { $_.MainWindowHandle -ne 0 }).MainWindowHandle
[U.W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`
  );
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${closeScript}"`);
  ok(await until(() => windowTitle() === '' && appProcs() === '1', 8000), 'closing the window keeps the app in the tray');
  spawn(EXE, [], { env, stdio: 'ignore' });
  ok(await until(() => windowTitle() !== '', 8000), 'launching again brings the window back');

  console.log('• updater');
  page = findPage();
  await page.click('.user-panel button[title="User Settings"]');
  await page.locator('.settings-nav button', { hasText: 'Updates' }).click();
  await page.locator('.update-card button', { hasText: 'Check for Updates' }).click();
  ok(await until(() => page.evaluate(() => document.querySelector('.update-card')?.textContent.includes('Version 9.9.9 is available'))), 'finds the newer version');
  ok(await page.evaluate(() => document.querySelector('.release-notes')?.textContent.length > 10), 'shows release notes');
  ok(await page.evaluate(() => !!document.querySelector('.update-banner')), 'update banner appears');
  await page.locator('.update-card button', { hasText: 'Update Now' }).click();
  ok(await until(() => appProcs() === '0', 20000), 'app downloads the update, starts the installer and exits');
  const installed = path.join(installDir, 'Hamsohbat.exe');
  const builtSize = fs.statSync(EXE).size;
  ok(await until(() => fs.existsSync(installed) && fs.statSync(installed).size === builtSize, 60000), 'Windows Installer put the new version in place');
  const lnk = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Hamsohbat.lnk');
  ok(await until(() => fs.existsSync(lnk), 30000), 'Start menu shortcut created');
  const runValue = () => spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Hamsohbat'], { encoding: 'utf8' }).stdout || '';
  await until(() => runValue().includes(installDir), 30000);
  const runNow = runValue();
  ok(runNow.includes(installDir) && runNow.includes('--minimized'), 'starts with Windows (minimized): ' + JSON.stringify(runNow.trim()) + ' | expected ' + installDir);
  // Remove the test installation again.
  await until(() => ps("@(Get-Process msiexec -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count") === '0', 30000);
  await sleep(3000);
  // 1618 = another installation is still finishing; wait for it.
  for (let i = 0; i < 30; i++) {
    const r = spawnSync('msiexec', ['/x', path.join(root, 'desktop', 'build', 'Hamsohbat-Setup.msi'), '/qn', '/norestart']);
    if (r.status !== 1618) break;
    await sleep(2000);
  }
  ok(!fs.existsSync(lnk) && !fs.existsSync(installed), 'uninstall removes the app and its shortcuts');
} catch (e) {
  failures.push('exception: ' + e.message);
  console.log(e);
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    execSync('taskkill /IM Hamsohbat.exe /F', { stdio: 'ignore' });
  } catch {}
  server.kill();
  await sleep(1500);
  if (hadConfig) fs.rmSync(path.join(appData, 'config.ini'), { force: true });
  restore();
  if (!hadConfig) for (const d of [appData, localData]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);
