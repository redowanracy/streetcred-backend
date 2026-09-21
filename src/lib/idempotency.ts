import { Request } from 'express';
import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AppError, badRequest } from './errors';
import { sha256Hex } from './crypto';

export interface HandlerResult {
  status: number;
  body: unknown;
  replayed?: boolean;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Runs `work` in a transaction. When the request carries an `Idempotency-Key`
 * header, the first successful response is stored in the same transaction and
 * returned verbatim to any retry with that key, so a flaky connection can never
 * charge or reward twice. Concurrent retries block on the key row until the
 * first request commits. Failed requests store nothing and can be retried.
 */
export async function runIdempotent(
  req: Request,
  userId: string,
  options: { required: boolean },
  work: (tx: PoolClient) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const key = req.get('idempotency-key');
  if (!key) {
    if (options.required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header (e.g. a GUID) per action');
    return withTransaction(work);
  }
  if (!KEY_PATTERN.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]');

  const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const requestHash = sha256Hex(JSON.stringify({ route, params: req.params, body: req.body ?? null }));

  return withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, route, request_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING key`,
      [userId, key, route, requestHash],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await tx.query(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      const saved = rows[0];
      if (!saved || saved.request_hash !== requestHash) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      return { status: saved.status_code, body: saved.response, replayed: true };
    }

    const result = await work(tx);
    await tx.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2', [
      userId,
      key,
      result.status,
      JSON.stringify(result.body),
    ]);
    return result;
  });
}
