/**
 * Calls every endpoint against a throwaway database and records the real
 * responses in docs/examples.json, which scripts/generate-postman.ts embeds as
 * Postman examples. It fails if any endpoint in the OpenAPI spec is missed.
 *
 *   npx tsx scripts/capture-examples.ts
 */
import fs from 'fs';
import path from 'path';
import { Client, Pool } from 'pg';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test'; // silent logs, no rate limits, fast password hashing
process.env.ENABLE_DEV_MONETIZATION = 'true';

async function main() {
  // ── throwaway database ────────────────────────────────────────────────
  require('dotenv').config({ quiet: true });
  const devUrl = new URL(process.env.DATABASE_URL!);
  const dbName = `${devUrl.pathname.slice(1)}_examples`;
  const adminClient = new Client({ connectionString: devUrl.toString() });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();
  const exampleUrl = new URL(devUrl.toString());
  exampleUrl.pathname = `/${dbName}`;
  process.env.DATABASE_URL = exampleUrl.toString();

  // Loaded after DATABASE_URL is set, because config/env reads it at import time.
  const { migrate } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  const { pool } = require('../src/db/pool') as typeof import('../src/db/pool');
  const { createApp } = require('../src/app') as typeof import('../src/app');
  const { mailer } = require('../src/lib/mailer') as typeof import('../src/lib/mailer');
  const request = require('supertest') as typeof import('supertest');
  await migrate(new Pool({ connectionString: exampleUrl.toString() }));

  const app = createApp();
  const api = () => request(app);
  const examples: Record<string, { status: number; body: unknown; requestBody?: unknown }> = {};
  const guid = () => crypto.randomUUID();

  /** Examples are committed to the repo, so never store real credentials in them. */
  function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => {
          if (k === 'accessToken') return [k, '<access token — a signed JWT>'];
          if (k === 'refreshToken') return [k, '<refresh token — store it securely>'];
          return [k, redact(v)];
        }),
      );
    }
    return value;
  }

  /** Runs one request and stores the response under its OpenAPI path key. */
  async function call(
    key: string,
    run: (r: ReturnType<typeof api>) => any,
    opts: { body?: unknown } = {},
  ) {
    const res = await run(api());
    examples[key] = { status: res.status, body: redact(res.body ?? null), ...(opts.body ? { requestBody: opts.body } : {}) };
    return res;
  }
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ── health & public ───────────────────────────────────────────────────
  await call('GET /health', (r) => r.get('/api/v1/health'));
  await call('GET /health/ready', (r) => r.get('/api/v1/health/ready'));
  await call('GET /config', (r) => r.get('/api/v1/config'));

  // ── player accounts ───────────────────────────────────────────────────
  const guest = (await call('POST /auth/guest', (r) => r.post('/api/v1/auth/guest').send({ displayName: 'Postman Player' }), { body: { displayName: 'Postman Player' } })).body;
  let token = guest.accessToken;

  const adminEmail = 'admin@example.com';
  const adminSignup = (await call('POST /auth/signup', (r) =>
    r.post('/api/v1/auth/signup').send({ email: adminEmail, password: 'correct-horse-battery' }),
  { body: { email: adminEmail, password: 'correct-horse-battery' } })).body;
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminSignup.user.id]);
  const adminToken = (await call('POST /auth/login', (r) =>
    r.post('/api/v1/auth/login').send({ email: adminEmail, password: 'correct-horse-battery' }),
  { body: { email: adminEmail, password: 'correct-horse-battery' } })).body.accessToken;

  // ── admin builds the catalog, so these examples show real content ─────
  const A = auth(adminToken);
  await call('PUT /admin/vehicles/{id}', (r) =>
    r.put('/api/v1/admin/vehicles/veh_night_interceptor').set(A).send({ name: 'Night Interceptor', description: 'Fast street racer.', priceCash: 4000, upgradeBaseCostCash: 750, minPlayerLevel: 1, sortOrder: 10 }));
  await call('PUT /admin/items/{id}', (r) =>
    r.put('/api/v1/admin/items/outfit_neon_jacket').set(A).send({ name: 'Neon Jacket', description: 'Glows in the dark.', category: 'Outfit', rarity: 'Rare', sellValueCash: 400 }));
  await pool.query(`INSERT INTO item_catalog (id, name, category, rarity, sell_value_cash, is_stackable) VALUES ('consumable_nitro', 'Nitro Canister', 'Consumable', 'Common', 50, TRUE)`);
  await call('PUT /admin/offers/{id}', (r) =>
    r.put('/api/v1/admin/offers/offer_nitro_pack').set(A).send({ title: 'Nitro pack x3', itemId: 'consumable_nitro', quantity: 3, priceCash: 300, sortOrder: 10 }));

  const created = (await call('POST /admin/missions', (r) =>
    r.post('/api/v1/admin/missions').set(A).send({
      title: 'Trafalgar Square Drop',
      description: 'Retrieve the encrypted memory stick before rival syndicates intercept.',
      missionType: 'DeadDropCourier',
      latitude: 51.508, longitude: -0.1281,
      triggerRadiusM: 35, timeLimitS: 120, requiredStamina: 15,
      rewardCash: 750, rewardGems: 10, rewardXp: 300, minCompletionS: 0,
    }))).body.mission;
  await call('PATCH /admin/missions/{id}', (r) => r.patch(`/api/v1/admin/missions/${created.id}`).set(A).send({ rewardGems: 12 }));
  await call('GET /admin/missions', (r) => r.get('/api/v1/admin/missions').query({ limit: 5 }).set(A));
  await call('GET /admin/config', (r) => r.get('/api/v1/admin/config').set(A));
  await call('PUT /admin/config/{key}', (r) => r.put('/api/v1/admin/config/stamina_regen_seconds').set(A).send({ value: 180 }));
  await call('GET /admin/users', (r) => r.get('/api/v1/admin/users').query({ email: 'admin' }).set(A));
  await call('GET /admin/users/{id}', (r) => r.get(`/api/v1/admin/users/${guest.user.id}`).set(A));
  await call('POST /admin/users/{id}/wallet-adjustments', (r) =>
    r.post(`/api/v1/admin/users/${guest.user.id}/wallet-adjustments`).set(A).set('Idempotency-Key', guid()).send({ cash: 500, note: 'Support refund for failed mission' }));

  // A separate account shows ban/unban without locking the example player out.
  const banned = (await api().post('/api/v1/auth/guest').send({})).body;
  await call('POST /admin/users/{id}/ban', (r) => r.post(`/api/v1/admin/users/${banned.user.id}/ban`).set(A).send({ reason: 'Automated cheating detection' }));
  await call('POST /admin/users/{id}/unban', (r) => r.post(`/api/v1/admin/users/${banned.user.id}/unban`).set(A));

  // ── player state ──────────────────────────────────────────────────────
  const P = () => auth(token);
  await call('GET /me', (r) => r.get('/api/v1/me').set(P()));
  await call('PATCH /me', (r) => r.patch('/api/v1/me').set(P()).send({ displayName: 'Neon Rider' }));
  await call('GET /catalog/vehicles', (r) => r.get('/api/v1/catalog/vehicles'));
  await call('GET /catalog/items', (r) => r.get('/api/v1/catalog/items'));

  // ── missions ──────────────────────────────────────────────────────────
  const at = { lat: 51.508, lng: -0.1281 };
  await call('GET /missions/nearby', (r) => r.get('/api/v1/missions/nearby').query({ ...at, radius: 2000 }).set(P()));
  await call('GET /missions/{id}', (r) => r.get(`/api/v1/missions/${created.id}`).set(P()));
  const attempt = (await call('POST /missions/{id}/attempts', (r) =>
    r.post(`/api/v1/missions/${created.id}/attempts`).set(P()).set('Idempotency-Key', guid()).send(at))).body.attempt;
  await call('GET /missions/attempts/active', (r) => r.get('/api/v1/missions/attempts/active').set(P()));
  await call('POST /missions/attempts/{id}/complete', (r) =>
    r.post(`/api/v1/missions/attempts/${attempt.id}/complete`).set(P()).send({ clientReport: { elapsedSeconds: 48, objectivesCompleted: 2 } }));

  // A second mission shows fail → free retry → abandon.
  const second = (await api().post('/api/v1/admin/missions').set(A).send({
    title: 'Piccadilly Cyber Skirmish', description: 'Neutralize 3 rogue combat drones in AR space.',
    missionType: 'TurfSkirmishAR', latitude: 51.51, longitude: -0.1345, requiredStamina: 20, rewardCash: 1200, rewardGems: 15, rewardXp: 500,
  })).body.mission;
  const failing = (await api().post(`/api/v1/missions/${second.id}/attempts`).set(P()).send({ lat: 51.51, lng: -0.1345 })).body.attempt;
  await call('POST /missions/attempts/{id}/fail', (r) =>
    r.post(`/api/v1/missions/attempts/${failing.id}/fail`).set(P()).send({ clientReport: { reason: 'timer expired' } }));
  const retried = (await call('POST /missions/attempts/{id}/retry', (r) =>
    r.post(`/api/v1/missions/attempts/${failing.id}/retry`).set(P()).set('Idempotency-Key', guid()).send({ lat: 51.51, lng: -0.1345 }))).body.attempt;
  await call('POST /missions/attempts/{id}/abandon', (r) => r.post(`/api/v1/missions/attempts/${retried.id}/abandon`).set(P()).send({}));
  await call('GET /missions/history', (r) => r.get('/api/v1/missions/history').query({ limit: 20 }).set(P()));

  // ── garage ────────────────────────────────────────────────────────────
  await call('GET /garage', (r) => r.get('/api/v1/garage').set(P()));
  await call('POST /garage/{id}/purchase', (r) => r.post('/api/v1/garage/veh_night_interceptor/purchase').set(P()).set('Idempotency-Key', guid()));
  await call('POST /garage/{id}/equip', (r) => r.post('/api/v1/garage/veh_night_interceptor/equip').set(P()));
  await call('POST /garage/{id}/upgrade', (r) =>
    r.post('/api/v1/garage/veh_night_interceptor/upgrade').set(P()).set('Idempotency-Key', guid()).send({ stat: 'speed', fromLevel: 0 }));
  await call('PATCH /garage/{id}/customization', (r) =>
    r.patch('/api/v1/garage/veh_night_interceptor/customization').set(P()).send({ paintColor: { r: 1, g: 0, b: 0.5, a: 1 }, underglowEnabled: true }));

  // ── shop & inventory ──────────────────────────────────────────────────
  await call('GET /shop/offers', (r) => r.get('/api/v1/shop/offers').set(P()));
  await call('POST /shop/offers/{id}/purchase', (r) => r.post('/api/v1/shop/offers/offer_nitro_pack/purchase').set(P()).set('Idempotency-Key', guid()));
  await call('GET /inventory', (r) => r.get('/api/v1/inventory').set(P()));
  await call('POST /inventory/{id}/equip', (r) => r.post('/api/v1/inventory/outfit_street_jacket/equip').set(P()));
  await call('POST /inventory/{id}/sell', (r) =>
    r.post('/api/v1/inventory/consumable_nitro/sell').set(P()).set('Idempotency-Key', guid()).send({ quantity: 1 }));

  // ── economy ───────────────────────────────────────────────────────────
  await call('POST /economy/ads/reward', (r) =>
    r.post('/api/v1/economy/ads/reward').set(P()).set('Idempotency-Key', guid()).send({ rewardType: 'stamina' }));
  await call('POST /economy/dev/founders-pass', (r) => r.post('/api/v1/economy/dev/founders-pass').set(P()).set('Idempotency-Key', guid()));
  await call('POST /economy/iap/verify', (r) =>
    r.post('/api/v1/economy/iap/verify').set(P()).send({ platform: 'google_play', productId: 'founders_pass', receipt: 'purchase-token-from-the-store' }));

  await call('GET /me/transactions', (r) => r.get('/api/v1/me/transactions').query({ limit: 5 }).set(P()));

  // ── the rest of auth ──────────────────────────────────────────────────
  await call('POST /auth/refresh', (r) => r.post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken }));
  await call('POST /auth/google', (r) => r.post('/api/v1/auth/google').send({ idToken: 'google-id-token' }));
  await call('POST /auth/apple', (r) => r.post('/api/v1/auth/apple').send({ identityToken: 'apple-identity-token' }));
  await call('POST /auth/link/google', (r) => r.post('/api/v1/auth/link/google').set(P()).send({ idToken: 'google-id-token' }));
  await call('POST /auth/link/apple', (r) => r.post('/api/v1/auth/link/apple').set(P()).send({ identityToken: 'apple-identity-token' }));

  // Guest → email account, on a fresh guest so the example player stays a guest.
  const linkable = (await api().post('/api/v1/auth/guest').send({})).body;
  await call('POST /auth/link/email', (r) =>
    r.post('/api/v1/auth/link/email').set(auth(linkable.accessToken)).send({ email: 'player@example.com', password: 'correct-horse-battery' }));

  // Password reset: grab the emailed token by intercepting the mailer.
  let resetToken = '';
  const realSend = mailer.sendPasswordReset;
  mailer.sendPasswordReset = async (to: string, t: string) => { resetToken = t; };
  await call('POST /auth/password/forgot', (r) => r.post('/api/v1/auth/password/forgot').send({ email: 'player@example.com' }));
  mailer.sendPasswordReset = realSend;
  await call('POST /auth/password/reset', (r) => r.post('/api/v1/auth/password/reset').send({ token: resetToken, newPassword: 'a-new-strong-password' }));

  const changer = (await api().post('/api/v1/auth/signup').send({ email: 'changer@example.com', password: 'correct-horse-battery' })).body;
  await call('POST /auth/password/change', (r) =>
    r.post('/api/v1/auth/password/change').set(auth(changer.accessToken)).send({ currentPassword: 'correct-horse-battery', newPassword: 'a-new-strong-password' }));

  const loggingOut = (await api().post('/api/v1/auth/guest').send({})).body;
  await call('POST /auth/logout', (r) => r.post('/api/v1/auth/logout').send({ refreshToken: loggingOut.refreshToken }));
  await call('POST /auth/logout-all', (r) => r.post('/api/v1/auth/logout-all').set(auth(loggingOut.accessToken)));

  const doomed = (await api().post('/api/v1/auth/guest').send({})).body;
  await call('POST /me/delete', (r) => r.post('/api/v1/me/delete').set(auth(doomed.accessToken)).send({ confirm: 'DELETE' }));

  // ── check every documented endpoint was exercised ─────────────────────
  const spec = parseYaml(fs.readFileSync(path.join(root, 'docs/openapi.yaml'), 'utf8'));
  const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([p, ops]) =>
    Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${p}`),
  );
  const missing = documented.filter((k) => !(k in examples));
  const extra = Object.keys(examples).filter((k) => !documented.includes(k));
  const failures = Object.entries(examples).filter(([, e]) => e.status >= 500 && e.status !== 501);

  fs.writeFileSync(path.join(root, 'docs/examples.json'), JSON.stringify(examples, null, 2) + '\n');
  console.log(`[examples] captured ${Object.keys(examples).length} of ${documented.length} endpoints`);
  if (missing.length) console.error('[examples] NOT CALLED:\n  ' + missing.join('\n  '));
  if (extra.length) console.error('[examples] unknown keys:\n  ' + extra.join('\n  '));
  if (failures.length) console.error('[examples] unexpected server errors:\n  ' + failures.map(([k, e]) => `${k} → ${e.status}`).join('\n  '));
  await pool.end();
  if (missing.length || extra.length || failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
