import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { api, bearer, idemKey, newAdmin, newGuest } from './helpers';

beforeAll(async () => {
  await pool.query(`
    INSERT INTO vehicle_catalog (id, name, price_cash, price_gems, max_upgrade_level, upgrade_base_cost_cash, min_player_level) VALUES
      ('test_car_cash', 'Cash Car', 3000, 0, 2, 500, 1),
      ('test_car_gems', 'Gem Car', 0, 40, 5, 500, 1),
      ('test_car_pricey', 'Pricey Car', 999999, 0, 5, 500, 1),
      ('test_car_locked', 'Locked Car', 100, 0, 5, 500, 10)
    ON CONFLICT (id) DO NOTHING`);
  await pool.query(`
    INSERT INTO item_catalog (id, name, category, sell_value_cash, is_stackable) VALUES
      ('test_outfit_neon', 'Neon', 'Outfit', 400, FALSE),
      ('test_nitro', 'Nitro', 'Consumable', 50, TRUE)
    ON CONFLICT (id) DO NOTHING`);
  await pool.query(`
    INSERT INTO store_offers (id, title, item_id, quantity, price_cash, price_gems, max_per_user) VALUES
      ('test_offer_neon', 'Neon', 'test_outfit_neon', 1, 3000, 0, NULL),
      ('test_offer_nitro', 'Nitro x3', 'test_nitro', 3, 300, 0, 2)
    ON CONFLICT (id) DO NOTHING`);
});

const cashOf = async (token: string) => (await api().get('/api/v1/me').set(bearer(token))).body.profile.cash as number;

