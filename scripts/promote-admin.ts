// Usage: npm run admin:promote -- someone@example.com
// Grants the admin role to an existing email account. Takes effect on the next request.
import { pool } from '../src/db/pool';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Usage: npm run admin:promote -- <email>');
  const result = await pool.query(`UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id`, [email]);
  if (!result.rowCount) throw new Error(`No account with email ${email}`);
  console.log(`[admin:promote] ${email} is now an admin.`);
}

main()
  .catch((err) => {
    console.error(`[admin:promote] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
