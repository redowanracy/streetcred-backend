import { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env';

// In-memory counters: fine for one instance. Use a shared store (e.g. Redis)
// before running several instances behind a load balancer.
function limiter(windowMs: number, limit: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
    },
  });
}

export const globalLimiter = limiter(60_000, 300, 'Too many requests, slow down');
/** Password guessing and account creation. */
export const credentialLimiter = limiter(15 * 60_000, 20, 'Too many attempts, try again later');
export const guestCreationLimiter = limiter(60 * 60_000, 10, 'Too many new guest accounts from this network');