describe('garage', () => {
  it('lists the vehicle and item catalogs publicly', async () => {
    const vehicles = await api().get('/api/v1/catalog/vehicles');
    expect(vehicles.status).toBe(200);
    expect(vehicles.body.vehicles.some((v: any) => v.id === 'veh_starter_drifter')).toBe(true);

    const items = await api().get('/api/v1/catalog/items');
    expect(items.status).toBe(200);
    expect(items.body.items.find((i: any) => i.id === 'test_nitro')).toMatchObject({
      category: 'Consumable',
      rarity: 'Common',
      sellValueCash: 50,
      isStackable: true,
    });
  });

  it('buys with cash or gems, then refuses a second purchase', async () => {
    const guest = await newGuest();
    const buy = await api().post('/api/v1/garage/test_car_cash/purchase').set(bearer(guest.accessToken));
    expect(buy.status).toBe(201);
    expect(buy.body.profile.cash).toBe(2000);
    expect(buy.body.vehicle).toMatchObject({ vehicleId: 'test_car_cash', isEquipped: false });

    const gems = await api().post('/api/v1/garage/test_car_gems/purchase').set(bearer(guest.accessToken));
    expect(gems.body.profile.gems).toBe(10);

    const again = await api().post('/api/v1/garage/test_car_cash/purchase').set(bearer(guest.accessToken));
    expect(again.body.error.code).toBe('ALREADY_OWNED');
  });

  it('rejects unaffordable, level-locked and unknown vehicles', async () => {
    const guest = await newGuest();
    expect((await api().post('/api/v1/garage/test_car_pricey/purchase').set(bearer(guest.accessToken))).body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await api().post('/api/v1/garage/test_car_locked/purchase').set(bearer(guest.accessToken))).body.error.code).toBe('LEVEL_TOO_LOW');
    expect((await api().post('/api/v1/garage/nope/purchase').set(bearer(guest.accessToken))).status).toBe(404);
    expect(await cashOf(guest.accessToken)).toBe(5000);
  });

  it('never overspends under concurrent purchases', async () => {
    const guest = await newGuest(); // 5000 cash, two things costing 3000 each
    const [car, outfit] = await Promise.all([
      api().post('/api/v1/garage/test_car_cash/purchase').set(bearer(guest.accessToken)),
      api().post('/api/v1/shop/offers/test_offer_neon/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()),
    ]);
    expect([car.status, outfit.status].sort()).toEqual([201, 409]);
    expect(await cashOf(guest.accessToken)).toBe(2000);
  });

  it('equips only owned vehicles', async () => {
    const guest = await newGuest();
    expect((await api().post('/api/v1/garage/test_car_cash/equip').set(bearer(guest.accessToken))).body.error.code).toBe('VEHICLE_NOT_OWNED');
    await api().post('/api/v1/garage/test_car_cash/purchase').set(bearer(guest.accessToken));
    const eq = await api().post('/api/v1/garage/test_car_cash/equip').set(bearer(guest.accessToken));
    expect(eq.body.profile.equippedVehicleId).toBe('test_car_cash');
  });

  it('upgrades with increasing cost, refuses retries and max level', async () => {
    const guest = await newGuest();
    await api().post('/api/v1/garage/test_car_gems/purchase').set(bearer(guest.accessToken));
    const up = (fromLevel: number) =>
      api().post('/api/v1/garage/test_car_gems/upgrade').set(bearer(guest.accessToken)).send({ stat: 'speed', fromLevel });

    const first = await up(0);
    expect(first.status).toBe(200);
    expect(first.body.vehicle.upgrades.speed).toBe(1);
    expect(first.body.profile.cash).toBe(4500); // 500 * 1
    expect(first.body.vehicle.nextUpgradeCostCash.speed).toBe(1000);

    const retry = await up(0);
    expect(retry.body.error.code).toBe('UPGRADE_LEVEL_MISMATCH');
    expect((await up(1)).body.profile.cash).toBe(3500); // 500 * 2
  });

  it('stops at the maximum upgrade level', async () => {
    const guest = await newGuest();
    await api().post('/api/v1/garage/test_car_cash/purchase').set(bearer(guest.accessToken)); // max level 2
    const up = (fromLevel: number) =>
      api().post('/api/v1/garage/test_car_cash/upgrade').set(bearer(guest.accessToken)).send({ stat: 'handling', fromLevel });
    await up(0);
    await up(1);
    expect((await up(2)).body.error.code).toBe('MAX_LEVEL_REACHED');
  });

  it('saves paint and underglow', async () => {
    const guest = await newGuest();
    const res = await api()
      .patch('/api/v1/garage/veh_starter_drifter/customization')
      .set(bearer(guest.accessToken))
      .send({ paintColor: { r: 1, g: 0, b: 0.5 }, underglowEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.vehicle.customization).toMatchObject({
      hasCustomPaint: true,
      paintColor: { r: 1, g: 0, b: 0.5, a: 1 },
      underglowEnabled: false,
    });
    const garage = await api().get('/api/v1/garage').set(bearer(guest.accessToken));
    expect(garage.body.vehicles[0].customization.paintColor).toEqual({ r: 1, g: 0, b: 0.5, a: 1 });

    const bad = await api().patch('/api/v1/garage/veh_starter_drifter/customization').set(bearer(guest.accessToken)).send({ paintColor: { r: 2, g: 0, b: 0 } });
    expect(bad.status).toBe(400);
  });
});

describe('idempotency keys', () => {
  it('replays the stored response for a retried request and charges once', async () => {
    const guest = await newGuest();
    const key = idemKey();
    const buy = () => api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', key);
    const [a, b, c] = await Promise.all([buy(), buy(), buy()]);
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
    expect(await cashOf(guest.accessToken)).toBe(4700);
  });

  it('rejects reusing a key for a different request, and requires keys where needed', async () => {
    const guest = await newGuest();
    const key = idemKey();
    await api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', key);
    const other = await api().post('/api/v1/shop/offers/test_offer_neon/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken));
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('does not store failed requests, so they can be retried', async () => {
    const guest = await newGuest();
    await pool.query('UPDATE player_profiles SET cash = 100 WHERE user_id = $1', [guest.user.id]);
    const key = idemKey();
    const buy = () => api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', key);
    expect((await buy()).status).toBe(409);
    await pool.query('UPDATE player_profiles SET cash = 1000 WHERE user_id = $1', [guest.user.id]);
    expect((await buy()).status).toBe(201);
  });
});

describe('shop and inventory', () => {
  it('stacks consumables and enforces per-user purchase limits', async () => {
    const guest = await newGuest();
    const buy = () => api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    await buy();
    await buy();
    const third = await buy();
    expect(third.body.error.code).toBe('PURCHASE_LIMIT_REACHED');
    const inv = await api().get('/api/v1/inventory').set(bearer(guest.accessToken));
    expect(inv.body.items.find((i: any) => i.itemId === 'test_nitro').quantity).toBe(6);
    const offers = await api().get('/api/v1/shop/offers').set(bearer(guest.accessToken));
    expect(offers.body.offers.find((o: any) => o.id === 'test_offer_nitro').purchasedCount).toBe(2);
  });

  it('sells items for their value and protects the equipped outfit', async () => {
    const guest = await newGuest();
    await api().post('/api/v1/shop/offers/test_offer_nitro/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    const sell = await api().post('/api/v1/inventory/test_nitro/sell').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({ quantity: 2 });
    expect(sell.body.sale).toMatchObject({ quantitySold: 2, cashEarned: 100, remaining: 1 });
    expect(sell.body.profile.cash).toBe(5000 - 300 + 100);
    const tooMany = await api().post('/api/v1/inventory/test_nitro/sell').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({ quantity: 5 });
    expect(tooMany.body.error.code).toBe('NOT_ENOUGH_ITEMS');

    await api().post('/api/v1/shop/offers/test_offer_neon/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    const equip = await api().post('/api/v1/inventory/test_outfit_neon/equip').set(bearer(guest.accessToken));
    expect(equip.body.profile.equippedOutfitId).toBe('test_outfit_neon');
    const sellEquipped = await api().post('/api/v1/inventory/test_outfit_neon/sell').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({});
    expect(sellEquipped.body.error.code).toBe('ITEM_EQUIPPED');
    const sellStarter = await api().post('/api/v1/inventory/outfit_street_jacket/sell').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({});
    expect(sellStarter.body.error.code).toBe('NOT_SELLABLE');
  });

  it('does not sell a non-stackable item twice', async () => {
    const guest = await newGuest();
    await api().post('/api/v1/shop/offers/test_offer_neon/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    const again = await api().post('/api/v1/shop/offers/test_offer_neon/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    expect(again.body.error.code).toBe('ALREADY_OWNED');
  });
});

describe('monetization (development mode)', () => {
  it('rewarded ad restores stamina capped at max, and enforces the daily cap', async () => {
    const guest = await newGuest();
    await pool.query('UPDATE player_profiles SET stamina = 50 WHERE user_id = $1', [guest.user.id]);
    const ad = await api().post('/api/v1/economy/ads/reward').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({ rewardType: 'stamina' });
    expect(ad.status).toBe(200);
    expect(ad.body.profile.stamina.current).toBe(80);

    const cash = await api().post('/api/v1/economy/ads/reward').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({ rewardType: 'bonus_cash' });
    expect(cash.body.profile.cash).toBe(5500);

    await pool.query(`INSERT INTO ad_reward_claims (user_id, reward_type) SELECT $1, 'stamina' FROM generate_series(1, 8)`, [guest.user.id]);
    const capped = await api().post('/api/v1/economy/ads/reward').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey()).send({ rewardType: 'stamina' });
    expect(capped.status).toBe(429);
  });

  it('grants the Founders Pass once', async () => {
    const guest = await newGuest();
    const first = await api().post('/api/v1/economy/dev/founders-pass').set(bearer(guest.accessToken));
    expect(first.body.profile).toMatchObject({ hasFoundersPass: true, cash: 15000, gems: 550 });
    expect((await api().post('/api/v1/economy/dev/founders-pass').set(bearer(guest.accessToken))).body.error.code).toBe('ALREADY_OWNED');
  });

  it('keeps real IAP verification as a 501 placeholder', async () => {
    const guest = await newGuest();
    const res = await api().post('/api/v1/economy/iap/verify').set(bearer(guest.accessToken)).send({ platform: 'google_play', productId: 'founders_pass', receipt: 'x' });
    expect(res.status).toBe(501);
  });
});

describe('admin', () => {
  it('is admin-only', async () => {
    const guest = await newGuest();
    expect((await api().get('/api/v1/admin/users').set(bearer(guest.accessToken))).status).toBe(403);
  });

  it('creates and edits missions, including partial updates', async () => {
    const admin = await newAdmin();
    const created = await api()
      .post('/api/v1/admin/missions')
      .set(bearer(admin.accessToken))
      .send({ title: 'Admin Sprint', missionType: 'HighRollerSprint', latitude: 23.8103, longitude: 90.4125, rewardCash: 999 });
    expect(created.status).toBe(201);
    expect(created.body.mission).toMatchObject({ title: 'Admin Sprint', latitude: 23.8103, longitude: 90.4125, reward: { cash: 999, gems: 5 } });

    const patched = await api().patch(`/api/v1/admin/missions/${created.body.mission.id}`).set(bearer(admin.accessToken)).send({ rewardGems: 42 });
    expect(patched.body.mission.reward).toMatchObject({ cash: 999, gems: 42 });
    expect(patched.body.mission.title).toBe('Admin Sprint');
  });

  it('changes game config with validation and it takes effect immediately', async () => {
    const admin = await newAdmin();
    const bad = await api().put('/api/v1/admin/config/starting_cash').set(bearer(admin.accessToken)).send({ value: -5 });
    expect(bad.status).toBe(400);
    const ok = await api().put('/api/v1/admin/config/starting_cash').set(bearer(admin.accessToken)).send({ value: 7777 });
    expect(ok.status).toBe(200);
    expect((await newGuest()).profile.cash).toBe(7777);
    await api().put('/api/v1/admin/config/starting_cash').set(bearer(admin.accessToken)).send({ value: 5000 });
  });

  it('finds players by email and shows their profile with recent ledger rows', async () => {
    const admin = await newAdmin();
    const player = await newGuest();
    await api()
      .post(`/api/v1/admin/users/${player.user.id}/wallet-adjustments`)
      .set(bearer(admin.accessToken))
      .set('Idempotency-Key', idemKey())
      .send({ cash: 10, note: 'test' });

    const search = await api().get('/api/v1/admin/users').query({ email: admin.email }).set(bearer(admin.accessToken));
    expect(search.status).toBe(200);
    expect(search.body.users[0]).toMatchObject({ id: admin.user.id, email: admin.email, isBanned: false });

    const detail = await api().get(`/api/v1/admin/users/${player.user.id}`).set(bearer(admin.accessToken));
    expect(detail.body.user.id).toBe(player.user.id);
    expect(detail.body.profile.cash).toBe(5010);
    expect(detail.body.recentTransactions[0].reason).toBe('admin_adjustment');
    expect((await api().get(`/api/v1/admin/users/${admin.user.id.replace(/.$/, '0')}`).set(bearer(admin.accessToken))).status).toBeGreaterThanOrEqual(400);
  });

  it('lists missions and the full config table', async () => {
    const admin = await newAdmin();
    const missions = await api().get('/api/v1/admin/missions').query({ limit: 5 }).set(bearer(admin.accessToken));
    expect(missions.status).toBe(200);
    expect(missions.body.missions.length).toBeGreaterThan(0);
    expect(missions.body.missions[0]).toHaveProperty('isActive');

    const config = await api().get('/api/v1/admin/config').set(bearer(admin.accessToken));
    expect(config.body.config.some((c: any) => c.key === 'xp_per_level')).toBe(true);
    expect(config.body.effective.xp_per_level).toBe(1000);
  });

  it('upserts catalog rows, which players see immediately', async () => {
    const admin = await newAdmin();
    const hdr = bearer(admin.accessToken);

    const vehicle = await api().put('/api/v1/admin/vehicles/admin_test_car').set(hdr).send({ name: 'Admin Car', priceCash: 1200 });
    expect(vehicle.body.vehicle).toMatchObject({ id: 'admin_test_car', name: 'Admin Car', priceCash: 1200 });
    const renamed = await api().put('/api/v1/admin/vehicles/admin_test_car').set(hdr).send({ name: 'Admin Car II', priceCash: 900 });
    expect(renamed.body.vehicle).toMatchObject({ name: 'Admin Car II', priceCash: 900 });

    const item = await api().put('/api/v1/admin/items/admin_test_item').set(hdr).send({ name: 'Admin Item', category: 'Consumable', sellValueCash: 25, isStackable: true });
    expect(item.body.item).toMatchObject({ id: 'admin_test_item', category: 'Consumable' });

    const badOffer = await api().put('/api/v1/admin/offers/admin_test_offer').set(hdr).send({ title: 'Nope', itemId: 'does_not_exist' });
    expect(badOffer.status).toBe(404);
    const offer = await api().put('/api/v1/admin/offers/admin_test_offer').set(hdr).send({ title: 'Admin Offer', itemId: 'admin_test_item', quantity: 2, priceCash: 100 });
    expect(offer.status).toBe(200);

    // A player can now buy exactly what the admin created.
    const guest = await newGuest();
    const buy = await api().post('/api/v1/shop/offers/admin_test_offer/purchase').set(bearer(guest.accessToken)).set('Idempotency-Key', idemKey());
    expect(buy.status).toBe(201);
    expect(buy.body.purchase).toMatchObject({ itemId: 'admin_test_item', quantityGranted: 2 });
    expect(buy.body.profile.cash).toBe(4900);
    const car = await api().post('/api/v1/garage/admin_test_car/purchase').set(bearer(guest.accessToken));
    expect(car.status).toBe(201);
  });

  it('unbans players', async () => {
    const admin = await newAdmin();
    const guest = await newGuest();
    await api().post(`/api/v1/admin/users/${guest.user.id}/ban`).set(bearer(admin.accessToken)).send({ reason: 'test' });
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken })).status).toBe(403);

    const unban = await api().post(`/api/v1/admin/users/${guest.user.id}/unban`).set(bearer(admin.accessToken));
    expect(unban.status).toBe(204);
    // A guest's refresh token is their only credential, so an unban must give the account back.
    const fresh = await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken });
    expect(fresh.status).toBe(200);
    expect((await api().get('/api/v1/me').set(bearer(fresh.body.accessToken))).status).toBe(200);
    expect((await api().post('/api/v1/admin/users/00000000-0000-0000-0000-000000000000/unban').set(bearer(admin.accessToken))).status).toBe(404);
  });

  it('adjusts wallets through the ledger and bans players', async () => {
    const admin = await newAdmin();
    const guest = await newGuest();
    const adj = await api()
      .post(`/api/v1/admin/users/${guest.user.id}/wallet-adjustments`)
      .set(bearer(admin.accessToken))
      .set('Idempotency-Key', idemKey())
      .send({ cash: 250, note: 'support refund' });
    expect(adj.body.profile.cash).toBe(5250);
    const tx = await api().get('/api/v1/me/transactions').set(bearer(guest.accessToken));
    expect(tx.body.transactions[0]).toMatchObject({ reason: 'admin_adjustment', cashDelta: 250, metadata: { note: 'support refund' } });

    const ban = await api().post(`/api/v1/admin/users/${guest.user.id}/ban`).set(bearer(admin.accessToken)).send({ reason: 'cheating' });
    expect(ban.status).toBe(204);
    expect((await api().get('/api/v1/me').set(bearer(guest.accessToken))).status).toBe(403);
  });
});

describe('misc', () => {
  it('serves health and public config', async () => {
    expect((await api().get('/api/v1/health')).body.status).toBe('ok');
    expect((await api().get('/api/v1/health/ready')).body.status).toBe('ready');
    const cfg = await api().get('/api/v1/config');
    expect(cfg.body.config).toMatchObject({ xp_per_level: 1000, stamina_regen_seconds: 180 });
  });

  it('returns JSON errors for bad JSON and unknown routes', async () => {
    const bad = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    expect((await api().get('/api/v1/nope')).body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});
