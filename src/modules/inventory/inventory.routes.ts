import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { runIdempotent } from '../../lib/idempotency';
import { catalogIdParam, parse } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { profileSnapshot } from '../wallet/player-state';
import * as inventory from './inventory.service';

export const itemCatalogRouter = Router();
itemCatalogRouter.get('/', async (_req, res) => {
  res.json({ items: await inventory.listItemCatalog(pool) });
});

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);

inventoryRouter.get('/', async (req, res) => {
  res.json({ items: await inventory.listInventory(pool, currentUser(req).id) });
});

inventoryRouter.post('/:id/equip', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const userId = currentUser(req).id;
  res.json(
    await withTransaction(async (tx) => ({
      item: await inventory.equipOutfit(tx, userId, id),
      profile: await profileSnapshot(tx, userId),
    })),
  );
});

inventoryRouter.post('/:id/sell', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const { quantity } = parse(z.object({ quantity: z.number().int().min(1).max(10_000).default(1) }), req.body);
  const userId = currentUser(req).id;
  // Selling is not naturally repeat-safe, so a key is mandatory.
  const result = await runIdempotent(req, userId, { required: true }, async (tx) => ({
    status: 200,
    body: { sale: await inventory.sellItem(tx, userId, id, quantity), profile: await profileSnapshot(tx, userId) },
  }));
  res.status(result.status).json(result.body);
});
