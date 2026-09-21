import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vitest/config';

dotenv.config({ quiet: true });

// Each invocation gets a new disposable database; never reset a shared *_test DB.
const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error('DATABASE_URL is not set (run `npm run setup:env` and `npm run db:up`)');
const testUrl = new URL(devUrl);
testUrl.pathname = `/streetcred_it_${randomUUID().replaceAll('-', '')}_test`;
// Read by test/global-setup.ts, which runs in this process rather than a test worker.
process.env.TEST_DATABASE_URL = testUrl.toString();
process.env.TEST_ADMIN_DATABASE_URL = devUrl;

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), ENABLE_DEV_MONETIZATION: 'true' },
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
