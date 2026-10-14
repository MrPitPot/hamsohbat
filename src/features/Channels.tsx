// Channels: type icons, creating channels of every type, channel settings (overview, permission overrides,
// webhooks), threads and forum channels.
import React, { useEffect, useState } from 'react';
import {
  Hash, Volume2, Megaphone, Podcast, MessagesSquare, MessageSquareText, Lock, Plus, Trash2, Copy, Check, X, Archive, ArchiveRestore, Webhook, Paperclip, Slash,
} from 'lucide-react';
import { useStore, get, act, toast, openModal, closeModal, navigate, findChannel, displayName, permsIn, canIn, threadsOf, P, CH } from '../store';
import { api, upload } from '../api';
import { t } from '../i18n';
import { Modal, Field, Toggle, Avatar, fmtStamp, num, openMenu } from '../ui';
import { CHANNEL_PERMS, PERM_LABELS } from '../../shared/perms';
import { Markdown } from '../markdown';
import { Attachment } from '../Chat';

export function ChannelIcon({ ch, size = 20 }: { ch: any; size?: number }) {
  const priv = ch.overwrites?.some((o: any) => o.type === 0 && o.id === ch.serverId && o.deny & P.VIEW_CHANNEL);
  const Icon =
    ch.type === CH.VOICE ? Volume2 : ch.type === CH.STAGE ? Podcast : ch.type === CH.ANNOUNCEMENT ? Megaphone : ch.type === CH.FORUM ? MessagesSquare : ch.type === CH.THREAD ? MessageSquareText : Hash;
  return (
    <span className="ch-icon">
      <Icon size={size} />
      {priv && <Lock size={Math.round(size * 0.5)} className="ch-lock" />}
    </span>
  );
}

const TYPES: [number, any, string, string][] = [
  [CH.TEXT, Hash, 'Text', 'Send messages, images, GIFs, emoji and opinions'],
  [CH.VOICE, Volume2, 'Voice', 'Hang out together with voice, video and screen share'],
  [CH.FORUM, MessagesSquare, 'Forum', 'Create a space for organized discussions'],
  [CH.ANNOUNCEMENT, Megaphone, 'Announcement', 'Important updates that only moderators can post'],
  [CH.STAGE, Podcast, 'Stage', 'Host events with speakers and a listening audience'],
];

