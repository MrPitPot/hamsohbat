// Server management: expressions (emoji, stickers, soundboard), AutoMod, audit log, scheduled events, notification
// levels, time-outs, voice moderation and importing a server from Discord.
import React, { useEffect, useRef, useState } from 'react';
import { Calendar, CalendarDays, Check, Clock, MapPin, Play, Plus, Trash2, Upload, Users, Volume2, X, Bot, Link as LinkIcon, FileJson } from 'lucide-react';
import { useStore, get, act, toast, openModal, closeModal, navigate, displayName, notifyLevel, setNotifyLevel, orderedChannels, P, CH } from '../store';
import { api, upload } from '../api';
import { t } from '../i18n';
import { Modal, Field, Toggle, Avatar, fmtStamp, fmtDate, num } from '../ui';
import { playBuiltin, BUILTIN_SOUNDS, BUILTIN_EMOJI } from '../sfx';

// ---------------------------------------------------------------- expressions
async function squareBlob(file: File, size: number): Promise<Blob> {
  if (file.type === 'image/gif') return file; // keep animations
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Invalid image'))), 'image/webp', 0.92));
}
const cleanName = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_]+/gu, '_').slice(0, 32).replace(/^_+|_+$/g, '') || 'emoji';

export function ExpressionsTab({ server, kind }: { server: any; kind: 'emojis' | 'stickers' | 'sounds' }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const list: any[] = server[kind] || [];
  const limits = { emojis: 100, stickers: 30, sounds: 50 };
  const titles = { emojis: 'Emoji', stickers: 'Stickers', sounds: 'Soundboard' };
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        let blob: Blob = file;
        let name = file.name;
        if (kind !== 'sounds') {
          blob = await squareBlob(file, kind === 'emojis' ? 128 : 320);
          if (blob !== file) name = name.replace(/\.[^.]+$/, '') + '.webp';
        } else if (file.size > 1024 * 1024) throw new Error('Sounds must be smaller than 1 MB');
        const f = await upload(blob, name);
        await api('POST', `/api/servers/${server.id}/${kind}`, { name: cleanName(file.name), fileId: f.id, emoji: kind === 'sounds' ? '🔊' : undefined });
      } catch (e: any) {
        toast(t(e.message) + ' — ' + file.name);
      }
    }
    setBusy(false);
  };
  return (
    <>
      <h2>{t(titles[kind])}</h2>
      <p className="muted">
        {kind === 'emojis'
          ? t('Add up to {n} custom emoji that anyone in this server can use. Names must be at least 2 characters.', { n: num(limits.emojis) })
          : kind === 'stickers'
          ? t('Upload up to {n} stickers for everyone in this server to use. PNG, GIF or WebP, up to 512 KB.', { n: num(limits.stickers) })
          : t('Upload up to {n} short sounds (MP3, OGG or WAV, under 1 MB) that members can play in voice channels.', { n: num(limits.sounds) })}
      </p>
      <button className="btn primary" disabled={busy || list.length >= limits[kind]} onClick={() => input.current?.click()}>
        <Upload size={16} /> {busy ? t('Uploading…') : kind === 'emojis' ? t('Upload Emoji') : kind === 'stickers' ? t('Upload Sticker') : t('Upload Sound')}
      </button>
      <input ref={input} type="file" hidden multiple accept={kind === 'sounds' ? 'audio/*' : 'image/png,image/jpeg,image/gif,image/webp'} onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      <div className="list-title" style={{ marginTop: 20 }}>
        {t(titles[kind])} — {num(list.length)} / {num(limits[kind])}
      </div>
      <div className={kind === 'stickers' ? 'expr-grid' : ''}>
        {list.map((x) => (
          <ExpressionRow key={x.id} x={x} kind={kind} />
        ))}
      </div>
      {kind === 'sounds' && (
        <>
          <h3>{t('Default Sounds')}</h3>
          <div className="sb-grid">
            {BUILTIN_SOUNDS.map((n) => (
              <button key={n} className="sb-btn" onClick={() => playBuiltin(n)}>
                <span>{BUILTIN_EMOJI['builtin:' + n]}</span> {t(n)}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
function ExpressionRow({ x, kind }: { x: any; kind: string }) {
  const [name, setName] = useState(x.name);
  const [emoji, setEmoji] = useState(x.emoji || '');
  const [vol, setVol] = useState(Math.round((x.volume ?? 1) * 100));
  const dirty = name !== x.name || (kind === 'sounds' && (emoji !== (x.emoji || '') || vol !== Math.round((x.volume ?? 1) * 100)));
  const play = () => {
    const a = new Audio(`/api/files/${x.id}`);
    a.volume = vol / 100;
    a.play().catch(() => {});
  };
  return (
    <div className={'list-row expr-row' + (kind === 'stickers' ? ' sticker-card' : '')}>
      {kind === 'sounds' ? (
        <button className="icon-btn" onClick={play} title={t('Preview')}>
          <Play size={18} />
        </button>
      ) : (
        <img className={kind === 'emojis' ? 'expr-emoji' : 'expr-sticker'} src={`/api/files/${x.id}`} alt="" />
      )}
      {kind === 'sounds' && <input className="emoji-in" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />}
      <input className="plain-input small grow" dir="ltr" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
      {kind === 'sounds' && <input type="range" min={10} max={100} value={vol} onChange={(e) => setVol(Number(e.target.value))} title={t('Volume')} />}
      {dirty && (
        <button className="btn small primary" onClick={() => act(api('PATCH', `/api/${kind}/${x.id}`, { name, emoji, volume: vol / 100 })).then((r) => r !== undefined && toast('Saved', 'ok'))}>
          {t('Save')}
        </button>
      )}
      <button className="icon-btn danger" title={t('Delete')} onClick={() => act(api('DELETE', `/api/${kind}/${x.id}`))}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- AutoMod
export function AutoModTab({ server }: { server: any }) {
  const cur = server.automod || {};
  const [f, setF] = useState({ enabled: !!cur.enabled, words: (cur.words || []).join(', '), blockLinks: !!cur.blockLinks, blockInvites: !!cur.blockInvites, maxMentions: cur.maxMentions || 0, exemptRoles: cur.exemptRoles || [] });
  const save = () =>
    act(api('PATCH', `/api/servers/${server.id}/automod`, { ...f, words: f.words.split(/[,\n]/).map((w: string) => w.trim()).filter(Boolean) })).then((r) => r && toast('Saved', 'ok'));
  const roles = server.roles.filter((r: any) => r.id !== server.id);
  return (
    <>
      <h2>{t('AutoMod')}</h2>
      <p className="muted">{t('AutoMod blocks messages that break your rules before anyone sees them. Moderators are never blocked.')}</p>
      <div className="setting-row">
        <div>
          <b>{t('Enable AutoMod')}</b>
        </div>
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
      </div>
      <fieldset disabled={!f.enabled} className="automod">
        <Field label={t('Block Custom Words')}>
          <textarea dir="auto" rows={3} value={f.words} onChange={(e) => setF({ ...f, words: e.target.value })} placeholder={t('Separate words with commas. Use * as a wildcard, e.g. bad*')} />
        </Field>
        <div className="setting-row">
          <div>
            <b>{t('Block Links')}</b>
            <small>{t('Blocks every message that contains a link.')}</small>
          </div>
          <Toggle checked={f.blockLinks} onChange={(v) => setF({ ...f, blockLinks: v })} />
        </div>
        <div className="setting-row">
          <div>
            <b>{t('Block Invites')}</b>
            <small>{t('Blocks invite links to other servers.')}</small>
          </div>
          <Toggle checked={f.blockInvites} onChange={(v) => setF({ ...f, blockInvites: v })} />
        </div>
        <Field label={t('Block Mention Spam') + ' — ' + (f.maxMentions ? t('more than {n} mentions', { n: num(f.maxMentions) }) : t('Off'))}>
          <input type="range" className="wide-range" min={0} max={30} value={f.maxMentions} onChange={(e) => setF({ ...f, maxMentions: Number(e.target.value) })} />
        </Field>
        {roles.length > 0 && (
          <Field label={t('Exempt Roles')}>
            <div className="role-chips">
              {roles.map((r: any) => (
                <button key={r.id} type="button" className={'role-chip' + (f.exemptRoles.includes(r.id) ? ' selected' : '')} onClick={() => setF({ ...f, exemptRoles: f.exemptRoles.includes(r.id) ? f.exemptRoles.filter((x: string) => x !== r.id) : [...f.exemptRoles, r.id] })}>
                  <i style={{ background: r.color || '#99aab5' }} />
                  {r.name}
                </button>
              ))}
            </div>
          </Field>
        )}
      </fieldset>
      <button className="btn primary" onClick={save}>
        {t('Save Changes')}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- audit log
const ACTIONS: Record<string, string> = {
  server_update: 'updated the server',
  channel_create: 'created channel {target}',
  channel_update: 'updated channel {target}',
  channel_delete: 'deleted channel {target}',
  channel_overwrites: 'changed permissions of {target}',
  role_create: 'created role {target}',
  role_update: 'updated role {target}',
  role_delete: 'deleted role {target}',
  member_kick: 'kicked {target}',
  member_ban: 'banned {target}',
  member_unban: 'unbanned {target}',
  member_role_add: 'gave a role to {target}',
  member_role_remove: 'removed a role from {target}',
  import_template: 'imported this server from a Discord template',
  import_discord: 'imported this server from Discord',
  member_nick: 'changed the nickname of {target}',
  member_timeout: 'timed out {target}',
  member_timeout_remove: 'removed the time out of {target}',
  message_delete: 'deleted a message by {target}',
  invite_create: 'created an invite',
  invite_delete: 'deleted an invite',
  webhook_create: 'created webhook {target}',
  webhook_delete: 'deleted webhook {target}',
  emoji_create: 'added emoji {target}',
  emoji_delete: 'removed emoji {target}',
  sticker_create: 'added sticker {target}',
  sticker_delete: 'removed sticker {target}',
  sound_create: 'added sound {target}',
  sound_delete: 'removed sound {target}',
  event_create: 'created event {target}',
  event_update: 'updated event {target}',
  event_end: 'ended event {target}',
  event_delete: 'deleted event {target}',
  thread_create: 'created thread {target}',
  thread_update: 'updated thread {target}',
  thread_delete: 'deleted thread {target}',
  voice_mute: 'server muted {target}',
  voice_unmute: 'server unmuted {target}',
  voice_deafen: 'server deafened {target}',
  voice_undeafen: 'server undeafened {target}',
  voice_move: 'moved {target} to another channel',
  voice_disconnect: 'disconnected {target} from voice',
  automod_update: 'updated AutoMod rules',
  automod_block: 'AutoMod blocked a message from {target}',
  owner_transfer: 'transferred ownership to {target}',
};
export function AuditLogTab({ server }: { server: any }) {
  const [entries, setEntries] = useState<any[] | null>(null);
  const [more, setMore] = useState(false);
  const [user, setUser] = useState('');
  const load = async (before?: string) => {
    const q = new URLSearchParams();
    if (before) q.set('before', before);
    if (user) q.set('user', user);
    try {
      const r = await api('GET', `/api/servers/${server.id}/audit-log?${q}`);
      useStore.setState((s: any) => ({ users: { ...Object.fromEntries(r.users.map((u: any) => [u.id, u])), ...s.users } }));
      setEntries((cur) => (before ? [...(cur || []), ...r.entries] : r.entries));
      setMore(r.entries.length === 50);
    } catch (e: any) {
      toast(e.message);
      setEntries([]);
    }
  };
  useEffect(() => {
    setEntries(null);
    load();
  }, [user]);
  const targetName = (e: any) => {
    const ch = server.channels.find((c: any) => c.id === e.targetId);
    if (ch) return '#' + ch.name;
    const role = server.roles.find((r: any) => r.id === e.targetId);
    if (role) return '@' + role.name;
    if (get().users[e.targetId]) return displayName(e.targetId, server.id);
    return e.changes?.name || e.changes?.nick || '';
  };
  return (
    <>
      <h2>{t('Audit Log')}</h2>
      <div className="two-col">
        <Field label={t('Filter by User')}>
          <select value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">{t('All Users')}</option>
            {Object.keys(server.members).map((id) => (
              <option key={id} value={id}>
                {displayName(id, server.id)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!entries ? (
        <p className="muted">{t('Loading…')}</p>
      ) : !entries.length ? (
        <p className="muted">{t('Nothing has been logged yet.')}</p>
      ) : (
        <div className="audit-list">
          {entries.map((e) => (
            <div key={e.id} className="audit-row">
              <Avatar userId={e.userId} size={32} />
              <div className="grow">
                <div>
                  <b>{displayName(e.userId, server.id)}</b> {t(ACTIONS[e.action] || e.action, { target: targetName(e) })}
                </div>
                <small className="muted">
                  {fmtStamp(e.createdAt)}
                  {e.reason ? ' • ' + t('Reason: {r}', { r: e.reason }) : ''}
                  {e.changes?.seconds ? ' • ' + fmtDuration(e.changes.seconds) : ''}
                </small>
              </div>
            </div>
          ))}
          {more && (
            <button className="btn wide" onClick={() => load(entries[entries.length - 1].id)}>
              {t('Load More')}
            </button>
          )}
        </div>
      )}
    </>
  );
}
const fmtDuration = (s: number) => (s < 3600 ? t('{n} minutes', { n: num(Math.round(s / 60)) }) : s < 86400 ? t('{n} hours', { n: num(Math.round(s / 3600)) }) : t('{n} days', { n: num(Math.round(s / 86400)) }));

// ---------------------------------------------------------------- scheduled events
export function EventsModal({ serverId }: { serverId: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const meId = useStore((s: any) => s.me.id);
  if (!server) return null;
  const canManage = !!(get().servers[serverId] && (server.ownerId === meId || (permsOf(server) & P.MANAGE_EVENTS)));
  const events = [...(server.events || [])].sort((a, b) => a.startAt - b.startAt);
  return (
    <Modal title={t('{n} Events', { n: num(events.length) })} width={560}>
      <div className="modal-body">
        {canManage && (
          <button className="btn primary" onClick={() => openModal('createEvent', { serverId })}>
            <Plus size={16} /> {t('Create Event')}
          </button>
        )}
        {!events.length && (
          <div className="empty small">
            <CalendarDays size={56} />
            <p>{t('There are no upcoming events. Schedule one for movie nights, game sessions or meetings.')}</p>
          </div>
        )}
        {events.map((e) => (
          <EventCard key={e.id} e={e} server={server} canManage={canManage || e.creatorId === meId} />
        ))}
      </div>
    </Modal>
  );
}
function permsOf(server: any) {
  const s = get();
  const m = server.members[s.me.id];
  if (!m) return 0;
  let p = 0;
  for (const r of server.roles) if (r.id === server.id || m.roles.includes(r.id)) p |= r.permissions;
  return p & P.ADMIN ? -1 : p;
}
export function EventCard({ e, server, canManage }: any) {
  const meId = useStore((s: any) => s.me.id);
  const interested = e.interested.includes(meId);
  const live = e.status === 2 || (e.startAt <= Date.now() && (!e.endAt || e.endAt > Date.now()) && e.status !== 3);
  const ch = e.channelId ? server.channels.find((c: any) => c.id === e.channelId) : null;
  return (
    <div className={'event-card' + (live ? ' live' : '')}>
      <div className="ev-when">
        {live ? (
          <span className="live">{t('Happening Now')}</span>
        ) : (
          <>
            <Calendar size={14} /> {fmtStamp(e.startAt)}
          </>
        )}
      </div>
      <h3 dir="auto">{e.name}</h3>
      {e.description && (
        <p className="muted" dir="auto">
          {e.description}
        </p>
      )}
      <div className="ev-meta">
        {ch ? (
          <a onClick={() => (closeModal(), navigate(server.id, ch.id))}>
            <Volume2 size={14} /> {ch.name}
          </a>
        ) : e.location ? (
          <span>
            <MapPin size={14} /> {e.location}
          </span>
        ) : null}
        <span>
          <Users size={14} /> {t('{n} interested', { n: num(e.interested.length) })}
        </span>
      </div>
      <div className="row-actions">
        <button className={'btn small ' + (interested ? 'green' : '')} onClick={() => act(api(interested ? 'DELETE' : 'PUT', `/api/events/${e.id}/interest`))}>
          {interested ? <Check size={14} /> : <Clock size={14} />} {t('Interested')}
        </button>
        {canManage && !live && e.status === 1 && (
          <button className="btn small" onClick={() => act(api('PATCH', '/api/events/' + e.id, { status: 2 }))}>
            {t('Start Event')}
          </button>
        )}
        {canManage && live && (
          <button className="btn small" onClick={() => act(api('PATCH', '/api/events/' + e.id, { status: 3 }))}>
            {t('End Event')}
          </button>
        )}
        {canManage && (
          <>
            <button className="btn small" onClick={() => openModal('createEvent', { serverId: server.id, event: e })}>
              {t('Edit')}
            </button>
            <button className="btn small danger" onClick={() => act(api('DELETE', '/api/events/' + e.id))}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
const localInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
export function CreateEventModal({ serverId, event }: { serverId: string; event?: any }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const voiceChans = server.channels.filter((c: any) => c.type === CH.VOICE || c.type === CH.STAGE);
  const [f, setF] = useState(() => ({
    name: event?.name || '',
    description: event?.description || '',
    where: event ? (event.channelId ? 'voice' : 'other') : voiceChans.length ? 'voice' : 'other',
    channelId: event?.channelId || voiceChans[0]?.id || '',
    location: event?.location || '',
    start: localInput(event?.startAt || Math.ceil(Date.now() / 3600000) * 3600000 + 3600000),
    end: event?.endAt ? localInput(event.endAt) : '',
  }));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const body = {
      name: f.name,
      description: f.description,
      channelId: f.where === 'voice' ? f.channelId : null,
      location: f.where === 'other' ? f.location : '',
      startAt: new Date(f.start).getTime(),
      endAt: f.end ? new Date(f.end).getTime() : null,
    };
    if (await act(api(event ? 'PATCH' : 'POST', event ? '/api/events/' + event.id : `/api/servers/${serverId}/events`, body))) openModal('events', { serverId });
    setBusy(false);
  };
  return (
    <Modal title={event ? t('Edit Event') : t('Create Event')} width={500}>
      <div className="modal-body">
        <div className="seg">
          <button className={f.where === 'voice' ? 'active' : ''} disabled={!voiceChans.length} onClick={() => setF({ ...f, where: 'voice' })}>
            <Volume2 size={14} /> {t('Voice Channel')}
          </button>
          <button className={f.where === 'other' ? 'active' : ''} onClick={() => setF({ ...f, where: 'other' })}>
            <MapPin size={14} /> {t('Somewhere Else')}
          </button>
        </div>
        {f.where === 'voice' ? (
          <Field label={t('Channel')}>
            <select value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value })}>
              {voiceChans.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t('Location')}>
            <input dir="auto" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={100} placeholder={t('Add a location, link or something.')} />
          </Field>
        )}
        <Field label={t('Event Topic')}>
          <input dir="auto" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} autoFocus placeholder={t("What's your event?")} />
        </Field>
        <div className="two-col">
          <Field label={t('Start')}>
            <input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label={t('End (optional)')}>
            <input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
        </div>
        <Field label={t('Description')}>
          <textarea dir="auto" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} placeholder={t('Tell people a little more about your event.')} />
        </Field>
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={() => openModal('events', { serverId })}>
          {t('Cancel')}
        </button>
        <button className="btn primary" disabled={busy || !f.name.trim() || !f.start} onClick={submit}>
          {event ? t('Save') : t('Create Event')}
        </button>
      </div>
    </Modal>
  );
}
/** "Event happening now / soon" strip at the top of the channel list. */
export function EventStrip({ server }: { server: any }) {
  const events = (server.events || []).filter((e: any) => e.status !== 3 && e.startAt < Date.now() + 86400000 * 7);
  if (!events.length) return null;
  const next = [...events].sort((a, b) => a.startAt - b.startAt)[0];
  const live = next.status === 2 || next.startAt <= Date.now();
  return (
    <button className={'event-strip' + (live ? ' live' : '')} onClick={() => openModal('events', { serverId: server.id })}>
      <CalendarDays size={16} />
      <span className="grow">
        {live ? t('Live: {name}', { name: next.name }) : next.name}
        <small>{live ? t('Happening Now') : fmtStamp(next.startAt)}</small>
      </span>
      {events.length > 1 && <span className="badge gray">{num(events.length)}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- notification level
export function NotificationSettingsModal({ serverId }: { serverId: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const level = useStore(() => notifyLevel(serverId));
  useStore((s: any) => s.settings.notifyLevel);
  return (
    <Modal title={t('Notification Settings')} width={420}>
      <div className="modal-body">
        <p className="muted">{server?.name}</p>
        {[
          ['all', 'All Messages', 'Get notified about every message.'],
          ['mentions', 'Only @mentions', 'Only get notified when someone mentions you or a role you have.'],
          ['none', 'Nothing', 'Never get notified (unread markers still show).'],
        ].map(([k, title, desc]) => (
          <button key={k} className={'type-choice' + (level === k ? ' active' : '')} onClick={() => setNotifyLevel(serverId, k)}>
            <div>
              <b>{t(title)}</b>
              <small>{t(desc)}</small>
            </div>
            <span className="radio" />
          </button>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={closeModal}>
          {t('Done')}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- moderation
const TIMEOUTS: [number, string][] = [
  [60, '60 seconds'],
  [300, '5 minutes'],
  [600, '10 minutes'],
  [3600, '1 hour'],
  [86400, '1 day'],
  [604800, '1 week'],
];
export function TimeoutModal({ serverId, userId }: { serverId: string; userId: string }) {
  const [secs, setSecs] = useState(300);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const name = displayName(userId, serverId);
  return (
    <Modal title={t('Time out {name}', { name })} width={440}>
      <div className="modal-body">
        <p className="muted">{t("Members who are timed out can't send messages, react, join voice channels or speak.")}</p>
        <span className="field-label">{t('Duration')}</span>
        <div className="chips">
          {TIMEOUTS.map(([s, l]) => (
            <button key={s} className={'chip' + (secs === s ? ' active' : '')} onClick={() => setSecs(s)}>
              {t(l)}
            </button>
          ))}
        </div>
        <Field label={t('Reason')}>
          <input dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          {t('Cancel')}
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (await act(api('PATCH', `/api/servers/${serverId}/members/${userId}`, { timeout: secs, reason }))) closeModal();
            setBusy(false);
          }}
        >
          {t('Time Out')}
        </button>
      </div>
    </Modal>
  );
}
export function MoveModal({ serverId, userId }: { serverId: string; userId: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const current = useStore((s: any) => s.voiceStates[userId]?.channelId);
  const chans = orderedChannels(server).filter((c: any) => (c.type === CH.VOICE || c.type === CH.STAGE) && c.id !== current);
  return (
    <Modal title={t('Move {name} To', { name: displayName(userId, serverId) })} width={380}>
      <div className="modal-body">
        <div className="pick-list">
          {chans.map((c: any) => (
            <button key={c.id} className="pick-row" onClick={() => act(api('PATCH', `/api/servers/${serverId}/voice/${userId}`, { channelId: c.id })).then((r) => r !== undefined && closeModal())}>
              <Volume2 size={18} />
              <b>{c.name}</b>
            </button>
          ))}
          {!chans.length && <p className="muted center">{t('There are no other voice channels.')}</p>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- importing from Discord
export function DiscordImportModal() {
  const [mode, setMode] = useState<'pick' | 'template' | 'bot'>('pick');
  const [code, setCode] = useState('');
  const [json, setJson] = useState('');
  const [token, setToken] = useState('');
  const [guilds, setGuilds] = useState<any[] | null>(null);
  const [guild, setGuild] = useState('');
  const [messages, setMessages] = useState(100);
  const [files, setFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(t(e.message));
    }
    setBusy(false);
  };
  const goTo = async (id: string) => {
    for (let i = 0; i < 60 && !get().servers[id]; i++) await new Promise((r) => setTimeout(r, 50));
    closeModal();
    navigate(id);
  };
  if (mode === 'pick')
    return (
      <Modal title={t('Import from Discord')} width={480}>
        <div className="modal-body">
          <p className="muted">{t('Bring a server over from Discord: its categories, channels, roles and permissions. With a bot you can also copy messages.')}</p>
          <button className="big-choice" onClick={() => setMode('template')}>
            <LinkIcon size={22} />
            <div>
              <b>{t('Server Template Link')}</b>
              <small>{t('Server Settings → Server Template in Discord. Copies channels and roles.')}</small>
            </div>
          </button>
          <button className="big-choice" onClick={() => setMode('bot')}>
            <Bot size={22} />
            <div>
              <b>{t('Bot Token (with messages)')}</b>
              <small>{t('Add your own bot to the Discord server; we copy channels, roles, emoji and recent messages.')}</small>
            </div>
          </button>
        </div>
      </Modal>
    );
  if (mode === 'template')
    return (
      <Modal title={t('Import a Server Template')} width={520}>
        <div className="modal-body">
          <Field label={t('Template Link')}>
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://discord.new/abcDEF123" autoFocus />
          </Field>
          <details>
            <summary className="muted">
              <FileJson size={14} /> {t("Discord blocked? Paste the template's JSON instead")}
            </summary>
            <textarea dir="ltr" rows={5} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"serialized_source_guild": …}' />
          </details>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn link" onClick={() => setMode('pick')}>
            {t('Back')}
          </button>
          <button
            className="btn primary"
            disabled={busy || (!code.trim() && !json.trim())}
            onClick={() =>
              run(async () => {
                let template: any;
                if (json.trim()) {
                  try {
                    template = JSON.parse(json);
                  } catch {
                    throw new Error('That JSON is not valid');
                  }
                }
                let r: any;
                try {
                  r = await api('POST', '/api/servers/import/template', template ? { template } : { code });
                } catch (e: any) {
                  // Our server cannot reach Discord (it blocks some hosting networks): fetch the template from this
                  // computer instead (through the Discord proxy when one is running) and send it over.
                  const id = code.trim().match(/([A-Za-z0-9]{8,})\/?$/)?.[1];
                  if (template || !id || !/discord/i.test(String(e?.message))) throw e;
                  let fetched: any;
                  try {
                    fetched = await (await fetch('https://discord.com/api/v10/guilds/templates/' + id)).json();
                  } catch {
                    throw e;
                  }
                  if (!fetched?.serialized_source_guild) throw e;
                  r = await api('POST', '/api/servers/import/template', { template: fetched });
                }
                await goTo(r.id);
              })
            }
          >
            {busy ? t('Importing…') : t('Import')}
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title={t('Import with a Bot')} width={560}>
      <div className="modal-body">
        <ol className="steps muted">
          <li>{t('Create an application at discord.com/developers, add a Bot and turn on "Message Content Intent".')}</li>
          <li>{t('Invite the bot to your Discord server with the "Read Message History" and "View Channels" permissions.')}</li>
          <li>{t('Paste the bot token here. It is only used for this import and is never stored.')}</li>
        </ol>
        <Field label={t('Bot Token')}>
          <div className="copy-row">
            <input dir="ltr" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button className="btn" disabled={busy || !token.trim()} onClick={() => run(async () => setGuilds(await api('POST', '/api/discord/guilds', { token })))}>
              {t('Find Servers')}
            </button>
          </div>
        </Field>
        {guilds && (
          <div className="pick-list">
            {!guilds.length && <p className="muted center">{t('The bot is not in any server yet.')}</p>}
            {guilds.map((g) => (
              <button key={g.id} className="pick-row" onClick={() => setGuild(g.id)}>
                {g.icon ? <img src={g.icon} alt="" className="pick-icon" /> : <span className="pick-hash">{[...g.name][0]}</span>}
                <b>{g.name}</b>
                <span className={'radio' + (guild === g.id ? ' on' : '')} />
              </button>
            ))}
          </div>
        )}
        {guild && (
          <>
            <Field label={t('Messages per channel') + ' — ' + num(messages)}>
              <input type="range" className="wide-range" min={0} max={2000} step={50} value={messages} onChange={(e) => setMessages(Number(e.target.value))} />
            </Field>
            <div className="setting-row">
              <div>
                <b>{t('Copy attachments')}</b>
                <small>{t('Downloads images and files into this server (slower, uses storage).')}</small>
              </div>
              <Toggle checked={files} onChange={setFiles} />
            </div>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={() => setMode('pick')}>
          {t('Back')}
        </button>
        <button
          className="btn primary"
          disabled={busy || !guild}
          onClick={() =>
            run(async () => {
              const r = await api('POST', '/api/servers/import/discord', { token, guildId: guild, messages, files });
              if (messages) toast(t('Copying messages in the background…'), 'ok');
              await goTo(r.id);
            })
          }
        >
          {busy ? t('Importing…') : t('Import')}
        </button>
      </div>
    </Modal>
  );
}
/** Small progress card for running imports. */
export function ImportProgress() {
  const imports = useStore((s: any) => s.imports);
  const running = Object.values<any>(imports).filter((j) => !j.done);
  if (!running.length) return null;
  return (
    <div className="import-progress">
      {running.map((j) => (
        <div key={j.job}>
          <b>{t('Importing messages…')}</b>
          <small>
            {j.channel ? '#' + j.channel + ' • ' : ''}
            {t('{a} of {b} channels', { a: num(j.channels || 0), b: num(j.total || 0) })} • {t('{n} messages', { n: num(j.messages || 0) })}
          </small>
          <div className="pf-progress">
            <div style={{ width: (j.total ? ((j.channels || 0) / j.total) * 100 : 5) + '%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
export { X, fmtDate };
