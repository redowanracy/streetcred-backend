-- Required rows every environment needs. Tune values later through the admin API.

INSERT INTO game_config (key, value, description) VALUES
  ('starting_cash',                 '5000',  'Cash given to a new account'),
  ('starting_gems',                 '50',    'Gems given to a new account'),
  ('starting_stamina_max',          '100',   'Max stamina for a new account'),
  ('starter_vehicle_id',            '"veh_starter_drifter"', 'Vehicle every new account owns and has equipped'),
  ('starter_outfit_id',             '"outfit_street_jacket"', 'Outfit every new account owns and has equipped'),
  ('stamina_regen_seconds',         '180',   'Seconds to regenerate 1 stamina point'),
  ('xp_per_level',                  '1000',  'XP needed to leave level L is L * xp_per_level (matches Unity)'),
  ('mission_proximity_enforced',    'true',  'Reject mission starts whose reported position is too far from the mission'),
  ('mission_proximity_tolerance_m', '150',   'Extra metres allowed beyond trigger radius for GPS noise'),
  ('mission_expiry_grace_s',        '30',    'Extra seconds after the time limit before an attempt expires (network latency)'),
  ('sprint_checkpoint_bonus_s',     '15',    'Bonus seconds per HighRollerSprint checkpoint (3 checkpoints)'),
  ('mission_free_retries',          '1',     'Free (no stamina) retries allowed after a failed or timed-out attempt'),
  ('mission_retry_window_s',        '600',   'How long after failing a free retry stays available'),
  ('nearby_max_radius_m',           '10000', 'Largest radius a nearby-missions query may request'),
  ('nearby_max_results',            '100',   'Maximum missions returned by a nearby query'),
  ('customization_cost_cash',       '0',     'Cash charged per paint/underglow change'),
  ('ad_reward_daily_cap',           '10',    'Rewarded ads a player can redeem per UTC day'),
  ('ad_reward_stamina',             '30',    'Stamina restored by a stamina ad'),
  ('ad_reward_cash',                '500',   'Cash granted by a bonus-cash ad'),
  ('founders_pass_cash',            '10000', 'Cash bundled with the Founders Pass'),
  ('founders_pass_gems',            '500',   'Gems bundled with the Founders Pass')
ON CONFLICT (key) DO NOTHING;

INSERT INTO vehicle_catalog (id, name, description, price_cash, price_gems, is_starter, sort_order) VALUES
  ('veh_starter_drifter', 'Starter Drifter', 'Your first ride.', 0, 0, TRUE, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO item_catalog (id, name, description, category, rarity, sell_value_cash) VALUES
  ('outfit_street_jacket', 'Street Jacket', 'Default outfit.', 'Outfit', 'Common', 0)
ON CONFLICT (id) DO NOTHING;
