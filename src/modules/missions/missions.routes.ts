import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { runIdempotent } from '../../lib/idempotency';
import { parse, uuidParam } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getConfig } from '../game-config/game-config.service';
import { profileSnapshot } from '../wallet/player-state';
import * as missions from './missions.service';

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const position = z.object({ lat, lng });
const nearbyQuery = z.object({ lat, lng, radius: z.coerce.number().positive().default(2000) });
// Free-form telemetry kept for anti-cheat review (e.g. elapsedSeconds, dronesDestroyed). Never trusted for rewards.
const clientReport = z
  .record(z.string(), z.unknown())
  .refine((r) => JSON.stringify(r).length <= 4096, 'clientReport must be at most 4 KB')
  .optional();
const finishBody = z.object({ clientReport });

export const missionsRouter = Router();
missionsRouter.use(requireAuth);

missionsRouter.get('/nearby', async (req, res) => {
  const q = parse(nearbyQuery, req.query);
  res.json(await missions.nearby(pool, currentUser(req).id, q, q.radius, await getConfig()));
});

missionsRouter.get('/attempts/active', async (req, res) => {
  res.json({ attempt: await missions.activeAttempt(pool, currentUser(req).id, await getConfig()) });
});

missionsRouter.get('/history', async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  res.json({ attempts: await missions.history(pool, currentUser(req).id, limit, await getConfig()) });
});

missionsRouter.post('/attempts/:id/complete', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const body = parse(finishBody, req.body);
  const userId = currentUser(req).id;
  const config = await getConfig();
  const outcome = await withTransaction(async (tx) => {
    const result = await missions.completeAttempt(tx, userId, id, body.clientReport, config);
    return { result, profile: await profileSnapshot(tx, userId, config) };
  });
  // The expiry is committed above; report it as an error afterwards.
  if (outcome.result.kind === 'expired') {
    throw new AppError(409, 'ATTEMPT_EXPIRED', 'The time limit for this mission has passed', { attempt: outcome.result.attempt });
  }
  res.json({ attempt: outcome.result.attempt, alreadyCompleted: outcome.result.replayed, profile: outcome.profile });
});

for (const [action, status] of [
  ['fail', 'failed'],
  ['abandon', 'abandoned'],
] as const) {
  missionsRouter.post(`/attempts/:id/${action}`, async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(finishBody, req.body);
    const userId = currentUser(req).id;
    const config = await getConfig();
    res.json(
      await withTransaction(async (tx) => ({
        attempt: await missions.endAttempt(tx, userId, id, status, config, body.clientReport),
        profile: await profileSnapshot(tx, userId, config),
      })),
    );
  });
}

missionsRouter.post('/attempts/:id/retry', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const pos = parse(position, req.body);
  const userId = currentUser(req).id;
  const config = await getConfig();
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => ({
    status: 201,
    body: { ...(await missions.retryAttempt(tx, userId, id, pos, config)), profile: await profileSnapshot(tx, userId, config) },
  }));
  res.status(result.status).json(result.body);
});

missionsRouter.get('/:id', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  res.json({ mission: missions.missionView(await missions.getMission(pool, id)) });
});

missionsRouter.post('/:id/attempts', async (req, res) => {
  const { id } = parse(uuidParam, req.params);
  const pos = parse(position, req.body);
  const userId = currentUser(req).id;
  const config = await getConfig();
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => ({
    status: 201,
    body: { ...(await missions.startAttempt(tx, userId, id, pos, config)), profile: await profileSnapshot(tx, userId, config) },
  }));
  res.status(result.status).json(result.body);
});
