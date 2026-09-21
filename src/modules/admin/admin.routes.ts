import { Router } from 'express';
import { z } from 'zod';
import { pool, queryOne, queryRows } from '../../db/pool';
import { badRequest, notFound } from '../../lib/errors';
import { runIdempotent } from '../../lib/idempotency';
import { catalogIdParam, parse, uuidParam } from '../../lib/validate';
import { currentUser, requireAdmin, requireAuth } from '../../middleware/auth';
import { UserRow, userView } from '../auth/auth.service';
import {
  getConfig,
  GameConfig,
  invalidateConfigCache,
  KNOWN_CONFIG_KEYS,
  validateConfigValue,
} from '../game-config/game-config.service';
import { catalogVehicleView } from '../garage/garage.service';
import { catalogItemView } from '../inventory/inventory.service';
import { MISSION_COLUMNS, MISSION_TYPES, MissionRow, missionView } from '../missions/missions.service';
import { changeWallet, lockProfile, profileSnapshot } from '../wallet/player-state';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// ───────────────────────────── Players ─────────────────────────────

adminRouter.get('/users', async (req, res) => {
  const q = parse(z.object({ email: z.string().trim().toLowerCase().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
  const rows = await queryRows<UserRow>(
    pool,
    `SELECT * FROM users WHERE ($1::text IS NULL OR email LIKE $1 || '%') ORDER BY created_at DESC LIMIT $2`,
    [q.email ?? null, q.limit],
  );
  res.json({ users: rows.map((u) => ({ ...userView(u), isBanned: u.is_banned })) });
});

adminRouter.get('/users/:id', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const user = await queryOne<UserRow & { ban_reason: string | null }>(pool, 'SELECT * FROM users WHERE id = $1', [id]);
  if (!user) throw notFound('User');
  const transactions = await queryRows(pool, 'SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);
  res.json({
    user: { ...userView(user), isBanned: user.is_banned, banReason: user.ban_reason },
    profile: await profileSnapshot(pool, id),
    recentTransactions: transactions,
  });
});

adminRouter.post('/users/:id/ban', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().min(1).max(500) }), req.body);
  const updated = await pool.query('UPDATE users SET is_banned = TRUE, ban_reason = $2 WHERE id = $1', [id, reason]);
  if (!updated.rowCount) throw notFound('User');
  // Sessions are deliberately left intact: requireAuth and refresh both reject banned
  // accounts, and revoking a guest's refresh token would destroy the account even after an unban.
  res.status(204).end();
});

adminRouter.post('/users/:id/unban', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const updated = await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = NULL WHERE id = $1', [id]);
  if (!updated.rowCount) throw notFound('User');
  res.status(204).end();
});

/** Manual correction (support refunds etc.). Always ledgered with the admin's id and note. */
adminRouter.post('/users/:id/wallet-adjustments', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const body = parse(
    z
      .object({ cash: z.number().int().default(0), gems: z.number().int().default(0), note: z.string().min(1).max(500) })
      .refine((b) => b.cash !== 0 || b.gems !== 0, 'cash or gems must be non-zero'),
    req.body,
  );
  const adminId = currentUser(req).id;
  const result = await runIdempotent(req, adminId, { required: true }, async (tx) => {
    const profile = await lockProfile(tx, id);
    await changeWallet(tx, profile, {
      cash: body.cash,
      gems: body.gems,
      reason: 'admin_adjustment',
      refType: 'admin',
      refId: adminId,
      metadata: { note: body.note },
    });
    return { status: 200, body: { profile: await profileSnapshot(tx, id) } };
  });
  res.status(result.status).json(result.body);
});

// ───────────────────────────── Game config ─────────────────────────────

adminRouter.get('/config', async (_req, res) => {
  const rows = await queryRows(pool, 'SELECT key, value, description, updated_at FROM game_config ORDER BY key');
  res.json({ config: rows, effective: await getConfig() });
});

