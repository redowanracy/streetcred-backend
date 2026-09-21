import { afterEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { api, AT_TRAFALGAR, bearer, createMission, newGuest, newUser, setConfig } from './helpers';

const start = (token: string, missionId: string, pos = AT_TRAFALGAR) =>
  api().post(`/api/v1/missions/${missionId}/attempts`).set(bearer(token)).send(pos);
const complete = (token: string, attemptId: string, clientReport?: object) =>
  api().post(`/api/v1/missions/attempts/${attemptId}/complete`).set(bearer(token)).send(clientReport ? { clientReport } : {});

afterEach(async () => {
  await setConfig('mission_proximity_enforced', true);
});

describe('the handoff flow: login → profile → mission → attempt → result → claim once → reload', () => {
  it('pays the server-defined reward exactly once and the balance survives a reload', async () => {
    const user = await newUser();
    const login = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    const token = login.body.accessToken;

    const before = (await api().get('/api/v1/me').set(bearer(token))).body.profile;
    const mission = await createMission({ reward_cash: 750, reward_gems: 10, reward_xp: 300, required_stamina: 15 });

    const nearby = await api().get('/api/v1/missions/nearby').query({ ...AT_TRAFALGAR, radius: 500 }).set(bearer(token));
    expect(nearby.body.missions.some((m: any) => m.id === mission.id)).toBe(true);

    const started = await start(token, mission.id);
    expect(started.status).toBe(201);
    expect(started.body.profile.stamina.current).toBe(before.stamina.current - 15);

    const done = await complete(token, started.body.attempt.id, { elapsedSeconds: 42 });
    expect(done.status).toBe(200);
    expect(done.body.alreadyCompleted).toBe(false);
    expect(done.body.profile.cash).toBe(before.cash + 750);
    expect(done.body.profile.gems).toBe(before.gems + 10);
    expect(done.body.profile.xp).toBe(300);

    const retried = await complete(token, started.body.attempt.id);
    expect(retried.status).toBe(200);
    expect(retried.body.alreadyCompleted).toBe(true);
    expect(retried.body.profile.cash).toBe(before.cash + 750);

    const relogin = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    const reloaded = (await api().get('/api/v1/me').set(bearer(relogin.body.accessToken))).body.profile;
    expect(reloaded.cash).toBe(before.cash + 750);
    expect(reloaded.gems).toBe(before.gems + 10);
  });
});

describe('nearby missions', () => {
  it('uses real PostGIS distance, integer metres, and respects the radius', async () => {
    const guest = await newGuest();
    const near = await createMission({ lat: 51.5081, lng: -0.1281 }); // ~11 m north
    const far = await createMission({ lat: 51.52, lng: -0.1281 }); // ~1.3 km north

    const res = await api().get('/api/v1/missions/nearby').query({ ...AT_TRAFALGAR, radius: 500 }).set(bearer(guest.accessToken));
    expect(res.status).toBe(200);
    const nearRow = res.body.missions.find((m: any) => m.id === near.id);
    expect(nearRow.distanceM).toBeGreaterThanOrEqual(10);
    expect(nearRow.distanceM).toBeLessThanOrEqual(12);
    expect(Number.isInteger(nearRow.distanceM)).toBe(true);
    expect(nearRow.availability).toEqual({ canStart: true, reason: null, availableAt: null });
    expect(res.body.missions.some((m: any) => m.id === far.id)).toBe(false);
    for (const m of res.body.missions) expect(m.distanceM).toBeLessThanOrEqual(500);
  });

  it('fetches a single mission and hides inactive ones', async () => {
    const guest = await newGuest();
    const mission = await createMission({ reward_cash: 640 });
    const res = await api().get(`/api/v1/missions/${mission.id}`).set(bearer(guest.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.mission).toMatchObject({ id: mission.id, reward: { cash: 640 }, missionType: 'DeadDropCourier' });

    await pool.query('UPDATE missions SET is_active = FALSE WHERE id = $1', [mission.id]);
    expect((await api().get(`/api/v1/missions/${mission.id}`).set(bearer(guest.accessToken))).status).toBe(404);
    expect((await api().get('/api/v1/missions/not-a-uuid').set(bearer(guest.accessToken))).status).toBe(400);
  });

  it('caps the radius and validates coordinates', async () => {
    const guest = await newGuest();
    const huge = await api().get('/api/v1/missions/nearby').query({ ...AT_TRAFALGAR, radius: 10_000_000 }).set(bearer(guest.accessToken));
    expect(huge.body.radiusM).toBe(10000);
    const bad = await api().get('/api/v1/missions/nearby').query({ lat: 95, lng: 0 }).set(bearer(guest.accessToken));
    expect(bad.status).toBe(400);
  });
});

describe('starting attempts', () => {
  it('rejects a start from too far away when proximity is enforced', async () => {
    const guest = await newGuest();
    const mission = await createMission();
    const res = await start(guest.accessToken, mission.id, { lat: 51.52, lng: -0.1281 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TOO_FAR_FROM_MISSION');

    await setConfig('mission_proximity_enforced', false);
    expect((await start(guest.accessToken, mission.id, { lat: 51.52, lng: -0.1281 })).status).toBe(201);
  });

  it('allows one active attempt at a time', async () => {
    const guest = await newGuest();
    const a = await createMission();
    const b = await createMission();
    const first = await start(guest.accessToken, a.id);
    const second = await start(guest.accessToken, b.id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ATTEMPT_IN_PROGRESS');
    expect(second.body.error.details.attemptId).toBe(first.body.attempt.id);

    const active = await api().get('/api/v1/missions/attempts/active').set(bearer(guest.accessToken));
    expect(active.body.attempt.id).toBe(first.body.attempt.id);
  });

  it('refuses when stamina is too low and never goes negative', async () => {
    const guest = await newGuest();
    const mission = await createMission({ required_stamina: 150 });
    const res = await start(guest.accessToken, mission.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ENOUGH_STAMINA');
  });

  it('enforces cooldowns and one-time missions', async () => {
    const guest = await newGuest();
    const repeatable = await createMission({ cooldown_s: 3600 });
    const once = await createMission({ cooldown_s: null });

    const a = await start(guest.accessToken, repeatable.id);
    await complete(guest.accessToken, a.body.attempt.id);
    const again = await start(guest.accessToken, repeatable.id);
    expect(again.body.error.code).toBe('MISSION_ON_COOLDOWN');
    expect(again.body.error.details.availableAt).toBeTruthy();

    const b = await start(guest.accessToken, once.id);
    await complete(guest.accessToken, b.body.attempt.id);
    expect((await start(guest.accessToken, once.id)).body.error.code).toBe('MISSION_NOT_REPEATABLE');

    const nearby = await api().get('/api/v1/missions/nearby').query({ ...AT_TRAFALGAR, radius: 200 }).set(bearer(guest.accessToken));
    expect(nearby.body.missions.find((m: any) => m.id === repeatable.id).availability.reason).toBe('MISSION_ON_COOLDOWN');
  });

  it('enforces the minimum player level', async () => {
    const guest = await newGuest();
    const mission = await createMission({ min_player_level: 5 });
    const res = await start(guest.accessToken, mission.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('LEVEL_TOO_LOW');
  });
});

describe('finishing attempts', () => {
  it('pays exactly once under concurrent completion requests', async () => {
    const guest = await newGuest();
    const mission = await createMission({ reward_cash: 1000 });
    const started = await start(guest.accessToken, mission.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => complete(guest.accessToken, started.body.attempt.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.alreadyCompleted)).toHaveLength(1);

    const me = await api().get('/api/v1/me').set(bearer(guest.accessToken));
    expect(me.body.profile.cash).toBe(5000 + 1000);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM wallet_transactions WHERE user_id = $1 AND reason = 'mission_reward'`, [guest.user.id]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects implausibly fast completions', async () => {
    const guest = await newGuest();
    const mission = await createMission({ min_completion_s: 30 });
    const started = await start(guest.accessToken, mission.id);
    const res = await complete(guest.accessToken, started.body.attempt.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPLETION_TOO_FAST');
    expect((await api().get('/api/v1/me').set(bearer(guest.accessToken))).body.profile.cash).toBe(5000);
  });

  it('expires attempts past their time limit without paying', async () => {
    const guest = await newGuest();
    const mission = await createMission();
    const started = await start(guest.accessToken, mission.id);
    await pool.query(`UPDATE mission_attempts SET expires_at = now() - interval '1 second' WHERE id = $1`, [started.body.attempt.id]);

    const res = await complete(guest.accessToken, started.body.attempt.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ATTEMPT_EXPIRED');
    const history = await api().get('/api/v1/missions/history').set(bearer(guest.accessToken));
    expect(history.body.attempts[0]).toMatchObject({ id: started.body.attempt.id, status: 'expired' });
    // A new mission can start once the old one expired.
    expect((await start(guest.accessToken, (await createMission()).id)).status).toBe(201);
  });

  it('allows one free retry after a failure, without charging stamina again', async () => {
    const guest = await newGuest();
    const mission = await createMission({ required_stamina: 20 });
    const started = await start(guest.accessToken, mission.id);
    const failed = await api().post(`/api/v1/missions/attempts/${started.body.attempt.id}/fail`).set(bearer(guest.accessToken)).send({});
    expect(failed.body.attempt).toMatchObject({ status: 'failed', canRetryFree: true });

    const retry = await api().post(`/api/v1/missions/attempts/${started.body.attempt.id}/retry`).set(bearer(guest.accessToken)).send(AT_TRAFALGAR);
    expect(retry.status).toBe(201);
    expect(retry.body.attempt.staminaCharged).toBe(0);
    expect(retry.body.profile.stamina.current).toBe(80);

    await api().post(`/api/v1/missions/attempts/${retry.body.attempt.id}/fail`).set(bearer(guest.accessToken)).send({});
    const second = await api().post(`/api/v1/missions/attempts/${retry.body.attempt.id}/retry`).set(bearer(guest.accessToken)).send(AT_TRAFALGAR);
    expect(second.body.error.code).toBe('NOT_RETRYABLE');
    const twice = await api().post(`/api/v1/missions/attempts/${started.body.attempt.id}/retry`).set(bearer(guest.accessToken)).send(AT_TRAFALGAR);
    expect(twice.status).toBe(409);
  });

  it('abandoning ends the attempt without reward or refund', async () => {
    const guest = await newGuest();
    const mission = await createMission();
    const started = await start(guest.accessToken, mission.id);
    const res = await api().post(`/api/v1/missions/attempts/${started.body.attempt.id}/abandon`).set(bearer(guest.accessToken)).send({});
    expect(res.body.attempt.status).toBe('abandoned');
    expect(res.body.profile.stamina.current).toBe(85);
    expect((await complete(guest.accessToken, started.body.attempt.id)).body.error.code).toBe('ATTEMPT_NOT_ACTIVE');
  });

  it("cannot touch another player's attempt", async () => {
    const owner = await newGuest();
    const other = await newGuest();
    const started = await start(owner.accessToken, (await createMission()).id);
    expect((await complete(other.accessToken, started.body.attempt.id)).status).toBe(404);
  });

  it('levels up with the Unity XP curve (level * 1000)', async () => {
    const guest = await newGuest();
    const mission = await createMission({ reward_xp: 3500 });
    const started = await start(guest.accessToken, mission.id);
    const done = await complete(guest.accessToken, started.body.attempt.id);
    // 1000 to leave L1, 2000 to leave L2 → level 3 with 500 left over.
    expect(done.body.profile).toMatchObject({ level: 3, xp: 500, totalXp: 3500, xpToNextLevel: 3000 });
    expect(done.body.attempt.result.levelsGained).toBe(2);
  });

  it('grants a reward item', async () => {
    await pool.query(`INSERT INTO item_catalog (id, name, category, sell_value_cash, is_stackable) VALUES ('test_reward_chip', 'Chip', 'Consumable', 10, TRUE) ON CONFLICT DO NOTHING`);
    const guest = await newGuest();
    const started = await start(guest.accessToken, (await createMission({ reward_item_id: 'test_reward_chip' })).id);
    await complete(guest.accessToken, started.body.attempt.id);
    const inv = await api().get('/api/v1/inventory').set(bearer(guest.accessToken));
    expect(inv.body.items.find((i: any) => i.itemId === 'test_reward_chip').quantity).toBe(1);
  });
});

describe('stamina regeneration', () => {
  it('regenerates one point per interval up to max and keeps partial progress', async () => {
    const guest = await newGuest();
    await pool.query(
      `UPDATE player_profiles SET stamina = 10, stamina_updated_at = now() - interval '370 seconds' WHERE user_id = $1`,
      [guest.user.id],
    );
    const me = await api().get('/api/v1/me').set(bearer(guest.accessToken));
    // 370 s / 180 s = 2 whole points; the extra 10 s carry towards the next point.
    expect(me.body.profile.stamina.current).toBe(12);
    const nextIn = (Date.parse(me.body.profile.stamina.nextPointAt) - Date.now()) / 1000;
    expect(nextIn).toBeGreaterThan(165);
    expect(nextIn).toBeLessThan(175);

    await pool.query(`UPDATE player_profiles SET stamina_updated_at = now() - interval '1 day' WHERE user_id = $1`, [guest.user.id]);
    const full = await api().get('/api/v1/me').set(bearer(guest.accessToken));
    expect(full.body.profile.stamina).toMatchObject({ current: 100, nextPointAt: null });
  });
});
