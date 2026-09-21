import { z } from 'zod';
import { Db, pool, queryRows } from '../../db/pool';

const int = (min = 0) => z.number().int().min(min);

/** Known tunables with safe fallbacks. Rows live in the game_config table. */
const configSchema = z.object({
  starting_cash: int().default(5000),
  starting_gems: int().default(50),
  starting_stamina_max: int(1).default(100),
  starter_vehicle_id: z.string().nullable().default('veh_starter_drifter'),
  starter_outfit_id: z.string().nullable().default('outfit_street_jacket'),
  stamina_regen_seconds: int(1).default(180),
  xp_per_level: int(1).default(1000),
  mission_proximity_enforced: z.boolean().default(true),
  mission_proximity_tolerance_m: z.number().min(0).default(150),
  mission_expiry_grace_s: int().default(30),
  sprint_checkpoint_bonus_s: int().default(15),
  mission_free_retries: int().default(1),
  mission_retry_window_s: int().default(600),
  nearby_max_radius_m: z.number().positive().default(10000),
  nearby_max_results: int(1).default(100),
  customization_cost_cash: int().default(0),
  ad_reward_daily_cap: int().default(10),
  ad_reward_stamina: int().default(30),
  ad_reward_cash: int().default(500),
  founders_pass_cash: int().default(10000),
  founders_pass_gems: int().default(500),
});

export type GameConfig = z.infer<typeof configSchema>;
export const KNOWN_CONFIG_KEYS = Object.keys(configSchema.shape) as (keyof GameConfig)[];

/** Validates one value for a known key; used by the admin API before saving. */
export function validateConfigValue(key: keyof GameConfig, value: unknown): unknown {
  return configSchema.shape[key].parse(value);
}

const CACHE_MS = 30_000;
let cache: { value: GameConfig; at: number } | undefined;

export async function getConfig(db: Db = pool): Promise<GameConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await queryRows<{ key: string; value: unknown }>(db, 'SELECT key, value FROM game_config');
  const raw = Object.fromEntries(rows.filter((r) => r.key in configSchema.shape).map((r) => [r.key, r.value]));
  const value = configSchema.parse(raw);
  cache = { value, at: Date.now() };
  return value;
}

export function invalidateConfigCache() {
  cache = undefined;
}
