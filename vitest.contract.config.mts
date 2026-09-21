import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vitest/config';

// Documentation/HTTP contract checks only. No migrations, seed scripts, database
// reset or persistent network listener. Never inherit a handed-off DB credential.
export default defineConfig({
  test: {
    include: ['test/openapi.test.ts'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: randomBytes(48).toString('hex'),
      DATABASE_URL: 'postgresql://contract:unused@127.0.0.1:1/contract_no_database',
      ENABLE_DEV_MONETIZATION: 'false',
      LOG_LEVEL: 'silent',
    },
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
