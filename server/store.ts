// Experimental store (فروشگاه): coins, cosmetics (name colours, avatar frames, profile effects), an upload boost and the
// "Hamsohbat Plus" subscription. Coins are fake for now: welcome gift, daily reward and test coin packs.
import { STORE_ITEMS, COIN_PACKS, SLOTS, DAILY_COINS, DAILY_EVERY, BASE_UPLOAD, BOOSTED_UPLOAD, itemById, priceFor } from '../shared/store';
import { REL } from '../shared/perms';
import { fail } from './util';

type Hub = any;

const DAY = 24 * 60 * 60 * 1000;

const parseEquipped = (u: any): Record<string, string> => {
  try {
    const e = JSON.parse(u.equipped || '{}');
    return e && typeof e === 'object' ? e : {};
  } catch {
    return {};
  }
};
export const plusActive = (u: any) => Number(u.plus_until || 0) > Date.now();

/** What other people see: the equipped cosmetics (plus-only ones only while Plus is active) and the Plus badge. */
export function cosmeticsOf(u: any) {
  const plus = plusActive(u);
  const eq = parseEquipped(u);
  const out: Record<string, any> = { plus };
  for (const slot of SLOTS) {
    const item = itemById(eq[slot]);
    if (item && item.kind === slot && (!item.plusOnly || plus)) out[slot] = item.id;
  }
  return out;
}

export function uploadLimit(hub: Hub, u: any) {
  if (plusActive(u) || hub.one("SELECT 1 FROM store_purchases WHERE user_id=? AND item_id='boost_upload'", u.id)) return BOOSTED_UPLOAD;
  return BASE_UPLOAD;
}

export function registerStoreRoutes(hub: Hub) {
  const on = hub.on.bind(hub);
  const reload = (id: string) => hub.one('SELECT * FROM users WHERE id=?', id);
  const log = (uid: string, amount: number, reason: string) =>
    hub.run('INSERT INTO coin_log(id, user_id, amount, reason, created_at) VALUES(?,?,?,?,?)', hub.id(), uid, amount, reason, Date.now());
  const owned = (uid: string): string[] => hub.all('SELECT item_id FROM store_purchases WHERE user_id=? ORDER BY created_at', uid).map((r: any) => r.item_id);

  const state = (uid: string) => {
    const u = reload(uid);
    return {
      coins: u.coins,
      owned: owned(uid),
      equipped: cosmeticsOf(u),
      plusUntil: Number(u.plus_until || 0),
      nextDailyAt: Number(u.daily_at || 0) + DAILY_EVERY,
      uploadLimit: uploadLimit(hub, u),
      log: hub.all('SELECT amount, reason, created_at FROM coin_log WHERE user_id=? ORDER BY created_at DESC LIMIT 15', uid).map((r: any) => ({ amount: r.amount, reason: r.reason, createdAt: r.created_at })),
    };
  };
  /** Tells everyone about the changed look (frames, colours) and returns the caller's new store state. */
  const changed = (uid: string, notify = [uid]) => {
    for (const id of new Set(notify)) hub.send(null, { op: 'USER_UPDATE', user: hub.pubUser(reload(id)) });
    return state(uid);
  };

  /** Spends coins and gives `item` to `target`. Returns the reason line for the log. */
  const grant = (buyer: any, target: any, itemId: string) => {
    const item = itemById(itemId);
    if (!item) fail('Not found', 404);
    const targetPlus = plusActive(target);
    if (item.plusOnly && !targetPlus) fail('This item is only for Hamsohbat Plus members');
    if (item.kind !== 'plus' && hub.one('SELECT 1 FROM store_purchases WHERE user_id=? AND item_id=?', target.id, item.id)) fail('Already owned');
    const price = priceFor(item, plusActive(buyer));
    if (buyer.coins < price) fail('Not enough coins');
    hub.run('UPDATE users SET coins=coins-? WHERE id=?', price, buyer.id);
    if (item.kind === 'plus') {
      const from = Math.max(Date.now(), Number(target.plus_until || 0));
      hub.run('UPDATE users SET plus_until=? WHERE id=?', from + (item.days || 30) * DAY, target.id);
    } else {
      hub.run('INSERT INTO store_purchases(user_id, item_id, created_at, gifted_by) VALUES(?,?,?,?)', target.id, item.id, Date.now(), buyer.id === target.id ? null : buyer.id);
    }
    return { item, price };
  };

  on('GET', '/api/store', ({ me }: any) => ({ ...state(me.id), items: STORE_ITEMS, packs: COIN_PACKS }));

  on('POST', '/api/store/daily', ({ me }: any) => {
    if (Date.now() < Number(me.daily_at || 0) + DAILY_EVERY) fail('Come back later for your next reward');
    hub.run('UPDATE users SET coins=coins+?, daily_at=? WHERE id=?', DAILY_COINS, Date.now(), me.id);
    log(me.id, DAILY_COINS, 'daily');
    return state(me.id);
  });

  // Test payment: no money moves. A real gateway would verify the payment here before adding coins.
  on('POST', '/api/store/packs/:id/buy', ({ me, p }: any) => {
    const pack = COIN_PACKS.find((x) => x.id === p.id);
    if (!pack) fail('Not found', 404);
    hub.run('UPDATE users SET coins=coins+? WHERE id=?', pack.coins, me.id);
    log(me.id, pack.coins, 'pack:' + pack.id);
    return state(me.id);
  });

  on('POST', '/api/store/items/:id/buy', ({ me, p }: any) => {
    const { item, price } = grant(me, me, p.id);
    log(me.id, -price, 'buy:' + item.id);
    // Wear a new cosmetic right away if that slot is empty.
    if ((SLOTS as string[]).includes(item.kind)) {
      const eq = parseEquipped(reload(me.id));
      if (!eq[item.kind]) hub.run('UPDATE users SET equipped=? WHERE id=?', JSON.stringify({ ...eq, [item.kind]: item.id }), me.id);
    }
    return changed(me.id);
  });

  on('POST', '/api/store/items/:id/gift', ({ me, p, body }: any) => {
    const to = String(body.userId || '');
    if (to === me.id) fail('Not found', 404);
    const target = hub.one('SELECT * FROM users WHERE id=? AND deleted=0', to);
    if (!target || !hub.one('SELECT 1 FROM relationships WHERE user_id=? AND target_id=? AND type=?', me.id, to, REL.FRIEND)) fail('You can only send gifts to friends', 403);
    const { item, price } = grant(me, target, p.id);
    log(me.id, -price, 'gift:' + item.id);
    return changed(me.id, [me.id, to]);
  });

  on('PUT', '/api/store/equip', ({ me, body }: any) => {
    const slot = String(body.kind || '');
    if (!(SLOTS as string[]).includes(slot)) fail('Not found', 404);
    const eq = parseEquipped(me);
    if (body.itemId) {
      const item = itemById(String(body.itemId));
      if (!item || item.kind !== slot || !owned(me.id).includes(item.id)) fail('Not found', 404);
      if (item.plusOnly && !plusActive(me)) fail('This item is only for Hamsohbat Plus members');
      eq[slot] = item.id;
    } else delete eq[slot];
    hub.run('UPDATE users SET equipped=? WHERE id=?', JSON.stringify(eq), me.id);
    return changed(me.id);
  });
}
