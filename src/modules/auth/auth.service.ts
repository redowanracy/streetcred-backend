import crypto from 'crypto';
import { PoolClient } from 'pg';
import { env } from '../../config/env';
import { Db, dbNow, pool, queryOne, withTransaction } from '../../db/pool';
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto';
import { AppError, conflict, unauthorized } from '../../lib/errors';
import { signAccessToken } from '../../lib/jwt';
import { mailer } from '../../lib/mailer';
import { getConfig } from '../game-config/game-config.service';
import { createPlayer, profileView, readProfile } from '../wallet/player-state';
import { ProviderIdentity, ProviderName } from './providers';

export interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  is_guest: boolean;
  role: 'player' | 'admin';
  is_banned: boolean;
  created_at: Date;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

/** A retried refresh within this window gets a fresh token instead of tripping reuse detection. */
const REFRESH_REUSE_GRACE_MS = 60_000;
const PASSWORD_RESET_TTL_MS = 30 * 60_000;

export const userView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  isGuest: u.is_guest,
  role: u.role,
  createdAt: u.created_at.toISOString(),
});

const defaultDisplayName = () => `Player_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

async function issueSession(tx: Db, user: UserRow, meta: SessionMeta, familyId: string = crypto.randomUUID()) {
  const refreshToken = randomToken(32);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const row = await queryOne<{ id: string }>(
    tx,
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user.id, familyId, sha256(refreshToken), expiresAt, meta.userAgent?.slice(0, 256) ?? null, meta.ip ?? null],
  );
  return {
    tokenId: row!.id,
    tokens: {
      accessToken: signAccessToken({ sub: user.id, role: user.role }),
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    },
  };
}

/** Standard body for every endpoint that signs someone in. */
async function sessionResponse(tx: Db, user: UserRow, meta: SessionMeta, familyId?: string) {
  const { tokens } = await issueSession(tx, user, meta, familyId);
  const [config, profile, now] = await Promise.all([getConfig(tx), readProfile(tx, user.id), dbNow(tx)]);
  return { ...tokens, user: userView(user), profile: profileView(profile, config, now) };
}

function ensureNotBanned(user: UserRow) {
  if (user.is_banned) throw new AppError(403, 'ACCOUNT_BANNED', 'This account has been suspended');
}

async function insertUser(tx: PoolClient, fields: { email?: string; passwordHash?: string; displayName?: string; isGuest: boolean }) {
  try {
    const user = await queryOne<UserRow>(
      tx,
      `INSERT INTO users (email, password_hash, display_name, is_guest) VALUES ($1, $2, $3, $4) RETURNING *`,
      [fields.email ?? null, fields.passwordHash ?? null, fields.displayName ?? defaultDisplayName(), fields.isGuest],
    );
    await createPlayer(tx, user!.id, await getConfig(tx));
    return user!;
  } catch (err: any) {
    if (err?.code === '23505' && String(err.constraint).includes('email')) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }
}

// ───────────────────────────── Guest / email accounts ─────────────────────────────

export function createGuest(displayName: string | undefined, meta: SessionMeta) {
  return withTransaction(async (tx) => {
    const user = await insertUser(tx, { displayName, isGuest: true });
    return sessionResponse(tx, user, meta);
  });
}

export async function signup(input: { email: string; password: string; displayName?: string }, meta: SessionMeta) {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (tx) => {
    const user = await insertUser(tx, { email: input.email, passwordHash, displayName: input.displayName, isGuest: false });
    return sessionResponse(tx, user, meta);
  });
}

export async function login(input: { email: string; password: string }, meta: SessionMeta) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE email = $1', [input.email]);
  if (!user?.password_hash) {
    await burnPasswordCheck(input.password);
    throw unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');
  }
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');
  }
  ensureNotBanned(user);
  return withTransaction(async (tx) => {
    await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return sessionResponse(tx, user, meta);
  });
}

/** Turns the signed-in guest into an email account, keeping all progress. */
export async function linkEmail(userId: string, input: { email: string; password: string; displayName?: string }) {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (tx) => {
    const current = await queryOne<UserRow>(tx, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!current) throw unauthorized();
    if (current.email) throw conflict('ALREADY_REGISTERED', 'This account already has an email login');
    try {
      const user = await queryOne<UserRow>(
        tx,
        `UPDATE users SET email = $2, password_hash = $3, is_guest = FALSE, display_name = COALESCE($4, display_name)
         WHERE id = $1 RETURNING *`,
        [userId, input.email, passwordHash, input.displayName ?? null],
      );
      return { user: userView(user!) };
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
  });
}

// ───────────────────────────── Sessions ─────────────────────────────

type Outcome<T> = { ok: T } | { error: AppError };

export async function refresh(refreshToken: string, meta: SessionMeta) {
  // Reuse detection must commit the family revocation *and* fail the request.
  const outcome = await withTransaction<Outcome<Awaited<ReturnType<typeof sessionResponse>>>>(async (tx) => {
    const token = await queryOne<{
      id: string;
      user_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      replaced_by: string | null;
    }>(tx, 'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(refreshToken)]);
    const invalid = { error: unauthorized('Refresh token is invalid', 'INVALID_REFRESH_TOKEN') };
    if (!token) return invalid;
    const now = await dbNow(tx);

    if (token.revoked_at) {
      const recentlyRotated = token.replaced_by && now.getTime() - token.revoked_at.getTime() <= REFRESH_REUSE_GRACE_MS;
      if (!recentlyRotated) {
        if (token.replaced_by) {
          await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [token.family_id]);
          return { error: unauthorized('Refresh token was already used; please sign in again', 'REFRESH_TOKEN_REUSED') };
        }
        return invalid;
      }
    }
    if (token.expires_at <= now) return { error: unauthorized('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED') };

    const user = await queryOne<UserRow>(tx, 'SELECT * FROM users WHERE id = $1', [token.user_id]);
    if (!user) return invalid;
    ensureNotBanned(user);

    const session = await issueSession(tx, user, meta, token.family_id);
    if (!token.revoked_at) {
      await tx.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [token.id, session.tokenId]);
    }
    const [config, profile] = await Promise.all([getConfig(tx), readProfile(tx, user.id)]);
    return { ok: { ...session.tokens, user: userView(user), profile: profileView(profile, config, now) } };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.ok;
}

/** Revokes one refresh token. Idempotent and silent for unknown tokens. */
export async function logout(refreshToken: string) {
  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(refreshToken)]);
}

export async function logoutAll(userId: string) {
  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

// ───────────────────────────── Passwords ─────────────────────────────

export async function changePassword(userId: string, currentPassword: string, newPassword: string, meta: SessionMeta) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!user?.password_hash) throw conflict('NO_PASSWORD', 'This account has no password; link an email first');
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  }
  const passwordHash = await hashPassword(newPassword);
  return withTransaction(async (tx) => {
    await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
    // Sign out every other device; this device gets a fresh session.
    await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return sessionResponse(tx, user, meta);
  });
}

/** Always succeeds from the caller's view so it cannot be used to discover registered emails. */
export async function requestPasswordReset(email: string) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE email = $1 AND password_hash IS NOT NULL', [email]);
  if (!user || user.is_banned) return;
  const token = randomToken(32);
  await pool.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    user.id,
    sha256(token),
    new Date(Date.now() + PASSWORD_RESET_TTL_MS),
  ]);
  await mailer.sendPasswordReset(email, token);
}

export async function resetPassword(token: string, newPassword: string) {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (tx) => {
    const row = await queryOne<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(token)],
    );
    if (!row) throw new AppError(400, 'INVALID_RESET_TOKEN', 'Reset link is invalid or has expired');
    await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
    await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [row.user_id, passwordHash]);
    await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
  });
}

// ───────────────────────────── Google / Apple (verification not enabled yet) ─────────────────────────────

/** Signs in (or creates) the account bound to a verified provider identity. */
export function signInWithProvider(provider: ProviderName, identity: ProviderIdentity, meta: SessionMeta) {
  return withTransaction(async (tx) => {
    const existing = await queryOne<UserRow>(
      tx,
      `SELECT u.* FROM auth_identities ai JOIN users u ON u.id = ai.user_id
       WHERE ai.provider = $1 AND ai.provider_subject = $2`,
      [provider, identity.subject],
    );
    if (existing) {
      ensureNotBanned(existing);
      await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [existing.id]);
      return sessionResponse(tx, existing, meta);
    }
    const email = identity.email && identity.emailVerified ? identity.email.toLowerCase() : undefined;
    if (email && (await queryOne(tx, 'SELECT 1 FROM users WHERE email = $1', [email]))) {
      throw conflict('EMAIL_TAKEN_LINK_REQUIRED', `Sign in with your password, then link ${provider} from settings`);
    }
    const user = await insertUser(tx, { email, isGuest: false });
    await tx.query('INSERT INTO auth_identities (user_id, provider, provider_subject, email) VALUES ($1, $2, $3, $4)', [
      user.id,
      provider,
      identity.subject,
      identity.email ?? null,
    ]);
    return sessionResponse(tx, user, meta);
  });
}

/** Attaches a verified provider identity to the signed-in account (guests become registered). */
export function linkProvider(userId: string, provider: ProviderName, identity: ProviderIdentity) {
  return withTransaction(async (tx) => {
    try {
      await tx.query('INSERT INTO auth_identities (user_id, provider, provider_subject, email) VALUES ($1, $2, $3, $4)', [
        userId,
        provider,
        identity.subject,
        identity.email ?? null,
      ]);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('PROVIDER_ALREADY_LINKED', `This ${provider} account is already linked`);
      throw err;
    }
    const user = await queryOne<UserRow>(tx, 'UPDATE users SET is_guest = FALSE WHERE id = $1 RETURNING *', [userId]);
    return { user: userView(user!) };
  });
}
