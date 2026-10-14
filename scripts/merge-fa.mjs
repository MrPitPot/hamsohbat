// Merges scripts/fa-additions.json into src/fa.ts (keys that already exist are kept) and deletes the JSON.
import fs from 'fs';
const add = JSON.parse(fs.readFileSync('scripts/fa-additions.json', 'utf8'));
let src = fs.readFileSync('src/fa.ts', 'utf8');
const mod = { exports: {} };
new Function('module', src.replace(/export const fa(?:: Record<string, string>)? =/, 'module.exports ='))(mod);
const lines = Object.entries(add).filter(([k]) => !(k in mod.exports)).map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',');
src = src.replace(/\n};\s*$/, '\n' + lines.join('\n') + '\n};\n');
fs.writeFileSync('src/fa.ts', src);
fs.unlinkSync('scripts/fa-additions.json');
console.log('added', lines.length);
