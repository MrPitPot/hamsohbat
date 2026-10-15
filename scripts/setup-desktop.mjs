// Downloads what the Windows app needs to build (not stored in git):
//   desktop/.deps/wv2          Microsoft WebView2 SDK (NuGet package)
//   desktop/.deps/tsclientlib  TeamSpeak client library (ReSpeak/tsclientlib, MIT/Apache-2.0)
// Usage: node scripts/setup-desktop.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEBVIEW2_VERSION = '1.0.4258.31';
const TSCLIENTLIB_COMMIT = 'ee3bc6f45a7137db7793ba5593a321df400d53e5';
const deps = path.resolve('desktop/.deps');
fs.mkdirSync(deps, { recursive: true });
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd });

const wv2 = path.join(deps, 'wv2');
if (!fs.existsSync(path.join(wv2, 'build/native/include/WebView2.h'))) {
  console.log(`Downloading WebView2 SDK ${WEBVIEW2_VERSION}…`);
  const res = await fetch(`https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${WEBVIEW2_VERSION}`);
  if (!res.ok) throw new Error('NuGet download failed: ' + res.status);
  const zip = path.join(os.tmpdir(), `webview2-${WEBVIEW2_VERSION}.zip`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  run(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip}' -DestinationPath '${wv2}'"`);
  fs.rmSync(zip);
}

const ts = path.join(deps, 'tsclientlib');
if (!fs.existsSync(path.join(ts, 'tsclientlib'))) {
  console.log('Cloning tsclientlib…');
  run(`git clone https://github.com/ReSpeak/tsclientlib.git "${ts}"`);
}
run(`git checkout ${TSCLIENTLIB_COMMIT}`, ts);
run('git submodule update --init', ts);
// Displayed ping must come from ping/pong only (command acks include server processing time and read ~70 ms high).
{
  const f = path.join(ts, 'tsproto', 'src', 'resend.rs');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('is_ping: bool')) {
    s = s
      .replace('con.resender.update_srtt(now - rec.sent);', 'con.resender.update_srtt(now - rec.sent, false);')
      .replace('con.resender.update_srtt(now - ping.sent);', 'con.resender.update_srtt(now - ping.sent, true);')
      .replace('fn update_srtt(&mut self, rtt: Duration) {', 'fn update_srtt(&mut self, rtt: Duration, is_ping: bool) {')
      .replace('		// Rtt (non-smoothed)
', '		if !is_ping && self.stats.rtt != Duration::ZERO {
			return;
		}
		// Rtt (non-smoothed)
');
    fs.writeFileSync(f, s);
  }
}
// Mihomo (Clash.Meta) core for the experimental Discord-through-proxy window. Pinned release, checked by SHA-256.
const MIHOMO = {
  version: 'v1.19.32',
  sha256: '1ac84e795b5b915446e20139677fb6cc013a0778e876e8d4c96f994750b4c4a3',
};
const mihomoDir = path.join(deps, 'mihomo');
if (!fs.existsSync(path.join(mihomoDir, 'mihomo.exe'))) {
  const name = `mihomo-windows-amd64-${MIHOMO.version}.zip`;
  console.log(`Downloading Mihomo ${MIHOMO.version}…`);
  const res = await fetch(`https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO.version}/${name}`);
  if (!res.ok) throw new Error('Mihomo download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
  if (got !== MIHOMO.sha256) throw new Error(`Mihomo checksum mismatch (${got}); refusing to use it.`);
  const zip = path.join(os.tmpdir(), name);
  fs.writeFileSync(zip, buf);
  fs.mkdirSync(mihomoDir, { recursive: true });
  run(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip}' -DestinationPath '${mihomoDir}'"`);
  fs.rmSync(zip);
  const exe = fs.readdirSync(mihomoDir).find((f) => /^mihomo.*\.exe$/i.test(f));
  if (!exe) throw new Error('mihomo.exe not found in the archive');
  if (exe !== 'mihomo.exe') fs.renameSync(path.join(mihomoDir, exe), path.join(mihomoDir, 'mihomo.exe'));
}
console.log('Desktop build dependencies are ready.');
