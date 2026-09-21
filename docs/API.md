# Street Cred API — v1

Base URL: `http://<host>:3000/api/v1`. All bodies are JSON with **camelCase** fields. Timestamps are ISO-8601 UTC.

**Try it out**: open `/api/v1/docs` in a browser for Swagger UI, or import
[`streetcred.postman_collection.json`](streetcred.postman_collection.json) into Postman — it has every
endpoint with a description, a filled-in body and a real example response. The machine-readable spec is
[`openapi.yaml`](openapi.yaml). This file is the prose version of the same contract.

## Conventions

**Authentication.** Send `Authorization: Bearer <accessToken>` on every route marked 🔒.
Access tokens last 15 minutes. When a call returns `401 INVALID_TOKEN`, call `POST /auth/refresh`
with the stored refresh token and retry once.

**Refresh tokens rotate.** Each refresh returns a *new* refresh token; store it and discard the old one.
A guest's refresh token is their only credential, so save it durably (Keychain / Keystore). Losing it loses the guest account,
which is why guests should be prompted to link an email.

**Errors** always look like:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Not enough cash or gems", "details": { } } }
```

Branch on `code`, never on `message`. The common codes are listed at the end of this file.

**Idempotency.** For actions that spend or grant currency, send `Idempotency-Key: <new GUID per user action>`.
If the network drops and you resend with the **same key**, the server returns the original status and body, and nothing is charged or granted twice.
Reusing a key for a *different* request returns `422 IDEMPOTENCY_KEY_REUSED`. Keys are kept for 7 days.
Required (400 `IDEMPOTENCY_KEY_REQUIRED` otherwise): shop purchase, item sale, ad reward, admin wallet adjustment.
Optional but recommended: vehicle purchase/upgrade/customization, mission start/retry.

**Server is authoritative.** Every mutating response includes the new `profile` snapshot. Replace your local
cash/gems/XP/stamina with it; never add rewards locally.

## The profile object

```json
{
  "level": 3, "xp": 500, "xpToNextLevel": 3000, "totalXp": 3500,
  "cash": 5750, "gems": 60,
  "stamina": { "current": 85, "max": 100, "regenSeconds": 180,
               "nextPointAt": "2026-09-19T10:42:00.000Z", "fullAt": "2026-09-19T11:27:00.000Z" },
  "equippedVehicleId": "veh_starter_drifter",
  "equippedOutfitId": "outfit_street_jacket",
  "hasFoundersPass": false
}
```

Stamina regenerates on the server clock; use `nextPointAt`/`fullAt` for UI timers.

---

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/guest` | `{ displayName? }` | 201 → session. Creates a new guest every call. |
| POST | `/auth/signup` | `{ email, password, displayName? }` | 201 → session. Password 8–128 chars. `409 EMAIL_TAKEN`. |
| POST | `/auth/login` | `{ email, password }` | 200 → session. `401 INVALID_CREDENTIALS`. |
| POST | `/auth/refresh` | `{ refreshToken }` | 200 → session with a new refresh token. |
| POST | `/auth/logout` | `{ refreshToken }` | 204. Signs out this device. |
| POST | `/auth/logout-all` 🔒 | – | 204. Signs out every device. |
| POST | `/auth/link/email` 🔒 | `{ email, password, displayName? }` | Guest → email account. Keeps all progress and the same user id. |
| POST | `/auth/password/change` 🔒 | `{ currentPassword, newPassword }` | 200 → new session; other devices signed out. |
| POST | `/auth/password/forgot` | `{ email }` | Always 202 (does not reveal if the email exists). |
| POST | `/auth/password/reset` | `{ token, newPassword }` | 204. Token from the email link, single use, 30 min. |
| POST | `/auth/google` | `{ idToken }` | **501 until enabled.** Contract is final. |
| POST | `/auth/apple` | `{ identityToken, nonce? }` | **501 until enabled.** Contract is final. |
| POST | `/auth/link/google` 🔒 | `{ idToken }` | **501 until enabled.** |
| POST | `/auth/link/apple` 🔒 | `{ identityToken, nonce? }` | **501 until enabled.** |

Session response (guest, signup, login, refresh, password change):

```json
{
  "accessToken": "eyJ...", "accessTokenExpiresIn": 900,
  "refreshToken": "q1w2...", "refreshTokenExpiresAt": "2026-12-18T10:00:00.000Z",
  "user": { "id": "uuid", "email": null, "displayName": "Player_3FA2C1", "isGuest": true, "role": "player", "createdAt": "..." },
  "profile": { "...": "see above" }
}
```

