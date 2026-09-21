# Street Cred server

Server-authoritative backend for Street Cred (Trapcity): accounts, profiles, wallet, stamina, missions,
garage, inventory, shop, monetization hooks and admin tools.
Node.js 20+ · TypeScript · Express 5 · PostgreSQL 16 + PostGIS · Zod · Vitest.

The old prototype in `../backend` is left untouched for reference; this is its replacement.

## Quick start

Requires Node.js 20+ and Docker.

```text
npm install
npm run setup:env      # creates .env with a random JWT secret and DB password (never overwrites)
npm run db:up          # PostGIS on 127.0.0.1:5442
npm run migrate
npm run seed:dev       # optional: 4 London missions (one per type) + example catalog rows
npm run dev            # http://localhost:3000/api/v1
```

Other scripts: `npm test` (integration tests against a uniquely named throwaway local database),
`npm run build && npm start`, `npm run typecheck`, `npm run admin:promote -- you@example.com`,
`npm run docs` (re-records the API examples and rebuilds the Postman collection).

The server also applies pending migrations at startup.

### Checks without a database

Run `npm run typecheck`, `npm run build`, and `npm run test:contract` to check
TypeScript and the documented HTTP routes without starting PostgreSQL. The
contract suite uses a dummy database URL and does not run the database-reset
setup. Passing it does **not** validate login, transactions, mission rewards,
or persistence. The full `npm test` suite needs an isolated PostGIS database;
each run creates a new `streetcred_it_<random>_test` database and removes only
that database afterward. It refuses non-local database hosts and never resets
an existing database. Use a dedicated local PostGIS instance, not a tunnel to
client/staging/production data.

The API listens on `127.0.0.1` by default. Set `HOST` explicitly only when you
intend to permit LAN/reverse-proxy connections; a phone cannot connect to the
PC's loopback address. Do not expose the development API to the public internet.

## Handing the API to the game developer

Three things, all kept in step with the code by `test/openapi.test.ts`, which fails if an endpoint
is added without documenting it:

| What | Where |
|---|---|
| **Swagger UI** — browse and try every endpoint in a browser | `http://localhost:3000/api/v1/docs` while the server runs |
| **OpenAPI file** — import into Postman, Insomnia, or generate a client | [docs/openapi.yaml](docs/openapi.yaml), also served at `/api/v1/docs/openapi.yaml` |
| **Postman collection** — 58 requests with descriptions, bodies and saved example responses | [docs/streetcred.postman_collection.json](docs/streetcred.postman_collection.json) |
| **Written reference** — conventions, flows and error codes | [docs/API.md](docs/API.md) |
| **Plain-language overview** — what the API covers and what multiplayer would need | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) |