adminRouter.put('/config/:key', async (req, res) => {
  const { key } = parse(z.object({ key: z.enum(KNOWN_CONFIG_KEYS as [keyof GameConfig, ...(keyof GameConfig)[]]) }), req.params);
  const { value } = parse(z.object({ value: z.unknown() }), req.body);
  let validated: unknown;
  try {
    validated = validateConfigValue(key, value);
  } catch (err: any) {
    throw badRequest('VALIDATION_ERROR', `Invalid value for ${key}`, err?.issues);
  }
  await pool.query(
    `INSERT INTO game_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(validated)],
  );
  invalidateConfigCache();
  res.json({ key, value: validated });
});

// ───────────────────────────── Missions ─────────────────────────────

// No .default() here: Zod 4 applies defaults even to optional keys, which would
// make PATCH overwrite unsent fields. Create-time defaults live in MISSION_DEFAULTS.
const missionFields = z.object({
  title: z.string().min(1).max(128),
  description: z.string().max(2000),
  missionType: z.enum(MISSION_TYPES),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  triggerRadiusM: z.number().positive().max(5000),
  timeLimitS: z.number().int().positive().max(86_400),
  requiredStamina: z.number().int().min(0),
  rewardCash: z.number().int().min(0),
  rewardGems: z.number().int().min(0),
  rewardXp: z.number().int().min(0),
  rewardItemId: z.string().nullable(),
  minPlayerLevel: z.number().int().min(1),
  cooldownS: z.number().int().min(0).nullable(),
  minCompletionS: z.number().int().min(0),
  isActive: z.boolean(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
});
type MissionFields = z.infer<typeof missionFields>;

const MISSION_DEFAULTS: Omit<MissionFields, 'title' | 'missionType' | 'latitude' | 'longitude'> = {
  description: '',
  triggerRadiusM: 30,
  timeLimitS: 120,
  requiredStamina: 15,
  rewardCash: 500,
  rewardGems: 5,
  rewardXp: 250,
  rewardItemId: null,
  minPlayerLevel: 1,
  cooldownS: 3600,
  minCompletionS: 10,
  isActive: true,
  startsAt: null,
  endsAt: null,
};
const missionCreate = missionFields.partial().required({ title: true, missionType: true, latitude: true, longitude: true });

const MISSION_COLUMN_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
  missionType: 'mission_type',
  triggerRadiusM: 'trigger_radius_m',
  timeLimitS: 'time_limit_s',
  requiredStamina: 'required_stamina',
  rewardCash: 'reward_cash',
  rewardGems: 'reward_gems',
  rewardXp: 'reward_xp',
  rewardItemId: 'reward_item_id',
  minPlayerLevel: 'min_player_level',
  cooldownS: 'cooldown_s',
  minCompletionS: 'min_completion_s',
  isActive: 'is_active',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
};

async function readMissionAdmin(id: string) {
  const m = await queryOne<MissionRow>(pool, `SELECT ${MISSION_COLUMNS} FROM missions m WHERE m.id = $1`, [id]);
  if (!m) throw notFound('Mission');
  return { ...missionView(m), minCompletionS: m.min_completion_s, isActive: m.is_active, startsAt: m.starts_at, endsAt: m.ends_at };
}

adminRouter.get('/missions', async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
  const rows = await queryRows<MissionRow>(pool, `SELECT ${MISSION_COLUMNS} FROM missions m ORDER BY m.created_at DESC LIMIT $1`, [limit]);
  res.json({ missions: rows.map((m) => ({ ...missionView(m), isActive: m.is_active })) });
});

adminRouter.post('/missions', async (req, res) => {
  const sent = parse(missionCreate, req.body);
  const b: MissionFields = {
    ...MISSION_DEFAULTS,
    ...(Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined)) as typeof sent),
  };
  const row = await queryOne<{ id: string }>(
    pool,
    `INSERT INTO missions (title, description, mission_type, location, trigger_radius_m, time_limit_s, required_stamina,
       reward_cash, reward_gems, reward_xp, reward_item_id, min_player_level, cooldown_s, min_completion_s, is_active, starts_at, ends_at)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [
      b.title, b.description, b.missionType, b.longitude, b.latitude, b.triggerRadiusM, b.timeLimitS, b.requiredStamina,
      b.rewardCash, b.rewardGems, b.rewardXp, b.rewardItemId, b.minPlayerLevel, b.cooldownS, b.minCompletionS, b.isActive,
      b.startsAt, b.endsAt,
    ],
  );
  res.status(201).json({ mission: await readMissionAdmin(row!.id) });
});

