import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, Hash, Plus, Trash2, Volume2, X, MoreVertical, Crown } from 'lucide-react';
import { useStore, get, act, toast, closeModal, openModal, navigate, updateSettings, displayName, roleColor, findChannel, dmName, permsIn, topPos, can, jumpTo, openDm, startCall, logout, P, CH, REL } from './store';
import { api, upload, uploadSquareImage } from './api';
import { voice } from './voice';
import { playSound } from './sfx';
import { isDesktop } from './desktop';
import { WindowsSettings, UpdatesPanel } from './AppSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { t } from './i18n';
import { Avatar, ServerIcon, Modal, Field, Toggle, openMenu, fmtDate, fmtStamp, num, colorFor, MenuItem } from './ui';
import { MessageCard } from './Chat';
import { PERM_LABELS } from '../shared/perms';
import { NOISE_MODES } from './noise';
import { ForwardModal, PollModal } from './features/Messages';
import { CreateChannelModal, ChannelSettings, CreateThreadModal, ThreadsModal, RenameThread, WebhooksTab } from './features/Channels';
import { ExpressionsTab, AutoModTab, AuditLogTab, EventsModal, CreateEventModal, NotificationSettingsModal, TimeoutModal, MoveModal, DiscordImportModal } from './features/Server';
import { AccountExtras, MicTest, StreamQuality, KeybindsTab, ActivityTab, ActivityLine, NoteField, InboxModal, QuickSwitcher } from './features/Account';
import { Clock, MicOff, HeadphoneOff, ArrowRightLeft, Hash as HashIcon, Download } from 'lucide-react';

export const STATUS_LABEL: Record<string, string> = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' };

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<any>, close = true) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (close) closeModal();
    } catch (e: any) {
      setError(t(e.message));
    }
    setBusy(false);
  };
  return { busy, error, run };
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="modal-foot">{children}</div>;
}

function VolumeSlider({ userId }: { userId: string }) {
  const vol = useStore((s: any) => s.settings.volumes[userId] ?? 100);
  return (
    <label className="volume">
      <span>
        {t('User Volume')} — {num(vol)}%
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={vol}
        onChange={(e) => {
          updateSettings({ volumes: { ...get().settings.volumes, [userId]: Number(e.target.value) } });
          voice.refreshOutput();
        }}
      />
    </label>
  );
}

/** Context menu shared by member rows, voice rows and the profile card. */
export function memberMenu(e: React.MouseEvent, userId: string, serverId?: string | null) {
  const s = get();
  const me = s.me.id;
  const self = userId === me;
  const rel = s.relationships[userId];
  const server = serverId ? s.servers[serverId] : null;
  const perms = server ? permsIn(server, me) : 0;
  const isMember = !!server?.members[userId];
  const outranks = server && isMember && !self && topPos(server, me) > topPos(server, userId);
  const name = displayName(userId, serverId);
  const inMyVoice = !self && s.voice.channelId && s.voiceStates[userId]?.channelId === s.voice.channelId;
  const ask = (title: string, text: string, action: string, fn: () => Promise<any>) => openModal('confirm', { title, text, action, danger: true, onConfirm: fn });
  const items: MenuItem[] = [
    { label: t('Profile'), onClick: () => openModal('profile', { userId, serverId }) },
    { label: t('Message'), hidden: self, onClick: () => openDm(userId) },
    { label: t('Start Voice Call'), hidden: self, onClick: () => startCall(userId) },
    { custom: <VolumeSlider userId={userId} />, hidden: !inMyVoice },
    { sep: true },
    { label: t('Change Nickname'), hidden: !isMember || !(self || (perms & P.MANAGE_SERVER && outranks)), onClick: () => openModal('nickname', { serverId, userId }) },
    { label: t('Add Friend'), hidden: self || !!rel, onClick: () => act(api('POST', '/api/friends', { username: s.users[userId].username })).then((r) => r && toast('Friend request sent', 'ok')) },
    { label: t('Accept Friend Request'), hidden: rel !== REL.INCOMING, onClick: () => act(api('PUT', '/api/friends/' + userId)) },
    { label: t('Remove Friend'), hidden: rel !== REL.FRIEND, onClick: () => act(api('DELETE', '/api/friends/' + userId)) },
    { label: rel === REL.BLOCKED ? t('Unblock') : t('Block'), hidden: self, danger: rel !== REL.BLOCKED, onClick: () => act(api(rel === REL.BLOCKED ? 'DELETE' : 'PUT', '/api/blocks/' + userId)) },
    { sep: true },
    {
      label: t('Kick {name}', { name }),
      danger: true,
      hidden: !(perms & P.KICK_MEMBERS) || !outranks,
      onClick: () => ask(t('Kick {name}', { name }), t('Are you sure you want to kick {name}? They can rejoin with a new invite.', { name }), t('Kick'), () => api('DELETE', `/api/servers/${serverId}/members/${userId}`)),
    },
    {
      label: t('Ban {name}', { name }),
      danger: true,
      hidden: !(perms & P.BAN_MEMBERS) || !outranks,
      onClick: () => ask(t('Ban {name}', { name }), t('Are you sure you want to ban {name}? They will not be able to rejoin.', { name }), t('Ban'), () => api('PUT', `/api/servers/${serverId}/bans/${userId}`, {})),
    },
    { sep: true },
    {
      label: server && (server.members[userId]?.timeoutUntil || 0) > Date.now() ? t('Remove Time Out') : t('Time Out {name}', { name }),
      icon: <Clock size={16} />,
      danger: true,
      hidden: !(perms & P.MODERATE_MEMBERS) || !outranks,
      onClick: () =>
        (server.members[userId]?.timeoutUntil || 0) > Date.now()
          ? act(api('PATCH', `/api/servers/${serverId}/members/${userId}`, { timeout: 0 }))
          : openModal('timeout', { serverId, userId }),
    },
    {
      label: server?.members[userId]?.serverMute ? t('Server Unmute') : t('Server Mute'),
      icon: <MicOff size={16} />,
      hidden: !server || !isMember || !(perms & P.MUTE_MEMBERS) || (!outranks && !self),
      onClick: () => act(api('PATCH', `/api/servers/${serverId}/voice/${userId}`, { mute: !server.members[userId]?.serverMute })),
    },
    {
      label: server?.members[userId]?.serverDeaf ? t('Server Undeafen') : t('Server Deafen'),
      icon: <HeadphoneOff size={16} />,
      hidden: !server || !isMember || !(perms & P.DEAFEN_MEMBERS) || (!outranks && !self),
      onClick: () => act(api('PATCH', `/api/servers/${serverId}/voice/${userId}`, { deaf: !server.members[userId]?.serverDeaf })),
    },
    {
      label: t('Move To…'),
      icon: <ArrowRightLeft size={16} />,
      hidden: !server || !(perms & P.MOVE_MEMBERS) || (!outranks && !self) || !server.channels.some((c: any) => c.id === s.voiceStates[userId]?.channelId),
      onClick: () => openModal('move', { serverId, userId }),
    },
    {
      label: t('Disconnect from Voice'),
      danger: true,
      hidden: !server || !(perms & P.MOVE_MEMBERS) || (!outranks && !self) || !server.channels.some((c: any) => c.id === s.voiceStates[userId]?.channelId),
      onClick: () => act(api('DELETE', `/api/servers/${serverId}/voice/${userId}`)),
    },
    {
      label: t('Transfer Ownership'),
      danger: true,
      hidden: !server || server.ownerId !== me || self || !isMember,
      onClick: () => ask(t('Transfer Ownership'), t('Are you sure you want to make {name} the owner of this server?', { name }), t('Transfer Ownership'), () => api('PATCH', `/api/servers/${serverId}`, { ownerId: userId })),
    },
    { sep: true },
    { label: t('Copy User ID'), icon: <HashIcon size={16} />, onClick: () => navigator.clipboard?.writeText(userId) },
  ];
  openMenu(e, items);
}

