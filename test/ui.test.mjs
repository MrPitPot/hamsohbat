// End-to-end UI test of the Discord-style features in a real (headless) browser: channel types, forums,
// threads, polls, custom emoji, stickers, rich text, forwarding, webhooks, events, moderation (time-outs, server
// mute), stage channels, the soundboard, the quick switcher, the inbox, folders, two-factor auth and Persian.
// Run `npm run dev` first, then `node test/ui.test.mjs`. Uses the locally installed Chrome (or Edge).
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const run = Date.now().toString(36);
let passed = 0;
const failures = [];
const pageErrors = [];
const ok = (cond, name) => {
  if (cond) passed++;
  else failures.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
};
async function api(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const PW = 'ui-test-pw-1';
const mkUser = async (name) => (await api(null, 'POST', '/api/auth/register', { username: name + '_' + run, password: PW, displayName: name })).token;

/** A tiny solid-colour PNG, for emoji and sticker uploads. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0, ...Array.from({ length: w }, () => [r, g, b]).flat()]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function totp(secret) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alpha.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const ta = await mkUser('ui_anna');
const tb = await mkUser('ui_ben');
const { id: serverId } = await api(ta, 'POST', '/api/servers', { name: 'UI Test ' + run, locale: 'en' });
const { code } = await api(ta, 'POST', `/api/servers/${serverId}/invites`, {});
await api(tb, 'POST', '/api/invites/' + code);
const forum = (await api(ta, 'POST', `/api/servers/${serverId}/channels`, { name: 'ideas', type: 15 })).id;
const news = (await api(ta, 'POST', `/api/servers/${serverId}/channels`, { name: 'news', type: 5 })).id;
const stage = (await api(ta, 'POST', `/api/servers/${serverId}/channels`, { name: 'Town Hall', type: 13 })).id;
const secret = (await api(ta, 'POST', `/api/servers/${serverId}/channels`, { name: 'secret', type: 0, private: true })).id;

let browser;
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
for (const channel of ['chrome', 'msedge']) {
  try {
    browser = await chromium.launch({ channel, headless: true, args });
    break;
  } catch {}
}
if (!browser) {
  console.log('No Edge or Chrome found; skipping.');
  process.exit(0);
}
async function open(token, lang = 'en') {
  const ctx = await browser.newContext({ permissions: ['microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(
    ([t, l]) => {
      localStorage.setItem('token', t);
      if (!localStorage.getItem('settings')) localStorage.setItem('settings', JSON.stringify({ lang: l, reducedMotion: 'on' }));
    },
    [token, lang]
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (pageErrors.push(e.message), console.log('  [page error]', e.message)));
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && (pageErrors.push(m.text()), console.log('  [CSP]', m.text())));
  await page.goto(BASE + '/channels/' + serverId);
  await page.waitForSelector('.channel');
  return page;
}
async function until(page, fn, arg, ms = 10000) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 150 });
    return true;
  } catch {
    return false;
  }
}
const chan = (page, name) => {
  const loc = page.locator('.sidebar .channel', { hasText: new RegExp('^' + name + '[0-9]*$') }).first();
  return {
    click: async (opts) => {
      await loc.click(opts);
      await page.waitForTimeout(250);
    },
  };
};
const menuClick = async (page, label) => page.locator('.menu .menu-item', { hasText: label }).first().click();

try {
  const A = await open(ta);
  const B = await open(tb);
  const st = (page, fn) => page.evaluate(fn);
  const generalId = await A.evaluate((sid) => window.__store.getState().servers[sid].channels.find((c) => c.name === 'general').id, serverId);

  console.log('• channel types & visibility');
  ok(await A.locator('.sidebar .channel .lucide-messages-square').count() >= 1, 'forum channel has its icon');
  ok(await A.locator('.sidebar .channel .lucide-megaphone').count() === 1, 'announcement channel has its icon');
  ok(await A.locator('.sidebar .channel .lucide-podcast').count() === 1, 'stage channel has its icon');
  ok(await A.locator('.sidebar .channel', { hasText: 'secret' }).locator('.ch-lock').count() === 1, 'private channel shows a lock');
  ok((await B.locator('.sidebar .channel', { hasText: 'secret' }).count()) === 0, 'members without access do not see the private channel');
  ok(await A.evaluate(() => location.pathname.split('/').length === 4 && !!document.querySelector('.channel.active .lucide-hash')), 'opening a server lands on a text channel');

  console.log('• announcement channel');
  await chan(B, 'news').click();
  ok(await until(B, () => document.querySelector('.composer.disabled')?.textContent.includes('Only moderators')), 'members cannot post in announcement channels');
  await chan(A, 'news').click();
  ok(await until(A, () => !!document.querySelector('.composer textarea')), 'moderators can post in announcement channels');

  console.log('• rich text');
  await chan(A, 'general').click();
  await until(A, (id) => location.pathname.endsWith(id), generalId);
  await A.waitForSelector('.composer textarea');
  const ts = Math.floor(Date.now() / 1000) - 3600;
  await A.locator('.composer textarea').fill(`see #news and [the docs](https://example.com/docs) <t:${ts}:R>`);
  await A.keyboard.press('Enter');
  ok(await until(A, () => !!document.querySelector('.msg .channel-mention')), '#channel becomes a channel mention');
  ok(await A.locator('.msg a[href="https://example.com/docs"]', { hasText: 'the docs' }).count() === 1, 'masked links render');
  ok(await until(A, () => /hour/.test(document.querySelector('.msg .timestamp')?.textContent || '')), '<t:…:R> renders as relative time');
  await A.locator('.msg .channel-mention').first().click();
  ok(await until(A, (id) => location.pathname.endsWith(id), news), 'clicking a channel mention opens it');
  await chan(A, 'general').click();

  console.log('• polls');
  await A.locator('.composer-row button[title="More"]').click();
  await menuClick(A, 'Create Poll');
  await A.locator('.modal input[placeholder="What question do you want to ask?"]').fill('Pizza or kebab?');
  const answers = A.locator('.modal .poll-edit-row input:not(.emoji-in)');
  await answers.nth(0).fill('Pizza');
  await answers.nth(1).fill('Kebab');
  await A.locator('.modal .btn.primary', { hasText: 'Post' }).click();
  ok(await until(A, () => document.querySelector('.poll .poll-q')?.textContent === 'Pizza or kebab?'), 'poll message appears');
  await B.goto(BASE + '/channels/' + serverId + '/' + generalId);
  await B.waitForSelector('.poll');
  await B.locator('.poll-answer', { hasText: 'Kebab' }).click();
  ok(await until(B, () => !!document.querySelector('.poll-answer.mine') && /100%/.test(document.querySelector('.poll-answer.mine .poll-pct')?.textContent || '')), 'your own vote is highlighted with results');
  ok(await until(A, () => !document.querySelector('.poll-pct')), 'results stay hidden until you vote');
  await A.locator('.poll-answer', { hasText: 'Pizza' }).click();
  ok(await until(A, () => [...document.querySelectorAll('.poll-pct')].every((e) => /50%/.test(e.textContent))), 'after voting both answers show 50%');

  console.log('• threads');
  await A.locator('.composer textarea').fill('Let us plan the trip');
  await A.keyboard.press('Enter');
  const tripMsg = A.locator('.msg', { hasText: 'Let us plan the trip' }).last();
  await tripMsg.click({ button: 'right' });
  await menuClick(A, 'Create Thread');
  await A.locator('.modal input').fill('Trip planning');
  await A.locator('.modal .btn.primary').click();
  ok(await until(A, () => document.querySelector('.main-head .head-title')?.textContent === 'Trip planning'), 'creating a thread opens it');
  ok(await A.locator('.sidebar .channel.thread', { hasText: 'Trip planning' }).count() === 1, 'thread is listed under its channel');
  await A.locator('.composer textarea').fill('first reply in the thread');
  await A.keyboard.press('Enter');
  ok(await until(A, () => [...document.querySelectorAll('.msg-content')].some((e) => e.textContent.includes('first reply in the thread'))), 'messages can be sent in a thread');
  await A.locator('.main-head .crumb').click();
  ok(await until(A, () => !!document.querySelector('.thread-chip')), 'starter message shows a thread chip');
  ok(await until(A, () => /1 Messages|Messages/.test(document.querySelector('.thread-chip')?.textContent || '')), 'thread chip shows the reply count');

  console.log('• forum');
  await chan(A, 'ideas').click();
  await A.locator('.forum-bar .btn.primary').click();
  await A.locator('.new-post .np-title').fill('Add dark mode to the fridge');
  await A.locator('.new-post textarea').fill('It is too bright at night.');
  await A.locator('.new-post .btn.primary').click();
  ok(await until(A, () => document.querySelector('.main-head .head-title')?.textContent === 'Add dark mode to the fridge'), 'creating a forum post opens it');
  await A.locator('.main-head .crumb').click();
  ok(await until(A, () => !!document.querySelector('.forum-post h3')), 'forum lists the post');

  console.log('• forwarding & message tools');
  await chan(A, 'general').click();
  await A.locator('.msg', { hasText: 'Let us plan the trip' }).last().click({ button: 'right' });
  await menuClick(A, 'Forward');
  await A.locator('.modal .pick-row', { hasText: 'news' }).click();
  await A.locator('.modal .btn.primary', { hasText: 'Send' }).click();
  await chan(A, 'news').click();
  ok(await until(A, () => !!document.querySelector('.forwarded') && document.querySelector('.forwarded').textContent.includes('Let us plan the trip')), 'forwarded message shows in the target channel');
  await chan(A, 'general').click();
  await A.locator('.msg', { hasText: 'Let us plan the trip' }).last().click({ button: 'right' });
  await menuClick(A, 'Copy Message Link');
  ok((await A.evaluate(() => navigator.clipboard.readText())).includes('/channels/' + serverId), 'message link is copied');

  console.log('• custom emoji & stickers');
  await A.locator('.sidebar-head').click();
  await menuClick(A, 'Server Settings');
  await A.locator('.settings-nav button', { hasText: 'Emoji' }).click();
  await A.locator('.settings-body input[type=file]').setInputFiles({ name: 'party_blob.png', mimeType: 'image/png', buffer: png(64, 64, [240, 120, 40]) });
  ok(await until(A, () => document.querySelectorAll('.expr-row').length === 1, null, 15000), 'emoji uploads in server settings');
  await A.locator('.settings-nav button', { hasText: 'Stickers' }).click();
  await A.locator('.settings-body input[type=file]').setInputFiles({ name: 'wave.png', mimeType: 'image/png', buffer: png(160, 160, [40, 160, 240]) });
  ok(await until(A, () => document.querySelectorAll('.expr-row').length === 1, null, 15000), 'sticker uploads in server settings');
  await A.locator('.settings-nav button', { hasText: 'Audit Log' }).click();
  ok(await until(A, () => document.querySelectorAll('.audit-row').length >= 3), 'audit log lists recent actions');
  await A.locator('.settings-nav button', { hasText: 'AutoMod' }).click();
  await A.locator('.settings-body .setting-row .toggle').first().click();
  await A.locator('.settings-body textarea').fill('forbiddenword');
  await A.locator('.settings-body .btn.primary', { hasText: 'Save Changes' }).click();
  ok(await until(A, () => window.__store.getState().servers[Object.keys(window.__store.getState().servers)[0]] && Object.values(window.__store.getState().servers).some((s) => s.automod?.enabled)), 'AutoMod rules save');
  await A.locator('.settings-nav button', { hasText: 'Integrations' }).click();
  await A.locator('.settings-body .btn.primary', { hasText: 'New Webhook' }).click();
  ok(await until(A, () => !!document.querySelector('.webhook-card')), 'webhook is created');
  const hookUrl = await A.evaluate(async (sid) => (await (await fetch('/api/servers/' + sid + '/webhooks', { headers: { authorization: 'Bearer ' + localStorage.getItem('token') } })).json())[0].url, serverId);
  await A.keyboard.press('Escape');
  await api(null, 'POST', hookUrl, { content: 'Build passed ✅', username: 'CI Bot', embeds: [{ title: 'Release 1.3', description: 'All tests green', color: 0x23a559, fields: [{ name: 'Tests', value: '400+', inline: true }] }] });
  ok(await until(A, () => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('CI Bot') && m.querySelector('.bot-tag') && m.querySelector('.rich-embed'))), 'webhook messages show the bot name, APP tag and embed');

  await B.locator('.composer textarea').fill('this has a forbiddenword inside');
  await B.keyboard.press('Enter');
  ok(await until(B, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('AutoMod'))), 'AutoMod blocks a message with a banned word');

  await A.locator('.composer textarea').fill('hello :party_');
  ok(await until(A, () => !!document.querySelector('.autocomplete img.custom-emoji')), ':emoji autocomplete suggests custom emoji');
  await A.keyboard.press('Enter');
  await A.keyboard.press('Enter');
  ok(await until(A, () => !!document.querySelector('.msg-content img.custom-emoji')), 'custom emoji renders in messages');
  await A.locator('.composer button[title="Stickers"]').click();
  await A.locator('.sticker-grid button').first().click();
  ok(await until(A, () => !!document.querySelector('.msg img.sticker')), 'stickers can be sent');
  const last = A.locator('.msg', { has: A.locator('img.sticker') }).last();
  await last.hover();
  await last.locator('.msg-tools button[title="Add Reaction"]').click();
  await A.locator('.popover .emoji-tabs button', { hasText: '⭐' }).click();
  await A.locator('.popover .custom-emoji-tab .emoji-grid button').first().click();
  ok(await until(A, () => !!document.querySelector('.reaction img.custom-emoji')), 'custom emoji can be used as reactions');

  console.log('• events');
  await A.locator('.sidebar-head').click();
  await menuClick(A, 'Create Event');
  await A.locator('.modal input[placeholder="What\'s your event?"]').fill('Movie night');
  await A.locator('.modal .btn.primary', { hasText: 'Create Event' }).click();
  ok(await until(A, () => !!document.querySelector('.event-card h3')), 'event shows in the events list');
  await A.keyboard.press('Escape');
  ok(await until(A, () => document.querySelector('.event-strip')?.textContent.includes('Movie night')), 'upcoming event shows above the channel list');
  ok(await until(B, () => document.querySelector('.event-strip')?.textContent.includes('Movie night')), 'other members see the event');

  console.log('• quick switcher & inbox');
  await A.keyboard.press('Control+k');
  await A.locator('.switcher-input').fill('news');
  await A.keyboard.press('Enter');
  ok(await until(A, (id) => location.pathname.endsWith(id), news), 'Ctrl+K jumps to a channel');
  await B.locator('.composer textarea').fill('@ui_anna_' + run + ' look at this');
  await B.keyboard.press('Escape');
  await B.locator('.composer textarea').press('Enter');
  await A.waitForTimeout(800);
  await A.keyboard.press('Control+i');
  ok(await until(A, () => [...document.querySelectorAll('.inbox .msg-card')].some((m) => m.textContent.includes('look at this'))), 'mention shows in the inbox');
  await A.keyboard.press('Escape');

  console.log('• time-outs');
  await chan(A, 'general').click();
  const benId = await B.evaluate(() => window.__store.getState().me.id);
  await A.evaluate(() => window.__store.setState({ showMembers: true }));
  await A.locator('.members .member', { hasText: 'ui_ben' }).click({ button: 'right' });
  await menuClick(A, 'Time Out');
  await A.locator('.modal .chip', { hasText: '5 minutes' }).click();
  await A.locator('.modal .btn.danger').click();
  ok(await until(B, () => document.querySelector('.composer.disabled')?.textContent.includes('timed out')), 'timed-out members cannot chat');
  ok(await until(A, () => !!document.querySelector('.members .member .lucide-clock')), 'members list marks the time-out');
  await A.locator('.members .member', { hasText: 'ui_ben' }).click({ button: 'right' });
  await menuClick(A, 'Remove Time Out');
  ok(await until(B, () => !!document.querySelector('.composer textarea')), 'removing the time-out restores chatting');

  console.log('• stage channel & soundboard');
  await chan(A, 'Town Hall').click();
  ok(await until(A, () => document.querySelectorAll('.stage-speakers .stage-person').length === 1), 'moderator joins the stage as a speaker');
  await chan(B, 'Town Hall').click();
  ok(await until(B, () => document.querySelectorAll('.stage-audience .stage-person').length === 1), 'members join the stage audience');
  ok(await B.evaluate(() => window.__voice.effectiveMute()), 'audience members cannot talk');
  await B.locator('.stage-controls .btn', { hasText: 'Request to Speak' }).click();
  ok(await until(A, () => !!document.querySelector('.stage-audience .hand')), 'speaker sees the raised hand');
  await A.locator('.stage-audience .stage-person').hover();
  await A.locator('.stage-audience .sp-actions button').click();
  ok(await until(B, () => document.querySelectorAll('.stage-speakers .stage-person').length === 2), 'invited member becomes a speaker');
  ok(await until(B, () => !window.__store.getState().voice.suppress), 'speaker is no longer suppressed');
  await B.locator('.voice-controls button[title="Soundboard"]').click();
  await B.locator('.soundboard .sb-btn', { hasText: 'airhorn' }).click();
  ok(await until(A, () => !!document.querySelector('.sb-flash')), 'soundboard sounds show up for everyone in the channel');
  await B.keyboard.press('Escape');

  console.log('• server mute / deafen');
  await A.locator('.voice-users .voice-user', { hasText: 'ui_ben' }).click({ button: 'right' });
  await menuClick(A, 'Server Mute');
  ok(await until(B, () => window.__store.getState().voice.serverMute === true), 'server mute reaches the member');
  ok(await B.evaluate(() => window.__voice.effectiveMute()), 'server-muted member is silenced');
  await A.locator('.voice-users .voice-user', { hasText: 'ui_ben' }).click({ button: 'right' });
  await menuClick(A, 'Server Unmute');
  ok(await until(B, () => window.__store.getState().voice.serverMute === false), 'server unmute reaches the member');
  await A.evaluate(() => window.__voice.leave());
  await B.evaluate(() => window.__voice.leave());

  console.log('• server folders');
  const sid2 = (await api(ta, 'POST', '/api/servers', { name: 'Second ' + run })).id;
  await until(A, (id) => !!window.__store.getState().servers[id], sid2);
  await A.locator('.rail .rail-item', { has: A.locator('[aria-label="Second ' + run + '"]') }).dragTo(A.locator('.rail .rail-item', { has: A.locator('[aria-label="UI Test ' + run + '"]') }), { targetPosition: { x: 36, y: 34 } });
  ok(await until(A, () => !!document.querySelector('.rail-folder')), 'dragging a server onto another makes a folder');
  await A.locator('.rail-folder .folder-head > button').click();
  ok(await until(A, () => document.querySelectorAll('.rail-folder.open .in-folder').length === 2), 'folder opens to show its servers');

  console.log('• account: pronouns, notes, two-factor auth');
  await A.locator('.user-panel button[title="User Settings"]').click();
  await A.locator('.settings-nav button', { hasText: 'Profile' }).click();
  await A.locator('.settings-body input[placeholder="Add your pronouns"]').fill('she/her');
  await A.locator('.settings-body .btn.primary', { hasText: 'Save Changes' }).click();
  ok(await until(A, () => window.__store.getState().me.pronouns === 'she/her' || window.__store.getState().users[window.__store.getState().me.id]?.pronouns === 'she/her'), 'pronouns save');
  await A.locator('.settings-nav button', { hasText: 'My Account' }).click();
  await A.locator('.settings-body .copy-row input[type=password]').first().fill(PW);
  await A.locator('.settings-body .btn.primary', { hasText: 'Enable Authenticator App' }).click();
  ok(await until(A, () => !!document.querySelector('.mfa-setup img')), 'QR code is shown for 2FA setup');
  const secretKey = await A.locator('.mfa-setup code').textContent();
  await A.locator('.mfa-setup input').fill(totp(secretKey));
  await A.locator('.mfa-setup .btn.primary').click();
  ok(await until(A, () => window.__store.getState().me.mfa === true), 'two-factor auth turns on');
  const login1 = await api(null, 'POST', '/api/auth/login', { username: 'ui_anna_' + run, password: PW });
  ok(login1.mfa === true && !login1.token, 'login now asks for a code');
  const login2 = await api(null, 'POST', '/api/auth/login', { username: 'ui_anna_' + run, password: PW, code: totp(secretKey) });
  ok(!!login2.token, 'login works with the code');
  await A.keyboard.press('Escape');
  await chan(B, 'general').click();
  await B.locator('.msg .msg-head b', { hasText: 'ui_anna' }).first().click();
  await B.locator('.modal .note-field').fill('met at the lan party');
  await B.locator('.modal h4').first().click();
  ok(await until(B, () => Object.values(window.__store.getState().notes).includes('met at the lan party')), 'private notes about users save');
  await B.keyboard.press('Escape');

  console.log('• input sensitivity');
  ok(await A.evaluate(() => window.__voice.threshold() < 0 && window.__store.getState().settings.vadAuto !== false), 'automatic input sensitivity is on by default');
  await A.evaluate(() => window.__voice.leave());

  console.log('• Persian interface');
  const C = await open(tb, 'fa');
  await C.waitForSelector('.channel');
  ok(await C.evaluate(() => document.documentElement.dir === 'rtl'), 'Persian switches to right-to-left');
  await C.locator('.sidebar-head').click();
  const menuText = await C.locator('.menu').textContent();
  ok(/رویداد/.test(menuText) && /تنظیمات اعلان/.test(menuText), 'new menu items are translated');
  await C.keyboard.press('Escape');
  await C.close();
} catch (e) {
  failures.push('crashed: ' + e.message);
  console.log(e);
}
ok(pageErrors.length === 0, 'no JavaScript errors in the pages');
await browser.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed:\n  - ' + failures.join('\n  - '));
process.exit(failures.length ? 1 : 0);
