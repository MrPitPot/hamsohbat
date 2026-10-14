// Music in voice channels: a shared queue that plays in sync for everyone in the channel (YouTube links or direct
// audio files). Each person's own app plays it, so it never goes through the voice mix and has its own volume.
import React, { useEffect, useRef, useState } from 'react';
import { Music, Pause, Play, SkipBack, SkipForward, Trash2, X, Volume2 } from 'lucide-react';
import { useStore, wsSend, updateSettings, displayName } from '../store';
import { t } from '../i18n';
import { Popover, num } from '../ui';

const send = (o: any) => wsSend({ op: 'music', ...o });
const ytId = (s: string) => s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/)?.[1] || (/^[\w-]{11}$/.test(s.trim()) ? s.trim() : '');

async function addUrl(url: string) {
  const u = url.trim();
  if (!u) return false;
  const id = ytId(u);
  if (id) {
    let title = '';
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
      title = ((await r.json()) as any).title || '';
    } catch {}
    send({ cmd: 'add', kind: 'youtube', ref: id, title: title || 'YouTube ' + id });
    return true;
  }
  if (!/^https?:\/\//i.test(u)) return false;
  send({ cmd: 'add', kind: 'audio', ref: u, title: decodeURIComponent(u.split('/').pop()!.split('?')[0]) || u });
  return true;
}

