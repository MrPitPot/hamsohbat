// Bundles the self-hosted server into release/hamsohbat-server/ (one server.mjs + the web app).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'release/hamsohbat-server';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['selfhost/server.ts'],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  alias: { 'cloudflare:workers': './selfhost/shim.ts' },
  external: ['bufferutil', 'utf-8-validate'],
  // `ws` is CommonJS and calls require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

fs.cpSync('dist', path.join(out, 'public'), { recursive: true });
for (const f of fs.readdirSync('selfhost/files')) fs.copyFileSync(path.join('selfhost/files', f), path.join(out, f));
console.log('built', out);
