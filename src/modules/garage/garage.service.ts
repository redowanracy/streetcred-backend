import { Db, queryOne, queryRows } from '../../db/pool';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors';
import { GameConfig } from '../game-config/game-config.service';
import { changeWallet, lockProfile } from '../wallet/player-state';

export type UpgradeStat = 'speed' | 'acceleration' | 'handling';
const STAT_COLUMN: Record<UpgradeStat, string> = {
  speed: 'speed_level',
  acceleration: 'acceleration_level',
  handling: 'handling_level',
};

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface VehicleCatalogRow {
  id: string;
  name: string;
  description: string;
  price_cash: number;
  price_gems: number;
  max_upgrade_level: number;
  upgrade_base_cost_cash: number;
  min_player_level: number;
  is_starter: boolean;
  is_active: boolean;
  sort_order: number;
}

interface OwnedVehicleRow extends VehicleCatalogRow {
  vehicle_id: string;
  speed_level: number;
  acceleration_level: number;
  handling_level: number;
  has_custom_paint: boolean;
  paint_color: Color;
  has_custom_underglow: boolean;
  underglow_enabled: boolean;
  underglow_color: Color;
  acquired_at: Date;
}

/** Cost to raise a stat from `level` to `level + 1`; null when already maxed. */
export const upgradeCost = (v: Pick<VehicleCatalogRow, 'upgrade_base_cost_cash' | 'max_upgrade_level'>, level: number) =>
  level >= v.max_upgrade_level ? null : v.upgrade_base_cost_cash * (level + 1);

export const catalogVehicleView = (v: VehicleCatalogRow) => ({
  id: v.id,
  name: v.name,
  description: v.description,
  priceCash: v.price_cash,
  priceGems: v.price_gems,
  maxUpgradeLevel: v.max_upgrade_level,
  upgradeBaseCostCash: v.upgrade_base_cost_cash,
  minPlayerLevel: v.min_player_level,
  isStarter: v.is_starter,
});

const ownedVehicleView = (v: OwnedVehicleRow, equippedId: string | null) => ({
  vehicleId: v.vehicle_id,
  name: v.name,
  isEquipped: v.vehicle_id === equippedId,
  upgrades: { speed: v.speed_level, acceleration: v.acceleration_level, handling: v.handling_level },
  maxUpgradeLevel: v.max_upgrade_level,
  nextUpgradeCostCash: {
    speed: upgradeCost(v, v.speed_level),
    acceleration: upgradeCost(v, v.acceleration_level),
    handling: upgradeCost(v, v.handling_level),
  },
  customization: {
    hasCustomPaint: v.has_custom_paint,
    paintColor: v.paint_color,
    hasCustomUnderglow: v.has_custom_underglow,
    underglowEnabled: v.underglow_enabled,
    underglowColor: v.underglow_color,
  },
  acquiredAt: v.acquired_at.toISOString(),
});

const OWNED_SELECT = `SELECT pv.*, vc.* , pv.vehicle_id FROM player_vehicles pv JOIN vehicle_catalog vc ON vc.id = pv.vehicle_id`;

export async function listVehicleCatalog(db: Db) {
  const rows = await queryRows<VehicleCatalogRow>(db, 'SELECT * FROM vehicle_catalog WHERE is_active ORDER BY sort_order, id');
  return rows.map(catalogVehicleView);
}

export async function listGarage(db: Db, userId: string) {
  const profile = await queryOne<{ equipped_vehicle_id: string | null }>(db, 'SELECT equipped_vehicle_id FROM player_profiles WHERE user_id = $1', [userId]);
  const rows = await queryRows<OwnedVehicleRow>(db, `${OWNED_SELECT} WHERE pv.user_id = $1 ORDER BY vc.sort_order, pv.vehicle_id`, [userId]);
  return rows.map((r) => ownedVehicleView(r, profile?.equipped_vehicle_id ?? null));
}

async function ownedVehicle(db: Db, userId: string, vehicleId: string, lock = false) {
  const row = await queryOne<OwnedVehicleRow>(
    db,
    `${OWNED_SELECT} WHERE pv.user_id = $1 AND pv.vehicle_id = $2${lock ? ' FOR UPDATE OF pv' : ''}`,
    [userId, vehicleId],
  );
  if (!row) throw new AppError(404, 'VEHICLE_NOT_OWNED', `You do not own vehicle '${vehicleId}'`);
  return row;
}

