// Voice messages and link previews.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Pause, Play, SendHorizontal, Trash2 } from 'lucide-react';
import { get, openModal, toast } from './store';
import { api } from './api';
import { t } from './i18n';

const fmtDur = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Voice messages carry their length in the file name: voice-message-<ms>.<ext> */
export const voiceMessageMs = (name: string) => {
  const m = name.match(/^voice-message-(\d+)\./);
  return m ? Number(m[1]) : null;
};

export function VoicePlayer({ url, ms }: { url: string; ms: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const total = ms / 1000;
  // A stable pseudo-waveform derived from the URL looks nicer than a flat bar.
  const bars = useMemo(() => {
    let h = 0;
    for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return Array.from({ length: 36 }, (_, i) => {
      h = (h * 1103515245 + 12345) >>> 0;
      return 0.25 + ((h >>> 16) % 1000) / 1333 + 0.1 * Math.sin(i / 2);
    });
  }, [url]);
  useEffect(() => {
    const el = ref.current!;
    const time = () => setPos(el.currentTime);
    const end = () => {
      setPlaying(false);
      setPos(0);
    };
    el.addEventListener('timeupdate', time);
    el.addEventListener('ended', end);
    el.addEventListener('pause', () => setPlaying(false));
    el.addEventListener('play', () => setPlaying(true));
    return () => {
      el.removeEventListener('timeupdate', time);
      el.removeEventListener('ended', end);
    };
  }, []);
  const toggle = () => {
    const el = ref.current!;
    if (el.paused) {
      // Only one voice message plays at a time.
      document.querySelectorAll<HTMLAudioElement>('.voice-msg audio').forEach((a) => a !== el && a.pause());
      el.play().catch(() => toast('Could not play this voice message'));
    } else el.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    let f = (e.clientX - r.left) / r.width;
    if (getComputedStyle(e.currentTarget).direction === 'rtl') f = 1 - f;
    ref.current!.currentTime = Math.max(0, Math.min(1, f)) * total;
    setPos(ref.current!.currentTime);
  };
  const progress = total ? pos / total : 0;
  return (
    <div className="voice-msg">
      <button className="vm-play" onClick={toggle} aria-label={playing ? t('Pause') : t('Play')}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <div className="vm-wave" onClick={seek}>
        {bars.map((b, i) => (
          <i key={i} className={i / bars.length < progress ? 'on' : ''} style={{ height: Math.round(b * 26) + 'px' }} />
        ))}
      </div>
      <span className="vm-time">{fmtDur(playing || pos ? pos : total)}</span>
      <audio ref={ref} src={url} preload="none" />
    </div>
  );
}

/** Records a voice message. Calls onDone with the result, or null when cancelled. */
export function VoiceRecorder({ onDone }: { onDone: (r: { blob: Blob; ms: number; ext: string } | null) => void }) {
  const [ms, setMs] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: any;
    let raf = 0;
    let ac: AudioContext | null = null;
    let cancelled = false;
    const st = get().settings;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined, echoCancellation: true, noiseSuppression: st.noiseSuppression, autoGainControl: true } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((x) => x.stop());
        stream = s;
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((x) => MediaRecorder.isTypeSupported(x)) || '';
        const r = new MediaRecorder(s, { mimeType: type || undefined, audioBitsPerSecond: 32000 });
        const chunks: Blob[] = [];
        const started = Date.now();
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          const mime = (r.mimeType || 'audio/webm').split(';')[0];
          const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
          const dur = Date.now() - started;
          onDone(keep.current && dur > 400 ? { blob: new Blob(chunks, { type: mime }), ms: dur, ext } : null);
        };
        r.start(250);
        rec.current = r;
        timer = setInterval(() => {
          const d = Date.now() - started;
          setMs(d);
          if (d > 5 * 60 * 1000) stop(true); // five minutes is plenty
        }, 200);
        ac = new AudioContext();
        const an = ac.createAnalyser();
        an.fftSize = 256;
        ac.createMediaStreamSource(s).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const b of buf) peak = Math.max(peak, Math.abs(b - 128) / 128);
          setLevel(peak);
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        toast('Microphone permission was denied');
        onDone(null);
      });
    return () => {
      cancelled = true;
      clearInterval(timer);
      cancelAnimationFrame(raf);
      if (rec.current?.state === 'recording') rec.current.stop();
      stream?.getTracks().forEach((x) => x.stop());
      ac?.close();
    };
  }, []);
  const stop = (send: boolean) => {
    keep.current = send;
    if (rec.current?.state === 'recording') rec.current.stop();
    else if (!rec.current) onDone(null);
  };
  return (
    <div className="recorder">
      <button className="icon-btn danger" title={t('Cancel')} onClick={() => stop(false)}>
        <Trash2 size={20} />
      </button>
      <span className="rec-dot" style={{ transform: `scale(${1 + level * 1.5})` }} />
      <span className="rec-time">{fmtDur(ms / 1000)}</span>
      <span className="rec-label">{t('Recording voice message…')}</span>
      <button className="icon-btn send-btn" title={t('Send')} onClick={() => stop(true)}>
        <SendHorizontal size={22} />
      </button>
    </div>
  );
}

