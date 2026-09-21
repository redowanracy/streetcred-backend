import { describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { mailer } from '../src/lib/mailer';
import { linkProvider, signInWithProvider } from '../src/modules/auth/auth.service';
import { api, bearer, newGuest, newUser, uniqueEmail } from './helpers';

describe('guest accounts', () => {
  it('creates a guest with starting profile, starter vehicle and outfit', async () => {
    const guest = await newGuest('Drifter One');
    expect(guest.user.isGuest).toBe(true);
    expect(guest.user.displayName).toBe('Drifter One');
    expect(guest.profile).toMatchObject({ cash: 5000, gems: 50, level: 1, xp: 0 });
    expect(guest.profile.stamina).toMatchObject({ current: 100, max: 100 });

    const me = await api().get('/api/v1/me').set(bearer(guest.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.vehicles.map((v: any) => v.vehicleId)).toEqual(['veh_starter_drifter']);
    expect(me.body.vehicles[0].isEquipped).toBe(true);
    expect(me.body.inventory.map((i: any) => i.itemId)).toEqual(['outfit_street_jacket']);
    expect(me.body.activeAttempt).toBeNull();
  });

  it('ledgers the starting balance', async () => {
    const guest = await newGuest();
    const res = await api().get('/api/v1/me/transactions').set(bearer(guest.accessToken));
    expect(res.body.transactions).toEqual([expect.objectContaining({ reason: 'account_created', cashAfter: 5000, gemsAfter: 50 })]);
  });

  it('keeps all progress when a guest links an email, then logs in with it', async () => {
    const guest = await newGuest();
    await pool.query('UPDATE player_profiles SET cash = 1234 WHERE user_id = $1', [guest.user.id]);
    const email = uniqueEmail();

    const link = await api().post('/api/v1/auth/link/email').set(bearer(guest.accessToken)).send({ email, password: 'a-strong-password' });
    expect(link.status).toBe(200);
    expect(link.body.user).toMatchObject({ id: guest.user.id, email, isGuest: false });

    const login = await api().post('/api/v1/auth/login').send({ email, password: 'a-strong-password' });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(guest.user.id);
    expect(login.body.profile.cash).toBe(1234);

    const again = await api().post('/api/v1/auth/link/email').set(bearer(guest.accessToken)).send({ email: uniqueEmail(), password: 'another-password' });
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });
});

describe('email signup and login', () => {
  it('signs up, normalises email, and rejects duplicates', async () => {
    const email = uniqueEmail();
    const res = await api().post('/api/v1/auth/signup').send({ email: `  ${email.toUpperCase()} `, password: 'long-enough-pw' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, isGuest: false });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();

    const dup = await api().post('/api/v1/auth/signup').send({ email, password: 'long-enough-pw' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('validates input', async () => {
    const res = await api().post('/api/v1/auth/signup').send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: any) => d.path).sort()).toEqual(['email', 'password']);
  });

  it('logs in with the right password only, with one generic error', async () => {
    const user = await newUser();
    const ok = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.user.id);

    const wrong = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'wrong-password' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: uniqueEmail(), password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('stores passwords hashed, never in plain text', async () => {
    const user = await newUser();
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.user.id]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(user.password);
  });
});

describe('access and refresh tokens', () => {
  it('rejects missing, forged and refresh-token bearer credentials', async () => {
    const guest = await newGuest();
    expect((await api().get('/api/v1/me')).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer('forged.token.value'))).status).toBe(401);
    expect((await api().get('/api/v1/me').set(bearer(guest.refreshToken))).status).toBe(401);
  });

  it('rotates refresh tokens and tolerates a quick retry of the old one', async () => {
    const guest = await newGuest();
    const first = await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(guest.refreshToken);
    expect(first.body.user.id).toBe(guest.user.id);

    // Lost response, client retries with the old token within the grace window.
    const retry = await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken });
    expect(retry.status).toBe(200);
  });

  it('revokes the whole login when an old refresh token is replayed later', async () => {
    const guest = await newGuest();
    const rotated = await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken });
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = $1 AND revoked_at IS NOT NULL`, [guest.user.id]);

    const replay = await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    const victim = await api().post('/api/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(victim.status).toBe(401);
  });

  it('logout revokes the refresh token; logout-all revokes every device', async () => {
    const user = await newUser();
    const second = await api().post('/api/v1/auth/login').send({ email: user.email, password: user.password });

    expect((await api().post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken })).status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken })).status).toBe(401);

    expect((await api().post('/api/v1/auth/logout-all').set(bearer(second.body.accessToken))).status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: second.body.refreshToken })).status).toBe(401);
  });

  it('blocks banned accounts immediately', async () => {
    const guest = await newGuest();
    await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [guest.user.id]);
    const me = await api().get('/api/v1/me').set(bearer(guest.accessToken));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('ACCOUNT_BANNED');
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: guest.refreshToken })).status).toBe(403);
  });
});

describe('passwords', () => {
  it('changes password and signs out other devices', async () => {
    const user = await newUser();
    const wrong = await api()
      .post('/api/v1/auth/password/change')
      .set(bearer(user.accessToken))
      .send({ currentPassword: 'nope-nope', newPassword: 'brand-new-password' });
    expect(wrong.status).toBe(401);

    const ok = await api()
      .post('/api/v1/auth/password/change')
      .set(bearer(user.accessToken))
      .send({ currentPassword: user.password, newPassword: 'brand-new-password' });
    expect(ok.status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken })).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: ok.body.refreshToken })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'brand-new-password' })).status).toBe(200);
  });

  it('resets a forgotten password with a single-use token', async () => {
    const user = await newUser();
    const spy = vi.spyOn(mailer, 'sendPasswordReset').mockResolvedValue();

    const unknown = await api().post('/api/v1/auth/password/forgot').send({ email: uniqueEmail() });
    expect(unknown.status).toBe(202);
    expect(spy).not.toHaveBeenCalled();

    const forgot = await api().post('/api/v1/auth/password/forgot').send({ email: user.email });
    expect(forgot.status).toBe(202);
    const token = spy.mock.calls[0][1];
    spy.mockRestore();

    const reset = await api().post('/api/v1/auth/password/reset').send({ token, newPassword: 'recovered-password' });
    expect(reset.status).toBe(204);
    const reuse = await api().post('/api/v1/auth/password/reset').send({ token, newPassword: 'another-password' });
    expect(reuse.body.error.code).toBe('INVALID_RESET_TOKEN');
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'recovered-password' })).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken })).status).toBe(401);
  });
});

describe('Google / Apple placeholders', () => {
  it('returns 501 until provider verification is enabled', async () => {
    const google = await api().post('/api/v1/auth/google').send({ idToken: 'x' });
    const apple = await api().post('/api/v1/auth/apple').send({ identityToken: 'x' });
    expect(google.status).toBe(501);
    expect(apple.status).toBe(501);
    expect(google.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 501 for linking a provider to a signed-in account', async () => {
    const guest = await newGuest();
    const google = await api().post('/api/v1/auth/link/google').set(bearer(guest.accessToken)).send({ idToken: 'x' });
    const apple = await api().post('/api/v1/auth/link/apple').set(bearer(guest.accessToken)).send({ identityToken: 'x' });
    expect([google.status, apple.status]).toEqual([501, 501]);
    // Still requires authentication, so the contract stays the same once enabled.
    expect((await api().post('/api/v1/auth/link/google').send({ idToken: 'x' })).status).toBe(401);
  });

  it('account flow behind the verifier already works (sign-in, repeat sign-in, email clash)', async () => {
    const identity = { subject: `google-sub-${Date.now()}`, email: uniqueEmail(), emailVerified: true };
    const first = await signInWithProvider('google', identity, {});
    const second = await signInWithProvider('google', identity, {});
    expect(second.user.id).toBe(first.user.id);
    expect(first.user.isGuest).toBe(false);

    const existing = await newUser();
    await expect(signInWithProvider('apple', { subject: 'apple-sub-x', email: existing.email, emailVerified: true }, {})).rejects.toMatchObject({
      code: 'EMAIL_TAKEN_LINK_REQUIRED',
    });
  });

  it('linking a provider promotes a guest and refuses a second use of the same provider account', async () => {
    const guest = await newGuest();
    const identity = { subject: `apple-sub-${Date.now()}` };
    const linked = await linkProvider(guest.user.id, 'apple', identity);
    expect(linked.user).toMatchObject({ id: guest.user.id, isGuest: false });

    const other = await newGuest();
    await expect(linkProvider(other.user.id, 'apple', identity)).rejects.toMatchObject({ code: 'PROVIDER_ALREADY_LINKED' });
    await expect(linkProvider(guest.user.id, 'apple', { subject: 'apple-sub-different' })).rejects.toMatchObject({ code: 'PROVIDER_ALREADY_LINKED' });
  });
});

describe('profile basics', () => {
  it('renames the player and validates the new name', async () => {
    const guest = await newGuest();
    const ok = await api().patch('/api/v1/me').set(bearer(guest.accessToken)).send({ displayName: 'Neon Rider' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.displayName).toBe('Neon Rider');
    expect((await api().get('/api/v1/me').set(bearer(guest.accessToken))).body.user.displayName).toBe('Neon Rider');

    const bad = await api().patch('/api/v1/me').set(bearer(guest.accessToken)).send({ displayName: 'a' });
    expect(bad.status).toBe(400);
    const illegal = await api().patch('/api/v1/me').set(bearer(guest.accessToken)).send({ displayName: 'drop<table>' });
    expect(illegal.status).toBe(400);
  });
});

describe('account deletion', () => {
  it('deletes a guest without a password', async () => {
    const guest = await newGuest();
    expect((await api().post('/api/v1/me/delete').set(bearer(guest.accessToken)).send({})).status).toBe(400);
    expect((await api().post('/api/v1/me/delete').set(bearer(guest.accessToken)).send({ confirm: 'DELETE' })).status).toBe(204);
    expect((await api().get('/api/v1/me').set(bearer(guest.accessToken))).status).toBe(401);
  });

  it('requires the password for email accounts and removes all data', async () => {
    const user = await newUser();
    const bad = await api().post('/api/v1/me/delete').set(bearer(user.accessToken)).send({ confirm: 'DELETE', password: 'wrong-one' });
    expect(bad.status).toBe(401);
    const ok = await api().post('/api/v1/me/delete').set(bearer(user.accessToken)).send({ confirm: 'DELETE', password: user.password });
    expect(ok.status).toBe(204);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM player_profiles WHERE user_id = $1', [user.user.id]);
    expect(rows[0].n).toBe(0);
    expect((await api().get('/api/v1/me').set(bearer(user.accessToken))).status).toBe(401);
  });
});
