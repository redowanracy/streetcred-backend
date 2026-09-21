import { createApp } from './app';
import { env } from './config/env';
import { pool } from './db/pool';
import { migrate } from './db/migrate';
import { logger } from './lib/logger';

const HOUR_MS = 3_600_000;

/** Housekeeping: drop expired credentials and old idempotency records. */
async function cleanup() {
  try {
    await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`);
  } catch (err) {
    logger.warn({ err }, 'Cleanup job failed');
  }
}

async function main() {
  await migrate(pool, (msg) => logger.info(`[migrate] ${msg}`));
  const server = createApp().listen(env.PORT, env.HOST, () => logger.info(`Street Cred API listening on http://${env.HOST}:${env.PORT}/api/v1`));
  void cleanup();
  const timer = setInterval(cleanup, HOUR_MS);

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    clearInterval(timer);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
