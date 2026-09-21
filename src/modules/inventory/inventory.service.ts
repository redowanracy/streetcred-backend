import { Db, queryOne, queryRows } from '../../db/pool';
import { AppError, conflict } from '../../lib/errors';
import { changeWallet, lockProfile } from '../wallet/player-state';

interface ItemCatalogRow {
  id: string;
  name: string;
  description: string;
  category: 'Weapon' | 'Outfit' | 'VehiclePart' | 'Consumable';
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  sell_value_cash: number;
  is_stackable: boolean;
}

interface InventoryRow extends ItemCatalogRow {
  item_id: string;
  quantity: number;
  acquired_at: Date;
}

export const catalogItemView = (i: ItemCatalogRow) => ({
  id: i.id,
  name: i.name,
  description: i.description,
  category: i.category,
  rarity: i.rarity,
  sellValueCash: i.sell_value_cash,
  isStackable: i.is_stackable,
});

const inventoryView = (row: InventoryRow, equippedOutfitId: string | null) => ({
  itemId: row.item_id,
  name: row.name,
  category: row.category,
  rarity: row.rarity,
  quantity: row.quantity,
  sellValueCash: row.sell_value_cash,
  isEquipped: row.category === 'Outfit' && row.item_id === equippedOutfitId,
  acquiredAt: row.acquired_at.toISOString(),
});

const INVENTORY_SELECT = `SELECT ic.*, pi.item_id, pi.quantity, pi.acquired_at
  FROM player_inventory pi JOIN item_catalog ic ON ic.id = pi.item_id`;

export async function listItemCatalog(db: Db) {
  const rows = await queryRows<ItemCatalogRow>(db, 'SELECT * FROM item_catalog WHERE is_active ORDER BY category, id');
  return rows.map(catalogItemView);
}

export async function listInventory(db: Db, userId: string) {
  const profile = await queryOne<{ equipped_outfit_id: string | null }>(db, 'SELECT equipped_outfit_id FROM player_profiles WHERE user_id = $1', [userId]);
  const rows = await queryRows<InventoryRow>(db, `${INVENTORY_SELECT} WHERE pi.user_id = $1 ORDER BY ic.category, pi.item_id`, [userId]);
  return rows.map((r) => inventoryView(r, profile?.equipped_outfit_id ?? null));
}

async function ownedItem(db: Db, userId: string, itemId: string) {
  const row = await queryOne<InventoryRow>(db, `${INVENTORY_SELECT} WHERE pi.user_id = $1 AND pi.item_id = $2 FOR UPDATE OF pi`, [userId, itemId]);
  if (!row) throw new AppError(404, 'ITEM_NOT_OWNED', `You do not own item '${itemId}'`);
  return row;
}

export async function equipOutfit(tx: Db, userId: string, itemId: string) {
  await lockProfile(tx, userId);
  const item = await ownedItem(tx, userId, itemId);
  if (item.category !== 'Outfit') throw conflict('NOT_EQUIPPABLE', 'Only outfits can be equipped here');
  await tx.query('UPDATE player_profiles SET equipped_outfit_id = $2 WHERE user_id = $1', [userId, itemId]);
  return inventoryView(item, itemId);
}

export async function sellItem(tx: Db, userId: string, itemId: string, quantity: number) {
  const profile = await lockProfile(tx, userId);
  const item = await ownedItem(tx, userId, itemId);
  if (item.sell_value_cash <= 0) throw conflict('NOT_SELLABLE', 'This item cannot be sold');
  if (quantity > item.quantity) {
    throw conflict('NOT_ENOUGH_ITEMS', `You only have ${item.quantity}`, { available: item.quantity });
  }
  if (item.item_id === profile.equipped_outfit_id && quantity >= item.quantity) {
    throw conflict('ITEM_EQUIPPED', 'Unequip this outfit before selling it');
  }
  const earned = item.sell_value_cash * quantity;
  await changeWallet(tx, profile, {
    cash: earned,
    reason: 'item_sale',
    refType: 'item',
    refId: itemId,
    metadata: { quantity, unitPrice: item.sell_value_cash },
  });
  if (quantity === item.quantity) {
    await tx.query('DELETE FROM player_inventory WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
  } else {
    await tx.query('UPDATE player_inventory SET quantity = quantity - $3 WHERE user_id = $1 AND item_id = $2', [userId, itemId, quantity]);
  }
  return { itemId, quantitySold: quantity, cashEarned: earned, remaining: item.quantity - quantity };
}