adminRouter.patch('/missions/:id', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const b = parse(missionFields.partial(), req.body);
  const entries = Object.entries(b).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw badRequest('VALIDATION_ERROR', 'No fields to update');

  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of entries) {
    if (key === 'latitude' || key === 'longitude') continue;
    params.push(value);
    sets.push(`${MISSION_COLUMN_MAP[key]} = $${params.length}`);
  }
  if (b.latitude !== undefined || b.longitude !== undefined) {
    if (b.latitude === undefined || b.longitude === undefined) throw badRequest('VALIDATION_ERROR', 'Send latitude and longitude together');
    params.push(b.longitude, b.latitude);
    sets.push(`location = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)::geography`);
  }
  const updated = await pool.query(`UPDATE missions SET ${sets.join(', ')} WHERE id = $1`, params);
  if (!updated.rowCount) throw notFound('Mission');
  res.json({ mission: await readMissionAdmin(id) });
});

// ───────────────────────────── Catalogs ─────────────────────────────

const vehicleBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1000).default(''),
  priceCash: z.number().int().min(0).default(0),
  priceGems: z.number().int().min(0).default(0),
  maxUpgradeLevel: z.number().int().min(0).max(50).default(5),
  upgradeBaseCostCash: z.number().int().min(0).default(500),
  minPlayerLevel: z.number().int().min(1).default(1),
  isStarter: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

adminRouter.put('/vehicles/:id', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const b = parse(vehicleBody, req.body);
  const row = await queryOne(
    pool,
    `INSERT INTO vehicle_catalog (id, name, description, price_cash, price_gems, max_upgrade_level, upgrade_base_cost_cash,
       min_player_level, is_starter, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, price_cash = EXCLUDED.price_cash,
       price_gems = EXCLUDED.price_gems, max_upgrade_level = EXCLUDED.max_upgrade_level,
       upgrade_base_cost_cash = EXCLUDED.upgrade_base_cost_cash, min_player_level = EXCLUDED.min_player_level,
       is_starter = EXCLUDED.is_starter, is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order
     RETURNING *`,
    [id, b.name, b.description, b.priceCash, b.priceGems, b.maxUpgradeLevel, b.upgradeBaseCostCash, b.minPlayerLevel, b.isStarter, b.isActive, b.sortOrder],
  );
  res.json({ vehicle: catalogVehicleView(row as any) });
});

const itemBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1000).default(''),
  category: z.enum(['Weapon', 'Outfit', 'VehiclePart', 'Consumable']),
  rarity: z.enum(['Common', 'Rare', 'Epic', 'Legendary']).default('Common'),
  sellValueCash: z.number().int().min(0).default(0),
  isStackable: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

adminRouter.put('/items/:id', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const b = parse(itemBody, req.body);
  const row = await queryOne(
    pool,
    `INSERT INTO item_catalog (id, name, description, category, rarity, sell_value_cash, is_stackable, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category,
       rarity = EXCLUDED.rarity, sell_value_cash = EXCLUDED.sell_value_cash, is_stackable = EXCLUDED.is_stackable,
       is_active = EXCLUDED.is_active
     RETURNING *`,
    [id, b.name, b.description, b.category, b.rarity, b.sellValueCash, b.isStackable, b.isActive],
  );
  res.json({ item: catalogItemView(row as any) });
});

const offerBody = z.object({
  title: z.string().min(1).max(128),
  itemId: z.string().min(1).max(64),
  quantity: z.number().int().positive().default(1),
  priceCash: z.number().int().min(0).default(0),
  priceGems: z.number().int().min(0).default(0),
  maxPerUser: z.number().int().positive().nullable().default(null),
  isActive: z.boolean().default(true),
  startsAt: z.iso.datetime().nullable().default(null),
  endsAt: z.iso.datetime().nullable().default(null),
  sortOrder: z.number().int().default(0),
});

adminRouter.put('/offers/:id', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const b = parse(offerBody, req.body);
  if (!(await queryOne(pool, 'SELECT 1 FROM item_catalog WHERE id = $1', [b.itemId]))) throw notFound(`Item '${b.itemId}'`);
  const row = await queryOne(
    pool,
    `INSERT INTO store_offers (id, title, item_id, quantity, price_cash, price_gems, max_per_user, is_active, starts_at, ends_at, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, item_id = EXCLUDED.item_id, quantity = EXCLUDED.quantity,
       price_cash = EXCLUDED.price_cash, price_gems = EXCLUDED.price_gems, max_per_user = EXCLUDED.max_per_user,
       is_active = EXCLUDED.is_active, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, sort_order = EXCLUDED.sort_order
     RETURNING *`,
    [id, b.title, b.itemId, b.quantity, b.priceCash, b.priceGems, b.maxPerUser, b.isActive, b.startsAt, b.endsAt, b.sortOrder],
  );
  res.json({ offer: row });
});
