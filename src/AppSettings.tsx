// Desktop-app settings, the updater UI and the "get the app" panel for browser users.
import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, Monitor, CheckCircle2, AlertTriangle, Smartphone } from 'lucide-react';
import { useStore, set } from './store';
import { t, lang } from './i18n';
import { Field, Toggle, num } from './ui';
import { isDesktop, APP_VERSION, checkForUpdates, installUpdate, setDesktopOption, setServerUrl } from './desktop';

export function WindowsSettings() {
  const d = useStore((s: any) => s.desktop) || {};
  const [server, setServer] = useState(d.server || location.origin);
  const valid = /^https?:\/\/[^\s/]+/.test(server.trim());
  return (
    <>
      <h2>{t('Windows Settings')}</h2>
      <div className="setting-row">
        <div>
          <b>{t('Open Hamsohbat when Windows starts')}</b>
          <small>{t('It starts minimized in the system tray.')}</small>
        </div>
        <Toggle checked={!!d.autostart} onChange={(v) => setDesktopOption('autostart', v)} />
      </div>
      <div className="setting-row">
        <div>
          <b>{t('Minimize to tray when closing')}</b>
          <small>{t('Closing the window keeps you online and reachable for calls.')}</small>
        </div>
        <Toggle checked={d.closeToTray !== false} onChange={(v) => setDesktopOption('closeToTray', v)} />
      </div>
      <h3>{t('Server Address')}</h3>
      <p className="muted" style={{ marginBottom: 8 }}>
        {t('Change this only if your group moved Hamsohbat to another server.')}
      </p>
      <div className="copy-row">
        <input dir="ltr" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://chat.example.ir" />
        <button className="btn primary" disabled={!valid || server.trim().replace(/\/+$/, '') === (d.server || '').replace(/\/+$/, '')} onClick={() => setServerUrl(server.trim())}>
          {t('Connect')}
        </button>
      </div>
    </>
  );
}

function ReleaseNotes({ notes }: { notes?: { fa?: string; en?: string } }) {
  const text = notes?.[lang() as 'fa' | 'en'] || notes?.en || notes?.fa;
  if (!text) return null;
  return (
    <div className="release-notes" dir="auto">
      {text}
    </div>
  );
}

export function UpdatesPanel() {
  const update = useStore((s: any) => s.update);
  const desktop = useStore((s: any) => s.desktop);
  const [latest, setLatest] = useState<any>(null);
  useEffect(() => {
    if (!isDesktop)
      fetch('/downloads/latest.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then(setLatest)
        .catch(() => {});
  }, []);
  if (!isDesktop)
    return (
      <>
        <h2>{t('Get the App')}</h2>
        <div className="get-app">
          <Monitor size={48} />
          <div>
            <b>{t('Hamsohbat for Windows')}</b>
            <small>
              {t('Faster, works in the background, global push-to-talk and shortcuts, and automatic updates.')}
              {latest && ` • v${latest.version} • ${num(Math.round(latest.size / 1024))} KB`}
            </small>
          </div>
          <a className="btn primary" href="/downloads/Hamsohbat-Setup.msi" download>
            <Download size={18} /> {t('Download')}
          </a>
        </div>
        <div className="get-app">
          <Smartphone size={48} />
          <div>
            <b>{t('On your phone')}</b>
            <small>{t('Open this site in Chrome or Safari and choose "Add to Home Screen" / "Install app".')}</small>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 16 }}>
          {t('Web version')} {APP_VERSION}
        </p>
      </>
    );
  const st = update?.state || 'idle';
  const busy = st === 'checking' || st === 'downloading' || st === 'installing';
  return (
    <>
      <h2>{t('Updates')}</h2>
      <div className="update-card">
        {st === 'available' || st === 'downloading' || st === 'installing' ? <Download size={36} className="green" /> : st === 'error' ? <AlertTriangle size={36} className="yellow" /> : <CheckCircle2 size={36} className="green" />}
        <div className="grow">
          <b>
            {st === 'checking'
              ? t('Checking for updates…')
              : st === 'available'
              ? t('Version {v} is available', { v: update.version })
              : st === 'downloading'
              ? t('Downloading update… {p}%', { p: num(Math.round((update.progress || 0) * 100)) })
              : st === 'installing'
              ? t('Installing update… the app will restart.')
              : st === 'error'
              ? t('Could not check for updates')
              : st === 'none'
              ? t("You're on the latest version")
              : t('Hamsohbat for Windows')}
          </b>
          <small>
            {t('Installed version')}: {desktop?.version || '?'} • {t('Web version')}: {APP_VERSION}
          </small>
          {st === 'error' && update.error && <small className="red">{update.error}</small>}
          {st === 'downloading' && (
            <div className="pf-progress" style={{ marginTop: 8 }}>
              <div style={{ width: (update.progress || 0) * 100 + '%' }} />
            </div>
          )}
        </div>
        {st === 'available' ? (
          <button className="btn green" onClick={installUpdate}>
            <Download size={18} /> {t('Update Now')}
          </button>
        ) : (
          <button className="btn primary" disabled={busy} onClick={checkForUpdates}>
            <RefreshCw size={18} className={st === 'checking' ? 'spin' : ''} /> {t('Check for Updates')}
          </button>
        )}
      </div>
      {(st === 'available' || st === 'downloading') && <ReleaseNotes notes={update.notes} />}
    </>
  );
}

/** Discord-style strip at the top of the window when the desktop app can be updated. */
export function UpdateBanner() {
  const update = useStore((s: any) => s.update);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!isDesktop || !update) return null;
  const st = update.state;
  if (!['available', 'downloading', 'installing'].includes(st) || hidden === update.version) return null;
  return (
    <div className="update-banner">
      <span>
        {st === 'available'
          ? t('A new version of Hamsohbat ({v}) is ready.', { v: update.version })
          : st === 'downloading'
          ? t('Downloading update… {p}%', { p: num(Math.round((update.progress || 0) * 100)) })
          : t('Installing update… the app will restart.')}
      </span>
      {st === 'available' && (
        <>
          <button className="btn small" onClick={installUpdate}>
            {t('Update Now')}
          </button>
          <button className="btn link small" onClick={() => setHidden(update.version)}>
            {t('Later')}
          </button>
          <button className="btn link small" onClick={() => set({ modal: { type: 'userSettings', tab: 'updates' } })}>
            {t("What's new?")}
          </button>
        </>
      )}
    </div>
  );
}
