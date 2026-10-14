// Settings > Appearance, modelled on Discord's.
import React from 'react';
import { useStore, updateSettings } from './store';
import { t } from './i18n';
import { Avatar, Field, Toggle, num } from './ui';
import { BASE_THEMES, COLOR_THEMES, ACCENTS, appearanceDefaults } from './appearance';

function Swatch({ active, bg, label, onClick }: { active: boolean; bg: string; label: string; onClick: () => void }) {
  return (
    <div className="theme-item">
      <button className={'theme-swatch' + (active ? ' active' : '')} style={{ background: bg }} onClick={onClick} aria-label={label} title={label} />
      <div className="theme-label">{label}</div>
    </div>
  );
}

function Range({ value, min, max, step = 1, unit, onChange }: { value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="range-row">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span>
        {num(value)}
        {unit}
      </span>
    </div>
  );
}

export function AppearanceSettings() {
  const s = useStore((st: any) => st.settings);
  const me = useStore((st: any) => st.me);
  const g = s.customGradient || appearanceDefaults.customGradient;
  return (
    <>
      <h2>{t('Appearance')}</h2>
      <div className="preview-msg">
        <div className="msg" style={{ margin: 0 }}>
          <div className="msg-row">
            <div className="msg-gutter">
              <Avatar userId={me.id} size={40} />
              <time>12:30</time>
            </div>
            <div className="msg-body">
              <div className="msg-head">
                <b>{me.displayName}</b>
                <time>{t('Today at {time}', { time: '12:30' })}</time>
              </div>
              <div className="msg-content">{t('This is how your messages will look. Pick a theme you like!')}</div>
            </div>
          </div>
        </div>
      </div>

      <h3>{t('Theme')}</h3>
      <div className="theme-row">
        {BASE_THEMES.map((th) => (
          <Swatch key={th.id} active={!s.colorTheme && s.theme === th.id} bg={th.swatch} label={t(th.name)} onClick={() => updateSettings({ theme: th.id, colorTheme: '' })} />
        ))}
      </div>

      <h3>{t('Color Themes')}</h3>
      <div className="theme-row">
        {COLOR_THEMES.map((th) => (
          <Swatch key={th.id} active={s.colorTheme === th.id} bg={th.bg} label={t(th.name)} onClick={() => updateSettings({ colorTheme: th.id })} />
        ))}
        <Swatch active={s.colorTheme === 'custom'} bg={`linear-gradient(${g.angle}deg, ${g.a}, ${g.b})`} label={t('Custom')} onClick={() => updateSettings({ colorTheme: 'custom' })} />
      </div>
      {s.colorTheme === 'custom' && (
        <div className="field">
          <span className="field-label">{t('Create your own')}</span>
          <div className="color-row">
            <input type="color" value={g.a} onChange={(e) => updateSettings({ customGradient: { ...g, a: e.target.value } })} />
            <input type="color" value={g.b} onChange={(e) => updateSettings({ customGradient: { ...g, b: e.target.value } })} />
            <div className="seg">
              {(['dark', 'light'] as const).map((b) => (
                <button key={b} className={g.base === b ? 'active' : ''} onClick={() => updateSettings({ customGradient: { ...g, base: b } })}>
                  {t(b === 'dark' ? 'Dark' : 'Light')}
                </button>
              ))}
            </div>
          </div>
          <Range value={g.angle} min={0} max={360} unit="°" onChange={(angle) => updateSettings({ customGradient: { ...g, angle } })} />
        </div>
      )}

      <h3>{t('Accent Color')}</h3>
      <div className="color-row" style={{ marginBottom: 18 }}>
        <button className={'swatch' + (!s.accent ? ' active-sw' : '')} style={{ background: '#5865f2', outline: !s.accent ? '2px solid var(--text-strong)' : 'none' }} onClick={() => updateSettings({ accent: '' })} title={t('Default')} />
        {ACCENTS.slice(1).map((c) => (
          <button key={c} className="swatch" style={{ background: c, outline: s.accent === c ? '2px solid var(--text-strong)' : 'none' }} onClick={() => updateSettings({ accent: c })} aria-label={c} />
        ))}
        <input type="color" value={s.accent || '#5865f2'} onChange={(e) => updateSettings({ accent: e.target.value })} title={t('Custom')} />
      </div>

      <h3>{t('Message Display')}</h3>
      <div className="seg" style={{ marginBottom: 18 }}>
        {(['cozy', 'compact'] as const).map((k) => (
          <button key={k} className={s.messageDisplay === k ? 'active' : ''} onClick={() => updateSettings({ messageDisplay: k })}>
            {t(k === 'cozy' ? 'Cozy' : 'Compact')}
          </button>
        ))}
      </div>

      <Field label={t('Chat Font Scaling')}>
        <Range value={s.fontSize} min={12} max={24} unit="px" onChange={(fontSize) => updateSettings({ fontSize })} />
      </Field>
      <Field label={t('Space Between Message Groups')}>
        <Range value={s.groupSpacing} min={0} max={24} step={4} unit="px" onChange={(groupSpacing) => updateSettings({ groupSpacing })} />
      </Field>
      <Field label={t('Zoom Level')}>
        <Range value={s.zoom} min={50} max={200} step={10} unit="%" onChange={(zoom) => updateSettings({ zoom })} />
      </Field>
      <Field label={t('Saturation')}>
        <Range value={s.saturation} min={0} max={100} step={5} unit="%" onChange={(saturation) => updateSettings({ saturation })} />
      </Field>

      <h3>{t('Accessibility')}</h3>
      <div className="setting-row">
        <div>
          <b>{t('Reduced Motion')}</b>
          <small>{t('Turns off animations. "Sync with computer" follows your Windows setting.')}</small>
        </div>
        <div className="seg">
          {(['system', 'on', 'off'] as const).map((k) => (
            <button key={k} className={s.reducedMotion === k ? 'active' : ''} onClick={() => updateSettings({ reducedMotion: k })}>
              {t(k === 'system' ? 'Sync with computer' : k === 'on' ? 'On' : 'Off')}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <b>{t('24-Hour Time')}</b>
        </div>
        <Toggle checked={!!s.clock24} onChange={(clock24) => updateSettings({ clock24 })} />
      </div>
      <div className="setting-row">
        <div>
          <b>{t('Show Role Colors in Names')}</b>
        </div>
        <Toggle checked={s.roleColors !== false} onChange={(roleColors) => updateSettings({ roleColors })} />
      </div>

      <h3>{t('Language')}</h3>
      <div className="seg">
        {[
          ['fa', 'فارسی'],
          ['en', 'English'],
        ].map(([k, label]) => (
          <button key={k} className={s.lang === k ? 'active' : ''} onClick={() => updateSettings({ lang: k })}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
