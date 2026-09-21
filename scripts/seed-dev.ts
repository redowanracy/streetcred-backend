// Development sample data: London missions (one per type), example vehicles, items and offers.
// Safe to re-run (fixed ids / upserts). Do NOT run against production.
// Example vehicle and item ids are placeholders — replace them with the real Unity ids.
import { env } from '../src/config/env';
import { pool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

const MISSIONS = [
  ['8f6a1c52-0b1e-4c1e-9a55-000000000001', 'Trafalgar Square Drop', 'Retrieve the encrypted memory stick before rival syndicates intercept.', 'DeadDropCourier', 51.508, -0.1281, 35, 120, 15, 750, 10, 300],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000002', 'Piccadilly Cyber Skirmish', 'Neutralize 3 rogue combat drones in AR space.', 'TurfSkirmishAR', 51.51, -0.1345, 40, 90, 20, 1200, 15, 500],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000003', 'Covent Garden Recon', 'Hack 3 local telemetry nodes on foot.', 'ZoneReconWalking', 51.5117, -0.1232, 25, 180, 10, 600, 5, 200],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000004', 'Strand High Roller', 'Blast through 3 checkpoints before the heat arrives.', 'HighRollerSprint', 51.5105, -0.1205, 30, 90, 15, 900, 8, 350],
] as const;

async function main() {
  if (env.isProduction) throw new Error('Refusing to seed sample data in production');
  await migrate(pool);

  for (const [id, title, description, type, lat, lng, radius, limit, stamina, cash, gems, xp] of MISSIONS) {
    await pool.query(
      `INSERT INTO missions (id, title, description, mission_type, location, trigger_radius_m, time_limit_s, required_stamina, reward_cash, reward_gems, reward_xp)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
      [id, title, description, type, lat, lng, radius, limit, stamina, cash, gems, xp],
    );
  }

  await pool.query(`
    INSERT INTO vehicle_catalog (id, name, description, price_cash, price_gems, max_upgrade_level, upgrade_base_cost_cash, min_player_level, sort_order) VALUES
      ('veh_example_interceptor', 'Example Interceptor', 'Placeholder — replace with a real Unity vehicle id.', 15000, 0, 5, 750, 2, 10),
      ('veh_example_phantom',     'Example Phantom',     'Placeholder — replace with a real Unity vehicle id.', 0, 250, 5, 1000, 5, 20)
    ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    INSERT INTO item_catalog (id, name, description, category, rarity, sell_value_cash, is_stackable) VALUES
      ('outfit_example_neon', 'Example Neon Jacket', 'Placeholder outfit.', 'Outfit', 'Rare', 400, FALSE),
      ('consumable_example_nitro', 'Example Nitro Canister', 'Placeholder consumable.', 'Consumable', 'Common', 50, TRUE)
    ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    INSERT INTO store_offers (id, title, item_id, quantity, price_cash, price_gems, max_per_user, sort_order) VALUES
      ('offer_example_neon',  'Neon Jacket',  'outfit_example_neon',      1, 2500, 0, NULL, 10),
      ('offer_example_nitro', 'Nitro x3',     'consumable_example_nitro', 3, 300,  0, NULL, 20)
    ON CONFLICT (id) DO NOTHING`);

  console.log('[seed:dev] Sample missions, vehicles, items and offers are in place.');
}

main()
  .catch((err) => {
    console.error(`[seed:dev] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
