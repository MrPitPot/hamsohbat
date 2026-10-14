// Small helpers shared by the Hub and its feature modules.

export class HttpError extends Error {
  constructor(public status: number, msg: string, public extra?: Record<string, any>) {
    super(msg);
  }
}
export const fail = (msg: string, status = 400): never => {
  throw new HttpError(status, msg);
};
/** Rejects a request that hit a brute-force limit; `wait` is in minutes and fills the message's {n}. */
export const tooMany = (wait: number): never => {
  throw new HttpError(429, 'Too many attempts. Try again in {n} minutes.', { wait });
};
export const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const str = (v: any, max: number, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);

export async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 },
    key,
    256
  );
  return hex(bits);
}

// ---------------------------------------------------------------- two-factor authentication (TOTP, RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export async function totp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
/** Accepts the current 30-second code and its neighbours (clock drift). */
export async function verifyTotp(secret: string, code: string) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) if ((await totp(secret, now + d)) === c) return true;
  return false;
}