function Confirm({ title, text, action, danger, onConfirm }: any) {
  const { busy, error, run } = useBusy();
  return (
    <Modal title={title}>
      <div className="modal-body">
        <p>{text}</p>
        {error && <div className="form-error">{error}</div>}
      </div>
      <Footer>
        <button className="btn link" onClick={closeModal}>
          {t('Cancel')}
        </button>
        <button className={'btn ' + (danger ? 'danger' : 'primary')} disabled={busy} autoFocus onClick={() => run(onConfirm)}>
          {action || t('Confirm')}
        </button>
      </Footer>
    </Modal>
  );
}

function ImagePick({ value, onChange, round, fallback }: { value: string | null; onChange: (url: string | null) => void; round?: boolean; fallback: React.ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadSquareImage(file));
    } catch (e: any) {
      toast(e.message || 'Invalid image');
    }
    setBusy(false);
  };
  return (
    <div className="image-pick">
      <button type="button" className={'pick-preview' + (round ? ' round-img' : '')} onClick={() => input.current?.click()} disabled={busy}>
        {value ? <img src={value} alt="" /> : fallback}
      </button>
      <div>
        <button type="button" className="btn primary small" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? t('Uploading…') : t('Upload Image')}
        </button>
        {value && (
          <button type="button" className="btn link small" onClick={() => onChange(null)}>
            {t('Remove')}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
    </div>
  );
}

function BannerPick({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      const scale = Math.min(1, 960 / bmp.width);
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(Math.min(bmp.height * scale, c.width * 0.5625));
      c.getContext('2d')!.drawImage(bmp, 0, 0, bmp.width, c.height / scale, 0, 0, c.width, c.height);
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Invalid image'))), 'image/webp', 0.88));
      onChange((await upload(blob, 'banner.webp')).url);
    } catch (e: any) {
      toast(e.message || 'Invalid image');
    }
    setBusy(false);
  };
  return (
    <div className="banner-pick">
      <button type="button" className="banner-preview" style={value ? { backgroundImage: `url(${value})` } : undefined} onClick={() => input.current?.click()} disabled={busy}>
        {!value && (busy ? t('Uploading…') : t('Upload Banner'))}
      </button>
      {value && (
        <button type="button" className="btn link small" onClick={() => onChange(null)}>
          {t('Remove')}
        </button>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
    </div>
  );
}

function CreateServer() {
  const me = useStore((s: any) => s.me);
  const [mode, setMode] = useState<'pick' | 'create' | 'join'>('pick');
  const [name, setName] = useState(t("{name}'s server", { name: me.displayName }));
  const [icon, setIcon] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useBusy();
  if (mode === 'pick')
    return (
      <Modal title={t('Add a Server')}>
        <div className="modal-body">
          <p className="muted">{t('Your server is where you and your friends hang out. Make yours and start talking.')}</p>
          <button className="big-choice" onClick={() => setMode('create')}>
            <Plus size={24} /> {t('Create My Own')}
          </button>
          <button className="big-choice" onClick={() => setMode('join')}>
            <Hash size={24} /> {t('Join a Server')}
          </button>
          <button className="big-choice" onClick={() => openModal('discordImport')}>
            <Download size={24} /> {t('Import from Discord')}
          </button>
        </div>
      </Modal>
    );
  if (mode === 'join')
    return (
      <Modal title={t('Join a Server')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const c = code.trim().split('/').pop()!;
            run(async () => openModal('join', { code: (await api('GET', '/api/invites/' + c)).code }), false);
          }}
        >
          <div className="modal-body">
            <p className="muted">{t('Enter an invite below to join an existing server.')}</p>
            <Field label={t('Invite Link')} error={error}>
              <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder={location.origin + '/invite/hTKzmak3'} autoFocus required />
            </Field>
          </div>
          <Footer>
            <button type="button" className="btn link" onClick={() => setMode('pick')}>
              {t('Back')}
            </button>
            <button className="btn primary" disabled={busy}>
              {t('Join Server')}
            </button>
          </Footer>
        </form>
      </Modal>
    );
  return (
    <Modal title={t('Customize Your Server')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api('POST', '/api/servers', { name, icon, locale: get().settings.lang });
            // The server arrives over the gateway; wait for it before navigating.
            for (let i = 0; i < 40 && !get().servers[r.id]; i++) await new Promise((res) => setTimeout(res, 50));
            navigate(r.id);
          });
        }}
      >
        <div className="modal-body">
          <p className="muted">{t('Give your new server a personality with a name and an icon. You can always change it later.')}</p>
          <ImagePick value={icon} onChange={setIcon} round fallback={<Plus size={28} />} />
          <Field label={t('Server Name')} error={error}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
          </Field>
        </div>
        <Footer>
          <button type="button" className="btn link" onClick={() => setMode('pick')}>
            {t('Back')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {t('Create')}
          </button>
        </Footer>
      </form>
    </Modal>
  );
}

