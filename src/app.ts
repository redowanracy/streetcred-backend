import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { globalLimiter } from './middleware/rate-limit';
import { adminRouter } from './modules/admin/admin.routes';
import { authRouter } from './modules/auth/auth.routes';
import { docsRouter } from './modules/docs/docs.routes';
import { economyRouter } from './modules/economy/economy.routes';
import { gameConfigRouter } from './modules/game-config/game-config.routes';
import { garageRouter, vehicleCatalogRouter } from './modules/garage/garage.routes';
import { inventoryRouter, itemCatalogRouter } from './modules/inventory/inventory.routes';
import { missionsRouter } from './modules/missions/missions.routes';
import { profileRouter } from './modules/profile/profile.routes';
import { shopRouter } from './modules/shop/shop.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false }));
  app.use(express.json({ limit: '32kb' }));
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger }));
  app.use(globalLimiter);

  const api = Router();
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
  api.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable', error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unreachable' } });
    }
  });

  api.use('/docs', docsRouter);
  api.use('/auth', authRouter);
  api.use('/me', profileRouter);
  api.use('/config', gameConfigRouter);
  api.use('/catalog/vehicles', vehicleCatalogRouter);
  api.use('/catalog/items', itemCatalogRouter);
  api.use('/missions', missionsRouter);
  api.use('/garage', garageRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/shop', shopRouter);
  api.use('/economy', economyRouter);
  api.use('/admin', adminRouter);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
