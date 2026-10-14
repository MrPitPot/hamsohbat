// Lists English UI strings that have no Persian translation in src/fa.ts.
// Usage: node scripts/check-i18n.mjs  (prints a JSON array; empty means everything is translated)
import fs from 'fs';
import path from 'path';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const files = [...walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('fa.ts')), 'shared/perms.ts', 'server/index.ts', 'server/features.ts'];
const keys = new Set();
const add = (k) => k && keys.add(k.replace(/\\'/g, "'"));
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) add(m[2]);
  for (const m of s.matchAll(/\b(?:toast|fail|new Error)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) add(m[2]);
  for (const m of s.matchAll(/(?:error|reason): (['"])((?:\\.|(?!\1).)*)\1/g)) add(m[2]);
  // labels in [key, 'Label', ...] tables
  for (const m of s.matchAll(/\[\s*'[\w]+',\s*'([A-Z][^']*)'\s*(?:,|\])/g)) add(m[1]);
  for (const m of s.matchAll(/\[\s*'[\w]+',\s*'[^']*',\s*'([A-Z][^']*)'\s*\]/g)) add(m[1]);
  for (const m of s.matchAll(/\[\s*(?:P\.\w+|CH\.\w+|\d+),\s*(?:\w+,\s*)?'([^']+)'(?:,\s*'([^']+)')?\s*\]/g)) (add(m[1]), add(m[2]));
  // keybind rows ['Label', 'Ctrl + K']
  for (const m of s.matchAll(/\[\s*'([A-Z][^']+)',\s*'[^']*(?:Ctrl|Alt|Esc|↑|Right-click)[^']*'\s*\]/g)) add(m[1]);
}
// Audit log sentences and the built-in sound names.
for (const m of fs.readFileSync('src/features/Server.tsx', 'utf8').matchAll(/^\s+\w+: '([^']+)',$/gm)) add(m[1]);
for (const m of fs.readFileSync('src/sfx.ts', 'utf8').match(/BUILTIN_SOUNDS = \[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)) add(m[1]);
for (const m of fs.readFileSync('src/emoji.ts', 'utf8').matchAll(/name: '([^']+)'/g)) add(m[1]);
for (const m of fs.readFileSync('src/Modals.tsx', 'utf8').matchAll(/(\w+): '([A-Z][^']+)'/g)) add(m[2]);
const src = fs.readFileSync('src/fa.ts', 'utf8').replace(/export const fa(?:: Record<string, string>)? =/, 'module.exports =');
const mod = { exports: {} };
new Function('module', src)(mod);
const builtin = new Set(fs.readFileSync('src/sfx.ts', 'utf8').match(/BUILTIN_SOUNDS = \[([^\]]+)\]/)[1].match(/\w+/g));
const miss = [...keys].filter((k) => !(k in mod.exports) && !/^(INTEGER|TEXT)/.test(k) && (/[a-zA-Z]/.test(k) && (!/^[\w-]+$/.test(k) || /^[A-Z]/.test(k) || builtin.has(k))));
console.log(JSON.stringify(miss.sort(), null, 1));
