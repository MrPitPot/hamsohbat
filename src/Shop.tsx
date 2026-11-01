// Experimental store (فروشگاه), like Discord's Shop + Nitro: name colours, avatar frames, profile effects, an upload
// boost and the "Hamsohbat Plus" subscription, bought with in-app coins. No real payment: coin packs are test-only.
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Coins, ShoppingBag, Gem, Gift, Sparkles, Upload, CalendarCheck, Check, History } from 'lucide-react';
import { useStore, get, set, navigate, openModal, toast, displayName, REL } from './store';
import { api } from './api';
import { t } from './i18n';
import { Avatar, NameColor, openMenu, fmtDate, num } from './ui';
import { STORE_ITEMS, COIN_PACKS, PLUS_DISCOUNT, DAILY_COINS, StoreItem, StoreKind, priceFor, itemById } from '../shared/store';

type Shop = {
  loaded: boolean;
  coins: number;
  owned: string[];
  equipped: Record<string, any>;
  plusUntil: number;
  nextDailyAt: number;
  uploadLimit: number;
  log: { amount: number; reason: string; createdAt: number }[];
};
const useShop = create<Shop>(() => ({ loaded: false, coins: 0, owned: [], equipped: {}, plusUntil: 0, nextDailyAt: 0, uploadLimit: 0, log: [] }));

const apply = (s: any) => {
  useShop.setState({ ...s, loaded: true });
  set({ me: { ...get().me, uploadLimit: s.uploadLimit } });
};
const call = async (method: string, path: string, body?: any) => {
  try {
    apply(await api(method, path, body));
    return true;
  } catch (e: any) {
    toast(t(e.message));
    return false;
  }
};
const load = () => call('GET', '/api/store');

const coinsText = (n: number) => t('{n} coins', { n: num(n) });

export function StoreRailItem() {
  const active = useStore((s: any) => s.route.serverId === '@shop');
  return (
    <div className={'rail-item shop' + (active ? ' active' : '')} title={t('Store')}>
      <span className="pill" />
      <button onClick={() => navigate('@shop')} aria-label={t('Store')}>
        <ShoppingBag size={24} />
      </button>
    </div>
  );
}

export function PlusBadge() {
  return (
    <span className="plus-badge" title={t('Hamsohbat Plus')}>
      <Gem size={12} /> {t('Plus')}
    </span>
  );
}

/** Animated layer over a profile card. */
export function ProfileEffect({ effectId }: { effectId?: string | null }) {
  const fx = itemById(effectId);
  if (!fx) return null;
  return (
    <div className={'profile-fx fx-' + fx.value} aria-hidden>
      {Array.from({ length: 14 }, (_, i) => (
        <i key={i} style={{ '--i': i, '--x': ((i * 37) % 100) + '%', '--d': 3 + ((i * 7) % 5) + 's', '--delay': -((i * 13) % 7) + 's' } as any} />
      ))}
    </div>
  );
}

const TABS: { id: string; label: string; kinds?: StoreKind[] }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'color', label: 'Name Colors', kinds: ['color'] },
  { id: 'frame', label: 'Avatar Frames', kinds: ['frame'] },
  { id: 'effect', label: 'Profile Effects', kinds: ['effect'] },
  { id: 'perks', label: 'Perks', kinds: ['boost'] },
  { id: 'coins', label: 'Get Coins' },
  { id: 'mine', label: 'My Items' },
];

