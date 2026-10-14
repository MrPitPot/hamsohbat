// Server relay for calls that cannot connect peer-to-peer (strict NATs without a TURN server).
// The sender records its microphone / camera / screen with MediaRecorder (WebM chunks) and sends them through the
// gateway; the Hub forwards them to the one person who asked. The receiver plays them through MediaSource and
// exposes the result as an ordinary MediaStream, so the rest of the call UI does not care how media arrived.
// Frame: [kind u8][sidLen u8][sid ascii][first u8][webm bytes]; kind 0 = audio, 1 = camera, 2 = screen.

export const RELAY_KINDS = { audio: 0, camera: 1, screen: 2 } as const;
const MIME: Record<number, string[]> = {
  0: ['audio/webm;codecs=opus'],
  1: ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'],
  2: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'],
};
const pick = (kind: number) => MIME[kind].find((m) => (window as any).MediaRecorder?.isTypeSupported(m)) || '';

interface Sink {
  ms: MediaSource;
  sb: SourceBuffer | null;
  el: HTMLVideoElement;
  queue: Uint8Array[];
  stream: MediaStream | null;
  mime: string;
}

export interface RelayHost {
  /** The streams this side can currently send. */
  localStreams(): { audio?: MediaStream; camera?: MediaStream; screen?: MediaStream };
  sendBinary(buf: ArrayBuffer): void;
  signal(to: string, data: any): void;
  onStream(sid: string, kind: number, stream: MediaStream): void;
}

export class Relay {
  private senders = new Map<string, Map<number, MediaRecorder>>(); // peer sid -> kind -> recorder
  private sinks = new Map<string, Sink>(); // `${sid}:${kind}`
  constructor(private host: RelayHost) {}

  /** We cannot reach this person directly: ask them to send their media through the server. */
  request(sid: string) {
    this.host.signal(sid, { relay: 'request' });
  }
  has(sid: string) {
    return this.senders.has(sid);
  }

  /** Start (or restart) sending our streams to one person. */
  startSend(sid: string) {
    this.stopSend(sid);
    const local = this.host.localStreams();
    const rec = new Map<number, MediaRecorder>();
    const add = (kind: number, stream?: MediaStream) => {
      if (!stream || !stream.getTracks().some((t) => t.readyState === 'live')) return;
      // A screen share without sound must be announced with a video-only codec string.
      const silent = kind === 2 && !stream.getAudioTracks().some((t) => t.readyState === 'live');
      const mime = silent ? pick(1) : pick(kind);
      if (!mime) return;
      try {
        const r = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 48000, videoBitsPerSecond: kind === 2 ? 1_500_000 : 700_000 });
        let first = silent ? 2 : 1;
        r.ondataavailable = async (e) => {
          if (!e.data.size) return;
          const body = new Uint8Array(await e.data.arrayBuffer());
          const sidBytes = new TextEncoder().encode(sid);
          const out = new Uint8Array(3 + sidBytes.length + body.length);
          out[0] = kind;
          out[1] = sidBytes.length;
          out.set(sidBytes, 2);
          out[2 + sidBytes.length] = first;
          out.set(body, 3 + sidBytes.length);
          first = 0;
          this.host.sendBinary(out.buffer);
        };
        r.start(150);
        rec.set(kind, r);
      } catch (e) {
        console.warn('relay recorder failed', e);
      }
    };
    add(0, local.audio);
    add(1, local.camera);
    add(2, local.screen);
    this.senders.set(sid, rec);
  }
  stopSend(sid: string) {
    for (const r of this.senders.get(sid)?.values() || []) {
      try {
        r.ondataavailable = null;
        if (r.state !== 'inactive') r.stop();
      } catch {}
    }
    this.senders.delete(sid);
  }
  /** Camera or screen was turned on/off, or the microphone changed: re-send to everybody who relies on us. */
  refresh() {
    for (const sid of [...this.senders.keys()]) this.startSend(sid);
  }
  closePeer(sid: string) {
    this.stopSend(sid);
    for (const k of [...this.sinks.keys()]) if (k.startsWith(sid + ':')) this.dropSink(k);
  }
  closeAll() {
    for (const sid of [...this.senders.keys()]) this.stopSend(sid);
    for (const k of [...this.sinks.keys()]) this.dropSink(k);
  }

  // ---- receiving
  private dropSink(key: string) {
    const s = this.sinks.get(key);
    if (!s) return;
    this.sinks.delete(key);
    try {
      s.el.pause();
      s.el.src = '';
      s.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  onFrame(buf: ArrayBuffer) {
    const u = new Uint8Array(buf);
    if (u.length < 4) return;
    const kind = u[0];
    const sidLen = u[1];
    const sid = new TextDecoder().decode(u.subarray(2, 2 + sidLen));
    const flag = u[2 + sidLen];
    const first = flag !== 0;
    const body = u.subarray(3 + sidLen);
    const key = `${sid}:${kind}`;
    let sink = this.sinks.get(key);
    if (first || !sink) {
      if (!first) return; // wait for the next init segment
      this.dropSink(key);
      sink = this.createSink(key, sid, kind, flag === 2);
      if (!sink) return;
    }
    sink.queue.push(new Uint8Array(body));
    this.pump(sink);
  }
  private createSink(key: string, sid: string, kind: number, silent = false): Sink | null {
    const mime = silent ? pick(1) : pick(kind);
    if (!mime || !(window as any).MediaSource) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    const ms = new MediaSource();
    const sink: Sink = { ms, sb: null, el, queue: [], stream: null, mime };
    el.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      try {
        // The sender's codec string decides what the receiver can decode; fall back to the plain container type.
        sink.sb = ms.addSourceBuffer(MediaSource.isTypeSupported(mime) ? mime : 'video/webm');
        sink.sb.mode = 'sequence';
        sink.sb.addEventListener('updateend', () => this.pump(sink));
        this.pump(sink);
      } catch (e) {
        console.warn('relay sink failed', e);
      }
    });
    el.play().catch(() => {});
    this.sinks.set(key, sink);
    // captureStream gives a normal MediaStream once the element has data.
    const grab = () => {
      if (sink.stream || !this.sinks.has(key)) return;
      const cap = (el as any).captureStream?.() as MediaStream | undefined;
      if (cap && cap.getTracks().length) {
        sink.stream = cap;
        this.host.onStream(sid, kind, cap);
      } else setTimeout(grab, 150);
    };
    el.addEventListener('loadeddata', grab);
    setTimeout(grab, 300);
    return sink;
  }
  private pump(sink: Sink) {
    const { sb, el } = sink;
    if (!sb || sb.updating || !sink.queue.length || sink.ms.readyState !== 'open') return;
    try {
      // Stay close to live: when the buffer runs far ahead, skip forward.
      if (el.buffered.length) {
        const end = el.buffered.end(el.buffered.length - 1);
        if (end - el.currentTime > 1.2) el.currentTime = end - 0.25;
      }
      sb.appendBuffer(sink.queue.shift()! as BufferSource);
      if (el.paused) el.play().catch(() => {});
    } catch (e: any) {
      if (e?.name === 'QuotaExceededError' && el.buffered.length) {
        try {
          sb.remove(0, Math.max(0, el.currentTime - 2));
        } catch {}
      } else sink.queue.length = 0;
    }
  }
}
