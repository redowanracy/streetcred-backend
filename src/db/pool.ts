import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';

// BIGINT (int8) arrives as a string by default; our bigints (total XP, counts) fit in a double.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'Idle database client error'));

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = Pick<PoolClient, 'query'>;

export async function queryRows<T extends QueryResultRow>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(db, text, params);
  return rows[0];
}

/** Database clock. Inside a transaction this is the transaction start time, used for every timing rule. */
export async function dbNow(db: Db): Promise<Date> {
  const row = await queryOne<{ now: Date }>(db, 'SELECT now() AS now');
  return row!.now;
}

const RETRYABLE =new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * Runs `fn` inside a READ COMMITTED transaction. Player state is serialized with
 * row locks (`SELECT ... FOR UPDATE` on the profile), so this is enough for
 * correctness; deadlocks are retried a few times.
 */
export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (RETRYABLE.has(err?.code) && attempt < 3) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