export function MicButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" title={t('Record a voice message')} onClick={onClick}>
      <Mic size={22} />
    </button>
  );
}

// ---------------------------------------------------------------- link previews
const cache = new Map<string, Promise<any>>();
const known = new Map<string, any>();
function getEmbed(url: string) {
  if (!cache.has(url))
    cache.set(
      url,
      api('GET', '/api/embed?url=' + encodeURIComponent(url))
        .then((r) => (known.set(url, r.embed), r.embed))
        .catch(() => null)
    );
  return cache.get(url)!;
}

const YT = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;

function YouTube({ id, url }: { id: string; url: string }) {
  const [play, setPlay] = useState(false);
  const [title, setTitle] = useState<string>(known.get(url)?.title || '');
  useEffect(() => {
    getEmbed(url).then((e) => e?.title && setTitle(e.title));
  }, [url]);
  return (
    <div className="embed" style={{ borderInlineStartColor: '#ff0000' }}>
      <small className="embed-site">YouTube</small>
      {title && (
        <a className="embed-title" href={url} target="_blank" rel="noopener noreferrer">
          {title}
        </a>
      )}
      {play ? (
        <iframe className="embed-video" src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen title={title || 'YouTube'} />
      ) : (
        <button className="embed-video yt-thumb" style={{ backgroundImage: `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` }} onClick={() => setPlay(true)} aria-label={t('Play')}>
          <span className="yt-play">
            <Play size={28} fill="currentColor" />
          </span>
        </button>
      )}
    </div>
  );
}

function Embed({ url }: { url: string }) {
  const [e, setE] = useState<any>(known.get(url));
  useEffect(() => {
    let alive = true;
    getEmbed(url).then((x) => alive && setE(x));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!e) return null;
  if (e.type === 'image')
    return <img className="att-image" src={e.image} alt="" loading="lazy" referrerPolicy="no-referrer" onClick={() => openModal('image', { url: e.image, name: '' })} />;
  return (
    <div className="embed" style={e.color ? { borderInlineStartColor: e.color } : undefined}>
      <small className="embed-site" dir="auto">
        {e.siteName}
      </small>
      <a className="embed-title" href={url} target="_blank" rel="noopener noreferrer" dir="auto">
        {e.title}
      </a>
      {e.description && (
        <p className="embed-desc" dir="auto">
          {e.description}
        </p>
      )}
      {e.image && <img className="embed-img" src={e.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(ev) => (ev.currentTarget.style.display = 'none')} />}
    </div>
  );
}

/** Up to three previews for the links in a message (code is ignored). */
export function Embeds({ content }: { content: string }) {
  const urls = useMemo(() => {
    const text = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/\|\|[\s\S]*?\|\|/g, '');
    const out: string[] = [];
    for (const m of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
      const u = m[0].replace(/[.,!?;:)\]]+$/, '');
      if (u.startsWith(location.origin + '/invite/') || out.includes(u)) continue;
      out.push(u);
      if (out.length === 3) break;
    }
    return out;
  }, [content]);
  if (!urls.length) return null;
  return (
    <div className="embeds">
      {urls.map((u) => {
        const yt = u.match(YT);
        return yt ? <YouTube key={u} id={yt[1]} url={u} /> : <Embed key={u} url={u} />;
      })}
    </div>
  );
}
