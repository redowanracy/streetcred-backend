import { Router } from 'express';
import { getConfig } from './game-config.service';

export const gameConfigRouter = Router();

/** Public gameplay tunables so the client never hardcodes prices, rates or curves. */
gameConfigRouter.get('/', async (_req, res) => {
  res.json({ config: await getConfig() });
});
