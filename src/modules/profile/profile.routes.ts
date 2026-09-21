import { Router } from 'express';
import { z } from 'zod';
import { pool, queryOne, queryRows } from '../../db/pool';
import { verifyPassword } from '../../lib/crypto';
import { AppError, unauthorized } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { displayName } from '../auth/auth.schemas';
import { UserRow, userView } from '../auth/auth.service';
import { getConfig } from '../game-config/game-config.service';
import { listGarage } from '../garage/garage.service';
import { listInventory } from '../inventory/inventory.service';
import { activeAttempt } from '../missions/missions.service';
import { profileSnapshot } from '../wallet/player-state';

export const profileRouter = Router();
profileRouter.use(requireAuth);

async function loadUser(userId: string) {
  const user = await queryOne<UserRow>(pool, 'SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) throw unauthorized();
  return user;
}

/** Everything the client needs after launch / sign-in, in one call. */
profileRouter.get('/', async (req, res) => {
  const userId = currentUser(req).id;
  const config = await getConfig();
  const [user, profile, vehicles, inventory, attempt] = await Promise.all([
    loadUser(userId),
    profileSnapshot(pool, userId, config),
    listGarage(pool, userId),
    listInventory(pool, userId),
    activeAttempt(pool, userId, config),
  ]);
  res.json({ user: userView(user), profile, vehicles, inventory, activeAttempt: attempt });
});

profileRouter.patch('/', async (req, res) => {
  const body = parse(z.object({ displayName }), req.body);
  const user = await queryOne<UserRow>(pool, 'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *', [
    currentUser(req).id,
    body.displayName,
  ]);
  res.json({ user: userView(user!) });
});

/** Wallet ledger, newest first. Page with ?before=<createdAt of last row>. */
profileRouter.get('/transactions', async (req, res) => {
  const q = parse(
    z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.iso.datetime().optional() }),
    req.query,
  );
  const rows = await queryRows<{
    id: string;
    reason: string;
    cash_delta: number;
    gems_delta: number;
    cash_after: number;
    gems_after: number;
    ref_type: string | null;
    ref_id: string | null;
    metadata: unknown;
    created_at: Date;
  }>(
    pool,
    `SELECT * FROM wallet_transactions WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC LIMIT $3`,
    [currentUser(req).id, q.before ?? null, q.limit],
  );
  res.json({
    transactions: rows.map((t) => ({
      id: t.id,
      reason: t.reason,
      cashDelta: t.cash_delta,
      gemsDelta: t.gems_delta,
      cashAfter: t.cash_after,
      gemsAfter: t.gems_after,
      refType: t.ref_type,
      refId: t.ref_id,
      metadata: t.metadata,
      createdAt: t.created_at.toISOString(),
    })),
  });
});

/**
 * Permanently deletes the account and all its data (required by Google Play / App Store).
 * Email accounts must confirm with their password; guests confirm with `confirm: "DELETE"`.
 */
profileRouter.post('/delete', async (req, res) => {
  const body = parse(z.object({ password: z.string().max(128).optional(), confirm: z.literal('DELETE') }), req.body);
  const user = await loadUser(currentUser(req).id);
  if (user.password_hash) {
    if (!body.password || !(await verifyPassword(body.password, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
    }
  }
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  res.status(204).end();
});
