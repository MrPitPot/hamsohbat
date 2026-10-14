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
console.log('Desktop build dependencies are ready.');
