// Renders public/favicon.svg into PNGs (PWA + Apple) and a multi-size Windows .ico, using local Chrome.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
const page = await browser.newPage();
const render = async (size, pad = 0) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  return page.screenshot({ omitBackground: true, type: 'png' });
};
fs.mkdirSync('public/icons', { recursive: true });
fs.writeFileSync('public/icons/icon-192.png', await render(192));
fs.writeFileSync('public/icons/icon-512.png', await render(512));
fs.writeFileSync('public/icons/apple-touch-icon.png', await render(180));
// ICO with PNG-compressed entries (supported since Windows Vista).
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push(await render(s));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, e);
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.mkdirSync('desktop', { recursive: true });
fs.writeFileSync('desktop/app.ico', Buffer.concat([header, ...pngs]));
await browser.close();
console.log('icons written');
