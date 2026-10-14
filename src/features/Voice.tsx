// Voice extras: the soundboard and stage channels (speakers, audience, raised hands).
import React, { useState } from 'react';
import { Hand, Mic, MicOff, Podcast, Users, ArrowDownToLine, ArrowUpToLine, Volume2 } from 'lucide-react';
import { useStore, get, act, displayName, findChannel, canIn, voiceIn, sendSoundboard, wsSend, updateSettings, P, CH } from '../store';
import { api } from '../api';
import { t } from '../i18n';
import { Avatar, Popover, num } from '../ui';
import { BUILTIN_SOUNDS, BUILTIN_EMOJI, playBuiltin } from '../sfx';
import { memberMenu } from '../Modals';

export function SoundboardPanel({ channelId }: { channelId: string }) {
  const ch = findChannel(channelId);
  const servers = useStore((s: any) => s.servers);
  const order = useStore((s: any) => s.serverOrder);
  const vol = useStore((s: any) => s.settings.sbVolume ?? 80);
  const [q, setQ] = useState('');
  const allowed = !ch?.serverId || canIn(ch, P.USE_SOUNDBOARD);
  // Sounds from this server first, then (in DMs) from every server you are in.
  const groups = (ch?.serverId ? [ch.serverId] : order).map((id: string) => servers[id]).filter((sv: any) => sv?.sounds?.length);
  const match = (n: string) => !q || n.toLowerCase().includes(q.toLowerCase());
  return (
    <div className="soundboard">
      <div className="sb-head">
        <input className="plain-input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search sounds')} autoFocus />
        <label className="sb-vol" title={t('Soundboard Volume')}>
          <Volume2 size={14} />
          <input type="range" min={0} max={100} value={vol} onChange={(e) => updateSettings({ sbVolume: Number(e.target.value) })} />
        </label>
      </div>
      {!allowed && <p className="muted small-note">{t('You do not have permission to use the soundboard here.')}</p>}
      {groups.map((sv: any) => (
        <React.Fragment key={sv.id}>
          <div className="emoji-group-title">{sv.name}</div>
          <div className="sb-grid">
            {sv.sounds
              .filter((x: any) => match(x.name))
              .map((x: any) => (
                <button key={x.id} className="sb-btn" disabled={!allowed} onClick={() => sendSoundboard(x.id)} onContextMenu={(e) => (e.preventDefault(), new Audio(`/api/files/${x.id}`).play().catch(() => {}))}>
                  <span>{x.emoji || '🔊'}</span> {x.name}
                </button>
              ))}
          </div>
        </React.Fragment>
      ))}
      <div className="emoji-group-title">{t('Default')}</div>
      <div className="sb-grid">
        {BUILTIN_SOUNDS.filter((n) => match(n) || match(t(n))).map((n) => (
          <button key={n} className="sb-btn" disabled={!allowed} onClick={() => sendSoundboard('builtin:' + n)} onContextMenu={(e) => (e.preventDefault(), playBuiltin(n))}>
            <span>{BUILTIN_EMOJI['builtin:' + n]}</span> {t(n)}
          </button>
        ))}
      </div>
      <p className="muted small-note">{t('Right-click a sound to preview it just for yourself.')}</p>
    </div>
  );
}

export function SoundboardButton({ channelId, className = 'round', size = 20 }: { channelId: string; className?: string; size?: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className={className + (anchor ? ' on' : '')} title={t('Soundboard')} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <span style={{ fontSize: size * 0.9, lineHeight: 1 }}>🎶</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <SoundboardPanel channelId={channelId} />
        </Popover>
      )}
    </>
  );
}

/** Stage channels: speakers on top, the audience below, raised hands for moderators. */
export function StageView({ channelId, serverId }: { channelId: string; serverId: string }) {
  useStore((s: any) => s.voiceStates);
  const meId = useStore((s: any) => s.me.id);
  const speaking = useStore((s: any) => s.speaking);
  const sbFlash = useStore((s: any) => s.sbFlash);
  const inStage = useStore((s: any) => s.voice.channelId === channelId);
  const ch = findChannel(channelId);
  const people = voiceIn(channelId);
  const speakers = people.filter((v) => !v.suppress);
  const audience = people.filter((v) => v.suppress).sort((a, b) => (b.hand || 0) - (a.hand || 0));
  const mod = canIn(ch, P.MUTE_MEMBERS) || canIn(ch, P.MOVE_MEMBERS);
  const me = people.find((v) => v.userId === meId);
  const setSuppress = (uid: string, suppress: boolean) => act(api('PATCH', `/api/servers/${serverId}/voice/${uid}`, { suppress }));
  const Person = ({ v, big }: any) => (
    <div className={'stage-person' + (big ? ' speaker' : '')} onContextMenu={(e) => memberMenu(e, v.userId, serverId)}>
      <div className="sp-avatar">
        <Avatar userId={v.userId} size={big ? 72 : 48} speaking={!!speaking[v.userId]} />
        {sbFlash[v.userId] && <span className="sb-flash">{sbFlash[v.userId].emoji}</span>}
        {v.hand > 0 && <span className="hand">✋</span>}
      </div>
      <span className="sp-name">{displayName(v.userId, serverId)}</span>
      {big && (v.mute || v.serverMute) && <MicOff size={14} className="red" />}
      {mod && v.userId !== meId && (
        <div className="sp-actions">
          {v.suppress ? (
            <button className="btn small" onClick={() => setSuppress(v.userId, false)} title={t('Invite to Speak')}>
              <ArrowUpToLine size={14} />
            </button>
          ) : (
            <button className="btn small" onClick={() => setSuppress(v.userId, true)} title={t('Move to Audience')}>
              <ArrowDownToLine size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
  return (
    <div className="stage">
      <div className="stage-head">
        <Podcast size={20} />
        <b>{ch?.topic || ch?.name}</b>
        <span className="muted">
          <Users size={14} /> {num(people.length)}
        </span>
      </div>
      <div className="list-title">
        {t('Speakers')} — {num(speakers.length)}
      </div>
      <div className="stage-speakers">
        {speakers.map((v) => (
          <Person key={v.userId} v={v} big />
        ))}
        {!speakers.length && <p className="muted">{t('No one is speaking yet.')}</p>}
      </div>
      <div className="list-title">
        {t('Audience')} — {num(audience.length)}
      </div>
      <div className="stage-audience">
        {audience.map((v) => (
          <Person key={v.userId} v={v} />
        ))}
      </div>
      {inStage && me && (
        <div className="stage-controls">
          {me.suppress ? (
            mod ? (
              <button className="btn primary" onClick={() => setSuppress(meId, false)}>
                <Mic size={16} /> {t('Become a Speaker')}
              </button>
            ) : (
              <button className={'btn ' + (me.hand ? 'green' : 'primary')} disabled={!canIn(ch, P.REQUEST_TO_SPEAK)} onClick={() => wsSend({ op: 'stage_hand', raise: !me.hand })}>
                <Hand size={16} /> {me.hand ? t('Lower Hand') : t('Request to Speak')}
              </button>
            )
          ) : (
            <button className="btn" onClick={() => setSuppress(meId, true)}>
              <ArrowDownToLine size={16} /> {t('Move to Audience')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
export { CH, get };
