import { Client, Pool } from 'pg';
import { migrate } from '../src/db/migrate';

/** Creates a uniquely named test database. Never drops pre-existing databases. */
export default async function setup() {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  const dbName = testUrl.pathname.slice(1);
  if (!/^streetcred_it_[a-f0-9]{32}_test$/.test(dbName)) throw new Error('Invalid disposable test database name');

  const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL!);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname) ||
      testUrl.protocol !== adminUrl.protocol || testUrl.hostname !== adminUrl.hostname ||
      testUrl.port !== adminUrl.port || testUrl.username !== adminUrl.username ||
      testUrl.pathname === adminUrl.pathname) {
    throw new Error('Integration tests require a separate database on a local disposable PostGIS server');
  }
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${dbName}"`); }
  finally { await admin.end(); }

  const pool = new Pool({ connectionString: testUrl.toString() });
  // Keep the disposable database for inspection if migration/test setup fails.
  try { await migrate(pool); }
  finally { await pool.end(); }
  return async () => {
    const cleanup = new Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE "${dbName}" WITH (FORCE)`); }
    finally { await cleanup.end(); }
  };
}
