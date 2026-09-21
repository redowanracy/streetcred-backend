import { Db, dbNow, queryOne } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { GameConfig, getConfig } from '../game-config/game-config.service';

/**
 * Every change to a player's balances, XP, stamina or items goes through this
 * file, inside a transaction that first locks the profile row (`lockProfile`).
 * That lock serializes all of one player's requests, so concurrent purchases
 * or retried rewards can never overspend or double-grant.
 */

export interface ProfileRow {
  user_id: string;
  level: number;
  xp: number;
  total_xp: number;
  cash: number;
  gems: number;
  stamina: number;
  stamina_max: number;
  stamina_updated_at: Date;
  equipped_vehicle_id: string | null;
  equipped_outfit_id: string | null;
  has_founders_pass: boolean;
}

export async function lockProfile(tx: Db, userId: string): Promise<ProfileRow> {
  const row = await queryOne<ProfileRow>(tx, 'SELECT * FROM player_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!row) throw notFound('Player profile');
  return row;
}

export async function readProfile(db: Db, userId: string): Promise<ProfileRow> {
  const row = await queryOne<ProfileRow>(db, 'SELECT * FROM player_profiles WHERE user_id = $1', [userId]);
  if (!row) throw notFound('Player profile');
  return row;
}

/** Creates the profile, starter vehicle and starter outfit for a brand-new user. */
export async function createPlayer(tx: Db, userId: string, config: GameConfig): Promise<ProfileRow> {
  const starterVehicle = config.starter_vehicle_id
    ? (await queryOne<{ id: string }>(tx, 'SELECT id FROM vehicle_catalog WHERE id = $1', [config.starter_vehicle_id]))?.id ?? null
    : null;
  const starterOutfit = config.starter_outfit_id
    ? (await queryOne<{ id: string }>(tx, `SELECT id FROM item_catalog WHERE id = $1 AND category = 'Outfit'`, [config.starter_outfit_id]))?.id ?? null
    : null;

  const profile = await queryOne<ProfileRow>(
    tx,
    `INSERT INTO player_profiles (user_id, cash, gems, stamina, stamina_max, equipped_vehicle_id, equipped_outfit_id)
     VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING *`,
    [userId, config.starting_cash, config.starting_gems, config.starting_stamina_max, starterVehicle, starterOutfit],
  );
  if (starterVehicle) {
    await tx.query('INSERT INTO player_vehicles (user_id, vehicle_id) VALUES ($1, $2)', [userId, starterVehicle]);
  }
  if (starterOutfit) {
    await tx.query('INSERT INTO player_inventory (user_id, item_id, quantity) VALUES ($1, $2, 1)', [userId, starterOutfit]);
  }
  await tx.query(
    `INSERT INTO wallet_transactions (user_id, reason, cash_delta, gems_delta, cash_after, gems_after)
     VALUES ($1, 'account_created', $2, $3, $2, $3)`,
    [userId, config.starting_cash, config.starting_gems],
  );
  return profile!;
}

// ───────────────────────────── Wallet ─────────────────────────────

export interface WalletChange {
  cash?: number;
  gems?: number;
  reason: string;
  refType?: string;
  refId?: string;
  metadata?: Record<string, unknown>;
}

/** Applies a signed cash/gem delta to a locked profile and records it in the ledger. */
export async function changeWallet(tx: Db, profile: ProfileRow, change: WalletChange): Promise<ProfileRow> {
  const cashDelta = change.cash ?? 0;
  const gemsDelta = change.gems ?? 0;
  const cashAfter = profile.cash + cashDelta;
  const gemsAfter = profile.gems + gemsDelta;
  if (cashAfter < 0 || gemsAfter < 0) {
    throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough cash or gems', {
      cash: { required: -cashDelta, available: profile.cash },
      gems: { required: -gemsDelta, available: profile.gems },
    });
  }
  if (cashDelta === 0 && gemsDelta === 0) return profile;

  const updated = await queryOne<ProfileRow>(
    tx,
    'UPDATE player_profiles SET cash = $2, gems = $3 WHERE user_id = $1 RETURNING *',
    [profile.user_id, cashAfter, gemsAfter],
  );
  await tx.query(
    `INSERT INTO wallet_transactions (user_id, reason, cash_delta, gems_delta, cash_after, gems_after, ref_type, ref_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      profile.user_id,
      change.reason,
      cashDelta,
      gemsDelta,
      cashAfter,
      gemsAfter,
      change.refType ?? null,
      change.refId ?? null,
      JSON.stringify(change.metadata ?? {}),
    ],
  );
  return updated!;
}

// ───────────────────────────── XP & levels ─────────────────────────────

/** Leaving level L costs L * xp_per_level XP (same rule as the Unity client). */
export const xpToNextLevel = (level: number, config: GameConfig) => level * config.xp_per_level;

export async function grantXp(tx: Db, profile: ProfileRow, amount: number, config: GameConfig) {
  let level = profile.level;
  let xp = profile.xp + amount;
  while (xp >= xpToNextLevel(level, config)) {
    xp -= xpToNextLevel(level, config);
    level++;
  }
  const updated = await queryOne<ProfileRow>(
    tx,
    'UPDATE player_profiles SET level = $2, xp = $3, total_xp = total_xp + $4 WHERE user_id = $1 RETURNING *',
    [profile.user_id, level, xp, amount],
  );
  return { profile: updated!, levelsGained: level - profile.level };
}

// ───────────────────────────── Stamina ─────────────────────────────

/**
 * Stamina is stored as (value, anchor time) and regenerates lazily: one point
 * every `stamina_regen_seconds` until max. Partial progress towards the next
 * point is kept by moving the anchor forward only by whole points.
 */
export function resolveStamina(profile: ProfileRow, config: GameConfig, now: Date) {
  const periodMs = config.stamina_regen_seconds * 1000;
  const max = profile.stamina_max;
  if (profile.stamina >= max) return { value: profile.stamina, anchor: now };
  const gained = Math.floor((now.getTime() - profile.stamina_updated_at.getTime()) / periodMs);
  if (gained <= 0) return { value: profile.stamina, anchor: profile.stamina_updated_at };
  if (profile.stamina + gained >= max) return { value: max, anchor: now };
  return { value: profile.stamina + gained, anchor: new Date(profile.stamina_updated_at.getTime() + gained * periodMs) };
}

export function staminaView(profile: ProfileRow, config: GameConfig, now: Date) {
  const { value, anchor } = resolveStamina(profile, config, now);
  const periodMs = config.stamina_regen_seconds * 1000;
  const full = value >= profile.stamina_max;
  return {
    current: value,
    max: profile.stamina_max,
    regenSeconds: config.stamina_regen_seconds,
    nextPointAt: full ? null : new Date(anchor.getTime() + periodMs).toISOString(),
    fullAt: full ? null : new Date(anchor.getTime() + (profile.stamina_max - value) * periodMs).toISOString(),
  };
}

/** Adds (positive) or spends (negative) stamina, capped at max. Throws if spending more than available. */
export async function changeStamina(tx: Db, profile: ProfileRow, delta: number, config: GameConfig, now: Date) {
  const { value, anchor } = resolveStamina(profile, config, now);
  if (value + delta < 0) {
    throw new AppError(409, 'NOT_ENOUGH_STAMINA', 'Not enough stamina', { required: -delta, available: value });
  }
  const wasFull = value >= profile.stamina_max;
  const next = Math.min(profile.stamina_max, value + delta);
  // Regeneration restarts from now when leaving a full bar; otherwise keep partial progress.
  const nextAnchor = wasFull || next >= profile.stamina_max ? now : anchor;
  const updated = await queryOne<ProfileRow>(
    tx,
    'UPDATE player_profiles SET stamina = $2, stamina_updated_at = $3 WHERE user_id = $1 RETURNING *',
    [profile.user_id, next, nextAnchor],
  );
  return updated!;
}

// ───────────────────────────── Items ─────────────────────────────

/**
 * Adds items to the inventory. Non-stackable items are capped at one copy;
 * returns how many were actually added.
 */
export async function grantItem(tx: Db, userId: string, itemId: string, quantity: number): Promise<number> {
  const item = await queryOne<{ is_stackable: boolean }>(tx, 'SELECT is_stackable FROM item_catalog WHERE id = $1', [itemId]);
  if (!item) throw notFound(`Item '${itemId}'`);
  if (!item.is_stackable) {
    const res = await tx.query(
      'INSERT INTO player_inventory (user_id, item_id, quantity) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING',
      [userId, itemId],
    );
    return res.rowCount ?? 0;
  }
  await tx.query(
    `INSERT INTO player_inventory (user_id, item_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
    [userId, itemId, quantity],
  );
  return quantity;
}

// ───────────────────────────── View ─────────────────────────────

export function profileView(profile: ProfileRow, config: GameConfig, now: Date) {
  return {
    level: profile.level,
    xp: profile.xp,
    xpToNextLevel: xpToNextLevel(profile.level, config),
    totalXp: profile.total_xp,
    cash: profile.cash,
    gems: profile.gems,
    stamina: staminaView(profile, config, now),
    equippedVehicleId: profile.equipped_vehicle_id,
    equippedOutfitId: profile.equipped_outfit_id,
    hasFoundersPass: profile.has_founders_pass,
  };
}
export type ProfileView = ReturnType<typeof profileView>;

/** Current profile view, read inside the caller's transaction so it reflects uncommitted changes. */
export async function profileSnapshot(db: Db, userId: string, config?: GameConfig): Promise<ProfileView> {
  const [profile, cfg, now] = await Promise.all([readProfile(db, userId), config ?? getConfig(db), dbNow(db)]);
  return profileView(profile, cfg, now);
}