function JoinInvite({ code }: { code: string }) {
  const [inv, setInv] = useState<any>(null);
  const [failed, setFailed] = useState('');
  const { busy, error, run } = useBusy();
  useEffect(() => {
    api('GET', '/api/invites/' + code)
      .then(setInv)
      .catch((e) => setFailed(t(e.message)));
  }, [code]);
  const go = (id: string) => {
    closeModal();
    navigate(id);
  };
  return (
    <Modal width={400} className="center">
      <div className="modal-body invite-card">
        {failed ? (
          <>
            <h2>{t('Invite Invalid')}</h2>
            <p className="muted">{failed}</p>
            <button className="btn primary wide" onClick={closeModal}>
              {t('Close')}
            </button>
          </>
        ) : !inv ? (
          <p className="muted">{t('Loading…')}</p>
        ) : (
          <>
            <ServerIcon server={inv.server} size={72} />
            <p className="muted">{inv.inviter ? t('{name} invited you to join', { name: inv.inviter.displayName }) : t('You have been invited to join')}</p>
            <h2>{inv.server.name}</h2>
            <p className="muted">{t('{n} Members', { n: num(inv.server.memberCount) })}</p>
            {error && <div className="form-error">{error}</div>}
            {inv.joined ? (
              <button className="btn primary wide" onClick={() => go(inv.server.id)}>
                {t('Go to Server')}
              </button>
            ) : (
              <button
                className="btn primary wide"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api('POST', '/api/invites/' + code);
                    for (let i = 0; i < 40 && !get().servers[r.id]; i++) await new Promise((res) => setTimeout(res, 50));
                    go(r.id);
                  }, false)
                }
              >
                {t('Accept Invite')}
              </button>
            )}
            <button className="btn link wide" onClick={closeModal}>
              {t('No Thanks')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Invite({ serverId }: { serverId: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const [age, setAge] = useState(604800);
  const [uses, setUses] = useState(0);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCode('');
    api('POST', `/api/servers/${serverId}/invites`, { maxAge: age, maxUses: uses })
      .then((r) => setCode(r.code))
      .catch((e) => toast(e.message));
  }, [age, uses]);
  const link = code ? `${location.origin}/invite/${code}` : '';
  const copy = () => {
    navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Modal title={t('Invite friends to {name}', { name: server?.name })}>
      <div className="modal-body">
        <Field label={t('Send this link to a friend')}>
          <div className="copy-row">
            <input dir="ltr" readOnly value={link || '…'} onFocus={(e) => e.target.select()} />
            <button className={'btn ' + (copied ? 'green' : 'primary')} onClick={copy} disabled={!code}>
              {copied ? t('Copied') : t('Copy')}
            </button>
          </div>
        </Field>
        <div className="two-col">
          <Field label={t('Expire After')}>
            <select value={age} onChange={(e) => setAge(Number(e.target.value))}>
              <option value={1800}>{t('30 minutes')}</option>
              <option value={3600}>{t('1 hour')}</option>
              <option value={86400}>{t('1 day')}</option>
              <option value={604800}>{t('7 days')}</option>
              <option value={0}>{t('Never')}</option>
            </select>
          </Field>
          <Field label={t('Max Number of Uses')}>
            <select value={uses} onChange={(e) => setUses(Number(e.target.value))}>
              <option value={0}>{t('No limit')}</option>
              {[1, 5, 10, 25, 100].map((n) => (
                <option key={n} value={n}>
                  {num(n)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function CreateChannel({ serverId, parentId, category }: any) {
  const [type, setType] = useState<number>(category ? CH.CATEGORY : CH.TEXT);
  const [name, setName] = useState('');
  const { busy, error, run } = useBusy();
  return (
    <Modal title={category ? t('Create Category') : t('Create Channel')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await api('POST', `/api/servers/${serverId}/channels`, { name, type, parentId });
            if (type === CH.TEXT) {
              for (let i = 0; i < 40 && !findChannel(r.id); i++) await new Promise((res) => setTimeout(res, 50));
              navigate(serverId, r.id);
            }
          });
        }}
      >
        <div className="modal-body">
          {!category && (
            <div className="field">
              <span className="field-label">{t('Channel Type')}</span>
              {[
                [CH.TEXT, <Hash size={24} />, t('Text'), t('Send messages, images, GIFs, emoji and opinions')],
                [CH.VOICE, <Volume2 size={24} />, t('Voice'), t('Hang out together with voice, video and screen share')],
              ].map(([v, icon, title, desc]: any) => (
                <button type="button" key={v} className={'type-choice' + (type === v ? ' active' : '')} onClick={() => setType(v)}>
                  {icon}
                  <div>
                    <b>{title}</b>
                    <small>{desc}</small>
                  </div>
                  <span className="radio" />
                </button>
              ))}
            </div>
          )}
          <Field label={category ? t('Category Name') : t('Channel Name')} error={error}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder={category ? t('New Category') : t('new-channel')} />
          </Field>
        </div>
        <Footer>
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {category ? t('Create Category') : t('Create Channel')}
          </button>
        </Footer>
      </form>
    </Modal>
  );
}

function EditChannel({ channelId }: { channelId: string }) {
  const ch = findChannel(channelId);
  const [name, setName] = useState(ch?.name || '');
  const [topic, setTopic] = useState(ch?.topic || '');
  const { busy, error, run } = useBusy();
  if (!ch) return null;
  const group = !ch.serverId;
  return (
    <Modal title={group ? t('Rename Group') : ch.type === CH.CATEGORY ? t('Edit Category') : t('Edit Channel')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api('PATCH', '/api/channels/' + channelId, group ? { name } : { name, topic }));
        }}
      >
        <div className="modal-body">
          <Field label={group ? t('Group Name') : ch.type === CH.CATEGORY ? t('Category Name') : t('Channel Name')} error={error}>
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required={!group} autoFocus />
          </Field>
          {!group && ch.type === CH.TEXT && (
            <Field label={t('Channel Topic')}>
              <textarea dir="auto" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} rows={3} placeholder={t('Let everyone know how to use this channel!')} />
            </Field>
          )}
        </div>
        <Footer>
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy}>
            {t('Save')}
          </button>
        </Footer>
      </form>
    </Modal>
  );
}

function Prompt({ title, label, initial, max, placeholder, onSave }: any) {
  const [v, setV] = useState(initial || '');
  const { busy, error, run } = useBusy();
  return (
    <Modal title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(() => onSave(v));
        }}
      >
        <div className="modal-body">
          <Field label={label} error={error}>
            <input dir="auto" value={v} onChange={(e) => setV(e.target.value)} maxLength={max} autoFocus placeholder={placeholder} />
          </Field>
        </div>
        <Footer>
          <button type="button" className="btn link" onClick={closeModal}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy}>
            {t('Save')}
          </button>
        </Footer>
      </form>
    </Modal>
  );
}