export function MusicPanel({ channelId }: { channelId: string }) {
  const st = useStore((s: any) => s.music[channelId]);
  const volume = useStore((s: any) => s.settings.musicVolume ?? 70);
  const [url, setUrl] = useState('');
  const [bad, setBad] = useState(false);
  const queue: any[] = st?.queue || [];
  return (
    <div className="music-panel">
      <form
        className="copy-row"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await addUrl(url);
          setBad(!ok);
          if (ok) setUrl('');
        }}
      >
        <input dir="ltr" value={url} onChange={(e) => (setUrl(e.target.value), setBad(false))} placeholder={t('YouTube or audio link')} autoFocus />
        <button className="btn primary" disabled={!url.trim()}>
          {t('Add')}
        </button>
      </form>
      {bad && <small className="red">{t('That does not look like a YouTube or audio link.')}</small>}
      <div className="music-controls">
        <button className="icon-btn" onClick={() => send({ cmd: 'prev' })} title={t('Previous')}>
          <SkipBack size={18} />
        </button>
        <button className="icon-btn" onClick={() => send({ cmd: st?.playing ? 'pause' : 'resume' })} title={st?.playing ? t('Pause') : t('Play')}>
          {st?.playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button className="icon-btn" onClick={() => send({ cmd: 'next' })} title={t('Skip')}>
          <SkipForward size={18} />
        </button>
        <button className="icon-btn" onClick={() => send({ cmd: 'clear' })} title={t('Clear Queue')}>
          <Trash2 size={18} />
        </button>
        <label className="sb-vol">
          <Volume2 size={14} />
          <input type="range" min={0} max={100} value={volume} onChange={(e) => updateSettings({ musicVolume: Number(e.target.value) })} />
        </label>
      </div>
      {!queue.length && <p className="muted center small-note">{t('Nothing is playing. Paste a YouTube link to start music for everyone in this channel.')}</p>}
      <div className="music-queue">
        {queue.map((q, i) => (
          <div key={i} className={'music-item' + (i === st.index ? ' now' : '')} onDoubleClick={() => send({ cmd: 'jump', index: i })}>
            <span className="music-no">{i === st.index && st.playing ? '▶' : num(i + 1)}</span>
            <span className="grow" dir="auto" title={q.title}>
              {q.title}
              <small className="muted"> — {displayName(q.by)}</small>
            </span>
            <button className="icon-btn" onClick={() => send({ cmd: 'remove', index: i })} title={t('Remove')}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MusicButton({ channelId, className = 'round', size = 20 }: { channelId: string; className?: string; size?: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const playing = useStore((s: any) => !!s.music[channelId]?.playing);
  return (
    <>
      <button className={className + (anchor || playing ? ' on' : '')} title={t('Music')} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <Music size={size} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <MusicPanel channelId={channelId} />
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the player (always mounted)
let ytApi: Promise<any> | null = null;
function loadYouTube() {
  ytApi ||= new Promise((resolve) => {
    if ((window as any).YT?.Player) return resolve((window as any).YT);
    (window as any).onYouTubeIframeAPIReady = () => resolve((window as any).YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApi;
}

export function MusicPlayer() {
  const channelId = useStore((s: any) => s.voice.channelId);
  const st = useStore((s: any) => (s.voice.channelId ? s.music[s.voice.channelId] : null));
  const volume = useStore((s: any) => s.settings.musicVolume ?? 70);
  const deaf = useStore((s: any) => s.voice.deaf || s.voice.serverDeaf);
  const audio = useRef<HTMLAudioElement | null>(null);
  const yt = useRef<any>(null);
  const ytHost = useRef<HTMLDivElement>(null);
  const loaded = useRef('');
  const track = st && st.index < st.queue.length ? st.queue[st.index] : null;
  const key = track ? `${channelId}:${st.index}:${track.kind}:${track.ref}` : '';

  const position = () => {
    if (!st) return 0;
    const now = Date.now() + (st.offset || 0);
    return (st.playing ? st.pos + (now - st.startedAt) : st.pos) / 1000;
  };
  const ended = () => send({ cmd: 'ended', index: st.index });

  // Load / switch track
  useEffect(() => {
    if (!track) {
      audio.current?.pause();
      try {
        yt.current?.stopVideo();
      } catch {}
      loaded.current = '';
      return;
    }
    if (loaded.current === key) return;
    loaded.current = key;
    audio.current?.pause();
    try {
      yt.current?.stopVideo();
    } catch {}
    if (track.kind === 'audio') {
      const a = (audio.current ||= new Audio());
      a.src = track.ref;
      a.onended = ended;
      a.currentTime = Math.max(0, position());
      if (st.playing) a.play().catch(() => {});
    } else {
      loadYouTube().then((YT) => {
        if (loaded.current !== key) return;
        const start = () => {
          yt.current.loadVideoById({ videoId: track.ref, startSeconds: Math.max(0, position()) });
          if (!st.playing) setTimeout(() => yt.current?.pauseVideo(), 600);
        };
        if (yt.current) return start();
        yt.current = new YT.Player(ytHost.current, {
          height: '1',
          width: '1',
          videoId: track.ref,
          playerVars: { autoplay: 1, controls: 0 },
          events: {
            onReady: () => {
              yt.current.setVolume(volume);
              start();
            },
            onStateChange: (e: any) => e.data === 0 && ended(),
          },
        });
      });
    }
  }, [key]);

  // Play / pause / seek follow the shared state; volume follows the local slider
  useEffect(() => {
    if (!st || !track) return;
    const pos = position();
    if (track.kind === 'audio' && audio.current) {
      const a = audio.current;
      if (Math.abs(a.currentTime - pos) > 1.5) a.currentTime = Math.max(0, pos);
      if (st.playing) a.play().catch(() => {});
      else a.pause();
    } else if (yt.current?.getCurrentTime) {
      try {
        if (Math.abs(yt.current.getCurrentTime() - pos) > 1.5) yt.current.seekTo(Math.max(0, pos), true);
        if (st.playing) yt.current.playVideo();
        else yt.current.pauseVideo();
      } catch {}
    }
  }, [st?.playing, st?.pos, st?.startedAt]);
  useEffect(() => {
    const v = deaf ? 0 : volume;
    if (audio.current) audio.current.volume = v / 100;
    try {
      yt.current?.setVolume(v);
    } catch {}
  }, [volume, deaf, key]);
  // Leaving the channel stops the music
  useEffect(() => {
    if (channelId) return;
    audio.current?.pause();
    try {
      yt.current?.stopVideo();
    } catch {}
    loaded.current = '';
  }, [channelId]);
  return <div ref={ytHost} style={{ position: 'fixed', width: 1, height: 1, opacity: 0, pointerEvents: 'none', left: -10, top: -10 }} />;
}
