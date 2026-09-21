import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const OPTIONS = { algorithm: 'HS256' as const, issuer: 'streetcred', audience: 'streetcred-client' };

export interface AccessClaims {
  sub: string;
  role: 'player' | 'admin';
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ role: claims.role, typ: 'access' }, env.JWT_SECRET, {
    ...OPTIONS,
    subject: claims.sub,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns the claims, or null for any invalid, expired or wrong-type token. */
export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [OPTIONS.algorithm],
      issuer: OPTIONS.issuer,
      audience: OPTIONS.audience,
    }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, role: payload.role === 'admin' ? 'admin' : 'player' };
  } catch {
    return null;
  }
}
