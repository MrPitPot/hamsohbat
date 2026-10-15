// Full release build: desktop app + installer, web app (with the installer under /downloads),
// self-hosted server bundle and compressed zips in release/.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
// The address the Windows app connects to by default: HAMSOHBAT_SERVER, or the first line of server-url.txt (not in git).
const server = (process.env.HAMSOHBAT_SERVER || (fs.existsSync('server-url.txt') ? fs.readFileSync('server-url.txt', 'utf8').split(/\r?\n/)[0] : '')).trim().replace(/\/$/, '');
if (!/^https?:\/\//.test(server)) {
  console.error('Set the server address first: put it in server-url.txt (e.g. https://hamsohbat.<you>.workers.dev) or set HAMSOHBAT_SERVER.');
  process.exit(1);
}
const [maj, min, pat] = version.split('.').map(Number);
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, HS_VERSION: version, HS_SERVER: server } });
/** Freshly linked executables are briefly locked by antivirus scanners; wait for them. */
function readRetry(file) {
  for (let i = 0; ; i++) {
    try {
      return fs.readFileSync(file);
    } catch (e) {
      if (i > 40) throw e;
      execSync('ping -n 2 127.0.0.1 >nul');
    }
  }
}
const copyRetry = (a, b) => fs.writeFileSync(b, readRetry(a));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg',
};
/** Packs a folder as: "HSPK", count, [pathLen, path, mimeLen, mime, offset, size]*, data. */
function writeUiPack(dir, dest) {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  const entries = files
    .map((f) => ({ url: '/' + path.relative(dir, f).split(path.sep).join('/'), data: fs.readFileSync(f), mime: MIME[path.extname(f)] || 'application/octet-stream' }))
    .filter((e) => !e.url.startsWith('/downloads/'));
  const head = [Buffer.from('HSPK'), Buffer.alloc(4)];
  head[1].writeUInt32LE(entries.length);
  let size = 8;
  const metas = entries.map((e) => {
    const p = Buffer.from(e.url, 'utf8');
    const m = Buffer.from(e.mime, 'utf8');
    const b = Buffer.alloc(2 + p.length + 2 + m.length + 8);
    b.writeUInt16LE(p.length, 0);
    p.copy(b, 2);
    b.writeUInt16LE(m.length, 2 + p.length);
    m.copy(b, 4 + p.length);
    size += b.length;
    return { b, at: 4 + p.length + m.length };
  });
  let offset = size;
  entries.forEach((e, i) => {
    metas[i].b.writeUInt32LE(offset, metas[i].at);
    metas[i].b.writeUInt32LE(e.data.length, metas[i].at + 4);
    offset += e.data.length;
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([...head, ...metas.map((m) => m.b), ...entries.map((e) => e.data)]));
  console.log(`ui.pack: ${entries.length} files, ${(offset / 1024).toFixed(0)} KB`);
}

// 1. desktop app
fs.mkdirSync('desktop/build', { recursive: true });
fs.writeFileSync(
  'desktop/build/version.h',
  `#pragma once
#define APP_VERSION_W L"${version}"
#define APP_VERSION_STR "${version}"
#define APP_VERSION_NUM ${maj},${min},${pat},0
#define DEFAULT_SERVER_W L"${server}"
`
);
// The desktop app carries the whole interface inside the exe (see LoadUiPack in desktop/app.cpp).
run('npx vite build');
writeUiPack('dist', 'desktop/build/ui.pack');
// TeamSpeak bridge (Rust). Opus is built with CMake from the Visual Studio tools.
const cargoEnv = {
  ...process.env,
  CMAKE_POLICY_VERSION_MINIMUM: '3.5',
  PATH: [path.join(os.homedir(), '.cargo', 'bin'), 'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin', process.env.PATH].join(path.delimiter),
};
execSync('cargo build --release', { cwd: 'desktop/teamspeak', stdio: 'inherit', env: cargoEnv });
fs.copyFileSync('desktop/teamspeak/target/release/hs-teamspeak.exe', 'desktop/build/hs-teamspeak.exe');
// Optional proxy core for the experimental Discord window (fetched by scripts/setup-desktop.mjs).
const proxyCore = 'desktop/.deps/mihomo/mihomo.exe';
if (fs.existsSync(proxyCore)) {
  fs.copyFileSync(proxyCore, 'desktop/build/hs-proxy.exe');
  process.env.HS_PROXY = '1';
} else {
  process.env.HS_PROXY = '0';
  console.log('Note: desktop/.deps/mihomo/mihomo.exe not found - building without the Discord proxy core.');
}
run('"' + path.resolve('desktop/build.cmd') + '"');

// 2. publish the installer next to the web app so the desktop updater can find it
const setup = readRetry('desktop/build/Hamsohbat-Setup.msi');
fs.mkdirSync('public/downloads', { recursive: true });
for (const old of fs.readdirSync('public/downloads')) fs.rmSync(path.join('public/downloads', old), { force: true });
fs.writeFileSync('public/downloads/Hamsohbat-Setup.msi', setup);
fs.writeFileSync('public/downloads/update-manually.html', '<!doctype html><meta charset=utf-8><title>Hamsohbat</title><p>Please download and install <a href="/downloads/Hamsohbat-Setup.msi">Hamsohbat-Setup.msi</a>.</p>');
const notes = JSON.parse(fs.readFileSync('desktop/release-notes.json', 'utf8'));
fs.writeFileSync(
  'public/downloads/latest.json',
  JSON.stringify(
    {
      version,
      // Version 1.1 could only install an .exe; send it to the download page instead of a file it cannot run.
      url: '/downloads/update-manually.html',
      msi: '/downloads/Hamsohbat-Setup.msi',
      sha256: crypto.createHash('sha256').update(setup).digest('hex'),
      size: setup.length,
      date: new Date().toISOString().slice(0, 10),
      notes,
    },
    null,
    2
  )
);

// 3. web app + self-hosted server
run('npx vite build');
run('node scripts/build-selfhost.mjs');

// 4. compressed bundles
const out = 'release';
for (const f of fs.readdirSync(out)) if (fs.statSync(path.join(out, f)).isFile()) fs.rmSync(path.join(out, f), { force: true });
copyRetry('desktop/build/Hamsohbat-Setup.msi', path.join(out, 'Hamsohbat-Setup.msi'));
fs.rmSync(path.join(out, 'portable'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'portable'));
copyRetry('desktop/build/Hamsohbat.exe', path.join(out, 'portable', 'Hamsohbat.exe'));
copyRetry('desktop/build/hs-teamspeak.exe', path.join(out, 'portable', 'hs-teamspeak.exe'));
if (fs.existsSync('desktop/build/hs-proxy.exe')) copyRetry('desktop/build/hs-proxy.exe', path.join(out, 'portable', 'hs-proxy.exe'));
zip([path.join(out, 'portable', '*')], path.join(out, 'Hamsohbat-Portable.zip'));
function zip(files, dest) {
  // New executables can be held for a few seconds while Windows asks the cloud about them; retry until readable.
  for (let i = 0; ; i++) {
    try {
      return execSync(`powershell -NoProfile -Command "Compress-Archive -Force -CompressionLevel Optimal -ErrorAction Stop -Path ${files.map((f) => `'${f}'`).join(',')} -DestinationPath '${dest}'"`, { stdio: 'pipe' });
    } catch (e) {
      if (i >= 12) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  }
}
zip([path.join(out, 'Hamsohbat-Setup.msi')], path.join(out, 'Hamsohbat-Windows.zip'));
zip([path.join(out, 'hamsohbat-server', '*')], path.join(out, 'hamsohbat-server.zip'));
for (const f of fs.readdirSync(out)) {
  const st = fs.statSync(path.join(out, f));
  if (st.isFile()) console.log(`${f.padEnd(28)} ${(st.size / 1024).toFixed(0).padStart(6)} KB`);
}