## Player (`/me`) 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/me` | – | `{ user, profile, vehicles, inventory, activeAttempt }` — call after launch/sign-in. |
| PATCH | `/me` | `{ displayName }` | 3–24 chars: letters, digits, space, `_ . -`. |
| GET | `/me/transactions?limit=50&before=<iso>` | – | Wallet ledger, newest first. |
| POST | `/me/delete` | `{ confirm: "DELETE", password? }` | Permanently deletes the account. Password required for email accounts. |

## Config & catalogs (public)

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | Gameplay tunables (`xp_per_level`, `stamina_regen_seconds`, …). |
| GET | `/catalog/vehicles` | Buyable vehicles with prices, max upgrade level, level requirement. |
| GET | `/catalog/items` | All items: `category` Weapon/Outfit/VehiclePart/Consumable, `rarity`, `sellValueCash`. |

## Missions 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/missions/nearby?lat=&lng=&radius=` | – | Radius metres (default 2000, capped by config). |
| GET | `/missions/:id` | – | One mission. |
| POST | `/missions/:id/attempts` | `{ lat, lng }` | Start. Charges stamina, fixes rewards, returns `attempt` with `expiresAt`. |
| GET | `/missions/attempts/active` | – | `{ attempt }` or `{ attempt: null }` — use on app resume. |
| POST | `/missions/attempts/:id/complete` | `{ clientReport? }` | Grants rewards once. Repeat calls return the same result with `alreadyCompleted: true`. |
| POST | `/missions/attempts/:id/fail` | `{ clientReport? }` | Ends without reward; stamina not refunded. |
| POST | `/missions/attempts/:id/abandon` | `{ clientReport? }` | Player quit; same as fail. |
| POST | `/missions/attempts/:id/retry` | `{ lat, lng }` | Free restart (0 stamina) after fail/timeout, once, within 10 min. |
| GET | `/missions/history?limit=20` | – | Recent attempts. |

Nearby mission:

```json
{
  "id": "uuid", "title": "Trafalgar Square Drop", "description": "...",
  "missionType": "DeadDropCourier",
  "latitude": 51.508, "longitude": -0.1281, "triggerRadiusM": 35,
  "timeLimitS": 120, "requiredStamina": 15,
  "reward": { "cash": 750, "gems": 10, "xp": 300, "itemId": null },
  "minPlayerLevel": 1, "cooldownS": 3600,
  "distanceM": 12,
  "availability": { "canStart": true, "reason": null, "availableAt": null }
}
```

`availability.reason` can be `LEVEL_TOO_LOW`, `MISSION_ON_COOLDOWN` (with `availableAt`) or `MISSION_NOT_REPEATABLE`.

Complete response:

```json
{
  "attempt": { "id": "uuid", "status": "completed", "result": {
      "reward": { "cash": 750, "gems": 10, "xp": 300, "itemId": null, "itemGranted": false },
      "levelsGained": 0, "serverElapsedS": 48 } },
  "alreadyCompleted": false,
  "profile": { "...": "updated balances" }
}
```

Mission rules enforced by the server:

- One active attempt per player (`409 ATTEMPT_IN_PROGRESS`, details include the running `attemptId`).
- Start position must be within `triggerRadiusM + mission_proximity_tolerance_m` (default 150 m) → `403 TOO_FAR_FROM_MISSION`.
  Can be switched off with config `mission_proximity_enforced = false`.
- Stamina must cover `requiredStamina` → `409 NOT_ENOUGH_STAMINA`.
- Cooldown between completions (`cooldownS`, `null` = one-time mission).
- Deadline = `timeLimitS` (+45 s for HighRollerSprint checkpoint bonuses) + 30 s network grace → `409 ATTEMPT_EXPIRED`.
- Completing faster than the mission's minimum time → `422 COMPLETION_TOO_FAST`.
- `clientReport` (≤ 4 KB, any JSON object, e.g. `{ "elapsedSeconds": 48, "dronesDestroyed": 3 }`) is stored for review only.

