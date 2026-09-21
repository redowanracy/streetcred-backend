import { Db, queryOne, queryRows } from '../../db/pool';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { changeWallet, grantItem, lockProfile } from '../wallet/player-state';

interface OfferRow {
  id: string;
  title: string;
  item_id: string;
  quantity: number;
  price_cash: number;
  price_gems: number;
  max_per_user: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  item_name: string;
  item_category: string;
  item_rarity: string;
  is_stackable: boolean;
  purchased: number;
}

const OFFER_SELECT = `
  SELECT so.*, ic.name AS item_name, ic.category AS item_category, ic.rarity AS item_rarity, ic.is_stackable,
         (SELECT count(*) FROM wallet_transactions wt
           WHERE wt.user_id = $1 AND wt.reason = 'shop_purchase' AND wt.ref_id = so.id)::int AS purchased
  FROM store_offers so JOIN item_catalog ic ON ic.id = so.item_id
  WHERE so.is_active AND ic.is_active
    AND (so.starts_at IS NULL OR so.starts_at <= now())
    AND (so.ends_at IS NULL OR so.ends_at > now())`;

const offerView = (o: OfferRow) => ({
  id: o.id,
  title: o.title,
  item: { id: o.item_id, name: o.item_name, category: o.item_category, rarity: o.item_rarity },
  quantity: o.quantity,
  priceCash: o.price_cash,
  priceGems: o.price_gems,
  maxPerUser: o.max_per_user,
  purchasedCount: o.purchased,
  endsAt: o.ends_at?.toISOString() ?? null,
});

export async function listOffers(db: Db, userId: string) {
  const rows = await queryRows<OfferRow>(db, `${OFFER_SELECT} ORDER BY so.sort_order, so.id`, [userId]);
  return rows.map(offerView);
}

export async function purchaseOffer(tx: Db, userId: string, offerId: string) {
  const profile = await lockProfile(tx, userId);
  const offer = await queryOne<OfferRow>(tx, `${OFFER_SELECT} AND so.id = $2`, [userId, offerId]);
  if (!offer) throw notFound(`Offer '${offerId}'`);
  if (offer.max_per_user !== null && offer.purchased >= offer.max_per_user) {
    throw forbidden('Purchase limit reached for this offer', 'PURCHASE_LIMIT_REACHED');
  }
  if (!offer.is_stackable && (await queryOne(tx, 'SELECT 1 FROM player_inventory WHERE user_id = $1 AND item_id = $2', [userId, offer.item_id]))) {
    throw conflict('ALREADY_OWNED', 'You already own this item');
  }
  await changeWallet(tx, profile, {
    cash: -offer.price_cash,
    gems: -offer.price_gems,
    reason: 'shop_purchase',
    refType: 'store_offer',
    refId: offer.id,
    metadata: { itemId: offer.item_id, quantity: offer.quantity },
  });
  // The ledger row doubles as the purchase record; log free offers too so limits apply.
  if (offer.price_cash === 0 && offer.price_gems === 0) {
    await tx.query(
      `INSERT INTO wallet_transactions (user_id, reason, cash_after, gems_after, ref_type, ref_id, metadata)
       VALUES ($1, 'shop_purchase', $2, $3, 'store_offer', $4, $5)`,
      [userId, profile.cash, profile.gems, offer.id, JSON.stringify({ itemId: offer.item_id, quantity: offer.quantity })],
    );
  }
  const granted = await grantItem(tx, userId, offer.item_id, offer.quantity);
  return { offerId: offer.id, itemId: offer.item_id, quantityGranted: granted };
}