export async function purchaseVehicle(tx: Db, userId: string, vehicleId: string) {
  const profile = await lockProfile(tx, userId);
  const vehicle = await queryOne<VehicleCatalogRow>(tx, 'SELECT * FROM vehicle_catalog WHERE id = $1 AND is_active', [vehicleId]);
  if (!vehicle) throw notFound(`Vehicle '${vehicleId}'`);
  if (await queryOne(tx, 'SELECT 1 FROM player_vehicles WHERE user_id = $1 AND vehicle_id = $2', [userId, vehicleId])) {
    throw conflict('ALREADY_OWNED', 'You already own this vehicle');
  }
  if (profile.level < vehicle.min_player_level) {
    throw forbidden(`Requires player level ${vehicle.min_player_level}`, 'LEVEL_TOO_LOW');
  }
  await changeWallet(tx, profile, {
    cash: -vehicle.price_cash,
    gems: -vehicle.price_gems,
    reason: 'vehicle_purchase',
    refType: 'vehicle',
    refId: vehicleId,
  });
  await tx.query('INSERT INTO player_vehicles (user_id, vehicle_id) VALUES ($1, $2)', [userId, vehicleId]);
  return ownedVehicleView(await ownedVehicle(tx, userId, vehicleId), profile.equipped_vehicle_id);
}

export async function equipVehicle(tx: Db, userId: string, vehicleId: string) {
  await lockProfile(tx, userId);
  const vehicle = await ownedVehicle(tx, userId, vehicleId);
  await tx.query('UPDATE player_profiles SET equipped_vehicle_id = $2 WHERE user_id = $1', [userId, vehicleId]);
  return ownedVehicleView(vehicle, vehicleId);
}

/**
 * `fromLevel` must equal the current level: a retried request then fails with
 * UPGRADE_LEVEL_MISMATCH instead of silently buying a second upgrade.
 */
export async function upgradeVehicle(tx: Db, userId: string, vehicleId: string, stat: UpgradeStat, fromLevel: number) {
  const profile = await lockProfile(tx, userId);
  const vehicle = await ownedVehicle(tx, userId, vehicleId, true);
  const column = STAT_COLUMN[stat];
  const current = (vehicle as unknown as Record<string, number>)[column];
  if (current !== fromLevel) {
    throw conflict('UPGRADE_LEVEL_MISMATCH', `${stat} is already level ${current}`, { stat, currentLevel: current });
  }
  const cost = upgradeCost(vehicle, current);
  if (cost === null) throw conflict('MAX_LEVEL_REACHED', `${stat} is already at the maximum level`);
  await changeWallet(tx, profile, {
    cash: -cost,
    reason: 'vehicle_upgrade',
    refType: 'vehicle',
    refId: vehicleId,
    metadata: { stat, fromLevel: current, toLevel: current + 1 },
  });
  await tx.query(`UPDATE player_vehicles SET ${column} = ${column} + 1 WHERE user_id = $1 AND vehicle_id = $2`, [userId, vehicleId]);
  return ownedVehicleView(await ownedVehicle(tx, userId, vehicleId), profile.equipped_vehicle_id);
}

export interface CustomizationPatch {
  hasCustomPaint?: boolean;
  paintColor?: Color;
  hasCustomUnderglow?: boolean;
  underglowEnabled?: boolean;
  underglowColor?: Color;
}

export async function customizeVehicle(tx: Db, userId: string, vehicleId: string, patch: CustomizationPatch, config: GameConfig) {
  const profile = await lockProfile(tx, userId);
  const vehicle = await ownedVehicle(tx, userId, vehicleId, true);
  const next = {
    has_custom_paint: patch.hasCustomPaint ?? (patch.paintColor ? true : vehicle.has_custom_paint),
    paint_color: patch.paintColor ?? vehicle.paint_color,
    has_custom_underglow: patch.hasCustomUnderglow ?? (patch.underglowColor ? true : vehicle.has_custom_underglow),
    underglow_enabled: patch.underglowEnabled ?? vehicle.underglow_enabled,
    underglow_color: patch.underglowColor ?? vehicle.underglow_color,
  };
  if (config.customization_cost_cash > 0) {
    await changeWallet(tx, profile, {
      cash: -config.customization_cost_cash,
      reason: 'vehicle_customization',
      refType: 'vehicle',
      refId: vehicleId,
    });
  }
  await tx.query(
    `UPDATE player_vehicles SET has_custom_paint = $3, paint_color = $4, has_custom_underglow = $5,
       underglow_enabled = $6, underglow_color = $7
     WHERE user_id = $1 AND vehicle_id = $2`,
    [
      userId,
      vehicleId,
      next.has_custom_paint,
      JSON.stringify(next.paint_color),
      next.has_custom_underglow,
      next.underglow_enabled,
      JSON.stringify(next.underglow_color),
    ],
  );
  return ownedVehicleView(await ownedVehicle(tx, userId, vehicleId), profile.equipped_vehicle_id);
}