## Garage 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/garage` | – | Owned vehicles with upgrades, next upgrade costs, paint/underglow. |
| POST | `/garage/:vehicleId/purchase` | – | 201. Charges `priceCash` **and** `priceGems`. `409 ALREADY_OWNED`, `403 LEVEL_TOO_LOW`. |
| POST | `/garage/:vehicleId/equip` | – | Must own it. |
| POST | `/garage/:vehicleId/upgrade` | `{ stat: "speed"\|"acceleration"\|"handling", fromLevel }` | Cost = `upgradeBaseCostCash × (fromLevel + 1)`. `fromLevel` must equal the current level (retry-safe). |
| PATCH | `/garage/:vehicleId/customization` | any of `{ hasCustomPaint, paintColor, hasCustomUnderglow, underglowEnabled, underglowColor }` | Colors are `{ r, g, b, a }` in 0–1, same as Unity `SerializableColor`. |

## Inventory & shop 🔒

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/inventory` | – | Items with quantity; outfits show `isEquipped`. |
| POST | `/inventory/:itemId/equip` | – | Outfits only. |
| POST | `/inventory/:itemId/sell` | `{ quantity? }` | **Idempotency-Key required.** Can't sell the last copy of the equipped outfit. |
| GET | `/shop/offers` | – | Active offers with `purchasedCount` / `maxPerUser`. |
| POST | `/shop/offers/:offerId/purchase` | – | **Idempotency-Key required.** 201. |

## Economy 🔒

| Method | Path | Notes |
|---|---|---|
| POST | `/economy/ads/reward` | `{ rewardType: "stamina"\|"bonus_cash" }`. **Idempotency-Key required.** Development mode only (501 otherwise) until server-side ad verification is added. Daily cap. |
| POST | `/economy/iap/verify` | `{ platform, productId, receipt }`. **501 placeholder** until store receipt verification is implemented. |
| POST | `/economy/dev/founders-pass` | Development mode only. Grants the pass once. |

## Admin 🔒 (role `admin`)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users?email=` | Search by email prefix. |
| GET | `/admin/users/:id` | User, profile, last 50 ledger rows. |
| POST | `/admin/users/:id/ban` / `/unban` | `{ reason }` for ban; revokes all sessions. |
| POST | `/admin/users/:id/wallet-adjustments` | `{ cash, gems, note }`. Idempotency-Key required. Ledgered. |
| GET / PUT | `/admin/config`, `/admin/config/:key` | `{ value }`, validated per key; applies within 30 s on every instance. |
| GET / POST / PATCH | `/admin/missions`, `/admin/missions/:id` | Create/edit missions (lat/lng, rewards, cooldown, schedule, active flag). |
| PUT | `/admin/vehicles/:id`, `/admin/items/:id`, `/admin/offers/:id` | Upsert catalog rows. Ids must match Unity ids. |

## Health

`GET /health` (process up) and `GET /health/ready` (database reachable, 503 otherwise).

## Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `details` lists `{ path, message }` per bad field. |
| 400 | `INVALID_JSON`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_RESET_TOKEN` | |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN` | Refresh and retry once; otherwise sign in again. |
| 401 | `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED` | Sign in again. |
| 403 | `ACCOUNT_BANNED`, `FORBIDDEN`, `LEVEL_TOO_LOW`, `TOO_FAR_FROM_MISSION`, `PURCHASE_LIMIT_REACHED` | |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `VEHICLE_NOT_OWNED`, `ITEM_NOT_OWNED` | |
| 409 | `EMAIL_TAKEN`, `ALREADY_REGISTERED`, `ALREADY_OWNED`, `INSUFFICIENT_FUNDS`, `NOT_ENOUGH_STAMINA` | |
| 409 | `ATTEMPT_IN_PROGRESS`, `ATTEMPT_NOT_ACTIVE`, `ATTEMPT_EXPIRED`, `MISSION_ON_COOLDOWN`, `MISSION_NOT_REPEATABLE`, `NOT_RETRYABLE`, `ALREADY_RETRIED` | |
| 409 | `UPGRADE_LEVEL_MISMATCH`, `MAX_LEVEL_REACHED`, `NOT_ENOUGH_ITEMS`, `ITEM_EQUIPPED`, `NOT_SELLABLE`, `NOT_EQUIPPABLE` | |
| 422 | `COMPLETION_TOO_FAST`, `IDEMPOTENCY_KEY_REUSED` | |
| 429 | `RATE_LIMITED`, `AD_DAILY_CAP_REACHED` | |
| 501 | `NOT_IMPLEMENTED` | Google/Apple sign-in, IAP verification, production ads. |
