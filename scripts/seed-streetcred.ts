// Street Cred (Trapcity) Production / Staging Seed
// Seeds real Unity vehicle catalog rows and missions.
import { pool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

const MISSIONS = [
  ['8f6a1c52-0b1e-4c1e-9a55-000000000001', 'Trafalgar Square Drop', 'Retrieve the encrypted dead drop before rival syndicates intercept.', 'DeadDropCourier', 51.508, -0.1281, 35, 120, 15, 750, 10, 300],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000002', 'Southbank Turf Skirmish', 'Neutralize 3 rogue combat drones in physical AR space.', 'TurfSkirmishAR', 51.5065, -0.1165, 40, 90, 20, 1200, 15, 500],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000003', 'Covent Garden Recon', 'Hack 3 local surveillance telemetry nodes on foot.', 'ZoneReconWalking', 51.5117, -0.1232, 25, 180, 10, 600, 5, 200],
  ['8f6a1c52-0b1e-4c1e-9a55-000000000004', 'Embankment Sprint', 'Blast through 3 street checkpoints along the Thames before time expires.', 'HighRollerSprint', 51.5090, -0.1220, 30, 90, 15, 900, 8, 350],
] as const;

async function main() {
  await migrate(pool);

  for (const [id, title, description, type, lat, lng, radius, limit, stamina, cash, gems, xp] of MISSIONS) {
    await pool.query(
      `INSERT INTO missions (id, title, description, mission_type, location, trigger_radius_m, time_limit_s, required_stamina, reward_cash, reward_gems, reward_xp)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
      [id, title, description, type, lat, lng, radius, limit, stamina, cash, gems, xp],
    );
  }

  // Real Unity Vehicle Catalog
  await pool.query(`
    INSERT INTO vehicle_catalog (id, name, description, price_cash, price_gems, max_upgrade_level, upgrade_base_cost_cash, min_player_level, sort_order) VALUES
      ('veh_starter_drifter', 'Starter Drifter', 'Reliable street-tuned coupe with balanced drift handling.', 0, 0, 5, 500, 1, 1),
      ('veh_street_phantom',  'Street Phantom',  'Aerodynamic futuristic supercar built for high-speed sprints.', 15000, 50, 5, 1200, 3, 2),
      ('veh_neon_apex',       'Neon Apex',       'Aggressive street muscle machine with unmatched straight-line velocity.', 35000, 150, 5, 2500, 5, 3)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      price_cash = EXCLUDED.price_cash,
      price_gems = EXCLUDED.price_gems,
      max_upgrade_level = EXCLUDED.max_upgrade_level,
      upgrade_base_cost_cash = EXCLUDED.upgrade_base_cost_cash,
      min_player_level = EXCLUDED.min_player_level,
      sort_order = EXCLUDED.sort_order;
  `);

  // Initial Vanity and Consumables
  await pool.query(`
    INSERT INTO item_catalog (id, name, description, category, rarity, sell_value_cash, is_stackable) VALUES
      ('outfit_street_syndicate', 'Syndicate Leather Jacket', 'Official street syndicate crew jacket.', 'Outfit', 'Rare', 500, FALSE),
      ('consumable_nitro_boost',  'Nitro Boost Canister',     'Instantly refuels 30 Stamina for street missions.', 'Consumable', 'Common', 50, TRUE)
    ON CONFLICT (id) DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO store_offers (id, title, item_id, quantity, price_cash, price_gems, max_per_user, sort_order) VALUES
      ('offer_syndicate_jacket', 'Syndicate Jacket', 'outfit_street_syndicate', 1, 3000, 25, NULL, 1),
      ('offer_nitro_bundle',     'Nitro Pack (x3)',  'consumable_nitro_boost',  3, 500,  0,  NULL, 2)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log('[seed:streetcred] Street Cred real vehicle catalog, items, and missions populated successfully.');
}

main()
  .catch((err) => {
    console.error(`[seed:streetcred] Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
