// Experimental (Windows app only): opens Discord in its own window through a VPN subscription, like FlClash.
// The desktop shell runs hs-proxy.exe (Mihomo / Clash.Meta). This page writes its config from your subscription
// link and drives it over its local REST API (127.0.0.1 only). Only the Discord window uses the proxy.
import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Plus, Trash2, RefreshCw, Zap, Play, Square, ExternalLink, Gamepad2 } from 'lucide-react';
import { useStore, navigate } from './store';
import { t } from './i18n';
import { isDesktop, sendNative } from './desktop';

const MIXED_PORT = 17890;
const API_PORT = 17891;
const GROUP = 'PROXY';
const TEST_URL = 'https://www.gstatic.com/generate_204';

type Sub = { name: string; url: string };
type Node = { name: string; delay: number | null; testing?: boolean };

const read = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: any) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

const useDc = create<{ running: boolean; error: string }>(() => ({ running: false, error: '' }));
(window as any).__proxyEvent = (m: any) => {
  if (m.state === 'error') useDc.setState({ running: false, error: m.message || 'error' });
};

const secretOf = () => {
  let s = '';
  try {
    s = sessionStorage.getItem('hs-proxy-secret') || '';
    if (!s) {
      s = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('hs-proxy-secret', s);
    }
  } catch {
    s = 'hamsohbat';
  }
  return s;
};

