import { Router } from 'express';
import { pool } from '../../db/pool';
import { runIdempotent } from '../../lib/idempotency';
import { catalogIdParam, parse } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { profileSnapshot } from '../wallet/player-state';
import * as shop from './shop.service';

export const shopRouter = Router();
shopRouter.use(requireAuth);

shopRouter.get('/offers', async (req, res) => {
  res.json({ offers: await shop.listOffers(pool, currentUser(req).id) });
});

shopRouter.post('/offers/:id/purchase', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const userId = currentUser(req).id;
  // Stackable offers can be bought repeatedly, so retries must be de-duplicated by key.
  const result = await runIdempotent(req, userId, { required: true }, async (tx) => ({
    status: 201,
    body: { purchase: await shop.purchaseOffer(tx, userId, id), profile: await profileSnapshot(tx, userId) },
  }));
  res.status(result.status).json(result.body);
});
