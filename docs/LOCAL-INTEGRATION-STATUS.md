# Local verification and Unity integration status

## Completed in this workspace

- Installed locked dependencies using `npm ci --ignore-scripts --no-audit --no-fund`.
- `npm run typecheck`: passed.
- `npm run build`: passed; supplied `dist` output regenerated from source.
- Added `npm run test:contract`: all four existing OpenAPI tests passed using
  the separate database-free configuration. This includes route/spec agreement
  for 58 endpoints and the documentation response/security-header checks.
- Left the supplied private `.env`, old backend, Unity gameplay, and player
  saves unchanged. No public service or deployment was started.
- Docker Desktop is now installed and its engine verified. Started the local
  `streetcred-postgres` container with PostGIS, bound to `127.0.0.1:5442`.
- Applied both migrations to the new development database and seeded the four
  sample London missions and example catalogs.
- Full `npm test`: **70 tests passed** against real PostGIS. The four contract
  tests are included in that total; running them separately also passed.
- The integration setup now creates a unique `streetcred_it_<random>_test`
  database per invocation instead of resetting a shared `_test` database. It
  removes only its own created database afterward. No test databases remain.
- The API is running at `http://127.0.0.1:3000/api/v1`, local-only. Added a
  configurable `HOST` with loopback as the default; no firewall changes made.
- `npm run test:smoke:local` passed against the running HTTP server: readiness,
  guest auth, profile, nearby AR missions, and refresh-token rotation. Removed
  only the synthetic guest created by this smoke test, not any real account.

## Agreed mission proximity rule

The owner explicitly chose **the phone's real GPS position**, not the virtual
car's position. Online acceptance must require a valid recent device GPS fix;
do not substitute mock London coordinates or the mission beacon coordinates
when permission is denied, location is unavailable, or the fix is stale.

This is recorded for the Unity integration, not yet wired into gameplay.
The current sample missions are in London; a phone elsewhere will correctly
need test missions placed near its real location. Do not disable proximity as
a workaround. Submitted GPS still is not tamper-proof anti-cheat evidence.

## Local operation

Keep Docker running. Start the API from this directory with `npm start` if it
is not already running. API docs: `http://127.0.0.1:3000/api/v1/docs`.
The existing backend process uses port 3000; do not start a duplicate listener.
`docker compose stop postgres` stops the database without deleting its volume.
Do not run `docker compose down -v` unless deliberately deleting development data.
Do not paste database passwords, refresh tokens or JWT secrets into chat.
Phone connectivity will require an explicit private LAN or HTTPS staging setup;
the current loopback-only listener is for this PC, not the APK.

## Next implementation checkpoint

Database tests passed. Next, integrate a single AR mission end to end before
expanding to the garage/shop:

1. Explicit Inspector-selected offline/online mode; preserve existing offline
   saves in their own namespace. Do not silently reset or import balances.
2. Guest session creation, securely stored refresh token, serialized refresh
   rotation, and one bounded refresh/retry for expired access tokens. The old
   Unity `token`/`resumeToken` contract is incompatible with this server.
3. Load `GET /api/v1/me`; validate and apply the server account/profile.
4. Fetch server missions and their UUIDs/camelCase fields using real device GPS,
   as agreed. Add permission, freshness and accuracy checks with visible errors.
5. Start via `POST /missions/:id/attempts`, retaining an idempotency key across
   retries. Charge stamina only on the server and retain the attempt ID.
6. Route AR completion, failure, abandonment and retry to that attempt. Online
   rewards must not also call the current local AddCash/AddGems/AddExperience
   methods. Keep a retryable pending result when connectivity fails.
7. Refresh profile, return to the map, restart, and verify persisted balances
   plus duplicate-safe reward claims on a real device.

The handoff checks mission timing/status, not actual combat success. That
limitation must remain documented; server-owned balances alone do not prove
that a player completed the objectives. Google/Apple verification, outbound
email and real monetization also remain unfinished as described in README.
