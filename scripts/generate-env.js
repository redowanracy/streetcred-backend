// Creates a private .env from .env.example with fresh random secrets. Never overwrites.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

if (fs.existsSync(envPath)) {
  console.error('[setup:env] .env already exists; refusing to overwrite it.');
  process.exit(1);
}

const dbPassword = crypto.randomBytes(18).toString('base64url');
const content = fs
  .readFileSync(path.join(root, '.env.example'), 'utf8')
  .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
  .replace(/^DB_PASSWORD=.*$/m, `DB_PASSWORD=${dbPassword}`)
  .replace(/CHANGE_ME@/, `${dbPassword}@`);

const fd = fs.openSync(envPath, 'wx', 0o600);
try {
  fs.writeFileSync(fd, content, 'utf8');
} finally {
  fs.closeSync(fd);
}
console.log('[setup:env] Created .env with a new JWT secret and database password (not printed).');
