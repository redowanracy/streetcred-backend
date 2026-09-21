-- Street Cred / Trapcity — initial server-authoritative schema.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ───────────────────────────── Accounts ─────────────────────────────

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT UNIQUE CHECK (email = lower(email)),
  password_hash  TEXT,
  display_name   TEXT NOT NULL,
  is_guest       BOOLEAN NOT NULL,
  role           TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  is_banned      BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason     TEXT,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A password is only meaningful with an email. Google/Apple accounts may have neither.
  CHECK (password_hash IS NULL OR email IS NOT NULL)
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Third-party sign-in (Google / Apple). Endpoints exist but are not enabled yet.
CREATE TABLE auth_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_subject  TEXT NOT NULL,
  email             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

-- Opaque refresh tokens (stored hashed), rotated on every use. A family is one
-- login; reuse of a rotated token revokes the whole family.
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    UUID NOT NULL,
  token_hash   BYTEA NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- ───────────────────────────── Game config ─────────────────────────────

CREATE TABLE game_config (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER game_config_updated_at BEFORE UPDATE ON game_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ───────────────────────────── Catalogs ─────────────────────────────

CREATE TABLE item_catalog (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL CHECK (category IN ('Weapon', 'Outfit', 'VehiclePart', 'Consumable')),
  rarity           TEXT NOT NULL DEFAULT 'Common' CHECK (rarity IN ('Common', 'Rare', 'Epic', 'Legendary')),
  sell_value_cash  INTEGER NOT NULL DEFAULT 0 CHECK (sell_value_cash >= 0),
  is_stackable     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER item_catalog_updated_at BEFORE UPDATE ON item_catalog FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicle_catalog (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  price_cash              INTEGER NOT NULL DEFAULT 0 CHECK (price_cash >= 0),
  price_gems              INTEGER NOT NULL DEFAULT 0 CHECK (price_gems >= 0),
  max_upgrade_level       INTEGER NOT NULL DEFAULT 5 CHECK (max_upgrade_level BETWEEN 0 AND 50),
  -- Cost of upgrading a stat from level L to L+1 is upgrade_base_cost_cash * (L + 1).
  upgrade_base_cost_cash  INTEGER NOT NULL DEFAULT 500 CHECK (upgrade_base_cost_cash >= 0),
  min_player_level        INTEGER NOT NULL DEFAULT 1 CHECK (min_player_level >= 1),
  is_starter              BOOLEAN NOT NULL DEFAULT FALSE,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER vehicle_catalog_updated_at BEFORE UPDATE ON vehicle_catalog FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE store_offers (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  item_id      TEXT NOT NULL REFERENCES item_catalog(id),
  quantity     INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_cash   INTEGER NOT NULL DEFAULT 0 CHECK (price_cash >= 0),
  price_gems   INTEGER NOT NULL DEFAULT 0 CHECK (price_gems >= 0),
  max_per_user INTEGER CHECK (max_per_user IS NULL OR max_per_user > 0),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER store_offers_updated_at BEFORE UPDATE ON store_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ───────────────────────────── Player state ─────────────────────────────

CREATE TABLE player_profiles (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level                INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp                   INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),        -- progress inside current level
  total_xp             BIGINT  NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  cash                 INTEGER NOT NULL CHECK (cash >= 0),
  gems                 INTEGER NOT NULL CHECK (gems >= 0),
  stamina              INTEGER NOT NULL CHECK (stamina >= 0),             -- value at stamina_updated_at
  stamina_max          INTEGER NOT NULL CHECK (stamina_max >= 1),
  stamina_updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  equipped_vehicle_id  TEXT REFERENCES vehicle_catalog(id),
  equipped_outfit_id   TEXT REFERENCES item_catalog(id),
  has_founders_pass    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER player_profiles_updated_at BEFORE UPDATE ON player_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE player_vehicles (
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id            TEXT NOT NULL REFERENCES vehicle_catalog(id),
  speed_level           INTEGER NOT NULL DEFAULT 0 CHECK (speed_level >= 0),
  acceleration_level    INTEGER NOT NULL DEFAULT 0 CHECK (acceleration_level >= 0),
  handling_level        INTEGER NOT NULL DEFAULT 0 CHECK (handling_level >= 0),
  has_custom_paint      BOOLEAN NOT NULL DEFAULT FALSE,
  paint_color           JSONB NOT NULL DEFAULT '{"r":0,"g":1,"b":1,"a":1}',
  has_custom_underglow  BOOLEAN NOT NULL DEFAULT FALSE,
  underglow_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  underglow_color       JSONB NOT NULL DEFAULT '{"r":0,"g":1,"b":1,"a":1}',
  acquired_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vehicle_id)
);
CREATE TRIGGER player_vehicles_updated_at BEFORE UPDATE ON player_vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE player_inventory (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES item_catalog(id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE TRIGGER player_inventory_updated_at BEFORE UPDATE ON player_inventory FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only ledger: every cash/gem change, with the resulting balance.
CREATE TABLE wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  cash_delta  INTEGER NOT NULL DEFAULT 0,
  gems_delta  INTEGER NOT NULL DEFAULT 0,
  cash_after  INTEGER NOT NULL,
  gems_after  INTEGER NOT NULL,
  ref_type    TEXT,
  ref_id      TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_transactions_user_idx ON wallet_transactions (user_id, created_at DESC);

-- Stored responses for retried requests carrying an Idempotency-Key header.
CREATE TABLE idempotency_keys (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  route         TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ───────────────────────────── Missions ─────────────────────────────

CREATE TABLE missions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  mission_type           TEXT NOT NULL CHECK (mission_type IN ('DeadDropCourier', 'TurfSkirmishAR', 'ZoneReconWalking', 'HighRollerSprint')),
  location               GEOGRAPHY(Point, 4326) NOT NULL,
  trigger_radius_m       REAL NOT NULL DEFAULT 30 CHECK (trigger_radius_m > 0),
  time_limit_s           INTEGER NOT NULL DEFAULT 120 CHECK (time_limit_s > 0),
  required_stamina       INTEGER NOT NULL DEFAULT 15 CHECK (required_stamina >= 0),
  reward_cash            INTEGER NOT NULL DEFAULT 500 CHECK (reward_cash >= 0),
  reward_gems            INTEGER NOT NULL DEFAULT 5 CHECK (reward_gems >= 0),
  reward_xp              INTEGER NOT NULL DEFAULT 250 CHECK (reward_xp >= 0),
  reward_item_id         TEXT REFERENCES item_catalog(id),
  min_player_level       INTEGER NOT NULL DEFAULT 1 CHECK (min_player_level >= 1),
  -- Replay rule: a player may start this mission again this long after completing it.
  -- NULL = never repeatable.
  cooldown_s             INTEGER DEFAULT 3600 CHECK (cooldown_s IS NULL OR cooldown_s >= 0),
  -- Completing faster than this is rejected as implausible.
  min_completion_s       INTEGER NOT NULL DEFAULT 10 CHECK (min_completion_s >= 0),
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at              TIMESTAMPTZ,
  ends_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX missions_location_idx ON missions USING GIST (location);
CREATE TRIGGER missions_updated_at BEFORE UPDATE ON missions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mission_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id        UUID NOT NULL REFERENCES missions(id),
  status            TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'abandoned', 'expired')),
  stamina_charged   INTEGER NOT NULL CHECK (stamina_charged >= 0),
  start_lat         DOUBLE PRECISION,
  start_lng         DOUBLE PRECISION,
  start_distance_m  REAL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ,
  -- Rewards are fixed when the attempt starts so later catalog edits cannot change them.
  reward_cash       INTEGER NOT NULL,
  reward_gems       INTEGER NOT NULL,
  reward_xp         INTEGER NOT NULL,
  reward_item_id    TEXT REFERENCES item_catalog(id),
  retry_of          UUID REFERENCES mission_attempts(id),
  retry_count       INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  client_report     JSONB,
  result            JSONB
);
-- At most one running attempt per player.
CREATE UNIQUE INDEX mission_attempts_one_active ON mission_attempts (user_id) WHERE status = 'active';
-- A failed attempt can be retried for free only once.
CREATE UNIQUE INDEX mission_attempts_one_retry ON mission_attempts (retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX mission_attempts_user_mission_idx ON mission_attempts (user_id, mission_id, finished_at DESC);

-- ───────────────────────────── Monetization (verification pending) ─────────────────────────────

CREATE TABLE ad_reward_claims (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_type  TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_reward_claims_user_idx ON ad_reward_claims (user_id, created_at DESC);

CREATE TABLE iap_purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('google_play', 'app_store', 'dev')),
  product_id      TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('verified', 'refunded', 'rejected')),
  raw             JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, transaction_id)
);
