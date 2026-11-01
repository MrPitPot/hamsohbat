// Voice through the media server (LiveKit SFU). Used for server voice channels when the Hub has a media server
// configured: every member keeps ONE connection to the server instead of one to each other member, which is what
// makes 100 people in one channel possible. The rest of the app does not notice: remote audio, camera and screen
// arrive as plain MediaStreams, exactly like the peer-to-peer and relay paths.
import { STREAM_MAX } from '../shared/voice';

export type SfuKind = 'mic' | 'camera' | 'screen' | 'screenAudio';
export interface SfuHandlers {
  /** A remote track arrived. `sid` is the participant's gateway session, `userId` comes from the token. */
  onTrack(sid: string, userId: string, kind: SfuKind, stream: MediaStream): void;
  onTrackGone(sid: string, kind: SfuKind): void;
  onParticipantLeft(sid: string): void;
  onState(state: 'connected' | 'reconnecting' | 'disconnected'): void;
}

export class Sfu {
  private room: any = null;
  private lk: any = null;
  private local = new Map<SfuKind, any>();

  constructor(private h: SfuHandlers) {}

  private kindOf(source: string): SfuKind | null {
    const S = this.lk.Track.Source;
    if (source === S.Microphone) return 'mic';
    if (source === S.Camera) return 'camera';
    if (source === S.ScreenShare) return 'screen';
    if (source === S.ScreenShareAudio) return 'screenAudio';
    return null;
  }

  async connect(url: string, token: string) {
    const lk = (this.lk = await import('livekit-client'));
    const room = (this.room = new lk.Room({ adaptiveStream: false, dynacast: true }));
    const E = lk.RoomEvent;
    room.on(E.TrackSubscribed, (track: any, _pub: any, p: any) => {
      const kind = this.kindOf(track.source);
      if (!kind) return;
      this.h.onTrack(p.identity, p.metadata || '', kind, new MediaStream([track.mediaStreamTrack]));
    });
    room.on(E.TrackUnsubscribed, (track: any, _pub: any, p: any) => {
      const kind = this.kindOf(track.source);
      if (kind) this.h.onTrackGone(p.identity, kind);
    });
    room.on(E.ParticipantDisconnected, (p: any) => this.h.onParticipantLeft(p.identity));
    room.on(E.Reconnecting, () => this.h.onState('reconnecting'));
    room.on(E.Reconnected, () => this.h.onState('connected'));
    room.on(E.Disconnected, () => this.h.onState('disconnected'));
    await room.connect(url, token, { autoSubscribe: true });
    this.h.onState('connected');
  }

  async publish(kind: SfuKind, track: MediaStreamTrack, opts: { audioKbps?: number } = {}) {
    if (!this.room) return;
    await this.unpublish(kind);
    const S = this.lk.Track.Source;
    const source = { mic: S.Microphone, camera: S.Camera, screen: S.ScreenShare, screenAudio: S.ScreenShareAudio }[kind];
    const options: any = { source, stopOnUnpublish: false };
    if (kind === 'mic') Object.assign(options, { dtx: true, red: false, audioPreset: { maxBitrate: (opts.audioKbps || 64) * 1000 } });
    if (kind === 'camera') Object.assign(options, { videoEncoding: { maxBitrate: STREAM_MAX.cameraKbps * 1000, maxFramerate: STREAM_MAX.fps }, simulcast: true });
    if (kind === 'screen') Object.assign(options, { videoEncoding: { maxBitrate: STREAM_MAX.screenKbps * 1000, maxFramerate: STREAM_MAX.fps }, simulcast: false });
    this.local.set(kind, await this.room.localParticipant.publishTrack(track, options));
  }

  async unpublish(kind: SfuKind) {
    const pub = this.local.get(kind);
    this.local.delete(kind);
    if (pub?.track) await this.room.localParticipant.unpublishTrack(pub.track, false).catch(() => {});
  }

  /** Swaps the microphone without renegotiating (input device changed). */
  async replace(kind: SfuKind, track: MediaStreamTrack) {
    const pub = this.local.get(kind);
    if (pub?.track) await pub.track.replaceTrack(track);
    else await this.publish(kind, track);
  }

  close() {
    const room = this.room;
    this.room = null;
    this.local.clear();
    room?.disconnect();
  }
}
