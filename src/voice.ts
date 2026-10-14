// WebRTC mesh voice/video. Every participant holds one peer connection to each other participant;
// the gateway only relays signalling. Glare is handled with the "perfect negotiation" pattern.
import { get, set, wsSend, toast, canIn, findChannel } from './store';
import { api } from './api';
import { P } from '../shared/perms';
import { audioCtx, playSound } from './sfx';
import { processMic, browserSuppression, type ProcessedMic, type NoiseMode } from './noise';

interface Peer {
  sid: string;
  userId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  streams: Map<string, MediaStream>;
  audios: Map<string, HTMLAudioElement>;
  audioSender: RTCRtpSender | null;
  camSender: RTCRtpSender | null;
  screenSenders: RTCRtpSender[];
}

const ctx = audioCtx;

/** Plays an interface sound unless sounds are turned off. */
export function sfx(name: string) {
  const st = get()?.settings;
  if (st && !st.sounds) return;
  playSound(name);
}
export { playSound };

const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

class Voice {
  channelId: string | null = null;
  userStream: MediaStream | null = null; // microphone + camera
  screenStream: MediaStream | null = null;
  peers = new Map<string, Peer>();
  ice: RTCIceServer[] = DEFAULT_ICE;
  meters = new Map<string, { userId: string; streamId: string; src: MediaStreamAudioSourceNode; an: AnalyserNode; buf: Uint8Array; until: number }>();
  meterTimer: any = null;
  ringTimer: any = null;
  meterTrack: MediaStreamTrack | null = null; // always-on copy of the mic, so the voice gate can hear us while closed
  gateUntil = 0;
  pttDown = false;
  lastTx: boolean | null = null;
  level = -100; // current microphone level in dB, shown in the settings
  floor = -60; // estimated noise floor in dB (automatic sensitivity)
  /** The level above which the microphone opens. */
  threshold() {
    const st = get().settings;
    return st.vadAuto ? Math.max(-70, Math.min(-25, this.floor + 10)) : st.vadThreshold;
  }
  warnedRelay = false;
  mic: ProcessedMic | null = null; // the microphone after noise cancellation
  bitrate = 64; // kbps, from the channel settings
  forced = { serverMute: false, serverDeaf: false, suppress: false }; // set by moderators / stage

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === get()?.settings.pttKey && !e.repeat) this.setPtt(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === get()?.settings.pttKey) this.setPtt(false);
    });
    // In a browser the key-up is lost when the window loses focus. The desktop app reports keys globally.
    window.addEventListener('blur', () => !(window as any).chrome?.webview && this.setPtt(false));
  }

  private bump() {
    set((s: any) => ({ voiceTick: s.voiceTick + 1 }));
  }
  private patch(v: any) {
    set((s: any) => ({ voice: { ...s.voice, ...v } }));
  }
  private audioConstraints(): MediaTrackConstraints {
    const st = get().settings;
    return {
      deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined,
      noiseSuppression: browserSuppression(this.noiseMode()),
      echoCancellation: st.echoCancellation,
      autoGainControl: st.autoGain,
    };
  }
  noiseMode(): NoiseMode {
    const st = get().settings;
    return st.noiseCancel || (st.noiseSuppression === false ? 'off' : 'ai');
  }
  /** Opens the microphone and runs it through the noise canceller. */
  private async openMic(): Promise<ProcessedMic> {
    let raw: MediaStream;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
    } catch (e: any) {
      // The saved device may have been unplugged; fall back to the default one.
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'NotFoundError') throw e;
      raw = await navigator.mediaDevices.getUserMedia({ audio: { ...this.audioConstraints(), deviceId: undefined } });
    }
    return processMic(raw, this.noiseMode());
  }
  private canSpeak() {
    const ch = findChannel(this.channelId);
    if (this.forced.serverMute || this.forced.suppress) return false;
    return !ch?.serverId || canIn(ch, P.SPEAK);
  }
  /** Deafened by yourself or by a moderator. */
  deafened() {
    return get().voice.deaf || this.forced.serverDeaf;
  }
  /** Muted for the outside world: self-muted, deafened, no microphone or no permission. */
  effectiveMute() {
    const v = get().voice;
    return v.mute || this.deafened() || v.noMic || !this.canSpeak();
  }
  /** The server told us a moderator (or the stage) changed our voice state. */
  applyServerState(st: any) {
    const next = { serverMute: !!st.serverMute, serverDeaf: !!st.serverDeaf, suppress: !!st.suppress };
    const f = this.forced;
    if (next.serverMute === f.serverMute && next.serverDeaf === f.serverDeaf && next.suppress === f.suppress) return;
    if (next.serverMute !== f.serverMute) sfx(next.serverMute ? 'mute' : 'unmute');
    if (next.serverDeaf !== f.serverDeaf) sfx(next.serverDeaf ? 'deafen' : 'undeafen');
    this.forced = next;
    this.patch({ ...next });
    this.applyMute();
    this.refreshOutput();
  }
  /** Applies the channel's bitrate to every outgoing audio sender. */
  applyBitrate(kbps?: number) {
    if (kbps) this.bitrate = kbps;
    for (const p of this.peers.values()) {
      const snd = p.audioSender;
      if (!snd) continue;
      try {
        const prm = snd.getParameters();
        if (!prm.encodings?.length) prm.encodings = [{}];
        prm.encodings[0].maxBitrate = this.bitrate * 1000;
        snd.setParameters(prm).catch(() => {});
      } catch {}
    }
  }
  private screenConstraints(): MediaTrackConstraints {
    const q = String(get().settings.streamQuality || '720p30');
    const [res, fps] = q.split('p').map(Number);
    const h = res || 720;
    return { height: { ideal: h }, width: { ideal: Math.round((h * 16) / 9) }, frameRate: { ideal: fps || 30 } };
  }
  private tuneScreenSenders(p: Peer) {
    const q = String(get().settings.streamQuality || '720p30');
    const h = Number(q.split('p')[0]) || 720;
    const max = h >= 1080 ? 6_000_000 : h >= 720 ? 2_500_000 : 1_000_000;
    for (const snd of p.screenSenders) {
      if (snd.track?.kind !== 'video') continue;
      try {
        const prm = snd.getParameters();
        if (!prm.encodings?.length) prm.encodings = [{}];
        prm.encodings[0].maxBitrate = max;
        snd.setParameters(prm).catch(() => {});
      } catch {}
    }
  }
  // ----- mic test (settings) -----
  testStream: MediaStream | null = null;
  testMic: ProcessedMic | null = null;
  testEl: HTMLAudioElement | null = null;
  async startMicTest(onLevel: (db: number) => void) {
    this.stopMicTest();
    try {
      this.testMic = await this.openMic();
      this.testStream = this.testMic.stream;
    } catch {
      toast('Microphone is unavailable');
      return false;
    }
    const ac = ctx();
    const src = ac.createMediaStreamSource(this.testStream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    this.testEl = new Audio();
    this.testEl.srcObject = this.testStream;
    const out = get().settings.outputDevice;
    if (out && (this.testEl as any).setSinkId) (this.testEl as any).setSinkId(out).catch(() => {});
    this.testEl.play().catch(() => {});
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      if (!this.testStream) return src.disconnect();
      an.getByteTimeDomainData(buf as any);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += ((buf[i] - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      onLevel(rms > 0 ? 20 * Math.log10(rms) : -100);
      requestAnimationFrame(tick);
    };
    tick();
    return true;
  }
  stopMicTest() {
    this.testMic?.stop();
    this.testMic = null;
    this.testStream = null;
    if (this.testEl) {
      this.testEl.pause();
      this.testEl.srcObject = null;
      this.testEl = null;
    }
  }
  /** Whether our microphone is actually being sent right now (mute, push-to-talk and the voice gate). */
  transmitting() {
    if (this.effectiveMute()) return false;
    const st = get().settings;
    if (st.voiceMode === 'ptt') return this.pttDown;
    return (!st.vadAuto && st.vadThreshold <= -100) || Date.now() < this.gateUntil;
  }
  private applyMute() {
    const tx = this.transmitting();
    this.lastTx = tx;
    this.userStream?.getAudioTracks().forEach((t) => (t.enabled = tx));
  }
  setPtt(down: boolean) {
    if (this.pttDown === down) return;
    this.pttDown = down;
    window.dispatchEvent(new CustomEvent('hs-ptt', { detail: down }));
    if (this.channelId && get().settings.voiceMode === 'ptt') {
      this.applyMute();
      sfx(down ? 'pttOn' : 'pttOff');
    }
  }
  /** Gives the self-meter its own copy of the microphone track. */
  private meterSelf() {
    const me = get().me.id;
    for (const [k, m] of this.meters)
      if (m.userId === me) {
        m.src.disconnect();
        this.meters.delete(k);
      }
    this.meterTrack?.stop();
    const mic = this.userStream?.getAudioTracks()[0];
    this.meterTrack = mic ? mic.clone() : null;
    if (this.meterTrack) {
      this.meterTrack.enabled = true;
      this.attachMeter(me, new MediaStream([this.meterTrack]));
    }
  }
  private sendState() {
    const v = get().voice;
    wsSend({ op: 'voice_state', mute: this.effectiveMute(), deaf: v.deaf, video: v.video, screen: this.screenStream?.id || null });
  }

  async join(channelId: string) {
    if (this.channelId === channelId) return;
    if (!navigator.mediaDevices || !window.RTCPeerConnection) return toast('Voice is not supported in this browser');
    if (this.channelId) this.leave();
    ctx();
    this.channelId = channelId;
    this.patch({ channelId, connecting: true, video: false, screen: false, noMic: false });
    this.userStream = new MediaStream();
    let noMic = false;
    try {
      const mic = await this.openMic();
      if (this.channelId !== channelId) return mic.stop();
      this.mic = mic;
      mic.stream.getAudioTracks().forEach((t) => this.userStream!.addTrack(t));
    } catch {
      noMic = true;
      toast('Microphone is unavailable. You joined in listen-only mode.');
    }
    try {
      this.ice = (await api('GET', '/api/ice')).iceServers || DEFAULT_ICE;
    } catch {
      this.ice = DEFAULT_ICE;
    }
    if (this.channelId !== channelId) return;
    this.patch({ noMic });
    this.applyMute();
    const v = get().voice;
    wsSend({ op: 'voice_join', channelId, mute: this.effectiveMute(), deaf: v.deaf });
    setTimeout(() => wsSend({ op: 'music', cmd: 'get' }), 800);
    this.meterSelf();
    this.startMeters();
  }

  /** The gateway confirmed the join and told us who is already here: we call each of them. */
  onReady(ev: any) {
    if (ev.channelId !== this.channelId) return;
    this.patch({ connecting: false });
    if (ev.bitrate) this.bitrate = ev.bitrate;
    const mine = ev.states.find((x: any) => x.sid === get().sid);
    if (mine) this.applyServerState(mine);
    const sid = get().sid;
    for (const st of ev.states) if (st.sid !== sid && !this.peers.has(st.sid)) this.createPeer(st.sid, st.userId);
    sfx('join');
    // Calling someone who is not here yet: play a ringback tone until they pick up.
    const ch = findChannel(ev.channelId);
    if (ch && !ch.serverId && ev.states.length === 1) {
      let n = 0;
      clearInterval(this.ringTimer);
      this.ringTimer = setInterval(() => (++n > 12 || !this.channelId ? this.stopRingback() : sfx('outgoing')), 2500);
      setTimeout(() => this.ringTimer && sfx('outgoing'), 600);
    }
  }

  stopRingback() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
  }

  onVoiceState(st: any) {
    if (st.sid === get().sid) return;
    if (st.channelId && st.channelId === this.channelId) this.stopRingback();
    if (this.peers.has(st.sid) && st.channelId !== this.channelId) this.closePeer(st.sid);
    this.bump();
  }

  /** After a reconnect the server has forgotten our voice session, so join again. */
  onGatewayReady() {
    const ch = this.channelId;
    if (!ch) return;
    this.cleanup();
    if (findChannel(ch)) this.join(ch);
  }

  private createPeer(sid: string, userId: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const p: Peer = {
      sid,
      userId,
      pc,
      polite: get().sid < sid,
      makingOffer: false,
      ignoreOffer: false,
      streams: new Map(),
      audios: new Map(),
      audioSender: null,
      camSender: null,
      screenSenders: [],
    };
    this.peers.set(sid, p);
    const signal = (data: any) => wsSend({ op: 'signal', to: sid, data });

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        signal({ description: pc.localDescription });
      } catch (e) {
        console.warn('negotiation failed', e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => e.candidate && signal({ candidate: e.candidate });
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
      this.bump();
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      if (!p.streams.has(stream.id)) {
        p.streams.set(stream.id, stream);
        stream.onremovetrack = () => this.bump();
        stream.onaddtrack = () => this.bump();
      }
      if (e.track.kind === 'audio') this.attachAudio(p, stream);
      e.track.onunmute = () => this.bump();
      e.track.onmute = () => this.bump();
      e.track.onended = () => this.bump();
      this.bump();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.applyBitrate();
        this.tuneScreenSenders(p);
      }
    };
    // Still not connected after a while: most likely a strict NAT that needs a relay (TURN) server.
    setTimeout(() => {
      if (this.peers.get(sid) === p && !['connected', 'completed'].includes(pc.iceConnectionState) && !this.warnedRelay) {
        this.warnedRelay = true;
        toast('Could not connect directly to this person. The server may need a TURN relay (see README).');
      }
    }, 20000);
    const mic = this.userStream?.getAudioTracks()[0];
    // Without a microphone we still need an audio m-line so that negotiation starts and we can listen.
    if (mic) p.audioSender = pc.addTrack(mic, this.userStream!);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    const cam = this.userStream?.getVideoTracks()[0];
    if (cam) p.camSender = pc.addTrack(cam, this.userStream!);
    if (this.screenStream) p.screenSenders = this.screenStream.getTracks().map((t) => pc.addTrack(t, this.screenStream!));
    return p;
  }

  async onSignal(ev: any) {
    if (!this.channelId) return;
    const p = this.peers.get(ev.from) || this.createPeer(ev.from, ev.userId);
    const { pc } = p;
    const { description, candidate } = ev.data || {};
    try {
      if (description) {
        const collision = description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          wsSend({ op: 'signal', to: p.sid, data: { description: pc.localDescription } });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          if (!p.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn('signalling error', e);
    }
  }

  private attachAudio(p: Peer, stream: MediaStream) {
    if (p.audios.has(stream.id)) return;
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    el.muted = this.deafened();
    el.volume = this.volumeFor(p.userId);
    const out = get().settings.outputDevice;
    if (out && (el as any).setSinkId) (el as any).setSinkId(out).catch(() => {});
    el.play().catch(() => {});
    p.audios.set(stream.id, el);
    this.attachMeter(p.userId, stream);
  }
  volumeFor(userId: string) {
    return Math.min(1, Math.max(0, (get().settings.volumes[userId] ?? 100) / 100));
  }
  refreshOutput() {
    const s = get();
    for (const p of this.peers.values())
      for (const el of p.audios.values()) {
        el.muted = this.deafened();
        el.volume = this.volumeFor(p.userId);
        if ((el as any).setSinkId) (el as any).setSinkId(s.settings.outputDevice || '').catch(() => {});
      }
  }

  private closePeer(sid: string) {
    const p = this.peers.get(sid);
    if (!p) return;
    this.peers.delete(sid);
    for (const el of p.audios.values()) {
      el.pause();
      el.srcObject = null;
    }
    for (const [k, m] of this.meters)
      if (m.userId === p.userId && m.userId !== get().me?.id) {
        m.src.disconnect();
        this.meters.delete(k);
      }
    p.pc.onnegotiationneeded = p.pc.ontrack = p.pc.onicecandidate = p.pc.oniceconnectionstatechange = p.pc.onconnectionstatechange = null;
    p.pc.close();
    this.bump();
  }

  leave() {
    if (!this.channelId) return;
    wsSend({ op: 'voice_leave' });
    sfx('leave');
    this.cleanup();
  }

  /** Tears everything down locally without talking to the server. */
  cleanup() {
    for (const sid of [...this.peers.keys()]) this.closePeer(sid);
    this.userStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.userStream = this.screenStream = null;
    this.mic?.stop();
    this.mic = null;
    this.meterTrack?.stop();
    this.meterTrack = null;
    this.level = -100;
    for (const m of this.meters.values()) m.src.disconnect();
    this.meters.clear();
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.stopRingback();
    this.channelId = null;
    this.forced = { serverMute: false, serverDeaf: false, suppress: false };
    this.patch({ channelId: null, connecting: false, video: false, screen: false, noMic: false, serverMute: false, serverDeaf: false, suppress: false });
    set({ speaking: {} });
    this.bump();
  }

  setMute(mute: boolean) {
    const v = get().voice;
    if (v.noMic && !mute) return toast('Microphone is unavailable. You joined in listen-only mode.');
    if (!mute && this.channelId && this.forced.serverMute) return toast('You were muted by a moderator');
    if (!mute && this.channelId && !this.canSpeak() && !this.forced.suppress) return toast('You do not have permission to speak in this channel');
    // Un-muting while deafened also un-deafens, like every other voice app.
    this.patch({ mute, deaf: mute ? v.deaf : false });
    sfx(mute ? 'mute' : 'unmute');
    this.applyMute();
    this.refreshOutput();
    if (this.channelId) this.sendState();
  }
  setDeaf(deaf: boolean) {
    this.patch({ deaf });
    sfx(deaf ? 'deafen' : 'undeafen');
    this.applyMute();
    this.refreshOutput();
    if (this.channelId) this.sendState();
  }

  private canVideo() {
    const ch = findChannel(this.channelId);
    if (ch?.serverId && (!canIn(ch, P.VIDEO) || this.forced.suppress)) {
      toast('You do not have permission to share video in this channel');
      return false;
    }
    return true;
  }

  async setVideo(on: boolean) {
    if (!this.channelId || !this.userStream) return;
    const cur = this.userStream.getVideoTracks()[0];
    if (on === !!cur) return;
    if (on) {
      if (!this.canVideo()) return;
      let track: MediaStreamTrack;
      try {
        track = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0];
      } catch {
        return toast('Camera is unavailable');
      }
      if (!this.userStream) return track.stop();
      track.onended = () => this.setVideo(false);
      this.userStream.addTrack(track);
      for (const p of this.peers.values()) p.camSender = p.pc.addTrack(track, this.userStream);
    } else {
      cur.onended = null;
      cur.stop();
      this.userStream.removeTrack(cur);
      for (const p of this.peers.values()) {
        if (p.camSender) p.pc.removeTrack(p.camSender);
        p.camSender = null;
      }
    }
    this.patch({ video: on });
    sfx(on ? 'streamStart' : 'streamStop');
    this.sendState();
    this.bump();
  }

  async setScreen(on: boolean) {
    if (!this.channelId) return;
    if (on === !!this.screenStream) return;
    if (on) {
      if (!this.canVideo()) return;
      if (!navigator.mediaDevices.getDisplayMedia) return toast('Screen sharing is not supported on this device');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: this.screenConstraints(), audio: true });
      } catch {
        return; // the user closed the picker
      }
      if (!this.channelId) return stream.getTracks().forEach((t) => t.stop());
      this.screenStream = stream;
      stream.getVideoTracks()[0].onended = () => this.setScreen(false);
      try {
        (stream.getVideoTracks()[0] as any).contentHint = 'detail';
      } catch {}
      for (const p of this.peers.values()) {
        p.screenSenders = stream.getTracks().map((t) => p.pc.addTrack(t, stream));
        setTimeout(() => this.tuneScreenSenders(p), 1500);
      }
    } else {
      this.screenStream!.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.screenStream = null;
      for (const p of this.peers.values()) {
        p.screenSenders.forEach((s) => p.pc.removeTrack(s));
        p.screenSenders = [];
      }
    }
    this.patch({ screen: on });
    sfx(on ? 'streamStart' : 'streamStop');
    this.sendState();
    this.bump();
  }

  /** Swaps the microphone while connected (after changing the input device or filters). */
  async refreshInput() {
    if (!this.channelId || !this.userStream) return;
    try {
      const mic = await this.openMic();
      const track = mic.stream.getAudioTracks()[0];
      if (!this.userStream) return mic.stop();
      const old = this.userStream.getAudioTracks()[0];
      if (old) this.userStream.removeTrack(old);
      this.mic?.stop();
      this.mic = mic;
      this.userStream.addTrack(track);
      for (const p of this.peers.values()) {
        if (p.audioSender) await p.audioSender.replaceTrack(track);
        else p.audioSender = p.pc.addTrack(track, this.userStream);
      }
      this.patch({ noMic: false });
      this.applyMute();
      this.sendState();
      this.meterSelf();
    } catch {
      toast('Microphone is unavailable. You joined in listen-only mode.');
    }
  }

  /** Camera and screen streams to render for a participant. */
  media(userId: string): { camera: MediaStream | null; screen: MediaStream | null } {
    const s = get();
    const live = (st: MediaStream | null | undefined) => (st && st.getVideoTracks().some((t) => t.readyState === 'live') ? st : null);
    if (userId === s.me.id && this.channelId) return { camera: s.voice.video ? live(this.userStream) : null, screen: live(this.screenStream) };
    const vs = s.voiceStates[userId];
    const p = vs && this.peers.get(vs.sid);
    if (!p) return { camera: null, screen: null };
    let camera: MediaStream | null = null;
    if (vs.video) for (const [id, st] of p.streams) if (id !== vs.screen && live(st)) camera = st;
    return { camera, screen: vs.screen ? live(p.streams.get(vs.screen)) : null };
  }
  connectionState(userId: string): string {
    const vs = get().voiceStates[userId];
    const p = vs && this.peers.get(vs.sid);
    return p ? p.pc.iceConnectionState : 'new';
  }

  // ----- speaking indicators -----
  private attachMeter(userId: string, stream: MediaStream) {
    if (!stream.getAudioTracks().length) return;
    const key = userId + ':' + stream.id;
    if (this.meters.has(key)) return;
    try {
      const ac = ctx();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.meters.set(key, { userId, streamId: stream.id, src, an, buf: new Uint8Array(an.fftSize), until: 0 });
    } catch {}
  }
  private startMeters() {
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      const s = get();
      const now = Date.now();
      const speaking: Record<string, boolean> = {};
      for (const m of this.meters.values()) {
        const isMe = m.userId === s.me.id;
        const vs = s.voiceStates[m.userId];
        if (!isMe && vs?.screen === m.streamId) continue; // shared-screen audio is not speech
        m.an.getByteTimeDomainData(m.buf as any);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) {
          const x = (m.buf[i] - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / m.buf.length);
        if (isMe) {
          const db = rms > 0 ? 20 * Math.log10(rms) : -100;
          this.level = db;
          // The floor drops quickly to quiet moments and creeps up slowly, so speech never raises it.
          this.floor += (db - this.floor) * (db < this.floor ? 0.2 : 0.002);
          this.floor = Math.max(-100, Math.min(-20, this.floor));
          const thr = this.threshold();
          if (db > thr) this.gateUntil = now + 400; // keep the gate open briefly between words
          if (db > Math.max(thr, -45)) m.until = now + 350;
          if (this.transmitting() !== this.lastTx) this.applyMute();
          if (m.until > now && this.transmitting()) speaking[m.userId] = true;
          continue;
        }
        if (rms > 0.015) m.until = now + 350;
        if (m.until > now && !vs?.mute) speaking[m.userId] = true;
      }
      const prev = s.speaking;
      const a = Object.keys(prev);
      const b = Object.keys(speaking);
      if (a.length !== b.length || b.some((k) => !prev[k])) set({ speaking });
    }, 50);
  }
}

export const voice = new Voice();
// Hooks for tests and for the desktop app's global shortcuts.
(window as any).__voice = voice;
(window as any).__ptt = (down: boolean) => voice.setPtt(down);
(window as any).__toggleMute = () => voice.setMute(!get().voice.mute);
(window as any).__toggleDeafen = () => voice.setDeaf(!get().voice.deaf);