The Postman collection carries the tokens for you: run **Auth → Create a guest account** (or
**Create an email + password account**) and every later request is authenticated. List requests fill in
`missionId`, `attemptId`, `offerId` and the rest, so the folders can be run top to bottom. Admin requests
use a separate `adminToken` variable (see that folder's description). The example responses in it were
captured from a running server by `npm run docs:examples`, which calls all 58 endpoints and fails if one is missed.

## Layout

```text
migrations/             SQL migrations, applied in order and tracked in schema_migrations
scripts/                setup:env, seed:dev, admin:promote
src/
  app.ts                Express app and route mounting
  index.ts              startup, migrations, hourly cleanup, graceful shutdown
  config/env.ts         validated environment
  db/                   pool, transactions, migrator
  lib/                  errors, validation, JWT, password hashing, idempotency, mailer
  middleware/           auth, rate limits, error handler
  modules/
    auth/               guest, email signup/login, refresh rotation, passwords, Google/Apple stubs
    profile/            /me: bootstrap state, rename, ledger, account deletion
    wallet/             player-state.ts: the only code that changes cash, gems, XP, stamina, items
    missions/           nearby search (PostGIS), attempt lifecycle, rewards
    garage/             vehicle purchase, equip, upgrades, paint/underglow
    inventory/ shop/    items, outfits, selling, store offers
    economy/            rewarded ads, IAP verification (placeholder), dev Founders Pass
    admin/              players, bans, wallet adjustments, config, missions, catalogs
    game-config/        DB-backed tunables with a 30 s cache
test/                   integration tests (real PostGIS, no mocks)
```

## How money stays correct

- Every balance-changing request runs in one DB transaction that first locks the player's profile row
  (`SELECT … FOR UPDATE`). Concurrent requests from the same player queue up, so balances can't go negative
  and rewards can't be paid twice. The CHECK constraints (`cash >= 0` …) are a second line of defence.
- Every cash/gem change is written to `wallet_transactions` with the balance after it (audit trail, support).
- Retries are safe: `Idempotency-Key` replays the stored response. Mission completion is naturally idempotent,
  and vehicle upgrades require `fromLevel`.
- Mission rewards are copied onto the attempt when it starts, so editing a mission later can't change a running reward.

## Game rules chosen as defaults

The owner hasn't decided these rules yet. The server uses these defaults, and each one is a single config or column change:

| Question | Default | Change with |
|---|---|---|
| Proximity: GPS or vehicle? | Start position must be within trigger radius + 150 m | `mission_proximity_enforced`, `mission_proximity_tolerance_m` |
| Replays? | Yes, 1 h cooldown per mission; `NULL` = one-time | `missions.cooldown_s` |
| Stamina | Charged at start, never refunded, +1 per 180 s up to max | `stamina_regen_seconds`, `missions.required_stamina` |
| Retry after fail | One free retry within 10 min (like Unity's restart) | `mission_free_retries`, `mission_retry_window_s` |
| Offline earning | Not allowed: rewards only exist once the server grants them | — |
| Starting balance / XP curve | 5000 cash, 50 gems, level L needs L×1000 XP (matches Unity) | `starting_cash`, `starting_gems`, `xp_per_level` |
| Prototype local saves | Not imported; server accounts start fresh | — |

## Not done yet (placeholders in place)

- **Google / Apple sign-in**: routes, request shapes, DB table (`auth_identities`) and account logic are done and tested.
  Only token verification is missing (`src/modules/auth/providers.ts`); the routes return 501 until then.
- **Email delivery** for password reset: the link is logged in development. Plug a provider into `src/lib/mailer.ts`.
- **IAP receipt verification** (Google Play / App Store) and **rewarded-ad verification** (e.g. AdMob SSV):
  `/economy/iap/verify` returns 501; ads and the Founders Pass work only with `ENABLE_DEV_MONETIZATION=true` outside production.
- **Consumable effects**: consumables can be bought, held and sold, but using them isn't defined yet.
- Leaderboards, daily rewards, friends, and email verification are not in scope yet.

## Before production

- HTTPS in front of the server (reverse proxy / load balancer), `TRUST_PROXY=1`, `NODE_ENV=production`.
- Managed PostgreSQL with PostGIS, automated backups and a tested restore.
- Rate limits are in-memory per instance: move them to Redis before running more than one instance.
- Store the Unity refresh token in Keychain/Keystore, not PlayerPrefs.
- Centralised logs (pino JSON output) and uptime alerts on `/api/v1/health/ready`.

## Unity changes needed

1. Replace `TrapcityApiClient` auth with guest/signup/login + refresh-token storage and a 401 → refresh → retry wrapper.
2. On launch, call `GET /me` and use that as the player profile. Stop writing cash/gems/XP locally: `MissionController.CompleteMission`
   and `RuntimeGameSession.FinishActiveMission` must stop calling `AddCash/AddGems/AddExperience`.
3. Mission flow: `TryStartMission` → `POST /missions/:id/attempts` (stamina is charged by the server);
   success → `/complete`; timer out → `/fail`; quit → `/abandon`; restart → `/retry`. Apply the returned `profile`.
4. Garage, shop and inventory call the matching endpoints and apply the returned `profile`/`vehicle`.
5. DTOs switch to camelCase (see docs/API.md). Mission ids are UUID strings.
