import { pool } from './pool';
import { migrate } from './migrate';

migrate(pool, (msg) => console.log(`[migrate] ${msg}`))
  .then((applied) => console.log(applied.length ? `[migrate] ${applied.length} migration(s) applied.` : '[migrate] Database is up to date.'))
  .catch((err) => {
    console.error(`[migrate] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
