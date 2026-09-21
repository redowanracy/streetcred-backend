import { NextFunction, Request, Response } from 'express';
import { pool, queryOne } from '../db/pool';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';

export interface AuthUser {
  id: string;
  role: 'player' | 'admin';
  isGuest: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Verifies the bearer access token, then re-reads the user so bans, deletions
 * and role changes take effect immediately rather than when the token expires.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  const claims = verifyAccessToken(header.slice(7).trim());
  if (!claims) throw unauthorized('Invalid or expired access token', 'INVALID_TOKEN');

  const user = await queryOne<{ id: string; role: 'player' | 'admin'; is_guest: boolean; is_banned: boolean }>(
    pool,
    'SELECT id, role, is_guest, is_banned FROM users WHERE id = $1',
    [claims.sub],
  );
  if (!user) throw unauthorized('Account no longer exists', 'INVALID_TOKEN');
  if (user.is_banned) throw new AppError(403, 'ACCOUNT_BANNED', 'This account has been suspended');

  req.user = { id: user.id, role: user.role, isGuest: user.is_guest };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') throw forbidden('Admin access required');
  next();
}

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
