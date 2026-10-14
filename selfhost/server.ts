// Self-hosted server: runs the exact same Hub as Cloudflare, on Node 22.5+ with a local SQLite file.
// Usage: node server.mjs   (env: PORT, HOST, DATA_DIR, REGISTRATION_CODE, ICE_SERVERS, TURN_KEY_ID, TURN_KEY_API_TOKEN, TRUST_PROXY)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket as RawSocket } from 'ws';
import { Hub } from '../server/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(here, 'public'));

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'hamsohbat.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

/** Mimics the Durable Object SqlStorage API on top of node:sqlite. */
const sql = {
  exec(query: string, ...params: any[]) {
    const p = params.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    let rows: any[] = [];
    if (!p.length && query.trim().replace(/;\s*$/, '').includes(';')) db.exec(query);
    else rows = db.prepare(query).all(...p);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  },
};

/** Wraps a `ws` socket with the hibernatable-WebSocket methods the Hub expects. */
class Sock {
  tags: string[] = [];
  private att: any = null;
  constructor(public raw: RawSocket) {}
  serializeAttachment(v: any) {
    this.att = v == null ? null : JSON.parse(JSON.stringify(v));
  }
  deserializeAttachment() {
    return this.att;
  }
  send(data: string) {
    if (this.raw.readyState === RawSocket.OPEN) this.raw.send(data);
  }
  close(code?: number, reason?: string) {
    try {
      this.raw.close(code && code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000, reason);
    } catch {}
  }
}

const sockets = new Set<Sock>();
const ctx = {
  storage: { sql },
  acceptWebSocket(ws: Sock, tags: string[]) {
    ws.tags = tags;
    sockets.add(ws);
  },
  getWebSockets(tag?: string) {
    return [...sockets].filter((s) => !tag || s.tags.includes(tag));
  },
  setWebSocketAutoResponse() {},
};
const env = {
  REGISTRATION_CODE: process.env.REGISTRATION_CODE || '',
  ICE_SERVERS: process.env.ICE_SERVERS || '',
  TURN_KEY_ID: process.env.TURN_KEY_ID || '',
  TURN_KEY_API_TOKEN: process.env.TURN_KEY_API_TOKEN || '',
};
const hub: any = new Hub(ctx as any, env as any);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(pathname: string, res: http.ServerResponse) {
  let file = path.normalize(path.join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    // The Hub reads the caller's address from this header (login rate limits, the devices list). A client-sent value is
    // never used; X-Forwarded-For is only believed from a local reverse proxy (Caddy) or with TRUST_PROXY=1.
    const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const viaProxy = TRUST_PROXY || peer === '127.0.0.1' || peer === '::1';
    const forwarded = viaProxy ? String(req.headers['x-forwarded-for'] || '').split(',').pop()!.trim() : '';
    headers.set('cf-connecting-ip', forwarded || peer);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as any) : undefined,
      duplex: 'half',
    } as any);
    const response: Response = await hub.fetch(request);
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"Internal error"}');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (raw) => {
    const me = hub.auth(url.searchParams.get('token') || '');
    if (!me) return raw.close(4001, 'unauthorized');
    const sock = new Sock(raw);
    raw.on('message', (data, binary) => {
      if (binary) return;
      const text = data.toString();
      if (text === 'ping') return sock.send('pong');
      hub.webSocketMessage(sock, text);
    });
    raw.on('close', async (code) => {
      await hub.webSocketClose(sock, code);
      sockets.delete(sock);
    });
    raw.on('error', async () => {
      await hub.webSocketError(sock);
      sockets.delete(sock);
    });
    hub.attachSocket(sock, me);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Hamsohbat is running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
