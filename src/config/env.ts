import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Local by default. Set explicitly for a private LAN test or reverse proxy.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JWT_SECRET: z
    .string({ error: 'JWT_SECRET is required (run `npm run setup:env`)' })
    .refine((s) => Buffer.byteLength(s) >= 32, 'JWT_SECRET must be at least 32 bytes'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((o) => o.trim()).filter(Boolean) : [])),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  ENABLE_DEV_MONETIZATION: bool,
  DEV_LOG_PASSWORD_RESET_LINKS: bool,
  PASSWORD_RESET_URL_BASE: z.string().default('https://example.invalid/reset-password'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

const raw = parsed.data;
const isProduction = raw.NODE_ENV === 'production';

export const env = {
  ...raw,
  isProduction,
  // Development shortcuts are never honoured in production, whatever the flag says.
  devMonetization: !isProduction && raw.ENABLE_DEV_MONETIZATION,
  devLogPasswordResetLinks: !isProduction && raw.DEV_LOG_PASSWORD_RESET_LINKS,
};
