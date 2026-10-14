// Account & navigation extras: username, two-factor auth, deleting the account, mic test, keybinds, activity,
// the mentions inbox, the quick switcher (Ctrl+K), user notes and auto-idle.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Gamepad2, Hash, Inbox, KeyRound, Search, ShieldCheck, Trash2, Volume2, Users, Music, Monitor } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useStore, get, act, toast, openModal, closeModal, navigate, displayName, dmName, findChannel, sortedDms, orderedChannels, jumpTo, logout, updateSettings, wsSend, P, CH } from '../store';
import { api } from '../api';
import { t } from '../i18n';
import { Modal, Field, Toggle, Avatar, ServerIcon, fmtStamp, num } from '../ui';
import { voice } from '../voice';
import { MessageCard } from '../Chat';
import { ChannelIcon } from './Channels';

// ---------------------------------------------------------------- my account extras
export function AccountExtras() {
  const me = useStore((s: any) => s.me);
  const [user, setUser] = useState({ username: me.username, password: '' });
  const [mfa, setMfa] = useState<null | { secret: string; uri: string }>(null);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [delPw, setDelPw] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const qr = useMemo(() => {
    if (!mfa) return '';
    const q = qrcode(0, 'M');
    q.addData(mfa.uri);
    q.make();
    return q.createDataURL(5, 8);
  }, [mfa]);
  return (
    <>
      <h3>{t('Username')}</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act(api('PATCH', '/api/users/me', user))) {
            toast('Saved', 'ok');
            setUser({ ...user, password: '' });
          }
        }}
      >
        <div className="two-col">
          <Field label={t('Username')}>
            <input dir="ltr" value={user.username} onChange={(e) => setUser({ ...user, username: e.target.value })} maxLength={32} />
          </Field>
          <Field label={t('Current Password')}>
            <input dir="ltr" type="password" value={user.password} onChange={(e) => setUser({ ...user, password: e.target.value })} autoComplete="current-password" />
          </Field>
        </div>
        <button className="btn primary" disabled={user.username === me.username || !user.password}>
          {t('Change Username')}
        </button>
      </form>

      <h3>
        <ShieldCheck size={18} /> {t('Two-Factor Authentication')}
      </h3>
      {me.mfa ? (
        <>
          <p className="green">{t('Two-factor authentication is on. You need a code from your authenticator app to log in.')}</p>
          <div className="copy-row">
            <input dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={6} />
            <button className="btn danger" disabled={code.length < 6} onClick={() => act(api('POST', '/api/users/me/2fa/disable', { code })).then((r) => r !== undefined && (setCode(''), toast('Two-factor authentication removed', 'ok')))}>
              {t('Remove 2FA')}
            </button>
          </div>
        </>
      ) : mfa ? (
        <div className="mfa-setup">
          <img src={qr} alt="QR" width={180} height={180} />
          <div className="grow">
            <p>{t('Scan this QR code with an authenticator app (Google Authenticator, Authy, Microsoft Authenticator…), then type the 6-digit code it shows.')}</p>
            <small className="muted">
              {t('Or enter this key:')} <code dir="ltr">{mfa.secret}</code>
            </small>
            <div className="copy-row" style={{ marginTop: 12 }}>
              <input dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={6} autoFocus />
              <button
                className="btn primary"
                disabled={code.length < 6}
                onClick={() =>
                  act(api('POST', '/api/users/me/2fa/enable', { code })).then((r) => {
                    if (r === undefined) return;
                    setMfa(null);
                    setCode('');
                    toast('Two-factor authentication is on', 'ok');
                  })
                }
              >
                {t('Activate')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="muted">{t('Protect your account with an extra code from your phone when you log in.')}</p>
          <div className="copy-row">
            <input dir="ltr" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('Current Password')} autoComplete="current-password" />
            <button className="btn primary" disabled={!pw} onClick={() => act(api('POST', '/api/users/me/2fa/setup', { password: pw })).then((r) => r && (setMfa(r), setPw('')))}>
              {t('Enable Authenticator App')}
            </button>
          </div>
        </>
      )}

      <h3 className="danger-title">{t('Account Removal')}</h3>
      {!showDelete ? (
        <button className="btn danger" onClick={() => setShowDelete(true)}>
          <Trash2 size={16} /> {t('Delete Account')}
        </button>
      ) : (
        <div className="notice danger">
          <p>{t('Your messages stay, but your name, avatar, friends and servers are removed for good. You must transfer or delete the servers you own first.')}</p>
          <div className="copy-row">
            <input dir="ltr" type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder={t('Current Password')} />
            <button className="btn danger" disabled={!delPw} onClick={() => act(api('POST', '/api/users/me/delete', { password: delPw })).then((r) => r !== undefined && logout(true))}>
              {t('Delete Account')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- mic test & stream quality
export function MicTest() {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(-100);
  useEffect(() => () => voice.stopMicTest(), []);
  const pct = Math.max(0, Math.min(100, level + 100));
  return (
    <div className="field">
      <span className="field-label">{t('Mic Test')}</span>
      <small className="muted">{t("Having mic issues? Start a test and say something fun — we'll play your voice back to you.")}</small>
      <div className="mic-test">
        <button
          className={'btn ' + (on ? 'danger' : 'primary')}
          onClick={async () => {
            if (on) {
              voice.stopMicTest();
              setOn(false);
              setLevel(-100);
            } else if (await voice.startMicTest(setLevel)) setOn(true);
          }}
        >
          {on ? t('Stop Testing') : t("Let's Check")}
        </button>
        <div className="meter grow">
          <div className="meter-fill" style={{ width: pct + '%' }} />
        </div>
      </div>
    </div>
  );
}
export function StreamQuality() {
  const q = useStore((s: any) => s.settings.streamQuality || '720p30');
  return (
    <Field label={t('Screen Share Quality')}>
      <select value={q} onChange={(e) => updateSettings({ streamQuality: e.target.value })}>
        {[
          ['480p15', '480p • 15 FPS'],
          ['720p30', '720p • 30 FPS'],
          ['720p60', '720p • 60 FPS'],
          ['1080p30', '1080p • 30 FPS'],
          ['1080p60', '1080p • 60 FPS'],
          ['1440p30', '1440p • 30 FPS'],
        ].map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------- keybinds & activity
export function KeybindsTab() {
  const ptt = useStore((s: any) => s.settings.pttKey);
  const rows: [string, string][] = [
    ['Quick Switcher', 'Ctrl + K'],
    ['Toggle Mute', 'Ctrl + Shift + M'],
    ['Toggle Deafen', 'Ctrl + Shift + D'],
    ['Push to Talk', ptt.replace(/^Key|^Digit/, '').replace('Backquote', '`')],
    ['Mark Channel Read', 'Esc'],
    ['Edit Last Message', '↑'],
    ['Reply to Message', 'Right-click → Reply'],
    ['Navigate Channels', 'Alt + ↑ / ↓'],
    ['Navigate Servers', 'Ctrl + Alt + ↑ / ↓'],
    ['Previous Channel', 'Alt + ←'],
    ['Mentions Inbox', 'Ctrl + I'],
    ['Upload a File', 'Ctrl + Shift + U'],
    ['Search', 'Ctrl + F'],
  ];
  return (
    <>
      <h2>{t('Keybinds')}</h2>
      <p className="muted">{t('Handy shortcuts. In the desktop app, mute, deafen and push-to-talk also work while it is in the background.')}</p>
      <div className="keys">
        {rows.map(([a, k]) => (
          <React.Fragment key={a}>
            <span>{t(a)}</span>
            <kbd>{k}</kbd>
          </React.Fragment>
        ))}
      </div>
    </>
  );
}
export function ActivityTab() {
  const share = useStore((s: any) => s.settings.shareActivity !== false);
  const idle = useStore((s: any) => s.settings.autoIdle ?? 10);
  const desktop = useStore((s: any) => s.desktop);
  const mine = useStore((s: any) => s.activities[s.me.id]);
  return (
    <>
      <h2>{t('Activity Privacy')}</h2>
      <div className="setting-row">
        <div>
          <b>{t('Share your detected activities with others')}</b>
          <small>{desktop ? t('The Windows app shows the game you are playing next to your name, like Discord.') : t('Install the Windows app to show the game you are playing.')}</small>
        </div>
        <Toggle
          checked={share}
          onChange={(v) => {
            updateSettings({ shareActivity: v });
            if (!v) wsSend({ op: 'activity', activity: null });
            else reportActivity(lastGame);
          }}
        />
      </div>
      {mine && (
        <div className="notice">
          <Gamepad2 size={16} /> {t('Playing {name}', { name: mine.name })}
        </div>
      )}
      {desktop && <CustomGames />}
      <Field label={t('Go idle after') + ' — ' + (idle ? t('{n} minutes', { n: num(idle) }) : t('Never'))}>
        <input type="range" className="wide-range" min={0} max={60} step={5} value={idle} onChange={(e) => updateSettings({ autoIdle: Number(e.target.value) })} />
        <small className="muted">{t('Your status shows Idle when you are away from the computer.')}</small>
      </Field>
    </>
  );
}

/** Games the Windows app should recognise besides the built-in list (Discord's "Add it!"). */
function CustomGames() {
  const games = useStore((s: any) => s.settings.customGames || []);
  const [exe, setExe] = useState('');
  const [name, setName] = useState('');
  const add = () => {
    const e = exe.trim().replace(/^.*[\\/]/, '');
    if (!e || !name.trim()) return;
    updateSettings({ customGames: [...games.filter((g: any) => g.exe.toLowerCase() !== e.toLowerCase()), { exe: /\.exe$/i.test(e) ? e : e + '.exe', name: name.trim().slice(0, 80) }] });
    setExe('');
    setName('');
  };
  return (
    <>
      <h3>{t('Registered Games')}</h3>
      <p className="muted">{t("Popular games are detected automatically. Add others by their program file name (for example game.exe).")}</p>
      {games.map((g: any) => (
        <div className="list-row" key={g.exe}>
          <Gamepad2 size={18} />
          <div className="grow">
            <b>{g.name}</b>
            <small dir="ltr">{g.exe}</small>
          </div>
          <button className="icon-btn danger" title={t('Remove')} onClick={() => updateSettings({ customGames: games.filter((x: any) => x !== g) })}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <div className="copy-row" style={{ marginTop: 8 }}>
        <input dir="ltr" value={exe} onChange={(e) => setExe(e.target.value)} placeholder="game.exe" />
        <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Game name')} />
        <button className="btn primary" disabled={!exe.trim() || !name.trim()} onClick={add}>
          {t('Add')}
        </button>
      </div>
    </>
  );
}

// Activity coming from the Windows app (it watches running games) and auto-idle.
let lastGame: any = null;
export function reportActivity(game: any) {
  lastGame = game;
  if (get().status !== 'ready') return;
  wsSend({ op: 'activity', activity: get().settings.shareActivity !== false && game ? { name: game.name, type: 0 } : null });
}
(window as any).__game = reportActivity;
let idleSent = false;
let lastInput = Date.now();
let systemIdleSecs = -1; // reported by the desktop app (covers input in other windows)
const markInput = () => {
  lastInput = Date.now();
  if (idleSent) setIdle(false);
};
function setIdle(v: boolean) {
  idleSent = v;
  wsSend({ op: 'idle', idle: v });
}
for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart']) window.addEventListener(ev, markInput, { passive: true });
(window as any).__sysIdle = (secs: number) => {
  systemIdleSecs = secs;
  if (secs < 5) markInput();
};
setInterval(() => {
  const s = get();
  if (s.status !== 'ready') return;
  const mins = s.settings.autoIdle ?? 10;
  if (!mins) return idleSent && setIdle(false);
  const away = systemIdleSecs >= 0 ? systemIdleSecs * 1000 : Date.now() - lastInput;
  const idle = away > mins * 60000;
  if (idle !== idleSent) setIdle(idle);
}, 15000);
export function resendPresenceExtras() {
  if (idleSent) wsSend({ op: 'idle', idle: true });
  if (lastGame) reportActivity(lastGame);
}

export function ActivityLine({ userId }: { userId: string }) {
  const a = useStore((s: any) => s.activities[userId]);
  if (!a) return null;
  const Icon = a.type === 2 ? Music : a.type === 3 ? Monitor : Gamepad2;
  return (
    <small className="activity-line">
      <Icon size={12} /> {a.type === 2 ? t('Listening to {name}', { name: a.name }) : a.type === 3 ? t('Watching {name}', { name: a.name }) : t('Playing {name}', { name: a.name })}
    </small>
  );
}

// ---------------------------------------------------------------- notes
export function NoteField({ userId }: { userId: string }) {
  const note = useStore((s: any) => s.notes[userId] || '');
  const [v, setV] = useState(note);
  useEffect(() => setV(note), [note]);
  return (
    <textarea
      className="note-field"
      dir="auto"
      rows={2}
      maxLength={256}
      value={v}
      placeholder={t('Click to add a note')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== note && act(api('PUT', `/api/users/${userId}/note`, { note: v }))}
    />
  );
}

// ---------------------------------------------------------------- inbox
export function InboxModal() {
  const [data, setData] = useState<any[] | null>(null);
  const [tab, setTab] = useState<'mentions' | 'unreads'>('mentions');
  useStore((s: any) => s.readStates);
  useEffect(() => {
    api('GET', '/api/mentions')
      .then((r) => {
        useStore.setState((s: any) => ({ users: { ...Object.fromEntries(r.users.map((u: any) => [u.id, u])), ...s.users } }));
        setData(r.messages);
      })
      .catch((e) => (toast(e.message), setData([])));
  }, []);
  const s = get();
  const unreads = Object.entries<any>(s.readStates)
    .filter(([, rs]) => rs.mentions > 0)
    .map(([id]) => findChannel(id))
    .filter(Boolean);
  return (
    <Modal title={t('Inbox')} width={560} className="inbox">
      <div className="modal-body">
        <div className="seg">
          <button className={tab === 'mentions' ? 'active' : ''} onClick={() => setTab('mentions')}>
            <AtSign size={14} /> {t('Mentions')}
          </button>
          <button className={tab === 'unreads' ? 'active' : ''} onClick={() => setTab('unreads')}>
            <Inbox size={14} /> {t('Unreads')} {unreads.length > 0 && <span className="badge">{num(unreads.length)}</span>}
          </button>
        </div>
        {tab === 'mentions' ? (
          !data ? (
            <p className="muted center">{t('Loading…')}</p>
          ) : !data.length ? (
            <div className="empty small">
              <AtSign size={56} />
              <p>{t("You've caught up with everything. When someone mentions you it shows up here.")}</p>
            </div>
          ) : (
            data.map((m) => {
              const ch = findChannel(m.channelId);
              const sv = ch?.serverId ? s.servers[ch.serverId] : null;
              return (
                <div key={m.id} className="inbox-item">
                  <div className="list-title">
                    {sv ? `${sv.name} • #${ch.name}` : ch ? dmName(ch) : ''}
                  </div>
                  <MessageCard
                    m={m}
                    serverId={ch?.serverId}
                    onClick={() => {
                      closeModal();
                      jumpTo(m.channelId, m.id);
                    }}
                  />
                </div>
              );
            })
          )
        ) : !unreads.length ? (
          <p className="muted center">{t('No unread mentions.')}</p>
        ) : (
          unreads.map((ch: any) => (
            <button key={ch.id} className="thread-row" onClick={() => (closeModal(), navigate(ch.serverId || null, ch.id))}>
              {ch.serverId ? <ChannelIcon ch={ch} /> : <Users size={20} />}
              <div className="grow">
                <b>{ch.serverId ? ch.name : dmName(ch)}</b>
                <small className="muted">{ch.serverId ? s.servers[ch.serverId]?.name : t('Direct Message')}</small>
              </div>
              <span className="badge">{num(s.readStates[ch.id].mentions)}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- quick switcher
export function QuickSwitcher() {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const s = get();
  const items = useMemo(() => {
    const out: { key: string; label: string; sub: string; icon: React.ReactNode; go: () => void }[] = [];
    const query = q.replace(/^[#@*!]/, '').toLowerCase();
    const prefix = /^[#@*!]/.test(q) ? q[0] : '';
    if (!prefix || prefix === '@') {
      for (const d of sortedDms())
        out.push({
          key: d.id,
          label: dmName(d),
          sub: d.type === CH.DM ? t('Direct Message') : t('Group DM'),
          icon: d.type === CH.DM ? <Avatar userId={d.recipients.find((r: string) => r !== s.me.id)} size={20} /> : <Users size={18} />,
          go: () => navigate(null, d.id),
        });
    }
    for (const sid of s.serverOrder) {
      const sv = s.servers[sid];
      if (!prefix || prefix === '*') out.push({ key: sid, label: sv.name, sub: t('Server'), icon: <ServerIcon server={sv} size={20} />, go: () => navigate(sid) });
      if (!prefix || prefix === '#' || prefix === '!')
        for (const c of orderedChannels(sv)) {
          if (c.type === CH.CATEGORY) continue;
          const isVoice = c.type === CH.VOICE || c.type === CH.STAGE;
          if ((prefix === '!' && !isVoice) || (prefix === '#' && isVoice)) continue;
          out.push({ key: c.id, label: c.name, sub: sv.name, icon: <ChannelIcon ch={c} size={18} />, go: () => navigate(sid, c.id) });
        }
    }
    const filtered = query ? out.filter((x) => x.label.toLowerCase().includes(query)) : out.slice(0, 20);
    return filtered.sort((a, b) => Number(!a.label.toLowerCase().startsWith(query)) - Number(!b.label.toLowerCase().startsWith(query))).slice(0, 30);
  }, [q]);
  const pick = (x: any) => {
    closeModal();
    x?.go();
  };
  return (
    <Modal width={560} className="switcher">
      <div className="modal-body">
        <input
          className="switcher-input"
          dir="auto"
          autoFocus
          value={q}
          placeholder={t('Where would you like to go?')}
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((i + 1) % Math.max(1, items.length)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI((i - 1 + items.length) % Math.max(1, items.length)));
            else if (e.key === 'Enter') pick(items[i]);
          }}
        />
        <div className="switcher-list">
          {items.map((x, j) => (
            <button key={x.key} className={j === i ? 'active' : ''} onMouseEnter={() => setI(j)} onClick={() => pick(x)}>
              {x.icon}
              <b dir="auto">{x.label}</b>
              <small>{x.sub}</small>
            </button>
          ))}
          {!items.length && <p className="muted center">{t("Can't find what you're looking for?")}</p>}
        </div>
        <small className="muted">{t('Tip: start with @ for people, # for text channels, ! for voice channels, * for servers.')}</small>
      </div>
    </Modal>
  );
}
export { Hash, KeyRound, Search, Volume2, fmtStamp, P, displayName, openModal };
