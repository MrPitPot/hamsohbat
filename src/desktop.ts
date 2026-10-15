// Bridge to the Windows desktop app (WebView2). In a normal browser everything here is a no-op.
import { useStore, get, set } from './store';
import { voice } from './voice';

const wv = (window as any).chrome?.webview;
export const isDesktop = !!wv;
export const APP_VERSION: string = __APP_VERSION__;

export function sendNative(msg: any) {
  wv?.postMessage(msg);
}

export type UpdateState = {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';
  version?: string;
  notes?: { fa?: string; en?: string };
  progress?: number;
  error?: string;
  manual?: boolean;
};

export const checkForUpdates = () => sendNative({ type: 'checkUpdate' });
export const installUpdate = () => sendNative({ type: 'installUpdate' });
export const setDesktopOption = (key: 'autostart' | 'closeToTray', value: boolean) => {
  sendNative({ type: 'setOption', key, value });
  set((s: any) => ({ desktop: { ...s.desktop, [key]: value } }));
};
export const setServerUrl = (url: string) => sendNative({ type: 'setServer', url });

/** Tells the desktop app which key is push-to-talk, so it works while the window is in the background. */
function syncPtt() {
  const s = get();
  const inVoice = !!s.voice.channelId || !!(window as any).__tsConnected?.();
  sendNative({ type: 'ptt', code: s.settings.pttKey, enabled: s.settings.voiceMode === 'ptt' && inVoice });
}
(window as any).__syncPtt = syncPtt;

if (wv) {
  wv.addEventListener('message', (e: any) => {
    const m = e.data || {};
    if (m.type === 'info') set((s: any) => ({ desktop: { ...s.desktop, ...m } }));
    else if (m.type === 'update') set({ update: m });
    else if (m.type === 'proxy') (window as any).__proxyEvent?.(m);
    // Idle time of the whole computer and the game being played (see PresenceTick in app.cpp).
    else if (m.type === 'sysidle') (window as any).__sysIdle?.(Number(m.seconds) || 0);
    else if (m.type === 'game') (window as any).__game?.(m.name ? { name: m.name } : null);
  });
  sendNative({ type: 'hello', lang: get().settings.lang });
  const syncGames = () => sendNative({ type: 'games', list: (get().settings.customGames || []).map((g: any) => `${g.exe}=${g.name}`).join('|') });
  syncGames();
  syncPtt();
  useStore.subscribe((s: any, prev: any) => {
    if (s.settings.lang !== prev.settings.lang) sendNative({ type: 'lang', value: s.settings.lang });
    if (s.settings.customGames !== prev.settings.customGames) syncGames();
    if (s.settings.pttKey !== prev.settings.pttKey || s.settings.voiceMode !== prev.settings.voiceMode || s.voice.channelId !== prev.voice.channelId) syncPtt();
  });
  // Tray icon: a ring while in voice that fills up with your own voice level (like Discord).
  let lastTray = '';
  setInterval(() => {
    const st = get();
    let msg: any = { type: 'tray', state: 'off', level: 0 };
    const ts = (window as any).__tsTray?.();
    if (!st.voice.channelId && ts) msg = { type: 'tray', ...ts };
    else if (st.voice.channelId) {
      if (st.voice.deaf) msg.state = 'deafened';
      else if (st.voice.mute || st.voice.noMic) msg.state = 'muted';
      else {
        msg.state = 'voice';
        msg.level = voice.transmitting() ? Math.max(0, Math.min(5, Math.round((voice.level + 55) / 7))) : 0;
      }
    }
    const key = msg.state + msg.level;
    if (key !== lastTray) {
      lastTray = key;
      sendNative(msg);
    }
  }, 90);
}
(window as any).__openUpdates = () => set({ modal: { type: 'userSettings', tab: 'updates' } });
