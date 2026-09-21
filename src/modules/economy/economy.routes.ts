import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { dbNow, queryOne } from '../../db/pool';
import { AppError, conflict, notImplemented } from '../../lib/errors';
import { runIdempotent } from '../../lib/idempotency';
import { parse } from '../../lib/validate';
import { currentUser, requireAuth } from '../../middleware/auth';
import { getConfig } from '../game-config/game-config.service';
import { changeStamina, changeWallet, lockProfile, profileSnapshot } from '../wallet/player-state';

export const economyRouter = Router();
economyRouter.use(requireAuth);

/**
 * Rewarded ads. Production needs server-side verification (e.g. AdMob SSV
 * callbacks) before granting; until then only explicit development mode works.
 */
economyRouter.post('/ads/reward', async (req, res) => {
  if (!env.devMonetization) throw notImplemented('Rewarded ad verification is not configured yet');
  const { rewardType } = parse(z.object({ rewardType: z.enum(['stamina', 'bonus_cash']) }), req.body);
  const userId = currentUser(req).id;
  const config = await getConfig();

  const result = await runIdempotent(req, userId, { required: true }, async (tx) => {
    let profile = await lockProfile(tx, userId);
    const today = await queryOne<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM ad_reward_claims WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [userId],
    );
    if (today!.n >= config.ad_reward_daily_cap) {
      throw new AppError(429, 'AD_DAILY_CAP_REACHED', 'Daily rewarded-ad limit reached');
    }
    await tx.query('INSERT INTO ad_reward_claims (user_id, reward_type) VALUES ($1, $2)', [userId, rewardType]);
    if (rewardType === 'stamina') {
      profile = await changeStamina(tx, profile, config.ad_reward_stamina, config, await dbNow(tx));
    } else {
      profile = await changeWallet(tx, profile, { cash: config.ad_reward_cash, reason: 'ad_reward', refType: 'ad', refId: rewardType });
    }
    return { status: 200, body: { rewardType, profile: await profileSnapshot(tx, userId, config) } };
  });
  res.status(result.status).json(result.body);
});

/**
 * In-app purchase receipt verification. Contract is fixed; verification against
 * Google Play Developer API / App Store Server API is not implemented yet.
 */
economyRouter.post('/iap/verify', async (req, res) => {
  parse(
    z.object({
      platform: z.enum(['google_play', 'app_store']),
      productId: z.string().min(1).max(128),
      receipt: z.string().min(1).max(20_000),
    }),
    req.body,
  );
  throw notImplemented('In-app purchase verification is not configured yet');
});

/** Development-only Founders Pass grant, recorded like a real purchase. */
economyRouter.post('/dev/founders-pass', async (req, res) => {
  if (!env.devMonetization) throw notImplemented('Development purchases are disabled');
  const userId = currentUser(req).id;
  const config = await getConfig();
  const result = await runIdempotent(req, userId, { required: false }, async (tx) => {
    const profile = await lockProfile(tx, userId);
    if (profile.has_founders_pass) throw conflict('ALREADY_OWNED', 'Founders Pass already active');
    const purchase = await queryOne<{ id: string }>(
      tx,
      `INSERT INTO iap_purchases (user_id, platform, product_id, transaction_id, status)
       VALUES ($1, 'dev', 'founders_pass', gen_random_uuid()::text, 'verified') RETURNING id`,
      [userId],
    );
    await tx.query('UPDATE player_profiles SET has_founders_pass = TRUE WHERE user_id = $1', [userId]);
    await changeWallet(tx, profile, {
      cash: config.founders_pass_cash,
      gems: config.founders_pass_gems,
      reason: 'iap_founders_pass',
      refType: 'iap_purchase',
      refId: purchase!.id,
    });
    return { status: 200, body: { profile: await profileSnapshot(tx, userId, config) } };
  });
  res.status(result.status).json(result.body);
});
