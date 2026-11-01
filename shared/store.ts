// Experimental store: cosmetics and perks bought with in-app coins (سکه). No real payment yet: coins come from a
// welcome gift, a daily reward and "test" coin packs. A real gateway (e.g. Zarinpal) would only replace the coin packs.
// Shared by the server (prices, rules) and the client (names, previews).

export type StoreKind = 'color' | 'frame' | 'effect' | 'boost' | 'plus';
export type StoreItem = {
  id: string;
  kind: StoreKind;
  /** English name; the Persian one is in src/fa.ts. */
  name: string;
  price: number;
  /** CSS colour / gradient used by the preview and by the cosmetic itself. */
  value: string;
  /** Only Hamsohbat Plus members can buy it. */
  plusOnly?: boolean;
  /** For timed items (the subscription): how many days one purchase adds. */
  days?: number;
};

export const WELCOME_COINS = 1000;
export const DAILY_COINS = 100;
export const DAILY_EVERY = 20 * 60 * 60 * 1000;
/** Plus members get this much off every cosmetic. */
export const PLUS_DISCOUNT = 0.2;
export const BASE_UPLOAD = 25 * 1024 * 1024;
export const BOOSTED_UPLOAD = 50 * 1024 * 1024;

export const STORE_ITEMS: StoreItem[] = [
  { id: 'plus_month', kind: 'plus', name: 'Hamsohbat Plus (30 days)', price: 1500, value: 'linear-gradient(135deg,#7c5cff,#ff5ca8)', days: 30 },

  { id: 'color_saffron', kind: 'color', name: 'Saffron', price: 300, value: '#f4a300' },
  { id: 'color_turquoise', kind: 'color', name: 'Turquoise', price: 300, value: '#1ec8c8' },
  { id: 'color_pomegranate', kind: 'color', name: 'Pomegranate', price: 300, value: '#e8364f' },
  { id: 'color_persian_blue', kind: 'color', name: 'Persian Blue', price: 400, value: 'linear-gradient(90deg,#1c39bb,#5c8dff)' },
  { id: 'color_sunset', kind: 'color', name: 'Caspian Sunset', price: 600, value: 'linear-gradient(90deg,#ff7a18,#ff3d77,#a93cff)' },
  { id: 'color_aurora', kind: 'color', name: 'Aurora', price: 800, value: 'linear-gradient(90deg,#00f5a0,#00d9f5,#a45cff)', plusOnly: true },

  { id: 'frame_gold', kind: 'frame', name: 'Golden Ring', price: 500, value: 'conic-gradient(#f9d976,#b8860b,#f9d976,#b8860b,#f9d976)' },
  { id: 'frame_tile', kind: 'frame', name: 'Isfahan Tile', price: 700, value: 'conic-gradient(#0f6a8b,#2ec4d6,#f2e2b1,#0f6a8b,#2ec4d6,#f2e2b1,#0f6a8b)' },
  { id: 'frame_neon', kind: 'frame', name: 'Neon', price: 600, value: 'conic-gradient(#ff00c8,#00e5ff,#ff00c8)' },
  { id: 'frame_rainbow', kind: 'frame', name: 'Rainbow', price: 900, value: 'conic-gradient(#ff4d4d,#ffb84d,#fff04d,#4dff88,#4dc3ff,#b84dff,#ff4d4d)', plusOnly: true },

  { id: 'effect_stars', kind: 'effect', name: 'Starry Night', price: 800, value: 'stars' },
  { id: 'effect_snow', kind: 'effect', name: 'Snowfall', price: 800, value: 'snow' },
  { id: 'effect_petals', kind: 'effect', name: 'Rose Petals', price: 1000, value: 'petals' },
  { id: 'effect_flames', kind: 'effect', name: 'Flames', price: 1200, value: 'flames', plusOnly: true },

  { id: 'boost_upload', kind: 'boost', name: 'Upload Boost (50 MB files)', price: 1200, value: '#3ba55d' },
];

/** Test coin packs: in the prototype "paying" just adds the coins. Prices are what a real gateway would charge. */
export const COIN_PACKS = [
  { id: 'pack_s', coins: 500, toman: 50_000 },
  { id: 'pack_m', coins: 1200, toman: 100_000 },
  { id: 'pack_l', coins: 3000, toman: 220_000 },
];

export const itemById = (id: string | null | undefined) => STORE_ITEMS.find((i) => i.id === id) || null;
/** Equippable slots (one item each). */
export const SLOTS: StoreKind[] = ['color', 'frame', 'effect'];
export const priceFor = (item: StoreItem, plus: boolean) => (plus && item.kind !== 'plus' ? Math.round(item.price * (1 - PLUS_DISCOUNT)) : item.price);
