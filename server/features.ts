// Discord-style features on top of the core Hub: threads & forums, polls, events, expressions (emoji, stickers,
// soundboard), audit log, mentions inbox, forwarding, notes, webhooks, AutoMod settings, two-factor auth,
// account deletion, voice moderation (server mute/deafen, move, stage) and importing servers from Discord.
import { P, ALL_PERMS, CH, REL, VOICE_LIKE, MAX_MESSAGE_LENGTH } from '../shared/perms';
import { fail, json, str, randHex, hashPassword, verifyTotp, base32Encode } from './util';
import type { Att } from './index';

type Hub = any;

const NAME_RE = /^[\p{L}\p{N}_]{2,32}$/u;

export function registerFeatureRoutes(hub: Hub) {
  const on = hub.on.bind(hub);

  // ---------------------------------------------------------------- threads & forum posts
  on('POST', '/api/channels/:id/threads', ({ me, p, body }: any) => {
    const { ch, perms } = hub.access(me.id, p.id);
    if (![CH.TEXT, CH.ANNOUNCEMENT, CH.FORUM].includes(ch.type)) fail('Threads can only be started in text channels and forums');
    if (!(perms & P.CREATE_THREADS)) fail('You do not have permission to do that', 403);
    const name = str(body.name, 100);
    if (!name) fail('Name is required');
    let starter: any = null;
    if (body.messageId) {
      starter = hub.one('SELECT * FROM messages WHERE id=? AND channel_id=?', String(body.messageId), ch.id);
      if (!starter) fail('Not found', 404);
      if (starter.thread_id) fail('This message already has a thread');
    }
    if (ch.type === CH.FORUM && !str(body.content, MAX_MESSAGE_LENGTH) && !(body.attachments || []).length) fail('A forum post needs a message');
    const id = hub.id();
    hub.run(
      'INSERT INTO channels(id, server_id, type, name, parent_id, position, owner_id, thread_msg_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      ch.server_id,
      CH.THREAD,
      name,
      ch.id,
      0,
      me.id,
      starter?.id || null,
      Date.now()
    );
    hub.pushChannels(ch.server_id);
    if (starter) {
      hub.run('UPDATE messages SET thread_id=? WHERE id=?', id, starter.id);
      hub.send(hub.audience(ch), { op: 'MESSAGE_UPDATE', message: hub.msg(starter.id) });
    }
    if (ch.type === CH.FORUM) {
      const attachments = takeAttachments(hub, me.id, id, body.attachments);
      hub.createMessage(id, me.id, { content: str(body.content, MAX_MESSAGE_LENGTH), attachments });
    } else if (!starter) {
      // "X started a thread" notice in the parent channel.
      hub.createMessage(ch.id, me.id, { type: 3, content: name, replyTo: null });
      hub.run("UPDATE messages SET thread_id=? WHERE id=(SELECT MAX(id) FROM messages WHERE channel_id=? AND type=3)", id, ch.id);
    }
    hub.audit(ch.server_id, me.id, 'thread_create', id, { name });
    return { id };
  });
  on('GET', '/api/channels/:id/threads', ({ me, p }: any) => {
    const { ch } = hub.access(me.id, p.id);
    const rows = hub.all('SELECT * FROM channels WHERE parent_id=? AND type=? ORDER BY COALESCE(last_message_id, id) DESC LIMIT 100', ch.id, CH.THREAD);
    const first: Record<string, any> = {};
    for (const t of rows) {
      const m = hub.one('SELECT * FROM messages WHERE channel_id=? AND type=0 ORDER BY id LIMIT 1', t.id);
      if (m) first[t.id] = hub.hydrate([m])[0];
    }
    const users = hub.users([...rows.map((r: any) => r.owner_id), ...Object.values(first).map((m: any) => m.authorId)].filter(Boolean));
    return { threads: rows.map((t: any) => ({ ...hub.chanObj(t), firstMessage: first[t.id] || null })), users };
  });

  // ---------------------------------------------------------------- polls
  const pollMessage = (uid: string, mid: string) => {
    const m = hub.one('SELECT * FROM messages WHERE id=?', mid);
    if (!m || !m.poll) return fail('Not found', 404);
    const { ch, perms } = hub.access(uid, m.channel_id);
    return { m, ch, perms, poll: JSON.parse(m.poll) };
  };
  const pushMsg = (ch: any, mid: string) => hub.send(hub.audience(ch), { op: 'MESSAGE_UPDATE', message: hub.msg(mid) });
  on('PUT', '/api/messages/:id/poll/:answer', ({ me, p }: any) => {
    const { m, ch, poll } = pollMessage(me.id, p.id);
    const answer = Number(p.answer);
    if (poll.expiresAt < Date.now()) fail('This poll has ended');
    if (!poll.answers.some((a: any) => a.id === answer)) fail('Not found', 404);
    if (!poll.multi) hub.run('DELETE FROM poll_votes WHERE message_id=? AND user_id=?', m.id, me.id);
    hub.run('INSERT OR IGNORE INTO poll_votes(message_id, answer_id, user_id) VALUES(?,?,?)', m.id, answer, me.id);
    pushMsg(ch, m.id);
  });
  on('DELETE', '/api/messages/:id/poll/:answer', ({ me, p }: any) => {
    const { m, ch, poll } = pollMessage(me.id, p.id);
    if (poll.expiresAt < Date.now()) fail('This poll has ended');
    hub.run('DELETE FROM poll_votes WHERE message_id=? AND answer_id=? AND user_id=?', m.id, Number(p.answer), me.id);
    pushMsg(ch, m.id);
  });
  on('POST', '/api/messages/:id/poll/end', ({ me, p }: any) => {
    const { m, ch, perms, poll } = pollMessage(me.id, p.id);
    if (m.author_id !== me.id && !(ch.server_id && perms & P.MANAGE_MESSAGES)) fail('You do not have permission to do that', 403);
    poll.expiresAt = Math.min(poll.expiresAt, Date.now());
    hub.run('UPDATE messages SET poll=? WHERE id=?', JSON.stringify(poll), m.id);
    pushMsg(ch, m.id);
  });

  // ---------------------------------------------------------------- scheduled events
  const eventFields = (sid: string, body: any, old: any = {}) => {
    const startAt = body.startAt !== undefined ? Number(body.startAt) : old.start_at;
    if (!startAt || isNaN(startAt)) fail('Pick a start time');
    let channelId = body.channelId !== undefined ? (body.channelId ? String(body.channelId) : null) : old.channel_id;
    if (channelId && !hub.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', channelId, sid)) channelId = null;
    return {
      name: body.name !== undefined ? str(body.name, 100) || fail('Name is required') : old.name,
      description: body.description !== undefined ? str(body.description, 1000) : old.description || '',
      location: body.location !== undefined ? str(body.location, 100) : old.location || '',
      startAt,
      endAt: body.endAt !== undefined ? Number(body.endAt) || null : old.end_at || null,
      channelId,
    };
  };
  on('POST', '/api/servers/:id/events', ({ me, p, body }: any) => {
    hub.need(p.id, me.id, P.MANAGE_EVENTS);
    const f = eventFields(p.id, body);
    const id = hub.id();
    hub.run(
      'INSERT INTO events(id, server_id, channel_id, name, description, location, start_at, end_at, status, creator_id, created_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)',
      id,
      p.id,
      f.channelId,
      f.name,
      f.description,
      f.location,
      f.startAt,
      f.endAt,
      me.id,
      Date.now()
    );
    hub.run('INSERT OR IGNORE INTO event_users(event_id, user_id) VALUES(?,?)', id, me.id);
    hub.audit(p.id, me.id, 'event_create', id, { name: f.name });
    hub.pushServerData(p.id);
    return { id };
  });
  const ownEvent = (uid: string, eid: string) => {
    const e = hub.one('SELECT * FROM events WHERE id=?', eid);
    if (!e || !hub.perms(e.server_id, uid)) return fail('Not found', 404);
    return e;
  };
  on('PATCH', '/api/events/:id', ({ me, p, body }: any) => {
    const e = ownEvent(me.id, p.id);
    if (e.creator_id !== me.id) hub.need(e.server_id, me.id, P.MANAGE_EVENTS);
    const f = eventFields(e.server_id, body, e);
    const status = body.status !== undefined ? Math.max(1, Math.min(3, Number(body.status) || 1)) : e.status;
    hub.run(
      'UPDATE events SET name=?, description=?, location=?, start_at=?, end_at=?, channel_id=?, status=? WHERE id=?',
      f.name,
      f.description,
      f.location,
      f.startAt,
      f.endAt,
      f.channelId,
      status,
      e.id
    );
    hub.audit(e.server_id, me.id, status === 3 ? 'event_end' : 'event_update', e.id, { name: f.name });
    hub.pushServerData(e.server_id);
  });
  on('DELETE', '/api/events/:id', ({ me, p }: any) => {
    const e = ownEvent(me.id, p.id);
    if (e.creator_id !== me.id) hub.need(e.server_id, me.id, P.MANAGE_EVENTS);
    hub.run('DELETE FROM events WHERE id=?', e.id);
    hub.run('DELETE FROM event_users WHERE event_id=?', e.id);
    hub.audit(e.server_id, me.id, 'event_delete', e.id, { name: e.name });
    hub.pushServerData(e.server_id);
  });
  on('PUT', '/api/events/:id/interest', ({ me, p }: any) => {
    const e = ownEvent(me.id, p.id);
    hub.run('INSERT OR IGNORE INTO event_users(event_id, user_id) VALUES(?,?)', e.id, me.id);
    hub.pushServerData(e.server_id);
  });
  on('DELETE', '/api/events/:id/interest', ({ me, p }: any) => {
    const e = ownEvent(me.id, p.id);
    hub.run('DELETE FROM event_users WHERE event_id=? AND user_id=?', e.id, me.id);
    hub.pushServerData(e.server_id);
  });

  // ---------------------------------------------------------------- emoji, stickers, soundboard sounds
  const ownUpload = (uid: string, fileId: string, kind: 'image' | 'audio', maxBytes: number) => {
    const f = hub.one('SELECT * FROM files WHERE id=? AND uploader_id=?', String(fileId), uid);
    if (!f || !f.type.startsWith(kind + '/')) return fail(kind === 'image' ? 'Invalid image' : 'Invalid sound');
    if (f.size > maxBytes) fail('File is too large', 413);
    return f;
  };
  const expression = (table: string, label: string, kind: 'image' | 'audio', maxBytes: number, limit: number) => {
    on('POST', `/api/servers/:id/${table}`, ({ me, p, body }: any) => {
      hub.need(p.id, me.id, P.MANAGE_EXPRESSIONS);
      const name = str(body.name, 32).replace(/\s+/g, '_');
      if (!NAME_RE.test(name)) fail('Names must be 2-32 letters, numbers or underscores');
      if (hub.one(`SELECT COUNT(*) AS c FROM ${table} WHERE server_id=?`, p.id).c >= limit) fail(`This server has reached its ${label} limit`);
      const f = ownUpload(me.id, body.fileId, kind, maxBytes);
      hub.run("UPDATE files SET ref='expression' WHERE id=?", f.id);
      if (table === 'emojis')
        hub.run('INSERT INTO emojis(id, server_id, name, creator_id, animated, created_at) VALUES(?,?,?,?,?,?)', f.id, p.id, name, me.id, f.type === 'image/gif' ? 1 : 0, Date.now());
      else if (table === 'stickers') hub.run('INSERT INTO stickers(id, server_id, name, creator_id, created_at) VALUES(?,?,?,?,?)', f.id, p.id, name, me.id, Date.now());
      else
        hub.run(
          'INSERT INTO sounds(id, server_id, name, emoji, volume, creator_id, created_at) VALUES(?,?,?,?,?,?,?)',
          f.id,
          p.id,
          name,
          str(body.emoji, 16) || null,
          Math.max(0.1, Math.min(1, Number(body.volume) || 1)),
          me.id,
          Date.now()
        );
      hub.audit(p.id, me.id, `${label}_create`, f.id, { name });
      hub.pushServerData(p.id);
      return { id: f.id };
    });
    on('PATCH', `/api/${table}/:id`, ({ me, p, body }: any) => {
      const row = hub.one(`SELECT * FROM ${table} WHERE id=?`, p.id);
      if (!row) return fail('Not found', 404);
      hub.need(row.server_id, me.id, P.MANAGE_EXPRESSIONS);
      const name = body.name !== undefined ? str(body.name, 32).replace(/\s+/g, '_') : row.name;
      if (!NAME_RE.test(name)) fail('Names must be 2-32 letters, numbers or underscores');
      hub.run(`UPDATE ${table} SET name=? WHERE id=?`, name, row.id);
      if (table === 'sounds')
        hub.run('UPDATE sounds SET emoji=?, volume=? WHERE id=?', body.emoji !== undefined ? str(body.emoji, 16) || null : row.emoji, body.volume !== undefined ? Math.max(0.1, Math.min(1, Number(body.volume) || 1)) : row.volume, row.id);
      hub.pushServerData(row.server_id);
    });
    on('DELETE', `/api/${table}/:id`, ({ me, p }: any) => {
      const row = hub.one(`SELECT * FROM ${table} WHERE id=?`, p.id);
      if (!row) return fail('Not found', 404);
      hub.need(row.server_id, me.id, P.MANAGE_EXPRESSIONS);
      hub.run(`DELETE FROM ${table} WHERE id=?`, row.id);
      hub.audit(row.server_id, me.id, `${label}_delete`, row.id, { name: row.name });
      hub.pushServerData(row.server_id);
    });
  };
  expression('emojis', 'emoji', 'image', 256 * 1024, 100);
  expression('stickers', 'sticker', 'image', 512 * 1024, 30);
  expression('sounds', 'sound', 'audio', 1024 * 1024, 50);

  // ---------------------------------------------------------------- audit log
  on('GET', '/api/servers/:id/audit-log', ({ me, p, q }: any) => {
    hub.need(p.id, me.id, P.VIEW_AUDIT_LOG);
    const conds = ['server_id=?'];
    const args: any[] = [p.id];
    if (q.get('before')) conds.push('id<?'), args.push(q.get('before'));
    if (q.get('user')) conds.push('user_id=?'), args.push(q.get('user'));
    if (q.get('action')) conds.push('action LIKE ?'), args.push(q.get('action') + '%');
    const rows = hub.all(`SELECT * FROM audit_log WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 50`, ...args);
    return {
      entries: rows.map((r: any) => ({ id: r.id, userId: r.user_id, action: r.action, targetId: r.target_id, changes: JSON.parse(r.changes || 'null'), reason: r.reason, createdAt: r.created_at })),
      users: hub.users(rows.flatMap((r: any) => [r.user_id, r.target_id]).filter((x: any) => x && /^\d+$/.test(x))),
    };
  });

  // ---------------------------------------------------------------- mentions inbox
  on('GET', '/api/mentions', ({ me, q }: any) => {
    const rows = hub.all(
      `SELECT * FROM messages WHERE id<? AND type=0 AND author_id<>? AND (mentions LIKE ? OR mention_everyone=1) AND channel_id IN (
         SELECT id FROM channels WHERE server_id IN (SELECT server_id FROM members WHERE user_id=?)
         UNION SELECT channel_id FROM dm_members WHERE user_id=?)
       ORDER BY id DESC LIMIT 150`,
      q.get('before') || '9999999999999999999',
      me.id,
      `%"${me.id}"%`,
      me.id,
      me.id
    );
    const ok: any[] = [];
    for (const r of rows) {
      try {
        hub.access(me.id, r.channel_id);
        ok.push(r);
      } catch {}
      if (ok.length >= 25) break;
    }
    return { messages: hub.hydrate(ok), users: hub.users(ok.map((r) => r.author_id)), more: rows.length === 150 };
  });

  // ---------------------------------------------------------------- forwarding
  on('POST', '/api/messages/:id/forward', ({ me, p, body }: any) => {
    const m = hub.one('SELECT * FROM messages WHERE id=?', p.id);
    if (!m || m.type) return fail('Not found', 404);
    const src = hub.access(me.id, m.channel_id).ch;
    const { ch, perms } = hub.access(me.id, String(body.channelId));
    if (!(perms & (ch.type === CH.THREAD ? P.SEND_IN_THREADS : P.SEND_MESSAGES)) || [CH.CATEGORY, CH.FORUM].includes(ch.type)) fail('You do not have permission to do that', 403);
    const snapshot = {
      messageId: m.id,
      channelId: m.channel_id,
      serverId: src.server_id,
      authorId: m.author_id,
      content: m.content,
      attachments: JSON.parse(m.attachments || '[]'),
      embeds: JSON.parse(m.embeds || '[]'),
      createdAt: m.created_at,
    };
    return hub.createMessage(ch.id, me.id, { content: str(body.comment, MAX_MESSAGE_LENGTH), forwarded: snapshot });
  });

  // ---------------------------------------------------------------- notes about other users (private)
  on('PUT', '/api/users/:id/note', ({ me, p, body }: any) => {
    const note = str(body.note, 256);
    if (note) hub.run('INSERT OR REPLACE INTO notes(user_id, target_id, note) VALUES(?,?,?)', me.id, p.id, note);
    else hub.run('DELETE FROM notes WHERE user_id=? AND target_id=?', me.id, p.id);
    hub.send([me.id], { op: 'NOTE', userId: p.id, note });
  });

  // ---------------------------------------------------------------- webhooks (Discord-compatible execute endpoint)
  const hookObj = (w: any, withToken: boolean) => ({
    id: w.id,
    serverId: w.server_id,
    channelId: w.channel_id,
    name: w.name,
    avatar: w.avatar,
    creatorId: w.creator_id,
    createdAt: w.created_at,
    token: withToken ? w.token : undefined,
    url: withToken ? `/api/webhooks/${w.id}/${w.token}` : undefined,
  });
  on('GET', '/api/servers/:id/webhooks', ({ me, p }: any) => {
    hub.need(p.id, me.id, P.MANAGE_WEBHOOKS);
    return hub.all('SELECT * FROM webhooks WHERE server_id=? ORDER BY created_at', p.id).map((w: any) => hookObj(w, true));
  });
  on('POST', '/api/channels/:id/webhooks', ({ me, p, body }: any) => {
    const { ch, perms } = hub.access(me.id, p.id);
    if (!ch.server_id || ![CH.TEXT, CH.ANNOUNCEMENT, CH.VOICE, CH.FORUM].includes(ch.type)) fail('Webhooks only work in server text channels');
    if (!(perms & P.MANAGE_WEBHOOKS)) fail('You do not have permission to do that', 403);
    if (hub.one('SELECT COUNT(*) AS c FROM webhooks WHERE server_id=?', ch.server_id).c >= 50) fail('This server has reached its webhook limit');
    const id = hub.id();
    const avatar = body.avatar ? hub.ownImage(me.id, body.avatar, null) : null;
    hub.run(
      'INSERT INTO webhooks(id, server_id, channel_id, name, avatar, token, creator_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
      id,
      ch.server_id,
      ch.id,
      str(body.name, 80) || 'Captain Hook',
      avatar,
      randHex(32),
      me.id,
      Date.now()
    );
    hub.audit(ch.server_id, me.id, 'webhook_create', id, { name: str(body.name, 80) || 'Captain Hook' });
    return hookObj(hub.one('SELECT * FROM webhooks WHERE id=?', id), true);
  });
  const ownHook = (uid: string, id: string) => {
    const w = hub.one('SELECT * FROM webhooks WHERE id=?', id);
    if (!w) return fail('Not found', 404);
    hub.need(w.server_id, uid, P.MANAGE_WEBHOOKS);
    return w;
  };
  on('PATCH', '/api/webhooks/:id', ({ me, p, body }: any) => {
    const w = ownHook(me.id, p.id);
    let channel = w.channel_id;
    if (body.channelId && hub.one('SELECT 1 FROM channels WHERE id=? AND server_id=?', String(body.channelId), w.server_id)) channel = String(body.channelId);
    hub.run(
      'UPDATE webhooks SET name=?, avatar=?, channel_id=? WHERE id=?',
      body.name !== undefined ? str(body.name, 80) || w.name : w.name,
      body.avatar !== undefined ? hub.ownImage(me.id, body.avatar, w.avatar) : w.avatar,
      channel,
      w.id
    );
    return hookObj(hub.one('SELECT * FROM webhooks WHERE id=?', w.id), true);
  });
  on('DELETE', '/api/webhooks/:id', ({ me, p }: any) => {
    const w = ownHook(me.id, p.id);
    hub.run('DELETE FROM webhooks WHERE id=?', w.id);
    hub.audit(w.server_id, me.id, 'webhook_delete', w.id, { name: w.name });
  });
  const tokenHook = (id: string, token: string) => {
    const w = hub.one('SELECT * FROM webhooks WHERE id=? AND token=?', id, token);
    if (!w) return fail('Unknown Webhook', 404);
    return w;
  };
  on('GET', '/api/webhooks/:id/:token', ({ p }: any) => hookObj(tokenHook(p.id, p.token), false), true);
  on(
    'POST',
    '/api/webhooks/:id/:token',
    async ({ p, q, req, body }: any) => {
      const w = tokenHook(p.id, p.token);
      if (!Object.keys(body).length) body = await req.json().catch(() => ({})); // senders often omit the content-type
      const content = str(body.content, 2000);
      const embeds = sanitizeEmbeds(body.embeds);
      if (!content && !embeds.length) fail('Cannot send an empty message');
      const ch = hub.one('SELECT * FROM channels WHERE id=?', w.channel_id);
      if (!ch) fail('Unknown Channel', 404);
      const message = hub.createMessage(ch.id, w.id, {
        content,
        embeds,
        webhook: { id: w.id, name: str(body.username, 80) || w.name, avatar: str(body.avatar_url, 500) || w.avatar },
      });
      return q.get('wait') === 'true' ? message : new Response(null, { status: 204 });
    },
    true
  );

  // ---------------------------------------------------------------- AutoMod
  on('PATCH', '/api/servers/:id/automod', ({ me, p, body }: any) => {
    hub.need(p.id, me.id, P.MANAGE_SERVER);
    const rules = {
      enabled: !!body.enabled,
      words: (Array.isArray(body.words) ? body.words : []).map((w: any) => str(w, 60)).filter(Boolean).slice(0, 200),
      blockLinks: !!body.blockLinks,
      blockInvites: !!body.blockInvites,
      maxMentions: Math.max(0, Math.min(50, Number(body.maxMentions) || 0)),
      exemptRoles: (Array.isArray(body.exemptRoles) ? body.exemptRoles : []).map(String).slice(0, 50),
    };
    hub.run('UPDATE servers SET automod=? WHERE id=?', JSON.stringify(rules), p.id);
    hub.audit(p.id, me.id, 'automod_update', p.id, { enabled: rules.enabled, words: rules.words.length });
    hub.pushServerData(p.id);
    return rules;
  });

  // ---------------------------------------------------------------- two-factor authentication
  on('POST', '/api/users/me/2fa/setup', async ({ me, body }: any) => {
    if ((await hashPassword(String(body.password || ''), me.pass_salt)) !== me.pass_hash) fail('Current password is wrong', 403);
    const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    hub.run('UPDATE users SET totp_pending=? WHERE id=?', secret, me.id);
    return { secret, uri: `otpauth://totp/Hamsohbat:${encodeURIComponent(me.username)}?secret=${secret}&issuer=Hamsohbat` };
  });
  on('POST', '/api/users/me/2fa/enable', async ({ me, body }: any) => {
    if (!me.totp_pending) fail('Start the setup first');
    if (!(await verifyTotp(me.totp_pending, String(body.code || '')))) fail('Invalid two-factor code', 400);
    hub.run('UPDATE users SET totp_secret=totp_pending, totp_pending=NULL WHERE id=?', me.id);
    hub.send([me.id], { op: 'ME_UPDATE', statusPref: me.status_pref, mfa: true });
  });
  on('POST', '/api/users/me/2fa/disable', async ({ me, body }: any) => {
    if (!me.totp_secret) return;
    if (!(await verifyTotp(me.totp_secret, String(body.code || '')))) fail('Invalid two-factor code', 400);
    hub.run('UPDATE users SET totp_secret=NULL WHERE id=?', me.id);
    hub.send([me.id], { op: 'ME_UPDATE', statusPref: me.status_pref, mfa: false });
  });

  // ---------------------------------------------------------------- deleting your account
  on('POST', '/api/users/me/delete', async ({ me, body }: any) => {
    if ((await hashPassword(String(body.password || ''), me.pass_salt)) !== me.pass_hash) fail('Current password is wrong', 403);
    if (hub.one('SELECT 1 FROM servers WHERE owner_id=?', me.id)) fail('Transfer or delete the servers you own first');
    for (const r of hub.all('SELECT server_id FROM members WHERE user_id=?', me.id)) hub.removeMember(r.server_id, me.id);
    for (const r of hub.all('SELECT target_id FROM relationships WHERE user_id=?', me.id)) {
      hub.setRel(me.id, r.target_id, 0);
      if (hub.rel(r.target_id, me.id) && hub.rel(r.target_id, me.id) !== REL.BLOCKED) hub.setRel(r.target_id, me.id, 0);
    }
    for (const g of hub.all('SELECT c.* FROM channels c JOIN dm_members d ON d.channel_id=c.id WHERE d.user_id=? AND c.type=?', me.id, CH.GROUP)) hub.leaveGroup(g, me.id);
    const old = hub.fileIdFromUrl(me.avatar);
    if (old) hub.deleteFiles([old]);
    hub.run(
      "UPDATE users SET username=?, display_name='Deleted User', avatar=NULL, bio='', custom_status='', pronouns='', pass_hash='', totp_secret=NULL, deleted=1 WHERE id=?",
      'deleted_' + me.id,
      me.id
    );
    hub.run('DELETE FROM sessions WHERE user_id=?', me.id);
    hub.run('DELETE FROM notes WHERE user_id=?', me.id);
    hub.send(null, { op: 'USER_UPDATE', user: hub.user(me.id) });
    for (const [ws, a] of hub.sockets())
      if (a.uid === me.id)
        try {
          ws.close(4001, 'account deleted');
        } catch {}
  });

  // ---------------------------------------------------------------- voice moderation: server mute/deafen, move, stage speakers
  on('PATCH', '/api/servers/:id/voice/:uid', ({ me, p, body }: any) => {
    const uid = p.uid === '@me' ? me.id : p.uid;
    const perms = hub.perms(p.id, me.id);
    if (!perms || !hub.memberObj(p.id, uid)) fail('Not found', 404);
    const self = uid === me.id;
    const strict = () => {
      if (!self && !hub.outranks(p.id, me.id, uid)) fail('You cannot do that to someone with an equal or higher role', 403);
    };
    if (body.mute !== undefined) {
      if (!(perms & P.MUTE_MEMBERS)) fail('You do not have permission to do that', 403);
      strict();
      hub.run('UPDATE members SET server_mute=? WHERE server_id=? AND user_id=?', body.mute ? 1 : 0, p.id, uid);
      hub.audit(p.id, me.id, body.mute ? 'voice_mute' : 'voice_unmute', uid);
    }
    if (body.deaf !== undefined) {
      if (!(perms & P.DEAFEN_MEMBERS)) fail('You do not have permission to do that', 403);
      strict();
      hub.run('UPDATE members SET server_deaf=? WHERE server_id=? AND user_id=?', body.deaf ? 1 : 0, p.id, uid);
      hub.audit(p.id, me.id, body.deaf ? 'voice_deafen' : 'voice_undeafen', uid);
    }
    if (body.mute !== undefined || body.deaf !== undefined) hub.pushMember(p.id, uid);
    for (const [ws, a] of hub.sockets() as [WebSocket, Att][]) {
      if (a.uid !== uid || !a.v) continue;
      const ch = hub.one('SELECT * FROM channels WHERE id=?', a.v.c);
      if (!ch || ch.server_id !== p.id) continue;
      if (body.mute !== undefined) a.v.sm = !!body.mute;
      if (body.deaf !== undefined) a.v.sd = !!body.deaf;
      if (body.suppress !== undefined) {
        if (ch.type !== CH.STAGE) fail('Not a stage channel');
        const mod = !!(hub.channelPerms(ch, me.id) & (P.MUTE_MEMBERS | P.MOVE_MEMBERS));
        // Anybody can step down; only stage moderators can bring someone up.
        if (!mod && !(self && body.suppress)) fail('You do not have permission to do that', 403);
        a.v.sup = !!body.suppress;
        a.v.hand = 0;
        if (a.v.sup) a.v.vid = false;
      }
      ws.serializeAttachment(a);
      hub.send(hub.audience(ch), { op: 'VOICE_STATE', state: hub.voiceObj(a), serverId: ch.server_id });
      if (body.channelId && String(body.channelId) !== a.v.c) {
        if (!(perms & P.MOVE_MEMBERS)) fail('You do not have permission to do that', 403);
        strict();
        const target = hub.one('SELECT * FROM channels WHERE id=? AND server_id=?', String(body.channelId), p.id);
        if (!target || !VOICE_LIKE.includes(target.type)) fail('Not found', 404);
        if (!(hub.channelPerms(target, uid) & P.CONNECT)) fail('They cannot join that channel', 403);
        ws.send(JSON.stringify({ op: 'VOICE_MOVE', channelId: target.id }));
        hub.audit(p.id, me.id, 'voice_move', uid, { from: a.v.c, to: target.id });
      }
    }
  });

  // ---------------------------------------------------------------- importing a server from Discord
  on('POST', '/api/servers/import/template', async ({ me, body }: any) => {
    // The template JSON can also be pasted directly (useful when discord.com is not reachable from the server).
    let t: any = body.template && typeof body.template === 'object' ? body.template : null;
    const code = String(body.code || '').trim().replace(/^https?:\/\/(discord\.new|discord\.com\/template)\//i, '').replace(/\/$/, '');
    if (!t) {
      if (!/^[\w-]{2,64}$/.test(code)) fail('That does not look like a Discord template link');
      const r = await fetch(`https://discord.com/api/v10/guilds/templates/${code}`, { headers: { 'user-agent': 'Hamsohbat (import, 1.0)' } }).catch(() => null);
      if (!r || !r.ok) fail(r && r.status === 404 ? 'Template not found' : 'Could not reach Discord', r?.status === 404 ? 404 : 502);
      t = await r!.json();
    }
    const g = t.serialized_source_guild || {};
    const icon = g.icon_hash && t.source_guild_id ? `https://cdn.discordapp.com/icons/${t.source_guild_id}/${g.icon_hash}.png?size=256` : null;
    const sid = await importStructure(hub, me.id, { name: str(body.name, 100) || g.name || t.name, icon, roles: g.roles || [], channels: g.channels || [] }, true);
    return { id: sid };
  });
  on('POST', '/api/discord/guilds', async ({ body }: any) => {
    const token = String(body.token || '').trim();
    if (!token) fail('Paste your bot token');
    const guilds = await discordApi(token, '/users/@me/guilds');
    return guilds.map((g: any) => ({ id: g.id, name: g.name, icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null }));
  });
  on('POST', '/api/servers/import/discord', async ({ me, body }: any) => {
    const token = String(body.token || '').trim();
    const gid = String(body.guildId || '');
    if (!token || !/^\d+$/.test(gid)) fail('Pick a server to import');
    const guild = await discordApi(token, `/guilds/${gid}`);
    const channels = await discordApi(token, `/guilds/${gid}/channels`);
    const icon = guild.icon ? `https://cdn.discordapp.com/icons/${gid}/${guild.icon}.png?size=256` : null;
    const map: Record<string, string> = {};
    const sid = await importStructure(hub, me.id, { name: str(body.name, 100) || guild.name, icon, roles: guild.roles || [], channels }, false, map);
    const perChannel = Math.max(0, Math.min(2000, Number(body.messages) || 0));
    const job = randHex(6);
    if (perChannel) {
      const work = importMessages(hub, me.id, sid, token, channels, map, perChannel, job, !!body.files).catch((e) =>
        hub.send([me.id], { op: 'IMPORT_PROGRESS', job, serverId: sid, error: String(e?.message || e), done: true })
      );
      // Keep the Durable Object alive while the import runs in the background.
      hub.ctx.waitUntil?.(work);
    }
    return { id: sid, job };
  });
}

// ---------------------------------------------------------------- socket operations
export function handleFeatureSocket(hub: Hub, ws: WebSocket, att: Att, m: any): boolean {
  if (m.op === 'idle') {
    const before = hub.statusOf(att.uid);
    att.idle = !!m.idle;
    ws.serializeAttachment(att);
    const now = hub.statusOf(att.uid);
    if (now !== before) hub.send(null, { op: 'PRESENCE', userId: att.uid, status: now, activity: hub.activityOf(att.uid) });
    return true;
  }
  if (m.op === 'activity') {
    att.act = m.activity && m.activity.name ? { name: str(m.activity.name, 80), type: Number(m.activity.type) || 0, since: Date.now() } : null;
    ws.serializeAttachment(att);
    hub.send(null, { op: 'PRESENCE', userId: att.uid, status: hub.statusOf(att.uid), activity: hub.activityOf(att.uid) });
    return true;
  }
  if (m.op === 'stage_hand') {
    if (!att.v) return true;
    const ch = hub.one('SELECT * FROM channels WHERE id=?', att.v.c);
    if (!ch || ch.type !== CH.STAGE || !att.v.sup) return true;
    if (!(hub.channelPerms(ch, att.uid) & P.REQUEST_TO_SPEAK)) return true;
    att.v.hand = m.raise ? Date.now() : 0;
    ws.serializeAttachment(att);
    hub.send(hub.audience(ch), { op: 'VOICE_STATE', state: hub.voiceObj(att), serverId: ch.server_id });
    return true;
  }
  if (m.op === 'soundboard') {
    if (!att.v) return true;
    const ch = hub.one('SELECT * FROM channels WHERE id=?', att.v.c);
    if (!ch) return true;
    const now = Date.now();
    if ((att as any).sb && now - (att as any).sb < 1500) return true; // a little spam protection
    if (att.v.sm || att.v.sup || att.v.d) return true;
    let sound: any = null;
    if (typeof m.sound === 'string' && m.sound.startsWith('builtin:')) sound = { id: m.sound.slice(0, 40), builtin: true, volume: 1 };
    else {
      const row = hub.one('SELECT * FROM sounds WHERE id=?', String(m.sound));
      if (!row || (ch.server_id && row.server_id !== ch.server_id) || !hub.perms(row.server_id, att.uid)) return true;
      sound = { id: row.id, name: row.name, emoji: row.emoji, volume: row.volume, url: `/api/files/${row.id}` };
    }
    if (ch.server_id && !(hub.channelPerms(ch, att.uid) & P.USE_SOUNDBOARD)) return true;
    (att as any).sb = now;
    ws.serializeAttachment(att);
    const ids = new Set<string>();
    for (const [, a] of hub.sockets() as [WebSocket, Att][]) if (a.v?.c === ch.id) ids.add(a.uid);
    hub.send(ids, { op: 'SOUNDBOARD', channelId: ch.id, userId: att.uid, sound });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- helpers
function takeAttachments(hub: Hub, uid: string, channelId: string, ids: any) {
  return (Array.isArray(ids) ? ids : []).slice(0, 10).map((fid: any) => {
    const f = hub.one('SELECT * FROM files WHERE id=? AND uploader_id=? AND ref IS NULL', String(fid), uid);
    if (!f) return fail('Invalid attachment');
    hub.run('UPDATE files SET ref=? WHERE id=?', channelId, f.id);
    return { id: f.id, name: f.name, type: f.type, size: f.size, width: f.width, height: f.height, url: `/api/files/${f.id}` };
  });
}

/** Keeps the parts of Discord-style embeds we can show, with size limits. */
export function sanitizeEmbeds(list: any): any[] {
  if (!Array.isArray(list)) return [];
  const url = (u: any) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u.slice(0, 1000) : null);
  return list.slice(0, 10).map((e: any) => ({
    title: str(e?.title, 256) || null,
    description: str(e?.description, 4096) || null,
    url: url(e?.url),
    color: Number.isFinite(e?.color) ? Number(e.color) & 0xffffff : null,
    timestamp: typeof e?.timestamp === 'string' ? e.timestamp.slice(0, 40) : null,
    author: e?.author ? { name: str(e.author.name, 256), url: url(e.author.url), icon: url(e.author.icon_url) } : null,
    footer: e?.footer ? { text: str(e.footer.text, 2048), icon: url(e.footer.icon_url) } : null,
    image: url(e?.image?.url),
    thumbnail: url(e?.thumbnail?.url),
    fields: (Array.isArray(e?.fields) ? e.fields : []).slice(0, 25).map((f: any) => ({ name: str(f?.name, 256), value: str(f?.value, 1024), inline: !!f?.inline })),
  }));
}

async function discordApi(token: string, path: string, attempt = 0): Promise<any> {
  const r = await fetch('https://discord.com/api/v10' + path, {
    headers: { authorization: 'Bot ' + token.replace(/^Bot\s+/i, ''), 'user-agent': 'DiscordBot (hamsohbat, 1.0)' },
  }).catch(() => null);
  if (!r) return fail('Could not reach Discord', 502);
  if (r.status === 429 && attempt < 5) {
    const wait = Number((await r.json().catch(() => ({})))?.retry_after || 1);
    await new Promise((res) => setTimeout(res, Math.min(10, wait) * 1000 + 100));
    return discordApi(token, path, attempt + 1);
  }
  if (r.status === 401) fail('Discord rejected the bot token', 401);
  if (r.status === 403) fail('The bot cannot see that (missing permission)', 403);
  if (!r.ok) fail('Discord error ' + r.status, 502);
  return r.json();
}

// Discord permission bits -> ours.
const DISCORD_PERMS: [bigint, number][] = [
  [1n << 3n, P.ADMIN],
  [1n << 5n, P.MANAGE_SERVER],
  [1n << 4n, P.MANAGE_CHANNELS],
  [1n << 28n, P.MANAGE_ROLES],
  [1n << 1n, P.KICK_MEMBERS],
  [1n << 2n, P.BAN_MEMBERS],
  [1n << 13n, P.MANAGE_MESSAGES],
  [1n << 0n, P.CREATE_INVITE],
  [1n << 11n, P.SEND_MESSAGES],
  [1n << 15n, P.ATTACH_FILES],
  [1n << 6n, P.ADD_REACTIONS],
  [1n << 17n, P.MENTION_EVERYONE],
  [1n << 20n, P.CONNECT],
  [1n << 21n, P.SPEAK],
  [1n << 9n, P.VIDEO],
  [1n << 24n, P.MOVE_MEMBERS],
  [1n << 10n, P.VIEW_CHANNEL],
  [1n << 22n, P.MUTE_MEMBERS],
  [1n << 23n, P.DEAFEN_MEMBERS],
  [1n << 29n, P.MANAGE_WEBHOOKS],
  [1n << 40n, P.MODERATE_MEMBERS],
  [1n << 30n, P.MANAGE_EXPRESSIONS],
  [1n << 33n, P.MANAGE_EVENTS],
  [1n << 35n, P.CREATE_THREADS],
  [1n << 38n, P.SEND_IN_THREADS],
  [1n << 42n, P.USE_SOUNDBOARD],
  [1n << 7n, P.VIEW_AUDIT_LOG],
  [1n << 32n, P.REQUEST_TO_SPEAK],
  [1n << 34n, P.MANAGE_THREADS],
];
function mapPerms(v: any): number {
  let b: bigint;
  try {
    b = BigInt(v || 0);
  } catch {
    return 0;
  }
  let out = 0;
  for (const [d, ours] of DISCORD_PERMS) if (b & d) out |= ours;
  return out;
}
const TYPE_MAP: Record<number, number> = { 0: CH.TEXT, 2: CH.VOICE, 4: CH.CATEGORY, 5: CH.ANNOUNCEMENT, 13: CH.STAGE, 15: CH.FORUM, 16: CH.FORUM };

async function fetchToFile(hub: Hub, uid: string, url: string, name: string, maxBytes: number): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    const id = randHex(16);
    const type = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    hub.run('INSERT INTO files(id, name, type, size, uploader_id, created_at) VALUES(?,?,?,?,?,?)', id, name.slice(0, 200), type, buf.length, uid, Date.now());
    for (let i = 0, n = 0; i < buf.length; i += 1024 * 1024, n++) hub.run('INSERT INTO file_chunks(file_id, idx, data) VALUES(?,?,?)', id, n, buf.slice(i, i + 1024 * 1024).buffer);
    return { id, name, type, size: buf.length, url: `/api/files/${id}` };
  } catch {
    return null;
  }
}

/** Creates a server from a Discord template or guild: roles, categories, channels and permission overrides. */
async function importStructure(
  hub: Hub,
  uid: string,
  g: { name: string; icon: string | null; roles: any[]; channels: any[] },
  fromTemplate: boolean,
  channelMap: Record<string, string> = {}
) {
  const sid = hub.id();
  hub.run('INSERT INTO servers(id, name, icon, owner_id, created_at) VALUES(?,?,?,?,?)', sid, str(g.name, 100) || 'Imported server', null, uid, Date.now());
  if (g.icon) {
    const f = await fetchToFile(hub, uid, g.icon, 'icon.png', 2 * 1024 * 1024);
    if (f) {
      hub.run("UPDATE files SET ref='profile' WHERE id=?", f.id);
      hub.run('UPDATE servers SET icon=? WHERE id=?', f.url, sid);
    }
  }
  // Roles: Discord's @everyone has the guild id (bot) or id 0 (template).
  const roleMap: Record<string, string> = {};
  const sorted = [...g.roles].sort((a, b) => (a.position || 0) - (b.position || 0));
  const everyone = sorted.find((r) => r.name === '@everyone' || String(r.id) === '0') || null;
  hub.run('INSERT INTO roles(id, server_id, name, color, permissions, position) VALUES(?,?,?,?,?,0)', sid, sid, '@everyone', null, mapPerms(everyone?.permissions) | P.VIEW_CHANNEL);
  if (everyone) roleMap[String(everyone.id)] = sid;
  let pos = 1;
  for (const r of sorted) {
    if (r === everyone || r.managed) continue;
    const id = hub.id();
    roleMap[String(r.id)] = id;
    hub.run(
      'INSERT INTO roles(id, server_id, name, color, permissions, position, hoist) VALUES(?,?,?,?,?,?,?)',
      id,
      sid,
      str(r.name, 50) || 'role',
      r.color ? '#' + Number(r.color).toString(16).padStart(6, '0') : null,
      mapPerms(r.permissions),
      pos++,
      r.hoist ? 1 : 0
    );
  }
  // Categories first, so channels can point at them.
  const chans = [...g.channels].filter((c) => TYPE_MAP[c.type] !== undefined).sort((a, b) => (a.type === 4 ? 0 : 1) - (b.type === 4 ? 0 : 1) || (a.position || 0) - (b.position || 0));
  for (const c of chans) {
    const id = hub.id();
    channelMap[String(c.id)] = id;
    const type = TYPE_MAP[c.type];
    let name = str(c.name, 100) || 'channel';
    if (([CH.TEXT, CH.ANNOUNCEMENT, CH.FORUM] as number[]).includes(type)) name = name.toLowerCase().replace(/\s+/g, '-');
    hub.run(
      'INSERT INTO channels(id, server_id, type, name, topic, parent_id, position, rate_limit, user_limit, bitrate, nsfw, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      sid,
      type,
      name,
      str(c.topic, 1024),
      c.parent_id != null ? channelMap[String(c.parent_id)] || null : null,
      c.position || 0,
      c.rate_limit_per_user || 0,
      c.user_limit || 0,
      Math.round((c.bitrate || 64000) / 1000),
      c.nsfw ? 1 : 0,
      Date.now()
    );
    for (const o of c.permission_overwrites || []) {
      const target = Number(o.type) === 0 ? roleMap[String(o.id)] : null; // members of the Discord server do not exist here
      if (target) hub.setOverwrite(id, target, 0, mapPerms(o.allow), mapPerms(o.deny));
    }
  }
  hub.run('INSERT INTO members(server_id, user_id, joined_at) VALUES(?,?,?)', sid, uid, Date.now());
  hub.audit(sid, uid, fromTemplate ? 'import_template' : 'import_discord', sid, { roles: pos - 1, channels: chans.length });
  hub.sendServer(uid, sid);
  return sid;
}

/** Copies message history from Discord with a bot token (newest `perChannel` messages of every text channel). */
async function importMessages(hub: Hub, uid: string, sid: string, token: string, channels: any[], map: Record<string, string>, perChannel: number, job: string, files: boolean) {
  const text = channels.filter((c) => [0, 5].includes(c.type) && map[String(c.id)]);
  const names: Record<string, string> = Object.fromEntries(channels.map((c) => [String(c.id), c.name]));
  let done = 0;
  let imported = 0;
  let totalBytes = 0;
  for (const c of text) {
    const target = map[String(c.id)];
    const batch: any[] = [];
    let before = '';
    try {
      while (batch.length < perChannel) {
        const page = await discordApi(token, `/channels/${c.id}/messages?limit=100${before ? '&before=' + before : ''}`);
        if (!page.length) break;
        batch.push(...page);
        before = page[page.length - 1].id;
        if (page.length < 100) break;
      }
    } catch (e: any) {
      hub.send([uid], { op: 'IMPORT_PROGRESS', job, serverId: sid, channel: c.name, warning: String(e?.message || e) });
      done++;
      continue;
    }
    const pinned = new Set<string>();
    try {
      for (const pm of await discordApi(token, `/channels/${c.id}/pins`)) pinned.add(pm.id);
    } catch {}
    const idMap: Record<string, string> = {};
    for (const m of batch.slice(0, perChannel).reverse()) {
      if (![0, 19].includes(m.type)) continue; // normal messages and replies
      const mentionNames: Record<string, string> = {};
      for (const u of m.mentions || []) mentionNames[u.id] = u.global_name || u.username;
      const content = String(m.content || '')
        .replace(/<@!?(\d+)>/g, (_a, id) => '@' + (mentionNames[id] || 'user'))
        .replace(/<#(\d+)>/g, (_a, id) => '#' + (names[id] || 'channel'))
        .slice(0, MAX_MESSAGE_LENGTH);
      const attachments: any[] = [];
      if (files)
        for (const a of m.attachments || []) {
          if (a.size > 8 * 1024 * 1024 || totalBytes > 400 * 1024 * 1024) continue;
          const f = await fetchToFile(hub, uid, a.url, a.filename || 'file', 8 * 1024 * 1024);
          if (f) {
            totalBytes += f.size;
            hub.run('UPDATE files SET ref=?, width=?, height=? WHERE id=?', target, a.width || null, a.height || null, f.id);
            attachments.push({ ...f, width: a.width || null, height: a.height || null });
          }
        }
      const extraLinks = files ? '' : (m.attachments || []).map((a: any) => '\n' + a.filename).join('');
      if (!content && !attachments.length && !(m.embeds || []).length && !extraLinks) continue;
      const author = m.author || {};
      const msg = hub.createMessage(target, 'd' + author.id, {
        content: content + extraLinks,
        attachments,
        embeds: sanitizeEmbeds(m.embeds),
        createdAt: Date.parse(m.timestamp) || Date.now(),
        replyTo: m.message_reference?.message_id ? idMap[m.message_reference.message_id] || null : null,
        webhook: {
          id: 'discord:' + author.id,
          name: author.global_name || author.username || 'Discord user',
          avatar: author.avatar ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=128` : null,
          imported: true,
        },
      });
      idMap[m.id] = msg.id;
      if (pinned.has(m.id)) hub.run('UPDATE messages SET pinned=1 WHERE id=?', msg.id);
      imported++;
    }
    done++;
    hub.send([uid], { op: 'IMPORT_PROGRESS', job, serverId: sid, channel: c.name, done: false, channels: done, total: text.length, messages: imported });
  }
  hub.send([uid], { op: 'IMPORT_PROGRESS', job, serverId: sid, done: true, channels: done, total: text.length, messages: imported });
}

export { ALL_PERMS, json };
