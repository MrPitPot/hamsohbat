import React, { useEffect, useRef, useState } from 'react';
import { PictureInPicture2, Headphones, HeadphoneOff, Maximize, Mic, MicOff, MonitorUp, MonitorX, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useStore, get, set, voiceIn, displayName, navigate, findChannel, dmName, openModal } from './store';
import { voice, sfx } from './voice';
import { t } from './i18n';
import { Avatar, Modal, colorFor } from './ui';
import { memberMenu } from './Modals';
import { SoundboardButton, StageView } from './features/Voice';
import { CH } from '../shared/perms';

function VideoEl({ stream, mirror }: { stream: MediaStream; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => {});
  }, [stream]);
  // Audio is played by the voice engine, so the video element itself is always muted.
  return <video ref={ref} autoPlay playsInline muted className={mirror ? 'mirror' : ''} />;
}

function Tile({ userId, serverId, kind, stream, focused, onFocus }: any) {
  const meId = useStore((s: any) => s.me.id);
  const vs = useStore((s: any) => s.voiceStates[userId]);
  const speaking = useStore((s: any) => !!s.speaking[userId]);
  const flash = useStore((s: any) => s.sbFlash[userId]);
  const ref = useRef<HTMLDivElement>(null);
  const connecting = userId !== meId && !['connected', 'completed'].includes(voice.connectionState(userId));
  return (
    <div
      ref={ref}
      className={'tile' + (speaking && kind === 'user' ? ' speaking' : '') + (focused ? ' focused' : '')}
      style={{ background: stream ? '#000' : colorFor(userId) + '55' }}
      onClick={onFocus}
      onContextMenu={(e) => memberMenu(e, userId, serverId)}
    >
      {flash && kind === 'user' && <span className="sb-flash">{flash.emoji}</span>}
      {stream ? <VideoEl stream={stream} mirror={kind === 'user' && userId === meId} /> : <Avatar userId={userId} size={80} />}
      <div className="tile-label">
        {kind === 'screen' && <MonitorUp size={14} />}
        {vs?.deaf || vs?.serverDeaf ? <HeadphoneOff size={14} className="red" /> : (vs?.mute || vs?.serverMute) && kind === 'user' ? <MicOff size={14} className="red" /> : null}
        <span>{displayName(userId, serverId)}</span>
        {connecting && kind === 'user' && <em>{t('Connecting…')}</em>}
      </div>
      {stream && document.pictureInPictureEnabled && (
        <button
          className="tile-full tile-pip"
          title={t('Picture in Picture')}
          onClick={(e) => {
            e.stopPropagation();
            const v = ref.current?.querySelector('video');
            if (document.pictureInPictureElement) document.exitPictureInPicture();
            else v?.requestPictureInPicture().catch(() => {});
          }}
        >
          <PictureInPicture2 size={16} />
        </button>
      )}
      {stream && (
        <button
          className="tile-full"
          title={t('Fullscreen')}
          onClick={(e) => {
            e.stopPropagation();
            if (document.fullscreenElement) document.exitFullscreen();
            else ref.current?.requestFullscreen?.();
          }}
        >
          <Maximize size={16} />
        </button>
      )}
    </div>
  );
}

export function VoiceControls({ channelId, big = false }: { channelId: string; big?: boolean }) {
  const v = useStore((s: any) => s.voice);
  const size = big ? 24 : 20;
  if (v.channelId !== channelId)
    return (
      <div className="voice-controls">
        <button className="btn green" onClick={() => voice.join(channelId)}>
          <Phone size={18} /> {t('Join Voice')}
        </button>
      </div>
    );
  return (
    <div className={'voice-controls' + (big ? ' big' : '')}>
      <button className={'round' + (v.mute || v.noMic || v.serverMute || v.suppress ? ' off' : '')} title={v.serverMute ? t('Server Muted') : v.mute ? t('Unmute') : t('Mute')} onClick={() => voice.setMute(!v.mute)}>
        {v.mute || v.noMic || v.serverMute || v.suppress ? <MicOff size={size} /> : <Mic size={size} />}
      </button>
      <button className={'round' + (v.deaf || v.serverDeaf ? ' off' : '')} title={v.serverDeaf ? t('Server Deafened') : v.deaf ? t('Undeafen') : t('Deafen')} onClick={() => voice.setDeaf(!v.deaf)}>
        {v.deaf || v.serverDeaf ? <HeadphoneOff size={size} /> : <Headphones size={size} />}
      </button>
      <button className={'round' + (v.video ? ' on' : '')} title={v.video ? t('Turn Off Camera') : t('Turn On Camera')} onClick={() => voice.setVideo(!v.video)}>
        {v.video ? <Video size={size} /> : <VideoOff size={size} />}
      </button>
      <button className={'round' + (v.screen ? ' on' : '')} title={v.screen ? t('Stop Sharing') : t('Share Your Screen')} onClick={() => voice.setScreen(!v.screen)}>
        {v.screen ? <MonitorX size={size} /> : <MonitorUp size={size} />}
      </button>
      <SoundboardButton channelId={channelId} size={size} />
      <button className="round red" title={t('Disconnect')} onClick={() => voice.leave()}>
        <PhoneOff size={size} />
      </button>
    </div>
  );
}

