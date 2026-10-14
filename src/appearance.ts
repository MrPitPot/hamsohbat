// Discord-style appearance: base themes, gradient color themes and display options.

export const BASE_THEMES = [
  { id: 'light', name: 'Light', swatch: '#ffffff' },
  { id: 'ash', name: 'Ash', swatch: '#36393f' },
  { id: 'dark', name: 'Dark', swatch: '#313338' },
  { id: 'onyx', name: 'Onyx', swatch: '#0a0a0c' },
  { id: 'system', name: 'Sync with computer', swatch: 'linear-gradient(135deg,#fff 50%,#313338 50%)' },
];

export const COLOR_THEMES: { id: string; name: string; base: 'light' | 'dark'; bg: string }[] = [
  { id: 'mint-apple', name: 'Mint Apple', base: 'light', bg: 'linear-gradient(180deg,#56b69f 6%,#63bc61 46%,#9eca67 94%)' },
  { id: 'citrus-sherbert', name: 'Citrus Sherbert', base: 'light', bg: 'linear-gradient(180deg,#f3b336 31%,#ee8558 67%)' },
  { id: 'retro-raincloud', name: 'Retro Raincloud', base: 'light', bg: 'linear-gradient(148deg,#3a7ca1 5%,#7f7eb9 79%)' },
  { id: 'hanami', name: 'Hanami', base: 'light', bg: 'linear-gradient(38deg,#efaab3 4%,#efd696 44%,#a6daa2 77%)' },
  { id: 'sunrise', name: 'Sunrise', base: 'light', bg: 'linear-gradient(155deg,#9f4175 10%,#c49064 48%,#a6953d 64%)' },
  { id: 'cotton-candy', name: 'Cotton Candy', base: 'light', bg: 'linear-gradient(180deg,#f4abb8 6%,#b1c2fc 76%)' },
  { id: 'lofi-vibes', name: 'Lofi Vibes', base: 'light', bg: 'linear-gradient(180deg,#a4c0f7 6%,#a9e4e8 30%,#b0e2b8 49%,#cfdfa2 85%)' },
  { id: 'desert-khaki', name: 'Desert Khaki', base: 'light', bg: 'linear-gradient(180deg,#e7dbd0 12%,#dfd0b2 39%,#e0d6a3 56%)' },
  { id: 'sunset', name: 'Sunset', base: 'dark', bg: 'linear-gradient(141deg,#48288c 27%,#db7f4b 71%)' },
  { id: 'chroma-glow', name: 'Chroma Glow', base: 'dark', bg: 'linear-gradient(128deg,#0eb5bf 3%,#4c0ce0 33%,#a308a7 66%,#9a053e 100%)' },
  { id: 'forest', name: 'Forest', base: 'dark', bg: 'linear-gradient(162deg,#142215 11%,#2d4d39 36%,#454c32 61%,#5a7c58 81%,#a98e4b 99%)' },
  { id: 'crimson-moon', name: 'Crimson Moon', base: 'dark', bg: 'linear-gradient(64deg,#950909 16%,#000000 72%)' },
  { id: 'midnight-blurple', name: 'Midnight Blurple', base: 'dark', bg: 'linear-gradient(48deg,#5348ca 12%,#140730 70%)' },
  { id: 'mars', name: 'Mars', base: 'dark', bg: 'linear-gradient(170deg,#895240 14%,#8f4343 74%)' },
  { id: 'dusk', name: 'Dusk', base: 'dark', bg: 'linear-gradient(180deg,#665069 12%,#91a3d1 85%)' },
  { id: 'under-the-sea', name: 'Under the Sea', base: 'dark', bg: 'linear-gradient(180deg,#647962 1%,#588575 48%,#6a8482 82%)' },
  { id: 'retro-storm', name: 'Retro Storm', base: 'dark', bg: 'linear-gradient(148deg,#3a7ca1 6%,#58579a 75%)' },
  { id: 'neon-nights', name: 'Neon Nights', base: 'dark', bg: 'linear-gradient(180deg,#01a89e 0%,#7d60ba 50%,#b43898 100%)' },
  { id: 'strawberry-lemonade', name: 'Strawberry Lemonade', base: 'dark', bg: 'linear-gradient(161deg,#af1a6c 18%,#c26b20 49%,#e7a525 80%)' },
  { id: 'aurora', name: 'Aurora', base: 'dark', bg: 'linear-gradient(239deg,#062053 9%,#191fbb 28%,#13b6ec 43%,#109f81 66%,#026273 86%)' },
  { id: 'sepia', name: 'Sepia', base: 'dark', bg: 'linear-gradient(69deg,#857664 15%,#5b4421 85%)' },
];

export const ACCENTS = ['#5865f2', '#3ba55d', '#eb459e', '#ed4245', '#faa61a', '#00a8fc', '#9b59b6', '#1abc9c', '#e67e22', '#ff73fa'];

export const appearanceDefaults = {
  theme: 'dark',
  colorTheme: '',
  customGradient: { a: '#5865f2', b: '#eb459e', angle: 135, base: 'dark' as 'light' | 'dark' },
  accent: '',
  messageDisplay: 'cozy' as 'cozy' | 'compact',
  fontSize: 16,
  groupSpacing: 16,
  zoom: 100,
  saturation: 100,
  reducedMotion: 'system' as 'system' | 'on' | 'off',
  clock24: false,
  roleColors: true,
};

const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
let current: any = null;

/** Applies the appearance settings to the page (CSS variables and data attributes). */
export function applyAppearance(s: any) {
  current = s;
  const root = document.documentElement;
  const st = root.style;
  let base = s.theme === 'system' ? (mq?.matches ? 'dark' : 'light') : s.theme;
  let gradient = '';
  if (s.colorTheme === 'custom') {
    const g = s.customGradient || appearanceDefaults.customGradient;
    gradient = `linear-gradient(${g.angle}deg, ${g.a}, ${g.b})`;
    base = g.base;
  } else if (s.colorTheme) {
    const ct = COLOR_THEMES.find((c) => c.id === s.colorTheme);
    if (ct) {
      gradient = ct.bg;
      base = ct.base;
    }
  }
  root.dataset.theme = base;
  if (gradient) {
    root.dataset.gradient = base;
    st.setProperty('--app-gradient', gradient);
  } else {
    delete root.dataset.gradient;
    st.removeProperty('--app-gradient');
  }
  if (s.accent) {
    st.setProperty('--brand', s.accent);
    st.setProperty('--brand-hover', `color-mix(in srgb, ${s.accent} 82%, black)`);
  } else {
    st.removeProperty('--brand');
    st.removeProperty('--brand-hover');
  }
  st.setProperty('--chat-font', (s.fontSize || 16) + 'px');
  st.setProperty('--group-gap', (s.groupSpacing ?? 16) + 'px');
  st.setProperty('--saturation', String((s.saturation ?? 100) / 100));
  st.zoom = s.zoom && s.zoom !== 100 ? String(s.zoom / 100) : '';
  root.dataset.display = s.messageDisplay || 'cozy';
  const reduce = s.reducedMotion === 'on' || (s.reducedMotion !== 'off' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  root.dataset.motion = reduce ? 'reduce' : 'full';
  root.dataset.roleColors = s.roleColors === false ? 'off' : 'on';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', base === 'light' ? '#e3e5e8' : base === 'onyx' ? '#000000' : '#1e1f22');
}
mq?.addEventListener?.('change', () => current && current.theme === 'system' && applyAppearance(current));