export function StoreMain() {
  const shop = useShop();
  const me = useStore((s: any) => s.me);
  const [tab, setTab] = useState('featured');
  // Reload on every tab switch so gifts from friends show up.
  useEffect(() => {
    load();
  }, [tab]);
  const plus = shop.plusUntil > Date.now();
  const kinds = TABS.find((x) => x.id === tab)?.kinds;
  const items =
    tab === 'mine'
      ? STORE_ITEMS.filter((i) => shop.owned.includes(i.id))
      : tab === 'featured'
        ? STORE_ITEMS.filter((i) => ['color_sunset', 'frame_tile', 'effect_petals', 'color_saffron', 'frame_gold', 'effect_stars', 'boost_upload'].includes(i.id))
        : STORE_ITEMS.filter((i) => kinds?.includes(i.kind));
  return (
    <div className="main-col shop-page">
      <header className="main-head">
        <ShoppingBag size={22} />
        <b className="head-title">{t('Store')}</b>
        <span className="shop-tag">{t('Experimental')}</span>
        <div className="tabs">
          {TABS.map((x) => (
            <button key={x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)}>
              {t(x.label)}
            </button>
          ))}
        </div>
        <div className="coin-pill" title={t('Your coins')}>
          <Coins size={16} /> {num(shop.coins)}
        </div>
      </header>
      <div className="shop-body">
        {!shop.loaded ? (
          <div className="empty">
            <ShoppingBag size={48} />
          </div>
        ) : (
          <>
            {tab === 'featured' && (
              <>
                <PlusHero plus={plus} />
                <DailyReward />
              </>
            )}
            {tab === 'coins' ? (
              <CoinPacks />
            ) : (
              <>
                {tab !== 'featured' && tab !== 'mine' && plus && (
                  <p className="shop-note">
                    <Gem size={14} /> {t('Plus discount: {n}% off everything', { n: num(PLUS_DISCOUNT * 100) })}
                  </p>
                )}
                {tab === 'featured' && <h3 className="shop-h">{t('Picked for you')}</h3>}
                {tab === 'mine' && plus && <PlusHero plus={plus} />}
                {tab === 'mine' && (
                  <button className="btn primary shop-preview" onClick={() => openModal('profile', { userId: me.id })}>
                    {t('View my profile')}
                  </button>
                )}
                {items.length ? (
                  <div className="shop-grid">
                    {items.map((i) => (
                      <ItemCard key={i.id} item={i} meId={me.id} plus={plus} />
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <ShoppingBag size={48} />
                    <p>{t("You haven't bought anything yet.")}</p>
                  </div>
                )}
                {tab === 'mine' && <CoinLog />}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const confirmBuy = (item: StoreItem, plus: boolean, to?: string) => {
  const price = priceFor(item, plus);
  openModal('confirm', {
    title: to ? t('Send a gift') : t('Buy {name}', { name: t(item.name) }),
    text: to
      ? t('Send {item} to {name} for {price}?', { item: t(item.name), name: displayName(to), price: coinsText(price) })
      : t('Buy {item} for {price}?', { item: t(item.name), price: coinsText(price) }),
    action: to ? t('Send Gift') : t('Buy'),
    onConfirm: async () => {
      apply(await api('POST', `/api/store/items/${item.id}/${to ? 'gift' : 'buy'}`, to ? { userId: to } : undefined));
      toast(to ? t('Gift sent!') : t('Purchased!'), 'ok');
    },
  });
};

function giftMenu(e: React.MouseEvent, item: StoreItem, plus: boolean) {
  const rels = get().relationships;
  const friends = Object.keys(rels).filter((id) => rels[id] === REL.FRIEND);
  if (!friends.length) return toast(t('You can only send gifts to friends'));
  openMenu(
    e,
    friends.map((id) => ({ label: displayName(id), icon: <Avatar userId={id} size={20} />, onClick: () => confirmBuy(item, plus, id) })),
    true
  );
}

function PlusHero({ plus }: { plus: boolean }) {
  const shop = useShop();
  const item = itemById('plus_month')!;
  return (
    <section className="plus-hero" style={{ background: item.value }}>
      <div>
        <h2>
          <Gem size={22} /> {t('Hamsohbat Plus')}
        </h2>
        <ul>
          <li>{t('Plus badge on your profile')}</li>
          <li>{t('{n}% off everything in the store', { n: num(PLUS_DISCOUNT * 100) })}</li>
          <li>{t('Send files up to {n} MB', { n: num(50) })}</li>
          <li>{t('Exclusive colors, frames and effects')}</li>
        </ul>
      </div>
      <div className="plus-cta">
        {plus && <b>{t('Active until {date}', { date: fmtDate(shop.plusUntil) })}</b>}
        <button className="btn" onClick={() => confirmBuy(item, plus)}>
          {plus ? t('Add 30 days') : t('Subscribe')} · <Coins size={14} /> {num(item.price)}
        </button>
        <button className="btn link small" onClick={(e) => giftMenu(e, item, plus)}>
          <Gift size={14} /> {t('Gift to a friend')}
        </button>
      </div>
    </section>
  );
}

function DailyReward() {
  const next = useShop((s) => s.nextDailyAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);
  const left = next - Date.now();
  const hours = Math.ceil(left / 3600000);
  return (
    <section className="daily">
      <CalendarCheck size={28} />
      <div>
        <b>{t('Daily reward')}</b>
        <p className="muted">{t('Come back every day for {n} free coins.', { n: num(DAILY_COINS) })}</p>
      </div>
      <button className="btn green" disabled={left > 0} onClick={() => call('POST', '/api/store/daily').then((ok) => ok && toast(t('+{n} coins!', { n: num(DAILY_COINS) }), 'ok'))}>
        {left > 0 ? t('In {n} hours', { n: num(hours) }) : t('Claim')}
      </button>
    </section>
  );
}

function Preview({ item, meId }: { item: StoreItem; meId: string }) {
  const me = useStore((s: any) => s.users[meId] || s.me);
  if (item.kind === 'color')
    return (
      <div className="pv pv-name">
        <NameColor colorId={item.id}>{me.displayName || me.username}</NameColor>
      </div>
    );
  if (item.kind === 'frame')
    return (
      <div className="pv">
        <Avatar userId={meId} size={64} frameId={item.id} />
      </div>
    );
  if (item.kind === 'effect')
    return (
      <div className="pv pv-effect">
        <ProfileEffect effectId={item.id} />
        <Avatar userId={meId} size={48} frameId={null} />
      </div>
    );
  if (item.kind === 'plus')
    return (
      <div className="pv" style={{ background: item.value, color: '#fff' }}>
        <Gem size={40} />
      </div>
    );
  return (
    <div className="pv pv-boost">
      <Upload size={40} />
      <b>{t('{n} MB', { n: num(50) })}</b>
    </div>
  );
}

function ItemCard({ item, meId, plus }: { item: StoreItem; meId: string; plus: boolean }) {
  const shop = useShop();
  const owned = shop.owned.includes(item.id);
  const equipped = shop.equipped[item.kind] === item.id;
  const price = priceFor(item, plus);
  const locked = item.plusOnly && !plus;
  const slot = ['color', 'frame', 'effect'].includes(item.kind);
  return (
    <div className={'shop-card' + (equipped ? ' equipped' : '')}>
      <Preview item={item} meId={meId} />
      <div className="shop-info">
        <b>{t(item.name)}</b>
        <span className="shop-kind">
          {t(TABS.find((x) => x.kinds?.includes(item.kind))?.label || 'Plus')}
          {item.plusOnly && <PlusBadge />}
        </span>
        {owned ? (
          <div className="shop-actions">
            {slot ? (
              <button className={'btn small ' + (equipped ? '' : 'primary')} disabled={locked} onClick={() => call('PUT', '/api/store/equip', { kind: item.kind, itemId: equipped ? null : item.id })}>
                {equipped ? t('Unequip') : t('Equip')}
              </button>
            ) : (
              <span className="owned">
                <Check size={14} /> {t('Active')}
              </span>
            )}
            {!locked && (
              <button className="icon-btn" title={t('Gift to a friend')} onClick={(e) => giftMenu(e, item, plus)}>
                <Gift size={16} />
              </button>
            )}
          </div>
        ) : (
          <div className="shop-actions">
            <button className="btn small primary" disabled={locked || shop.coins < price} onClick={() => confirmBuy(item, plus)} title={locked ? t('This item is only for Hamsohbat Plus members') : ''}>
              <Coins size={14} /> {num(price)}
              {price !== item.price && <s>{num(item.price)}</s>}
            </button>
            {!locked && (
              <button className="icon-btn" title={t('Gift to a friend')} onClick={(e) => giftMenu(e, item, plus)}>
                <Gift size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CoinPacks() {
  return (
    <>
      <p className="shop-note warn">
        <Sparkles size={14} /> {t('Test mode: no real payment happens. In the real version this button opens the bank payment page.')}
      </p>
      <div className="shop-grid packs">
        {COIN_PACKS.map((p) => (
          <div key={p.id} className="shop-card pack">
            <div className="pv pv-coins">
              <Coins size={40} />
              <b>{num(p.coins)}</b>
            </div>
            <div className="shop-info">
              <b>{coinsText(p.coins)}</b>
              <span className="shop-kind">{t('{n} Toman', { n: num(p.toman) })}</span>
              <button className="btn small green" onClick={() => call('POST', `/api/store/packs/${p.id}/buy`).then((ok) => ok && toast(t('+{n} coins!', { n: num(p.coins) }), 'ok'))}>
                {t('Pay (test)')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CoinLog() {
  const log = useShop((s) => s.log);
  if (!log.length) return null;
  const label = (r: string) => {
    const [kind, id] = r.split(':');
    if (kind === 'daily') return t('Daily reward');
    if (kind === 'pack') return t('Coin pack (test)');
    const item = itemById(id);
    return (kind === 'gift' ? t('Gift: {item}', { item: t(item?.name || id) }) : t(item?.name || id)) as string;
  };
  return (
    <section className="coin-log">
      <h3 className="shop-h">
        <History size={16} /> {t('Coin history')}
      </h3>
      {log.map((l, i) => (
        <div key={i} className="coin-row">
          <span>{label(l.reason)}</span>
          <span className="muted">{fmtDate(l.createdAt)}</span>
          <b className={l.amount > 0 ? 'plus' : 'minus'} dir="ltr">
            {l.amount > 0 ? '+' : ''}
            {num(l.amount)}
          </b>
        </div>
      ))}
    </section>
  );
}