/** Grid of everybody in a voice channel, with their cameras and shared screens. */
export function VoiceStage({ channelId, serverId }: { channelId: string; serverId: string | null }) {
  useStore((s: any) => s.voiceStates);
  useStore((s: any) => s.voiceTick);
  useStore((s: any) => s.voice.channelId);
  const [focus, setFocus] = useState<string | null>(null);
  const inCall = voice.channelId === channelId;
  const people = voiceIn(channelId);
  const ch = findChannel(channelId);
  if (ch?.type === CH.STAGE && serverId)
    return (
      <div className="voice-stage">
        <StageView channelId={channelId} serverId={serverId} />
        <VoiceControls channelId={channelId} big />
      </div>
    );
  const tiles: any[] = [];
  for (const p of people) {
    const media = inCall ? voice.media(p.userId) : { camera: null, screen: null };
    if (media.screen) tiles.push({ key: p.userId + ':screen', userId: p.userId, kind: 'screen', stream: media.screen });
    tiles.push({ key: p.userId, userId: p.userId, kind: 'user', stream: media.camera });
  }
  const focused = tiles.find((x) => x.key === focus);
  const rest = focused ? tiles.filter((x) => x !== focused) : tiles;
  const cols = Math.ceil(Math.sqrt(rest.length || 1));
  return (
    <div className="voice-stage">
      {!people.length ? (
        <div className="voice-empty">
          <h2>{t('No one is here yet')}</h2>
          <p>{t('Join and your friends will see you here.')}</p>
        </div>
      ) : (
        <>
          {focused && (
            <div className="stage-focus">
              <Tile {...focused} serverId={serverId} focused onFocus={() => setFocus(null)} />
            </div>
          )}
          <div className={focused ? 'stage-strip' : 'stage-grid'} style={focused ? undefined : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {rest.map((x) => (
              <Tile key={x.key} {...x} serverId={serverId} onFocus={() => setFocus(x.key)} />
            ))}
          </div>
        </>
      )}
      <VoiceControls channelId={channelId} big />
    </div>
  );
}

export function IncomingCall() {
  const ringing = useStore((s: any) => s.ringing);
  const sounds = useStore((s: any) => s.settings.sounds);
  useEffect(() => {
    if (!ringing) return;
    sfx('ring');
    const loop = setInterval(() => sfx('ring'), 2500);
    const stop = setTimeout(() => set({ ringing: null }), 30000);
    return () => {
      clearInterval(loop);
      clearTimeout(stop);
    };
  }, [ringing?.channelId]);
  if (!ringing) return null;
  const ch = findChannel(ringing.channelId);
  if (!ch) return null;
  const answer = () => {
    set({ ringing: null });
    navigate(null, ringing.channelId);
    voice.join(ringing.channelId);
  };
  return (
    <Modal onClose={() => set({ ringing: null })} width={280} className="call-modal">
      <div className="ring-avatar">
        <Avatar userId={ringing.from} size={96} />
      </div>
      <h2>{dmName(ch)}</h2>
      <p>{t('Incoming call…')}</p>
      <div className="call-actions">
        <button className="round red" onClick={() => set({ ringing: null })} title={t('Decline')}>
          <PhoneOff size={24} />
        </button>
        <button className="round green" onClick={answer} title={t('Accept')}>
          <Phone size={24} />
        </button>
      </div>
    </Modal>
  );
}