/** Mihomo config for one subscription link: everything goes through the selectable PROXY group. */
function buildConfig(url: string, secret: string) {
  const q = (s: string) => JSON.stringify(s);
  return [
    `mixed-port: ${MIXED_PORT}`,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: rule',
    'log-level: warning',
    `external-controller: 127.0.0.1:${API_PORT}`,
    `secret: ${q(secret)}`,
    'external-controller-cors:',
    "  allow-origins: ['*']",
    '  allow-private-network: true',
    'proxy-providers:',
    '  sub:',
    '    type: http',
    `    url: ${q(url)}`,
    '    interval: 3600',
    '    path: ./sub.yaml',
    '    health-check:',
    '      enable: true',
    `      url: ${TEST_URL}`,
    '      interval: 600',
    'proxy-groups:',
    `  - name: ${GROUP}`,
    '    type: select',
    '    use: [sub]',
    'rules:',
    `  - MATCH,${GROUP}`,
    '',
  ].join('\n');
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    ...init,
    headers: { authorization: 'Bearer ' + secretOf(), 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.status === 204 ? null : r.json();
}

export function DcRailItem() {
  const active = useStore((s: any) => s.route.serverId === '@dc');
  if (!isDesktop) return null;
  return (
    <div className={'rail-item dc' + (active ? ' active' : '')} title="Discord">
      <span className="pill" />
      <button onClick={() => navigate('@dc')} aria-label="Discord">
        <Gamepad2 size={24} />
      </button>
    </div>
  );
}

export function DcMain() {
  const [subs, setSubs] = useState<Sub[]>(() => read<Sub[]>('hsSubs', []));
  const [active, setActive] = useState<number>(() => read<number>('hsSubActive', 0));
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [nodes, setNodes] = useState<Node[]>([]);
  const [now, setNow] = useState('');
  const [busy, setBusy] = useState(false);
  const { running, error } = useDc();
  const poll = useRef<any>(null);

  const save = (list: Sub[], idx = active) => {
    setSubs(list);
    setActive(idx);
    write('hsSubs', list);
    write('hsSubActive', idx);
  };
  const add = () => {
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    save([...subs, { name: name.trim() || new URL(u).hostname, url: u }], subs.length);
    setName('');
    setUrl('');
  };

  const refresh = async () => {
    try {
      const g = await api('/proxies/' + GROUP);
      setNow(g.now || '');
      setNodes((old) => (g.all || []).map((n: string) => old.find((o) => o.name === n) || { name: n, delay: null }));
      useDc.setState({ running: true, error: '' });
      return (g.all || []).length;
    } catch {
      return -1;
    }
  };

  const start = async () => {
    const s = subs[active];
    if (!s) return;
    setBusy(true);
    useDc.setState({ error: '' });
    sendNative({ type: 'proxy', cmd: 'start', yaml: buildConfig(s.url, secretOf()) });
    // The core needs a moment; then it downloads the subscription.
    let count = -1;
    for (let i = 0; i < 40 && count <= 0; i++) {
      await new Promise((r) => setTimeout(r, 750));
      count = await refresh();
    }
    if (count <= 0) useDc.setState({ running: count === 0, error: count < 0 ? t('The proxy core did not start.') : t('The subscription has no servers.') });
    setBusy(false);
  };
  const stop = () => {
    sendNative({ type: 'proxy', cmd: 'stop' });
    useDc.setState({ running: false });
    setNodes([]);
  };

  const test = async (n: string) => {
    setNodes((l) => l.map((x) => (x.name === n ? { ...x, testing: true } : x)));
    let d: number | null = null;
    try {
      const r = await api(`/proxies/${encodeURIComponent(n)}/delay?url=${encodeURIComponent(TEST_URL)}&timeout=6000`);
      d = r.delay ?? null;
    } catch {}
    setNodes((l) => l.map((x) => (x.name === n ? { name: n, delay: d } : x)));
    return d;
  };
  const testAll = async (pickBest = false) => {
    const names = nodes.map((n) => n.name);
    const results: Record<string, number | null> = {};
    let i = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (i < names.length) {
          const n = names[i++];
          results[n] = await test(n);
        }
      })
    );
    if (pickBest) {
      const best = Object.entries(results).filter(([, d]) => d && d > 0).sort((a, b) => a[1]! - b[1]!)[0];
      if (best) await choose(best[0]);
      else useDc.setState({ error: t('No server answered. Check the subscription.') });
    }
  };
  const choose = async (n: string) => {
    try {
      await api('/proxies/' + GROUP, { method: 'PUT', body: JSON.stringify({ name: n }) });
      setNow(n);
    } catch {}
  };

  useEffect(() => {
    refresh();
    poll.current = setInterval(() => running && refresh(), 15000);
    return () => clearInterval(poll.current);
  }, []);

  if (!isDesktop)
    return (
      <div className="main-col">
        <div className="empty">
          <p>{t('Discord through a proxy is available in the Hamsohbat Windows app.')}</p>
        </div>
      </div>
    );

  return (
    <div className="main-col dc-main">
      <div className="ts-form">
        <h2>{t('Discord (experimental)')}</h2>
        <p className="muted">{t('Add your VPN subscription link, pick a fast server, then open Discord in its own window through it. Only that window uses the VPN.')}</p>
        <p className="muted warn">{t('Logging in to Discord with a personal account inside a third-party app is outside Discord’s terms. Use it at your own risk, preferably with a spare account.')}</p>

        <h3>{t('Subscriptions')}</h3>
        {subs.map((s, i) => (
          <div key={i} className={'ts-bookmark' + (i === active ? ' selected' : '')} onClick={() => save(subs, i)}>
            <span>{s.name}</span>
            <small dir="ltr">{s.url.replace(/(https?:\/\/[^/]+\/).*/, '$1…')}</small>
            <button className="icon-btn" title={t('Remove')} onClick={(e) => (e.stopPropagation(), save(subs.filter((_, j) => j !== i), 0))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="dc-add">
          <input placeholder={t('Name')} value={name} onChange={(e) => setName(e.target.value)} />
          <input dir="ltr" placeholder="https://panel.example.com/sub/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" onClick={add} disabled={!/^https?:\/\//i.test(url.trim())}>
            <Plus size={14} /> {t('Add')}
          </button>
        </div>

        <div className="dc-actions">
          {!running ? (
            <button className="btn primary" onClick={start} disabled={busy || !subs[active]}>
              <Play size={14} /> {busy ? t('Connecting…') : t('Start proxy')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={stop}>
                <Square size={14} /> {t('Stop proxy')}
              </button>
              <button className="btn" onClick={() => testAll(false)}>
                <RefreshCw size={14} /> {t('Test all')}
              </button>
              <button className="btn" onClick={() => testAll(true)}>
                <Zap size={14} /> {t('Pick the fastest')}
              </button>
            </>
          )}
          <button className="btn primary" disabled={!running} onClick={() => sendNative({ type: 'discord', cmd: 'open', port: MIXED_PORT })}>
            <ExternalLink size={14} /> {t('Open Discord')}
          </button>
        </div>
        {error && <p className="error">{error}</p>}

        {running && (
          <div className="dc-nodes">
            {nodes.map((n) => (
              <div key={n.name} className={'ts-bookmark' + (n.name === now ? ' selected' : '')} onClick={() => choose(n.name)}>
                <span dir="auto">{n.name}</span>
                <small dir="ltr">{n.testing ? '…' : n.delay ? n.delay + ' ms' : n.delay === 0 ? t('Timeout') : ''}</small>
                <button className="icon-btn" title={t('Test')} onClick={(e) => (e.stopPropagation(), test(n.name))}>
                  <RefreshCw size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
