// LiveKit (media server, SFU) support. For voice channels with many people the Hub does not relay media itself:
// it only hands each member a short-lived token and the client connects to the LiveKit server we run on the VPS.
// Tokens are plain HS256 JWTs, so no SDK is needed here.

export interface LiveKitEnv {
  /** Public WebSocket address of the media server, e.g. wss://voice.example.ir */
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

export const livekitEnabled = (env: LiveKitEnv) => !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function livekitToken(
  env: LiveKitEnv,
  opts: { identity: string; name: string; userId: string; room: string; canSpeak: boolean; canVideo: boolean; ttlSeconds?: number }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sources = [opts.canSpeak && 'microphone', opts.canVideo && 'camera', opts.canVideo && 'screen_share', opts.canVideo && 'screen_share_audio'].filter(Boolean);
  const payload = {
    iss: env.LIVEKIT_API_KEY,
    sub: opts.identity,
    name: opts.name,
    metadata: opts.userId,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds || 6 * 3600),
    video: { room: opts.room, roomJoin: true, canSubscribe: true, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false },
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LIVEKIT_API_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head + '.' + body)));
  return `${head}.${body}.${b64url(sig)}`;
}