export function CreateChannelModal({ serverId, parentId, category }: any) {
  const server = useStore((s: any) => s.servers[serverId]);
  const [type, setType] = useState<number>(category ? CH.CATEGORY : CH.TEXT);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('POST', `/api/servers/${serverId}/channels`, { name, type, parentId, private: priv, roles });
      closeModal();
      if (type !== CH.CATEGORY && type !== CH.VOICE && type !== CH.STAGE) {
        for (let i = 0; i < 40 && !findChannel(r.id); i++) await new Promise((res) => setTimeout(res, 50));
        navigate(serverId, r.id);
      }
    } catch (err: any) {
      setError(t(err.message));
    }
    setBusy(false);
  };
  const custom = server.roles.filter((r: any) => r.id !== serverId);
  return (
    <Modal title={category ? t('Create Category') : t('Create Channel')} width={480}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {!category && (
            <div className="field">
              <span className="field-label">{t('Channel Type')}</span>
              {TYPES.map(([v, Icon, title, desc]) => (
                <button type="button" key={v} className={'type-choice' + (type === v ? ' active' : '')} onClick={() => setType(v)}>
                  <Icon size={24} />
                  <div>
                    <b>{t(title)}</b>
                    <small>{t(desc)}</small>
                  </div>
                  <span className="radio" />
                </button>
              ))}
            </div>
          )}
          <Field label={category ? t('Category Name') : t('Channel Name')} error={error}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder={category ? t('New Category') : t('new-channel')} />
          </Field>
          <div className="setting-row">
            <div>
              <b>
                <Lock size={14} /> {category ? t('Private Category') : t('Private Channel')}
              </b>
              <small>{t('Only selected members and roles will be able to view this channel.')}</small>
            </div>
            <Toggle checked={priv} onChange={setPriv} />
          </div>
          {priv && custom.length > 0 && (
            <div className="field">
              <span className="field-label">{t('Who can access this channel?')}</span>
              <div className="pick-list">
                {custom.map((r: any) => (
                  <button type="button" key={r.id} className="pick-row" onClick={() => setRoles(roles.includes(r.id) ? roles.filter((x) => x !== r.id) : [...roles, r.id])}>
                    <i className="role-dot" style={{ background: r.color || '#99aab5' }} />
                    <b>{r.name}</b>
                    <span className={'checkbox' + (roles.includes(r.id) ? ' on' : '')}>{roles.includes(r.id) && <Check size={14} />}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {category ? t('Create Category') : t('Create Channel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- channel settings
const SLOWMODE = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
const slowLabel = (s: number) => (!s ? t('Off') : s < 60 ? t('{n}s', { n: num(s) }) : s < 3600 ? t('{n}m', { n: num(s / 60) }) : t('{n}h', { n: num(s / 3600) }));

export function ChannelSettings({ channelId, tab: initialTab }: { channelId: string; tab?: string }) {
  const ch = useStore(() => findChannel(channelId));
  useStore((s: any) => s.servers);
  const [tab, setTab] = useState(initialTab || 'overview');
  const [f, setF] = useState<any>(() => ({ name: ch?.name || '', topic: ch?.topic || '', rateLimit: ch?.rateLimit || 0, nsfw: !!ch?.nsfw, userLimit: ch?.userLimit || 0, bitrate: ch?.bitrate || 64 }));
  const [saving, setSaving] = useState(false);
  if (!ch) return null;
  const server = get().servers[ch.serverId];
  const isCat = ch.type === CH.CATEGORY;
  const isVoice = ch.type === CH.VOICE || ch.type === CH.STAGE;
  const textual = [CH.TEXT, CH.ANNOUNCEMENT, CH.FORUM].includes(ch.type);
  const myPerms = permsIn(server, get().me.id);
  const dirty = f.name !== ch.name || f.topic !== (ch.topic || '') || f.rateLimit !== (ch.rateLimit || 0) || f.nsfw !== !!ch.nsfw || f.userLimit !== (ch.userLimit || 0) || f.bitrate !== (ch.bitrate || 64);
  const save = async () => {
    setSaving(true);
    if (await act(api('PATCH', '/api/channels/' + ch.id, f))) toast('Saved', 'ok');
    setSaving(false);
  };
  const tabs = [
    ['overview', 'Overview'],
    ['permissions', 'Permissions'],
    ...(textual && myPerms & P.MANAGE_WEBHOOKS ? [['integrations', 'Integrations']] : []),
  ];
  return (
    <Modal className="settings" width={960}>
      <nav className="settings-nav">
        <div className="list-title">
          {isCat ? '' : '# '}
          {ch.name}
        </div>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {t(label)}
          </button>
        ))}
        <div className="menu-sep" />
        <button
          className="danger"
          onClick={() =>
            openModal('confirm', {
              title: isCat ? t('Delete Category') : t('Delete Channel'),
              text: t('Are you sure you want to delete {name}? This cannot be undone.', { name: ch.name }),
              danger: true,
              action: t('Delete'),
              onConfirm: () => api('DELETE', '/api/channels/' + ch.id),
            })
          }
        >
          {isCat ? t('Delete Category') : t('Delete Channel')}
        </button>
      </nav>
      <div className="settings-body">
        <button className="icon-btn settings-close" onClick={closeModal} aria-label={t('Close')}>
          <X size={22} />
        </button>
        {tab === 'overview' && (
          <>
            <h2>{t('Overview')}</h2>
            <Field label={isCat ? t('Category Name') : t('Channel Name')}>
              <input dir="auto" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} />
            </Field>
            {textual && (
              <Field label={ch.type === CH.FORUM ? t('Post Guidelines') : t('Channel Topic')}>
                <textarea dir="auto" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} maxLength={1024} rows={3} placeholder={t('Let everyone know how to use this channel!')} />
              </Field>
            )}
            {!isCat && ch.type !== CH.STAGE && (
              <Field label={t('Slowmode') + ' — ' + slowLabel(f.rateLimit)}>
                <input type="range" className="wide-range" min={0} max={SLOWMODE.length - 1} value={Math.max(0, SLOWMODE.indexOf(f.rateLimit))} onChange={(e) => setF({ ...f, rateLimit: SLOWMODE[Number(e.target.value)] })} />
                <small className="muted">{t('Members will be restricted to sending one message per this interval, unless they have Manage Channel or Manage Messages permissions.')}</small>
              </Field>
            )}
            {textual && (
              <div className="setting-row">
                <div>
                  <b>{t('Age-Restricted Channel')}</b>
                  <small>{t('Users will need to confirm they are over legal age to view the content in this channel.')}</small>
                </div>
                <Toggle checked={f.nsfw} onChange={(v) => setF({ ...f, nsfw: v })} />
              </div>
            )}
            {isVoice && (
              <>
                <Field label={t('Bitrate') + ' — ' + num(f.bitrate) + 'kbps'}>
                  <input type="range" className="wide-range" min={8} max={128} step={8} value={f.bitrate} onChange={(e) => setF({ ...f, bitrate: Number(e.target.value) })} />
                  <small className="muted">{t('Higher bitrates sound better but use more data. Above 64kbps only helps on good connections.')}</small>
                </Field>
                <Field label={t('User Limit') + ' — ' + (f.userLimit ? num(f.userLimit) : '∞')}>
                  <input type="range" className="wide-range" min={0} max={99} value={f.userLimit} onChange={(e) => setF({ ...f, userLimit: Number(e.target.value) })} />
                  <small className="muted">{t('Limits the number of users that can connect to this voice channel. Users with Move Members can still join.')}</small>
                </Field>
              </>
            )}
            <button className="btn primary" disabled={!dirty || saving || !f.name.trim()} onClick={save}>
              {t('Save Changes')}
            </button>
          </>
        )}
        {tab === 'permissions' && <PermissionsTab ch={ch} server={server} />}
        {tab === 'integrations' && <WebhooksTab serverId={ch.serverId} channelId={ch.id} />}
      </div>
    </Modal>
  );
}

/** Tri-state permission editor for one role or member on one channel. */
function PermissionsTab({ ch, server }: { ch: any; server: any }) {
  const meId = useStore((s: any) => s.me.id);
  const [ows, setOws] = useState<any[]>(() => (ch.overwrites || []).map((o: any) => ({ ...o })));
  const [sel, setSel] = useState<string>(server.id);
  const [saving, setSaving] = useState(false);
  useEffect(() => setOws((ch.overwrites || []).map((o: any) => ({ ...o }))), [JSON.stringify(ch.overwrites)]);
  const parent = ch.parentId ? server.channels.find((c: any) => c.id === ch.parentId) : null;
  const synced = parent && !(ch.overwrites || []).length;
  const current = ows.find((o) => o.id === sel) || { id: sel, type: sel === server.id || server.roles.some((r: any) => r.id === sel) ? 0 : 1, allow: 0, deny: 0 };
  const set = (bit: number, v: 'allow' | 'deny' | 'inherit') => {
    const o = { ...current, allow: current.allow & ~bit, deny: current.deny & ~bit };
    if (v === 'allow') o.allow |= bit;
    if (v === 'deny') o.deny |= bit;
    setOws([...ows.filter((x) => x.id !== sel), o]);
  };
  const dirty = JSON.stringify([...ows].sort((a, b) => (a.id > b.id ? 1 : -1))) !== JSON.stringify([...(ch.overwrites || [])].sort((a: any, b: any) => (a.id > b.id ? 1 : -1)));
  const save = async () => {
    setSaving(true);
    if (await act(api('PATCH', '/api/channels/' + ch.id, { overwrites: ows.filter((o) => o.allow || o.deny || o.id === server.id) }))) toast('Saved', 'ok');
    setSaving(false);
  };
  const targets = [...new Set([server.id, ...ows.map((o) => o.id)])];
  const label = (id: string) => (id === server.id ? '@everyone' : server.roles.find((r: any) => r.id === id)?.name || displayName(id, server.id));
  const addable = [
    ...server.roles.filter((r: any) => !targets.includes(r.id)).map((r: any) => ({ label: r.name, icon: <i className="role-dot" style={{ background: r.color || '#99aab5' }} />, onClick: () => (setOws([...ows, { id: r.id, type: 0, allow: 0, deny: 0 }]), setSel(r.id)) })),
    ...Object.keys(server.members)
      .filter((id) => !targets.includes(id))
      .slice(0, 30)
      .map((id) => ({ label: displayName(id, server.id), icon: <Avatar userId={id} size={16} />, onClick: () => (setOws([...ows, { id, type: 1, allow: 0, deny: 0 }]), setSel(id)) })),
  ];
  const priv = !!(ows.find((o) => o.id === server.id)?.deny & P.VIEW_CHANNEL);
  const relevant = PERM_LABELS.filter(([bit]) => bit & CHANNEL_PERMS);
  return (
    <>
      <h2>{t('Channel Permissions')}</h2>
      <p className="muted">{t('Use permissions to customise who can do what in this channel.')}</p>
      {parent && (
        <div className="notice">
          {synced ? t('Permissions synced with category: {name}', { name: parent.name }) : t('Permissions are not synced with category: {name}', { name: parent.name })}{' '}
          {!synced && (
            <button className="btn small" onClick={() => act(api('PATCH', '/api/channels/' + ch.id, { syncPermissions: true }))}>
              {t('Sync Now')}
            </button>
          )}
        </div>
      )}
      <div className="setting-row">
        <div>
          <b>
            <Lock size={14} /> {t('Private Channel')}
          </b>
          <small>{t('By making a channel private, only select members and roles will be able to view this channel.')}</small>
        </div>
        <Toggle
          checked={priv}
          onChange={(v) => {
            const ev = ows.find((o) => o.id === server.id) || { id: server.id, type: 0, allow: 0, deny: 0 };
            const next = { ...ev, allow: ev.allow & ~P.VIEW_CHANNEL, deny: v ? ev.deny | P.VIEW_CHANNEL : ev.deny & ~P.VIEW_CHANNEL };
            const rest = ows.filter((o) => o.id !== server.id);
            // Whoever makes it private keeps access.
            if (v && !rest.some((o) => o.id === meId) && server.ownerId !== meId) rest.push({ id: meId, type: 1, allow: P.VIEW_CHANNEL, deny: 0 });
            setOws([...rest, next]);
          }}
        />
      </div>
      <div className="roles-layout">
        <div className="roles-list">
          <div className="list-title">
            {t('Roles/Members')}
            <button className="icon-btn" title={t('Add a role or member')} onClick={(e) => openMenu(e, addable, true)}>
              <Plus size={16} />
            </button>
          </div>
          {targets.map((id) => (
            <div key={id} className={'role-row' + (sel === id ? ' active' : '')} onClick={() => setSel(id)}>
              {ows.find((o) => o.id === id)?.type === 1 ? <Avatar userId={id} size={18} /> : <i className="role-dot" style={{ background: server.roles.find((r: any) => r.id === id)?.color || '#99aab5' }} />}
              <span>{label(id)}</span>
              {id !== server.id && (
                <button className="icon-btn" title={t('Remove')} onClick={(e) => (e.stopPropagation(), setOws(ows.filter((o) => o.id !== id)), setSel(server.id))}>
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="role-edit">
          <h3>{label(sel)}</h3>
          {relevant.map(([bit, title, desc]) => {
            const v = current.allow & bit ? 'allow' : current.deny & bit ? 'deny' : 'inherit';
            return (
              <div className="setting-row" key={bit}>
                <div>
                  <b>{t(title)}</b>
                  <small>{t(desc)}</small>
                </div>
                <div className="tri">
                  <button className={'tri-deny' + (v === 'deny' ? ' on' : '')} title={t('Deny')} onClick={() => set(bit, 'deny')}>
                    <X size={14} />
                  </button>
                  <button className={'tri-inherit' + (v === 'inherit' ? ' on' : '')} title={t('Inherit')} onClick={() => set(bit, 'inherit')}>
                    <Slash size={12} />
                  </button>
                  <button className={'tri-allow' + (v === 'allow' ? ' on' : '')} title={t('Allow')} onClick={() => set(bit, 'allow')}>
                    <Check size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {dirty && (
        <div className="save-bar">
          <span>{t('Careful — you have unsaved changes!')}</span>
          <button className="btn link" onClick={() => setOws((ch.overwrites || []).map((o: any) => ({ ...o })))}>
            {t('Reset')}
          </button>
          <button className="btn green" disabled={saving} onClick={save}>
            {t('Save Changes')}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- webhooks
export function WebhooksTab({ serverId, channelId }: { serverId: string; channelId?: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const [list, setList] = useState<any[] | null>(null);
  const reload = () => api('GET', `/api/servers/${serverId}/webhooks`).then(setList).catch((e) => (toast(e.message), setList([])));
  useEffect(() => {
    reload();
  }, [serverId]);
  const textChannels = server.channels.filter((c: any) => [CH.TEXT, CH.ANNOUNCEMENT, CH.FORUM, CH.VOICE].includes(c.type));
  const create = async () => {
    const target = channelId || textChannels[0]?.id;
    if (!target) return toast('Create a text channel first');
    if (await act(api('POST', `/api/channels/${target}/webhooks`, { name: t('Captain Hook') }))) reload();
  };
  const shown = (list || []).filter((w) => !channelId || w.channelId === channelId);
  return (
    <>
      <h2>{t('Webhooks')}</h2>
      <p className="muted">{t('Webhooks are a simple way to post messages from other apps and websites into your server. The URL works like a Discord webhook URL.')}</p>
      <button className="btn primary" onClick={create}>
        <Webhook size={16} /> {t('New Webhook')}
      </button>
      {!list ? (
        <p className="muted">{t('Loading…')}</p>
      ) : !shown.length ? (
        <p className="muted">{t('No webhooks yet.')}</p>
      ) : (
        shown.map((w) => <WebhookRow key={w.id} w={w} channels={textChannels} reload={reload} />)
      )}
    </>
  );
}
function WebhookRow({ w, channels, reload }: any) {
  const [name, setName] = useState(w.name);
  const [channelId, setChannelId] = useState(w.channelId);
  const [copied, setCopied] = useState(false);
  const url = location.origin + w.url;
  return (
    <div className="webhook-card">
      <div className="avatar" style={{ width: 48, height: 48 }}>
        {w.avatar ? <img src={w.avatar} alt="" /> : <div className="avatar-fallback" style={{ background: '#5865f2' }}>
          <Webhook size={22} />
        </div>}
      </div>
      <div className="grow">
        <div className="two-col">
          <Field label={t('Name')}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label={t('Channel')}>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {channels.map((c: any) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <small className="muted">{t('Created on {date}', { date: fmtStamp(w.createdAt) })}</small>
        <div className="row-actions">
          <button
            className={'btn small ' + (copied ? 'green' : '')}
            onClick={() => {
              navigator.clipboard?.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={14} /> {copied ? t('Copied') : t('Copy Webhook URL')}
          </button>
          {(name !== w.name || channelId !== w.channelId) && (
            <button className="btn small primary" onClick={() => act(api('PATCH', '/api/webhooks/' + w.id, { name, channelId })).then((r) => r && (toast('Saved', 'ok'), reload()))}>
              {t('Save Changes')}
            </button>
          )}
          <button className="btn small danger" onClick={() => act(api('DELETE', '/api/webhooks/' + w.id)).then(reload)}>
            <Trash2 size={14} /> {t('Delete Webhook')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- threads
export function CreateThreadModal({ channelId, messageId, initialName }: { channelId: string; messageId?: string; initialName?: string }) {
  const [name, setName] = useState(initialName || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ch = findChannel(channelId);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('POST', `/api/channels/${channelId}/threads`, { name, messageId });
      closeModal();
      for (let i = 0; i < 40 && !findChannel(r.id); i++) await new Promise((res) => setTimeout(res, 50));
      navigate(ch?.serverId || null, r.id);
    } catch (err: any) {
      setError(t(err.message));
    }
    setBusy(false);
  };
  return (
    <Modal title={t('Create Thread')}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <Field label={t('Thread Name')} error={error}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder={t('New Thread')} />
          </Field>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {t('Create Thread')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ThreadsModal({ channelId }: { channelId: string }) {
  const ch = findChannel(channelId);
  const server = useStore((s: any) => (ch ? s.servers[ch.serverId] : null));
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  if (!ch || !server) return null;
  const list = threadsOf(server, channelId, tab === 'archived');
  return (
    <Modal title={t('Threads')} width={520}>
      <div className="modal-body">
        <div className="seg">
          <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
            {t('Active')}
          </button>
          <button className={tab === 'archived' ? 'active' : ''} onClick={() => setTab('archived')}>
            {t('Archived')}
          </button>
          <div className="spacer" />
          {canIn(ch, P.CREATE_THREADS) && (
            <button className="btn primary small" onClick={() => openModal('createThread', { channelId })}>
              {t('Create')}
            </button>
          )}
        </div>
        <div className="thread-list">
          {!list.length && (
            <div className="empty small">
              <MessageSquareText size={48} />
              <p>{tab === 'active' ? t('There are no active threads.') : t('There are no archived threads.')}</p>
            </div>
          )}
          {list.map((th: any) => (
            <button key={th.id} className="thread-row" onClick={() => (closeModal(), navigate(ch.serverId, th.id))}>
              <MessageSquareText size={20} />
              <div className="grow">
                <b dir="auto">{th.name}</b>
                <small className="muted">
                  {th.ownerId && displayName(th.ownerId, ch.serverId)} • {t('{n} Messages', { n: num(th.messageCount) })}
                </small>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function threadMenuItems(th: any) {
  const can = th.ownerId === get().me.id || canIn(th, P.MANAGE_THREADS);
  return [
    { label: th.archived ? t('Unarchive Thread') : t('Archive Thread'), icon: th.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />, hidden: !can, onClick: () => act(api('PATCH', '/api/channels/' + th.id, { archived: !th.archived })) },
    { label: t('Rename Thread'), hidden: !can, onClick: () => openModal('renameThread', { channelId: th.id }) },
    {
      label: t('Delete Thread'),
      danger: true,
      icon: <Trash2 size={16} />,
      hidden: !canIn(th, P.MANAGE_THREADS),
      onClick: () =>
        openModal('confirm', {
          title: t('Delete Thread'),
          text: t('Are you sure you want to delete {name}? This cannot be undone.', { name: th.name }),
          danger: true,
          action: t('Delete'),
          onConfirm: () => api('DELETE', '/api/channels/' + th.id),
        }),
    },
  ];
}

// ---------------------------------------------------------------- forum channels
export function ForumView({ channelId }: { channelId: string }) {
  const ch = findChannel(channelId);
  useStore((s: any) => s.servers[ch?.serverId]?.channels);
  const [posts, setPosts] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'activity' | 'created'>('activity');
  const [composing, setComposing] = useState(false);
  const lastIds = useStore((s: any) => (s.servers[ch?.serverId]?.channels || []).filter((c: any) => c.parentId === channelId).map((c: any) => c.id + (c.lastMessageId || '')).join());
  useEffect(() => {
    api('GET', `/api/channels/${channelId}/threads`)
      .then((r) => {
        useStore.setState((s: any) => ({ users: { ...Object.fromEntries(r.users.map((u: any) => [u.id, u])), ...s.users } }));
        setPosts(r.threads);
      })
      .catch((e) => (toast(e.message), setPosts([])));
  }, [channelId, lastIds]);
  if (!ch) return null;
  const shown = (posts || [])
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.firstMessage?.content?.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === 'created' ? (b.id > a.id ? 1 : -1) : (b.lastMessageId || b.id) > (a.lastMessageId || a.id) ? 1 : -1));
  return (
    <div className="forum">
      {ch.topic && (
        <div className="forum-guidelines">
          <b>{t('Post Guidelines')}</b>
          <Markdown text={ch.topic} serverId={ch.serverId} />
        </div>
      )}
      <div className="forum-bar">
        <div className="search-box">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search or create a post…')} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="activity">{t('Recently Active')}</option>
          <option value="created">{t('Date Posted')}</option>
        </select>
        {canIn(ch, P.CREATE_THREADS) && (
          <button className="btn primary" onClick={() => setComposing(true)}>
            <Plus size={16} /> {t('New Post')}
          </button>
        )}
      </div>
      {composing && <NewPost channelId={channelId} initial={q} onDone={() => setComposing(false)} />}
      <div className="forum-posts">
        {!posts ? (
          <p className="muted center">{t('Loading…')}</p>
        ) : !shown.length ? (
          <div className="empty">
            <MessagesSquare size={64} />
            <p>{t('There are no posts yet. Be the first to start a discussion!')}</p>
          </div>
        ) : (
          shown.map((p) => {
            const img = p.firstMessage?.attachments?.find((a: any) => a.type.startsWith('image/'));
            return (
              <div key={p.id} className={'forum-post' + (p.archived ? ' archived' : '')} onClick={() => navigate(ch.serverId, p.id)}>
                <div className="grow">
                  <h3 dir="auto">{p.name}</h3>
                  {p.firstMessage && (
                    <div className="fp-preview" dir="auto">
                      <b>{displayName(p.firstMessage.authorId, ch.serverId)}:</b> {(p.firstMessage.content || '').slice(0, 200)}
                    </div>
                  )}
                  <div className="fp-meta">
                    <MessageSquareText size={14} /> {num(Math.max(0, p.messageCount - 1))} • {fmtStamp(p.createdAt || Number(p.id) || Date.now())}
                    {p.archived && <span className="tag">{t('Archived')}</span>}
                  </div>
                </div>
                {img && <img className="fp-thumb" src={img.url} alt="" loading="lazy" />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function NewPost({ channelId, initial, onDone }: { channelId: string; initial: string; onDone: () => void }) {
  const ch = findChannel(channelId);
  const [name, setName] = useState(initial);
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const f of files) ids.push((await upload(f, f.name)).id);
      const r = await api('POST', `/api/channels/${channelId}/threads`, { name, content, attachments: ids });
      onDone();
      for (let i = 0; i < 40 && !findChannel(r.id); i++) await new Promise((res) => setTimeout(res, 50));
      navigate(ch.serverId, r.id);
    } catch (e: any) {
      toast(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="new-post">
      <input dir="auto" className="np-title" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={t('Post Title')} autoFocus />
      <textarea dir="auto" value={content} onChange={(e) => setContent(e.target.value)} rows={4} maxLength={4000} placeholder={t('Enter a message to start the discussion')} />
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f, i) => (
            <span key={i} className="tag">
              {f.name}{' '}
              <button className="icon-btn" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row-actions">
        <label className="btn small">
          <Paperclip size={14} /> {t('Attach')}
          <input type="file" hidden multiple onChange={(e) => (setFiles([...files, ...Array.from(e.target.files || [])].slice(0, 10)), (e.target.value = ''))} />
        </label>
        <div className="spacer" />
        <button className="btn link" onClick={onDone}>
          {t('Cancel')}
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || (!content.trim() && !files.length)} onClick={submit}>
          {t('Post')}
        </button>
      </div>
    </div>
  );
}

export function RenameThread({ channelId }: { channelId: string }) {
  const th = findChannel(channelId);
  const [name, setName] = useState(th?.name || '');
  if (!th) return null;
  return (
    <Modal title={t('Rename Thread')}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act(api('PATCH', '/api/channels/' + channelId, { name }))) closeModal();
        }}
      >
        <div className="modal-body">
          <Field label={t('Thread Name')}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus required />
          </Field>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary">{t('Save')}</button>
        </div>
      </form>
    </Modal>
  );
}
export { Attachment };
