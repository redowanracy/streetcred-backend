import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { runIdempotent } from '../../lib/idempotency';
import { catalogIdParam, parse } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getConfig } from '../game-config/game-config.service';
import { profileSnapshot } from '../wallet/player-state';
import * as garage from './garage.service';

const color = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1).default(1),
});
const upgradeBody = z.object({
  stat: z.enum(['speed', 'acceleration', 'handling']),
  fromLevel: z.number().int().min(0),
});
const customizeBody = z
  .object({
    hasCustomPaint: z.boolean(),
    paintColor: color,
    hasCustomUnderglow: z.boolean(),
    underglowEnabled: z.boolean(),
    underglowColor: color,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one customization field');

export const vehicleCatalogRouter = Router();
vehicleCatalogRouter.get('/', async (_req, res) => {
  res.json({ vehicles: await garage.listVehicleCatalog(pool) });
});

export const garageRouter = Router();
garageRouter.use(requireAuth);

garageRouter.get('/', async (req, res) => {
  res.json({ vehicles: await garage.listGarage(pool, currentUser(req).id) });
});

garageRouter.post('/:id/purchase', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const userId = currentUser(req).id;
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => ({
    status: 201,
    body: { vehicle: await garage.purchaseVehicle(tx, userId, id), profile: await profileSnapshot(tx, userId) },
  }));
  res.status(result.status).json(result.body);
});

garageRouter.post('/:id/equip', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const userId = currentUser(req).id;
  res.json(
    await withTransaction(async (tx) => ({
      vehicle: await garage.equipVehicle(tx, userId, id),
      profile: await profileSnapshot(tx, userId),
    })),
  );
});

garageRouter.post('/:id/upgrade', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const body = parse(upgradeBody, req.body);
  const userId = currentUser(req).id;
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => ({
    status: 200,
    body: {
      vehicle: await garage.upgradeVehicle(tx, userId, id, body.stat, body.fromLevel),
      profile: await profileSnapshot(tx, userId),
    },
  }));
  res.status(result.status).json(result.body);
});

garageRouter.patch('/:id/customization', async (req, res) => {
  const { id } = parse(catalogIdParam, req.params);
  const body = parse(customizeBody, req.body);
  const userId = currentUser(req).id;
  const config = await getConfig();
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => ({
    status: 200,
    body: {
      vehicle: await garage.customizeVehicle(tx, userId, id, body, config),
      profile: await profileSnapshot(tx, userId, config),
    },
  }));
  res.status(result.status).json(result.body);
});