function NewDm({ groupId }: { groupId?: string }) {
  const rels = useStore((s: any) => s.relationships);
  const group = groupId ? get().dms[groupId] : null;
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const { busy, error, run } = useBusy();
  const friends = Object.keys(rels)
    .filter((i) => rels[i] === REL.FRIEND && !group?.recipients.includes(i))
    .filter((i) => !q || displayName(i).toLowerCase().includes(q.toLowerCase()) || get().users[i]?.username.includes(q.toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const limit = group ? 10 - group.recipients.length : 9;
  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < limit ? [...sel, id] : sel);
  const submit = () =>
    run(async () => {
      if (group) {
        for (const id of sel) await api('PUT', `/api/channels/${groupId}/recipients/${id}`);
        return;
      }
      const dm = await api('POST', '/api/dms', { recipients: sel });
      for (let i = 0; i < 40 && !get().dms[dm.id]; i++) await new Promise((res) => setTimeout(res, 50));
      navigate(null, dm.id);
    });
  return (
    <Modal title={group ? t('Add Friends to Group') : t('Select Friends')}>
      <div className="modal-body">
        <p className="muted">{t('You can add {n} more friends.', { n: num(limit - sel.length) })}</p>
        <input className="plain-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Type the username of a friend')} autoFocus />
        <div className="pick-list">
          {friends.length === 0 && <p className="muted center">{t('No friends found.')}</p>}
          {friends.map((id) => (
            <button key={id} className="pick-row" onClick={() => toggle(id)}>
              <Avatar userId={id} size={32} status />
              <b>{displayName(id)}</b>
              <small dir="ltr">{get().users[id]?.username}</small>
              <span className={'checkbox' + (sel.includes(id) ? ' on' : '')}>{sel.includes(id) && <Check size={14} />}</span>
            </button>
          ))}
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
      <Footer>
        <button className="btn primary wide" disabled={busy || !sel.length} onClick={submit}>
          {group ? t('Add') : sel.length > 1 ? t('Create Group DM') : t('Create DM')}
        </button>
      </Footer>
    </Modal>
  );
}

function Profile({ userId, serverId }: { userId: string; serverId?: string | null }) {
  const user = useStore((s: any) => s.users[userId]);
  const me = useStore((s: any) => s.me);
  const rel = useStore((s: any) => s.relationships[userId]);
  const presence = useStore((s: any) => s.presences[userId] || 'offline');
  const server = useStore((s: any) => (serverId ? s.servers[serverId] : null));
  const inMyVoice = useStore((s: any) => userId !== s.me.id && s.voice.channelId && s.voiceStates[userId]?.channelId === s.voice.channelId);
  if (!user) return null;
  const self = userId === me.id;
  const member = server?.members[userId];
  const myTop = server ? topPos(server, me.id) : 0;
  const canRoles = server && member && !!(permsIn(server, me.id) & P.MANAGE_ROLES);
  const roles = server ? server.roles.filter((r: any) => r.id !== server.id) : [];
  const setRoles = (ids: string[]) => act(api('PATCH', `/api/servers/${serverId}/members/${userId}`, { roles: ids }));
  const addable = roles.filter((r: any) => !member?.roles.includes(r.id) && r.position < myTop);
  return (
    <Modal width={360} className="profile">
      <div className="profile-banner" style={{ background: user.bannerColor || colorFor(userId) }} />
      <div className="profile-top">
        <div className="profile-avatar">
          <Avatar userId={userId} size={84} status />
        </div>
        <button className="icon-btn" onClick={(e) => memberMenu(e, userId, serverId)} title={t('More')}>
          <MoreVertical size={20} />
        </button>
      </div>
      <div className="profile-card">
        <h2>
          {displayName(userId, serverId)} {server?.ownerId === userId && <Crown size={16} className="crown" />}
        </h2>
        <div className="profile-user" dir="ltr">
          {user.username}
          {user.pronouns && <span className="pronouns"> • {user.pronouns}</span>}
        </div>
        <div className="muted">{user.customStatus || t(STATUS_LABEL[presence])}</div>
        <ActivityLine userId={userId} />
        {member && member.timeoutUntil > Date.now() && (
          <div className="notice">
            <Clock size={14} /> {t('Timed out until {time}', { time: fmtStamp(member.timeoutUntil) })}
          </div>
        )}
        {user.bio && (
          <>
            <h4>{t('About Me')}</h4>
            <p className="bio" dir="auto">
              {user.bio}
            </p>
          </>
        )}
        <h4>{t('Member Since')}</h4>
        <p>
          {fmtDate(user.createdAt)}
          {member && ` • ${t('joined this server on {date}', { date: fmtDate(member.joinedAt) })}`}
        </p>
        {member && (roles.length > 0 || canRoles) && (
          <>
            <h4>{t('Roles')}</h4>
            <div className="role-chips">
              {roles
                .filter((r: any) => member.roles.includes(r.id))
                .map((r: any) => (
                  <span key={r.id} className="role-chip">
                    <i style={{ background: r.color || '#99aab5' }} />
                    {r.name}
                    {canRoles && r.position < myTop && (
                      <button onClick={() => setRoles(member.roles.filter((x: string) => x !== r.id))} title={t('Remove')}>
                        <X size={12} />
                      </button>
                    )}
                  </span>
                ))}
              {canRoles && addable.length > 0 && (
                <button
                  className="role-chip add"
                  title={t('Add Role')}
                  onClick={(e) =>
                    openMenu(
                      e,
                      addable.map((r: any) => ({ label: r.name, icon: <i className="role-dot" style={{ background: r.color || '#99aab5' }} />, onClick: () => setRoles([...member.roles, r.id]) })),
                      true
                    )
                  }
                >
                  <Plus size={14} />
                </button>
              )}
              {!member.roles.length && !canRoles && <span className="muted">{t('No roles')}</span>}
            </div>
          </>
        )}
        {!self && (
          <>
            <h4>{t('Note')}</h4>
            <NoteField userId={userId} />
          </>
        )}
        {inMyVoice && <VolumeSlider userId={userId} />}
        {self ? (
          <button className="btn primary wide" onClick={() => openModal('userSettings', { tab: 'profile' })}>
            {t('Edit Profile')}
          </button>
        ) : (
          <div className="profile-actions">
            <button className="btn primary" onClick={() => (closeModal(), openDm(userId))}>
              {t('Message')}
            </button>
            {!rel && (
              <button className="btn green" onClick={() => act(api('POST', '/api/friends', { username: user.username }))}>
                {t('Add Friend')}
              </button>
            )}
            {rel === REL.INCOMING && (
              <button className="btn green" onClick={() => act(api('PUT', '/api/friends/' + userId))}>
                {t('Accept')}
              </button>
            )}
            {rel === REL.OUTGOING && (
              <button className="btn" disabled>
                {t('Request Sent')}
              </button>
            )}
            {rel === REL.BLOCKED && (
              <button className="btn" onClick={() => act(api('DELETE', '/api/blocks/' + userId))}>
                {t('Unblock')}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function MessageListModal({ title, load, serverId, channelId, emptyText, pins }: any) {
  const [data, setData] = useState<any[] | null>(null);
  useEffect(() => {
    load()
      .then((r: any) => {
        useStore.setState((s: any) => ({ users: { ...Object.fromEntries(r.users.map((u: any) => [u.id, u])), ...s.users } }));
        setData(r.messages);
      })
      .catch((e: any) => (toast(e.message), setData([])));
    const onDelete = (e: any) => setData((d) => d && d.filter((m) => m.id !== e.detail));
    const onUpdate = (e: any) => setData((d) => d && (pins && !e.detail.pinned ? d.filter((m) => m.id !== e.detail.id) : d.map((m) => (m.id === e.detail.id ? e.detail : m))));
    window.addEventListener('message-delete', onDelete);
    window.addEventListener('message-update', onUpdate);
    return () => {
      window.removeEventListener('message-delete', onDelete);
      window.removeEventListener('message-update', onUpdate);
    };
  }, []);
  const canUnpin = pins && (!serverId || can(serverId, P.MANAGE_MESSAGES));
  return (
    <Modal title={title} width={560}>
      <div className="modal-body msg-list-modal">
        {!data ? (
          <p className="muted center">{t('Loading…')}</p>
        ) : !data.length ? (
          <p className="muted center">{emptyText}</p>
        ) : (
          data.map((m) => {
            const ch = findChannel(m.channelId);
            return (
              <div key={m.id}>
                {!channelId && ch && <div className="list-title">{ch.serverId ? '#' + ch.name : dmName(ch)}</div>}
                <MessageCard
                  m={m}
                  serverId={ch?.serverId}
                  onClick={(e: React.MouseEvent) => {
                    if ((e.target as HTMLElement).closest('a, button, img, video, audio')) return;
                    closeModal();
                    jumpTo(m.channelId, m.id);
                  }}
                  action={
                    canUnpin && (
                      <button className="icon-btn" title={t('Unpin Message')} onClick={() => act(api('DELETE', `/api/messages/${m.id}/pin`))}>
                        <X size={16} />
                      </button>
                    )
                  }
                />
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ user settings
function Devices() {
  const settings = useStore((s: any) => s.settings);
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(setDevs).catch(() => {});
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, []);
  const needPerm = devs.length > 0 && devs.every((d) => !d.label);
  const grant = async () => {
    try {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((x) => x.stop());
      refresh();
    } catch {
      toast('Microphone permission was denied');
    }
  };
  const change = (patch: any, input = true) => {
    updateSettings(patch);
    if (input) voice.refreshInput();
    else voice.refreshOutput();
  };
  const opts = (kind: string) => devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
  return (
    <>
      <h2>{t('Voice & Video')}</h2>
      {needPerm && (
        <div className="notice">
          {t('Allow microphone access to see your devices.')}{' '}
          <button className="btn primary small" onClick={grant}>
            {t('Allow')}
          </button>
        </div>
      )}
      <div className="two-col">
        <Field label={t('Input Device')}>
          <select value={settings.inputDevice} onChange={(e) => change({ inputDevice: e.target.value })}>
            <option value="">{t('Default')}</option>
            {opts('audioinput').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || t('Microphone')}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Output Device')}>
          <select value={settings.outputDevice} onChange={(e) => change({ outputDevice: e.target.value }, false)}>
            <option value="">{t('Default')}</option>
            {opts('audiooutput').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || t('Speaker')}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h3>{t('Noise Cancellation')}</h3>
      {NOISE_MODES.map(([k, title, desc]) => (
        <button key={k} className={'type-choice' + ((settings.noiseCancel || 'ai') === k ? ' active' : '')} onClick={() => change({ noiseCancel: k })}>
          <div>
            <b>{t(title)}</b>
            <small>{t(desc)}</small>
          </div>
          <span className="radio" />
        </button>
      ))}
      {[
        ['echoCancellation', 'Echo Cancellation', 'Stops your friends from hearing themselves.'],
        ['autoGain', 'Automatic Gain Control', 'Keeps your volume level steady.'],
      ].map(([k, title, desc]) => (
        <div className="setting-row" key={k}>
          <div>
            <b>{t(title)}</b>
            <small>{t(desc)}</small>
          </div>
          <Toggle checked={settings[k]} onChange={(v) => change({ [k]: v })} />
        </div>
      ))}
      <MicTest />
      <InputMode />
      <h3>{t('Video')}</h3>
      <StreamQuality />
      <h3>{t('Keyboard Shortcuts')}</h3>
      <div className="keys">
        <span>{t('Toggle Mute')}</span>
        <kbd>Ctrl + Shift + M</kbd>
        <span>{t('Toggle Deafen')}</span>
        <kbd>Ctrl + Shift + D</kbd>
        {settings.voiceMode === 'ptt' && (
          <>
            <span>{t('Push to Talk')}</span>
            <kbd>{keyName(settings.pttKey)}</kbd>
          </>
        )}
      </div>
      {(window as any).chrome?.webview && <p className="muted small-note">{t('In the desktop app these shortcuts also work while the window is in the background.')}</p>}
    </>
  );
}

const keyName = (code: string) => code.replace(/^Key|^Digit/, '').replace('Backquote', '`').replace('Arrow', '↕ ');

/** Live microphone level with the voice-activity threshold, plus the push-to-talk key. */
function InputMode() {
  const settings = useStore((s: any) => s.settings);
  const [level, setLevel] = useState(-100);
  const [binding, setBinding] = useState(false);
  useEffect(() => {
    if (settings.voiceMode !== 'vad') return;
    let stop = () => {};
    let raf = 0;
    let alive = true;
    // In a call the engine already measures the mic; otherwise open a short test capture.
    if (voice.channelId) {
      const tick = () => {
        setLevel(voice.level);
        raf = requestAnimationFrame(tick);
      };
      tick();
      return () => cancelAnimationFrame(raf);
    }
    navigator.mediaDevices
      ?.getUserMedia({ audio: { deviceId: settings.inputDevice ? { exact: settings.inputDevice } : undefined, noiseSuppression: settings.noiseSuppression, echoCancellation: settings.echoCancellation, autoGainControl: settings.autoGain } })
      .then((stream) => {
        if (!alive) return stream.getTracks().forEach((x) => x.stop());
        const ac = new AudioContext();
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const b of buf) sum += ((b - 128) / 128) ** 2;
          const rms = Math.sqrt(sum / buf.length);
          setLevel(rms > 0 ? 20 * Math.log10(rms) : -100);
          raf = requestAnimationFrame(tick);
        };
        tick();
        stop = () => {
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((x) => x.stop());
          ac.close();
        };
      })
      .catch(() => {});
    return () => {
      alive = false;
      stop();
    };
  }, [settings.voiceMode, settings.inputDevice]);
  useEffect(() => {
    if (!binding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') updateSettings({ pttKey: e.code });
      setBinding(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [binding]);
  const pct = (db: number) => Math.max(0, Math.min(100, db + 100));
  return (
    <>
      <h3>{t('Input Mode')}</h3>
      <div className="seg">
        {[
          ['vad', 'Voice Activity'],
          ['ptt', 'Push to Talk'],
        ].map(([k, label]) => (
          <button key={k} className={settings.voiceMode === k ? 'active' : ''} onClick={() => updateSettings({ voiceMode: k })}>
            {t(label)}
          </button>
        ))}
      </div>
      {settings.voiceMode === 'vad' ? (
        <div className="field" style={{ marginTop: 16 }}>
          <span className="field-label">{t('Input Sensitivity')}</span>
          <div className="meter">
            <div className="meter-fill" style={{ width: pct(level) + '%' }} />
            <div className="meter-mark" style={{ insetInlineStart: pct(settings.vadThreshold) + '%' }} />
          </div>
          <input type="range" min={-100} max={0} value={settings.vadThreshold} className="wide-range" onChange={(e) => updateSettings({ vadThreshold: Number(e.target.value) })} />
          <small>{t('Your microphone is only sent when the bar passes the marker. Drag it right if friends hear background noise.')}</small>
        </div>
      ) : (
        <div className="field" style={{ marginTop: 16 }}>
          <span className="field-label">{t('Shortcut')}</span>
          <button className={'btn' + (binding ? ' primary' : '')} onClick={() => setBinding(true)}>
            {binding ? t('Press a key…') : keyName(settings.pttKey)}
          </button>
        </div>
      )}
    </>
  );
}

function UserSettings({ tab: initialTab }: { tab?: string }) {
  const me = useStore((s: any) => s.me);
  const settings = useStore((s: any) => s.settings);
  const [tab, setTab] = useState(initialTab || 'account');
  const [p, setP] = useState({ displayName: me.displayName, bio: me.bio || '', avatar: me.avatar, bannerColor: me.bannerColor || '', pronouns: me.pronouns || '' });
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);
  const dirty = p.displayName !== me.displayName || p.bio !== (me.bio || '') || p.avatar !== me.avatar || p.bannerColor !== (me.bannerColor || '') || p.pronouns !== (me.pronouns || '');
  const save = async () => {
    setSaving(true);
    if (await act(api('PATCH', '/api/users/me', p))) toast('Saved', 'ok');
    setSaving(false);
  };
  const tabs = [
    ['account', 'My Account'],
    ['profile', 'Profile'],
    ['voice', 'Voice & Video'],
    ['notifications', 'Notifications'],
    ['keybinds', 'Keybinds'],
    ['activity', 'Activity Privacy'],
    ['appearance', 'Appearance'],
    ...(isDesktop ? [['windows', 'Windows Settings']] : []),
    ['updates', isDesktop ? 'Updates' : 'Get the App'],
  ];
  return (
    <Modal className="settings" width={900}>
      <nav className="settings-nav">
        <div className="list-title">{t('User Settings')}</div>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {t(label)}
          </button>
        ))}
        <div className="menu-sep" />
        <button className="danger" onClick={() => openModal('confirm', { title: t('Log Out'), text: t('Are you sure you want to log out?'), danger: true, action: t('Log Out'), onConfirm: async () => logout() })}>
          {t('Log Out')}
        </button>
      </nav>
      <div className="settings-body">
        <button className="icon-btn settings-close" onClick={closeModal} aria-label={t('Close')}>
          <X size={22} />
        </button>
        {tab === 'account' && (
          <>
            <h2>{t('My Account')}</h2>
            <div className="account-card">
              <Avatar userId={me.id} size={64} />
              <div>
                <b>{me.displayName}</b>
                <div className="muted" dir="ltr">
                  {me.username}
                </div>
              </div>
              <button className="btn primary" onClick={() => setTab('profile')}>
                {t('Edit Profile')}
              </button>
            </div>
            <h3>{t('Change Password')}</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (await act(api('POST', '/api/users/me/password', pw))) {
                  toast('Password changed', 'ok');
                  setPw({ oldPassword: '', newPassword: '' });
                }
              }}
            >
              <div className="two-col">
                <Field label={t('Current Password')}>
                  <input dir="ltr" type="password" value={pw.oldPassword} onChange={(e) => setPw({ ...pw, oldPassword: e.target.value })} required autoComplete="current-password" />
                </Field>
                <Field label={t('New Password')}>
                  <input dir="ltr" type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={6} autoComplete="new-password" />
                </Field>
              </div>
              <button className="btn primary">{t('Change Password')}</button>
            </form>
            <AccountExtras />
          </>
        )}
        {tab === 'profile' && (
          <>
            <h2>{t('Profile')}</h2>
            <Field label={t('Avatar')}>
              <ImagePick value={p.avatar} onChange={(avatar) => setP({ ...p, avatar })} round fallback={<span style={{ fontSize: 32 }}>{[...me.displayName][0]}</span>} />
            </Field>
            <Field label={t('Display Name')}>
              <input dir="auto" value={p.displayName} onChange={(e) => setP({ ...p, displayName: e.target.value })} maxLength={32} />
            </Field>
            <Field label={t('Pronouns')}>
              <input dir="auto" value={p.pronouns} onChange={(e) => setP({ ...p, pronouns: e.target.value })} maxLength={40} placeholder={t('Add your pronouns')} />
            </Field>
            <Field label={t('About Me')}>
              <textarea dir="auto" value={p.bio} onChange={(e) => setP({ ...p, bio: e.target.value })} maxLength={300} rows={4} />
            </Field>
            <Field label={t('Banner Color')}>
              <div className="color-row">
                <input type="color" value={p.bannerColor || colorFor(me.id)} onChange={(e) => setP({ ...p, bannerColor: e.target.value })} />
                {p.bannerColor && (
                  <button type="button" className="btn link small" onClick={() => setP({ ...p, bannerColor: '' })}>
                    {t('Reset')}
                  </button>
                )}
              </div>
            </Field>
            <button className="btn primary" disabled={!dirty || saving} onClick={save}>
              {t('Save Changes')}
            </button>
          </>
        )}
        {tab === 'voice' && <Devices />}
        {tab === 'keybinds' && <KeybindsTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'notifications' && (
          <>
            <h2>{t('Notifications')}</h2>
            <div className="setting-row">
              <div>
                <b>{t('Sounds')}</b>
                <small>{t('Play a sound for messages, calls and people joining voice.')}</small>
              </div>
              <Toggle checked={settings.sounds} onChange={(v) => updateSettings({ sounds: v })} />
            </div>
            {settings.sounds && (
              <div className="field" style={{ marginTop: 12 }}>
                <span className="field-label">
                  {t('Sound Volume')} — {num(settings.soundVolume)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  className="wide-range"
                  value={settings.soundVolume}
                  onChange={(e) => updateSettings({ soundVolume: Number(e.target.value) })}
                  onMouseUp={() => playSound('message')}
                  onKeyUp={() => playSound('message')}
                />
                <div className="sound-tests">
                  {[
                    ['join', 'Join'],
                    ['userJoin', 'Someone joins'],
                    ['mute', 'Mute'],
                    ['deafen', 'Deafen'],
                    ['mention', 'Mention'],
                    ['ring', 'Call'],
                    ['streamStart', 'Go Live'],
                    ['leave', 'Disconnect'],
                  ].map(([k, label]) => (
                    <button key={k} className="btn small" onClick={() => playSound(k)}>
                      ▶ {t(label)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="setting-row">
              <div>
                <b>{t('Desktop Notifications')}</b>
                <small>{t('Show a notification when you are mentioned or get a direct message.')}</small>
              </div>
              <Toggle
                checked={settings.desktopNotif && 'Notification' in window && Notification.permission === 'granted'}
                onChange={async (v) => {
                  if (v) {
                    if (!('Notification' in window)) return toast('Notifications are not supported in this browser');
                    if ((await Notification.requestPermission()) !== 'granted') return toast('Notification permission was denied');
                  }
                  updateSettings({ desktopNotif: v });
                }}
              />
            </div>
          </>
        )}
        {tab === 'windows' && <WindowsSettings />}
        {tab === 'updates' && <UpdatesPanel />}
        {tab === 'appearance' && <AppearanceSettings />}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ server settings
function RolesTab({ server }: { server: any }) {
  const meId = useStore((s: any) => s.me.id);
  const [sel, setSel] = useState<string>(server.roles[0]?.id);
  const role = server.roles.find((r: any) => r.id === sel) || server.roles[server.roles.length - 1];
  const [draft, setDraft] = useState<any>(role);
  useEffect(() => setDraft(role), [role?.id, role?.name, role?.color, role?.permissions, role?.hoist]);
  const myTop = topPos(server, meId);
  const myPerms = permsIn(server, meId);
  const everyone = role.id === server.id;
  const editable = role.position < myTop;
  const dirty = draft && (draft.name !== role.name || (draft.color || '') !== (role.color || '') || draft.permissions !== role.permissions || draft.hoist !== role.hoist);
  const custom = server.roles.filter((r: any) => r.id !== server.id);
  const move = (id: string, d: number) => {
    const ids = custom.map((r: any) => r.id);
    const i = ids.indexOf(id);
    if (i + d < 0 || i + d >= ids.length) return;
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(api('PUT', `/api/servers/${server.id}/roles/order`, { ids }));
  };
  return (
    <>
      <h2>{t('Roles')}</h2>
      <p className="muted">{t('Use roles to group your server members and assign permissions. Higher roles outrank lower ones.')}</p>
      <div className="roles-layout">
        <div className="roles-list">
          <button className="btn primary small wide" onClick={async () => (await act(api('POST', `/api/servers/${server.id}/roles`, { name: t('new role') })).then((r) => r && setSel(r.id)))}>
            {t('Create Role')}
          </button>
          {server.roles.map((r: any) => (
            <div key={r.id} className={'role-row' + (r.id === role.id ? ' active' : '')} onClick={() => setSel(r.id)}>
              <i className="role-dot" style={{ background: r.color || '#99aab5' }} />
              <span>{r.name}</span>
              {r.id !== server.id && r.position < myTop && (
                <>
                  <button className="icon-btn" title={t('Move Up')} onClick={(e) => (e.stopPropagation(), move(r.id, -1))}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-btn" title={t('Move Down')} onClick={(e) => (e.stopPropagation(), move(r.id, 1))}>
                    <ArrowDown size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        {draft && (
          <div className="role-edit">
            {!editable && <div className="notice">{t('You cannot edit this role because it is equal to or higher than your highest role.')}</div>}
            <fieldset disabled={!editable}>
              {!everyone && (
                <>
                  <Field label={t('Role Name')}>
                    <input dir="auto" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={50} />
                  </Field>
                  <Field label={t('Role Color')}>
                    <div className="color-row">
                      <input type="color" value={draft.color || '#99aab5'} onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
                      {['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'].map((c) => (
                        <button type="button" key={c} className="swatch" style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} aria-label={c} />
                      ))}
                      {draft.color && (
                        <button type="button" className="btn link small" onClick={() => setDraft({ ...draft, color: null })}>
                          {t('Reset')}
                        </button>
                      )}
                    </div>
                  </Field>
                  <div className="setting-row">
                    <div>
                      <b>{t('Display role members separately from online members')}</b>
                    </div>
                    <Toggle checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} />
                  </div>
                </>
              )}
              <h3>{t('Permissions')}</h3>
              {PERM_LABELS.map(([bit, title, desc]) => (
                <div className="setting-row" key={bit}>
                  <div>
                    <b>{t(title)}</b>
                    <small>{t(desc)}</small>
                  </div>
                  <Toggle checked={!!(draft.permissions & bit)} disabled={!editable || !(myPerms & bit)} onChange={(v) => setDraft({ ...draft, permissions: v ? draft.permissions | bit : draft.permissions & ~bit })} />
                </div>
              ))}
            </fieldset>
            <div className="role-actions">
              {!everyone && editable && (
                <button
                  className="btn danger"
                  onClick={() =>
                    openModal('confirm', {
                      title: t('Delete Role'),
                      text: t('Are you sure you want to delete {name}? This cannot be undone.', { name: role.name }),
                      danger: true,
                      action: t('Delete'),
                      onConfirm: async () => {
                        await api('DELETE', '/api/roles/' + role.id);
                        openModal('serverSettings', { serverId: server.id, tab: 'roles' });
                      },
                    })
                  }
                >
                  <Trash2 size={16} /> {t('Delete Role')}
                </button>
              )}
              <button className="btn primary" disabled={!dirty || !editable} onClick={() => act(api('PATCH', '/api/roles/' + role.id, { name: draft.name, color: draft.color, permissions: draft.permissions, hoist: draft.hoist })).then((r) => r && toast('Saved', 'ok'))}>
                {t('Save Changes')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function AsyncList({ load, render, empty, title, deps = [] }: any) {
  const [data, setData] = useState<any[] | null>(null);
  const reload = () =>
    load()
      .then(setData)
      .catch((e: any) => (toast(e.message), setData([])));
  useEffect(() => {
    reload();
  }, deps);
  return (
    <>
      <h2>{title}</h2>
      {!data ? <p className="muted">{t('Loading…')}</p> : !data.length ? <p className="muted">{empty}</p> : data.map((x, i) => render(x, reload, i))}
    </>
  );
}

function ServerSettings({ serverId, tab: initialTab }: { serverId: string; tab?: string }) {
  const server = useStore((s: any) => s.servers[serverId]);
  const meId = useStore((s: any) => s.me.id);
  useStore((s: any) => s.users);
  const perms = server ? permsIn(server, meId) : 0;
  const tabs = [
    ['overview', 'Overview', P.MANAGE_SERVER],
    ['roles', 'Roles', P.MANAGE_ROLES],
    ['emojis', 'Emoji', P.MANAGE_EXPRESSIONS],
    ['stickers', 'Stickers', P.MANAGE_EXPRESSIONS],
    ['sounds', 'Soundboard', P.MANAGE_EXPRESSIONS],
    ['members', 'Members', 0],
    ['invites', 'Invites', P.MANAGE_SERVER],
    ['integrations', 'Integrations', P.MANAGE_WEBHOOKS],
    ['automod', 'AutoMod', P.MANAGE_SERVER],
    ['audit', 'Audit Log', P.VIEW_AUDIT_LOG],
    ['bans', 'Bans', P.BAN_MEMBERS],
  ].filter(([, , need]: any) => !need || perms & need) as [string, string, number][];
  const [tab, setTab] = useState(initialTab && tabs.some((x) => x[0] === initialTab) ? initialTab : tabs[0][0]);
  const [name, setName] = useState(server?.name || '');
  const [icon, setIcon] = useState<string | null>(server?.icon || null);
  const [banner, setBanner] = useState<string | null>(server?.banner || null);
  const [description, setDescription] = useState<string>(server?.description || '');
  const [q, setQ] = useState('');
  if (!server) return null;
  const members = Object.keys(server.members)
    .filter((i) => !q || displayName(i, serverId).toLowerCase().includes(q.toLowerCase()) || get().users[i]?.username.includes(q.toLowerCase()))
    .sort((a, b) => displayName(a, serverId).localeCompare(displayName(b, serverId)));
  return (
    <Modal className="settings" width={960}>
      <nav className="settings-nav">
        <div className="list-title">{server.name}</div>
        {tabs.map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {t(label)}
          </button>
        ))}
        {server.ownerId === meId && (
          <>
            <div className="menu-sep" />
            <button
              className="danger"
              onClick={() =>
                openModal('confirm', {
                  title: t("Delete '{name}'", { name: server.name }),
                  text: t('Are you sure you want to delete {name}? This cannot be undone.', { name: server.name }),
                  danger: true,
                  action: t('Delete Server'),
                  onConfirm: () => api('DELETE', '/api/servers/' + serverId),
                })
              }
            >
              {t('Delete Server')}
            </button>
          </>
        )}
      </nav>
      <div className="settings-body">
        <button className="icon-btn settings-close" onClick={closeModal} aria-label={t('Close')}>
          <X size={22} />
        </button>
        {tab === 'overview' && (
          <>
            <h2>{t('Server Overview')}</h2>
            <Field label={t('Server Icon')}>
              <ImagePick value={icon} onChange={setIcon} round fallback={<ServerIcon server={{ ...server, icon: null }} size={80} />} />
            </Field>
            <Field label={t('Server Name')}>
              <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <Field label={t('Server Banner')}>
              <BannerPick value={banner} onChange={setBanner} />
            </Field>
            <Field label={t('Description')}>
              <textarea dir="auto" rows={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('How did your server get started? Why should people join?')} />
            </Field>
            <button
              className="btn primary"
              disabled={!name.trim() || (name === server.name && icon === (server.icon || null) && banner === (server.banner || null) && description === (server.description || ''))}
              onClick={() => act(api('PATCH', '/api/servers/' + serverId, { name, icon, banner, description })).then((r) => r && toast('Saved', 'ok'))}
            >
              {t('Save Changes')}
            </button>
          </>
        )}
        {tab === 'roles' && <RolesTab server={server} />}
        {(tab === 'emojis' || tab === 'stickers' || tab === 'sounds') && <ExpressionsTab key={tab} server={server} kind={tab as any} />}
        {tab === 'integrations' && <WebhooksTab serverId={serverId} />}
        {tab === 'automod' && <AutoModTab server={server} />}
        {tab === 'audit' && <AuditLogTab server={server} />}
        {tab === 'members' && (
          <>
            <h2>
              {t('Members')} — {num(Object.keys(server.members).length)}
            </h2>
            <input className="plain-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} />
            {members.map((id) => (
              <div className="list-row" key={id}>
                <Avatar userId={id} size={36} />
                <div className="grow">
                  <b style={{ color: roleColor(id, serverId) }}>
                    {displayName(id, serverId)} {server.ownerId === id && <Crown size={14} className="crown" />}
                    {server.members[id].timeoutUntil > Date.now() && <Clock size={14} className="red" />}
                  </b>
                  <small dir="ltr">{get().users[id]?.username}</small>
                </div>
                <div className="role-chips">
                  {server.roles
                    .filter((r: any) => server.members[id].roles.includes(r.id))
                    .map((r: any) => (
                      <span key={r.id} className="role-chip">
                        <i style={{ background: r.color || '#99aab5' }} />
                        {r.name}
                      </span>
                    ))}
                </div>
                <button className="icon-btn" title={t('More')} onClick={(e) => memberMenu(e, id, serverId)}>
                  <MoreVertical size={18} />
                </button>
              </div>
            ))}
          </>
        )}
        {tab === 'invites' && (
          <AsyncList
            title={t('Invites')}
            empty={t('There are no active invites.')}
            load={() => api('GET', `/api/servers/${serverId}/invites`)}
            render={(inv: any, reload: () => void) => (
              <div className="list-row" key={inv.code}>
                {inv.creator && <Avatar userId={inv.creator.id} size={32} />}
                <div className="grow">
                  <b dir="ltr">{inv.code}</b>
                  <small>
                    {inv.creator?.displayName} • {t('{n} uses', { n: num(inv.uses) })}
                    {inv.maxUses ? ' / ' + num(inv.maxUses) : ''} • {inv.expiresAt ? (inv.expiresAt < Date.now() ? t('Expired') : t('Expires {date}', { date: fmtStamp(inv.expiresAt) })) : t('Never expires')}
                  </small>
                </div>
                <button className="icon-btn" title={t('Copy')} onClick={() => (navigator.clipboard?.writeText(`${location.origin}/invite/${inv.code}`), toast('Copied', 'ok'))}>
                  <Copy size={18} />
                </button>
                <button className="icon-btn danger" title={t('Revoke')} onClick={() => act(api('DELETE', '/api/invites/' + inv.code)).then(reload)}>
                  <Trash2 size={18} />
                </button>
              </div>
            )}
          />
        )}
        {tab === 'bans' && (
          <AsyncList
            title={t('Bans')}
            empty={t('No one is banned. Nice!')}
            load={() => api('GET', `/api/servers/${serverId}/bans`)}
            render={(b: any, reload: () => void) => (
              <div className="list-row" key={b.user.id}>
                <div className="grow">
                  <b>{b.user.displayName}</b>
                  <small dir="ltr">{b.user.username}</small>
                </div>
                <button className="btn small" onClick={() => act(api('DELETE', `/api/servers/${serverId}/bans/${b.user.id}`)).then(reload)}>
                  {t('Revoke Ban')}
                </button>
              </div>
            )}
          />
        )}
      </div>
    </Modal>
  );
}

export function ModalHost() {
  const m = useStore((s: any) => s.modal);
  const me = useStore((s: any) => s.me);
  if (!m) return null;
  switch (m.type) {
    case 'confirm':
      return <Confirm {...m} />;
    case 'createServer':
      return <CreateServer />;
    case 'join':
      return <JoinInvite key={m.code} code={m.code} />;
    case 'invite':
      return <Invite serverId={m.serverId} />;
    case 'createChannel':
      return m.serverId ? <CreateChannelModal {...m} /> : <CreateChannel {...m} />;
    case 'editChannel':
      return findChannel(m.channelId)?.serverId ? <ChannelSettings key={m.channelId} channelId={m.channelId} tab={m.tab} /> : <EditChannel channelId={m.channelId} />;
    case 'poll':
      return <PollModal channelId={m.channelId} />;
    case 'forward':
      return <ForwardModal messageId={m.messageId} />;
    case 'createThread':
      return <CreateThreadModal channelId={m.channelId} messageId={m.messageId} initialName={m.initialName} />;
    case 'threads':
      return <ThreadsModal channelId={m.channelId} />;
    case 'renameThread':
      return <RenameThread channelId={m.channelId} />;
    case 'events':
      return <EventsModal serverId={m.serverId} />;
    case 'createEvent':
      return <CreateEventModal serverId={m.serverId} event={m.event} />;
    case 'notifications':
      return <NotificationSettingsModal serverId={m.serverId} />;
    case 'timeout':
      return <TimeoutModal serverId={m.serverId} userId={m.userId} />;
    case 'move':
      return <MoveModal serverId={m.serverId} userId={m.userId} />;
    case 'discordImport':
      return <DiscordImportModal />;
    case 'inbox':
      return <InboxModal />;
    case 'switcher':
      return <QuickSwitcher />;
    case 'nickname':
      return (
        <Prompt
          title={t('Change Nickname')}
          label={t('Nickname')}
          max={32}
          initial={get().servers[m.serverId]?.members[m.userId]?.nickname}
          placeholder={get().users[m.userId]?.displayName}
          onSave={(v: string) => api('PATCH', `/api/servers/${m.serverId}/members/${m.userId}`, { nickname: v })}
        />
      );
    case 'customStatus':
      return <Prompt title={t('Set Custom Status')} label={t("What's on your mind?")} max={100} initial={me.customStatus} onSave={(v: string) => api('PATCH', '/api/users/me', { customStatus: v })} />;
    case 'newDm':
      return <NewDm groupId={m.groupId} />;
    case 'profile':
      return <Profile key={m.userId} userId={m.userId} serverId={m.serverId} />;
    case 'pins':
      return (
        <MessageListModal
          key={m.channelId}
          title={t('Pinned Messages')}
          pins
          channelId={m.channelId}
          serverId={findChannel(m.channelId)?.serverId}
          emptyText={t("This channel doesn't have any pinned messages… yet.")}
          load={() => api('GET', `/api/channels/${m.channelId}/pins`)}
        />
      );
    case 'search':
      return (
        <MessageListModal
          key={m.q}
          title={t('Search results for "{q}"', { q: m.q })}
          channelId={m.channelId}
          serverId={m.serverId}
          emptyText={t('No results found.')}
          load={() => api('GET', '/api/search?' + new URLSearchParams({ q: m.q, ...(m.serverId ? { serverId: m.serverId } : { channelId: m.channelId }) }))}
        />
      );
    case 'image':
      return (
        <Modal className="lightbox" width="auto">
          <img src={m.url} alt={m.name} onClick={closeModal} />
          <a href={m.url} target="_blank" rel="noopener noreferrer">
            {t('Open in Browser')}
          </a>
        </Modal>
      );
    case 'userSettings':
      return <UserSettings tab={m.tab} />;
    case 'serverSettings':
      return <ServerSettings key={m.serverId} serverId={m.serverId} tab={m.tab} />;
  }
  return null;
}
