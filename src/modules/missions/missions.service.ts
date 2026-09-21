import { Db, dbNow, queryOne, queryRows } from '../../db/pool';
import { AppError, conflict, notFound } from '../../lib/errors';
import { GameConfig } from '../game-config/game-config.service';
import { changeStamina, changeWallet, grantItem, grantXp, lockProfile, ProfileRow } from '../wallet/player-state';

export const MISSION_TYPES = ['DeadDropCourier', 'TurfSkirmishAR', 'ZoneReconWalking', 'HighRollerSprint'] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export interface MissionRow {
  id: string;
  title: string;
  description: string;
  mission_type: MissionType;
  latitude: number;
  longitude: number;
  trigger_radius_m: number;
  time_limit_s: number;
  required_stamina: number;
  reward_cash: number;
  reward_gems: number;
  reward_xp: number;
  reward_item_id: string | null;
  min_player_level: number;
  cooldown_s: number | null;
  min_completion_s: number;
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
}

interface AttemptRow {
  id: string;
  user_id: string;
  mission_id: string;
  status: 'active' | 'completed' | 'failed' | 'abandoned' | 'expired';
  stamina_charged: number;
  started_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  reward_cash: number;
  reward_gems: number;
  reward_xp: number;
  reward_item_id: string | null;
  retry_of: string | null;
  retry_count: number;
  result: unknown;
}

export interface Position {
  lat: number;
  lng: number;
}

export const MISSION_COLUMNS = `m.id, m.title, m.description, m.mission_type,
  ST_Y(m.location::geometry) AS latitude, ST_X(m.location::geometry) AS longitude,
  m.trigger_radius_m, m.time_limit_s, m.required_stamina, m.reward_cash, m.reward_gems, m.reward_xp,
  m.reward_item_id, m.min_player_level, m.cooldown_s, m.min_completion_s, m.is_active, m.starts_at, m.ends_at`;

const LIVE = `m.is_active AND (m.starts_at IS NULL OR m.starts_at <= now()) AND (m.ends_at IS NULL OR m.ends_at > now())`;
// $lng, $lat order: PostGIS points are (x = longitude, y = latitude).
const point = (lngParam: string, latParam: string) => `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

export const missionView = (m: MissionRow) => ({
  id: m.id,
  title: m.title,
  description: m.description,
  missionType: m.mission_type,
  latitude: m.latitude,
  longitude: m.longitude,
  triggerRadiusM: m.trigger_radius_m,
  timeLimitS: m.time_limit_s,
  requiredStamina: m.required_stamina,
  reward: { cash: m.reward_cash, gems: m.reward_gems, xp: m.reward_xp, itemId: m.reward_item_id },
  minPlayerLevel: m.min_player_level,
  cooldownS: m.cooldown_s,
});

function attemptView(a: AttemptRow, config: GameConfig, now: Date) {
  const retryable =
    (a.status === 'failed' || a.status === 'expired') &&
    a.retry_count < config.mission_free_retries &&
    a.finished_at !== null &&
    now.getTime() - a.finished_at.getTime() <= config.mission_retry_window_s * 1000;
  return {
    id: a.id,
    missionId: a.mission_id,
    status: a.status,
    staminaCharged: a.stamina_charged,
    startedAt: a.started_at.toISOString(),
    expiresAt: a.expires_at.toISOString(),
    finishedAt: a.finished_at?.toISOString() ?? null,
    reward: { cash: a.reward_cash, gems: a.reward_gems, xp: a.reward_xp, itemId: a.reward_item_id },
    retryOf: a.retry_of,
    retryCount: a.retry_count,
    canRetryFree: retryable,
    result: a.result ?? null,
  };
}
export type AttemptView = ReturnType<typeof attemptView>;

/** Why a player can or cannot start a mission right now (stamina and distance are checked at start). */
function availability(m: MissionRow, level: number, lastCompletedAt: Date | null, now: Date) {
  if (level < m.min_player_level) return { canStart: false, reason: 'LEVEL_TOO_LOW', availableAt: null };
  if (lastCompletedAt) {
    if (m.cooldown_s === null) return { canStart: false, reason: 'MISSION_NOT_REPEATABLE', availableAt: null };
    const availableAt = new Date(lastCompletedAt.getTime() + m.cooldown_s * 1000);
    if (availableAt > now) return { canStart: false, reason: 'MISSION_ON_COOLDOWN', availableAt: availableAt.toISOString() };
  }
  return { canStart: true, reason: null, availableAt: null };
}

async function lastCompletion(db: Db, userId: string, missionId: string): Promise<Date | null> {
  const row = await queryOne<{ at: Date | null }>(
    db,
    `SELECT max(finished_at) AS at FROM mission_attempts WHERE user_id = $1 AND mission_id = $2 AND status = 'completed'`,
    [userId, missionId],
  );
  return row?.at ?? null;
}

// ───────────────────────────── Queries ─────────────────────────────

export async function nearby(db: Db, userId: string, pos: Position, radiusM: number, config: GameConfig) {
  const radius = Math.min(radiusM, config.nearby_max_radius_m);
  const rows = await queryRows<MissionRow & { distance_m: number; last_completed_at: Date | null; level: number }>(
    db,
    `SELECT ${MISSION_COLUMNS},
            ST_Distance(m.location, ${point('$2', '$1')}) AS distance_m,
            (SELECT max(a.finished_at) FROM mission_attempts a
              WHERE a.user_id = $4 AND a.mission_id = m.id AND a.status = 'completed') AS last_completed_at,
            (SELECT level FROM player_profiles WHERE user_id = $4) AS level
     FROM missions m
     WHERE ${LIVE} AND ST_DWithin(m.location, ${point('$2', '$1')}, $3)
     ORDER BY distance_m
     LIMIT $5`,
    [pos.lat, pos.lng, radius, userId, config.nearby_max_results],
  );
  const now = await dbNow(db);
  return {
    radiusM: radius,
    missions: rows.map((r) => ({
      ...missionView(r),
      distanceM: Math.round(r.distance_m),
      availability: availability(r, r.level, r.last_completed_at, now),
    })),
  };
}

export async function getMission(db: Db, missionId: string) {
  const m = await queryOne<MissionRow>(db, `SELECT ${MISSION_COLUMNS} FROM missions m WHERE m.id = $1 AND ${LIVE}`, [missionId]);
  if (!m) throw notFound('Mission');
  return m;
}

export async function activeAttempt(db: Db, userId: string, config: GameConfig) {
  const now = await dbNow(db);
  const a = await queryOne<AttemptRow>(
    db,
    `SELECT * FROM mission_attempts WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
    [userId],
  );
  return a ? attemptView(a, config, now) : null;
}

export async function history(db: Db, userId: string, limit: number, config: GameConfig) {
  const now = await dbNow(db);
  const rows = await queryRows<AttemptRow & { mission_title: string; mission_type: MissionType }>(
    db,
    `SELECT a.*, m.title AS mission_title, m.mission_type FROM mission_attempts a JOIN missions m ON m.id = a.mission_id
     WHERE a.user_id = $1 ORDER BY a.started_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ ...attemptView(r, config, now), missionTitle: r.mission_title, missionType: r.mission_type }));
}

// ───────────────────────────── Attempt lifecycle ─────────────────────────────

async function expireStaleAttempts(tx: Db, userId: string) {
  await tx.query(
    `UPDATE mission_attempts SET status = 'expired', finished_at = expires_at
     WHERE user_id = $1 AND status = 'active' AND expires_at <= now()`,
    [userId],
  );
}

async function assertNoActiveAttempt(tx: Db, userId: string) {
  const running = await queryOne<{ id: string; mission_id: string }>(
    tx,
    `SELECT id, mission_id FROM mission_attempts WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  if (running) {
    throw conflict('ATTEMPT_IN_PROGRESS', 'Finish or abandon your current mission first', {
      attemptId: running.id,
      missionId: running.mission_id,
    });
  }
}

/** Rejects a start whose reported position is implausibly far from the mission (when enforced). */
async function checkProximity(tx: Db, mission: MissionRow, pos: Position, config: GameConfig) {
  const row = await queryOne<{ d: number }>(tx, `SELECT ST_Distance(m.location, ${point('$3', '$2')}) AS d FROM missions m WHERE m.id = $1`, [
    mission.id,
    pos.lat,
    pos.lng,
  ]);
  const distance = row!.d;
  const maxDistance = mission.trigger_radius_m + config.mission_proximity_tolerance_m;
  if (config.mission_proximity_enforced && distance > maxDistance) {
    throw new AppError(403, 'TOO_FAR_FROM_MISSION', 'You are too far from this mission', {
      distanceM: Math.round(distance),
      maxDistanceM: Math.round(maxDistance),
    });
  }
  return distance;
}

function expiryFor(mission: MissionRow, now: Date, config: GameConfig) {
  const sprintBonus = mission.mission_type === 'HighRollerSprint' ? 3 * config.sprint_checkpoint_bonus_s : 0;
  return new Date(now.getTime() + (mission.time_limit_s + sprintBonus + config.mission_expiry_grace_s) * 1000);
}

async function loadAttempt(tx: Db, userId: string, attemptId: string) {
  const a = await queryOne<AttemptRow>(tx, 'SELECT * FROM mission_attempts WHERE id = $1 AND user_id = $2 FOR UPDATE', [attemptId, userId]);
  if (!a) throw notFound('Mission attempt');
  return a;
}

export async function startAttempt(tx: Db, userId: string, missionId: string, pos: Position, config: GameConfig) {
  const profile = await lockProfile(tx, userId);
  const now = await dbNow(tx);
  await expireStaleAttempts(tx, userId);
  await assertNoActiveAttempt(tx, userId);

  const mission = await getMission(tx, missionId);
  const avail = availability(mission, profile.level, await lastCompletion(tx, userId, missionId), now);
  if (!avail.canStart) {
    const status = avail.reason === 'LEVEL_TOO_LOW' ? 403 : 409;
    throw new AppError(status, avail.reason!, 'This mission cannot be started right now', { availableAt: avail.availableAt });
  }
  const distance = await checkProximity(tx, mission, pos, config);
  await changeStamina(tx, profile, -mission.required_stamina, config, now);

  const attempt = await queryOne<AttemptRow>(
    tx,
    `INSERT INTO mission_attempts (user_id, mission_id, status, stamina_charged, start_lat, start_lng, start_distance_m,
       started_at, expires_at, reward_cash, reward_gems, reward_xp, reward_item_id)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      userId,
      mission.id,
      mission.required_stamina,
      pos.lat,
      pos.lng,
      distance,
      now,
      expiryFor(mission, now, config),
      mission.reward_cash,
      mission.reward_gems,
      mission.reward_xp,
      mission.reward_item_id,
    ],
  );
  return { attempt: attemptView(attempt!, config, now), mission: missionView(mission) };
}

/** A free (no stamina) restart of a failed or timed-out attempt, like Unity's TryRestartLastFailedMission. */
export async function retryAttempt(tx: Db, userId: string, attemptId: string, pos: Position, config: GameConfig) {
  await lockProfile(tx, userId);
  const now = await dbNow(tx);
  await expireStaleAttempts(tx, userId);
  const failed = await loadAttempt(tx, userId, attemptId);
  if (!attemptView(failed, config, now).canRetryFree) {
    throw conflict('NOT_RETRYABLE', 'This attempt has no free retry available', { status: failed.status, retryCount: failed.retry_count });
  }
  await assertNoActiveAttempt(tx, userId);
  const mission = await getMission(tx, failed.mission_id);
  const distance = await checkProximity(tx, mission, pos, config);

  try {
    const attempt = await queryOne<AttemptRow>(
      tx,
      `INSERT INTO mission_attempts (user_id, mission_id, status, stamina_charged, start_lat, start_lng, start_distance_m,
         started_at, expires_at, reward_cash, reward_gems, reward_xp, reward_item_id, retry_of, retry_count)
       VALUES ($1, $2, 'active', 0, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        userId,
        mission.id,
        pos.lat,
        pos.lng,
        distance,
        now,
        expiryFor(mission, now, config),
        failed.reward_cash,
        failed.reward_gems,
        failed.reward_xp,
        failed.reward_item_id,
        failed.id,
        failed.retry_count + 1,
      ],
    );
    return { attempt: attemptView(attempt!, config, now), mission: missionView(mission) };
  } catch (err: any) {
    if (err?.code === '23505') throw conflict('ALREADY_RETRIED', 'This attempt was already retried');
    throw err;
  }
}

export type CompleteOutcome =
  | { kind: 'completed'; attempt: AttemptView; replayed: boolean }
  | { kind: 'expired'; attempt: AttemptView };

/**
 * Grants the rewards fixed at start, exactly once. Calling it again for an
 * already-completed attempt returns the same result without paying again.
 */
export async function completeAttempt(
  tx: Db,
  userId: string,
  attemptId: string,
  clientReport: Record<string, unknown> | undefined,
  config: GameConfig,
): Promise<CompleteOutcome> {
  let profile: ProfileRow = await lockProfile(tx, userId);
  const now = await dbNow(tx);
  const attempt = await loadAttempt(tx, userId, attemptId);

  if (attempt.status === 'completed') return { kind: 'completed', attempt: attemptView(attempt, config, now), replayed: true };
  if (attempt.status === 'active' && attempt.expires_at <= now) {
    const expired = await queryOne<AttemptRow>(
      tx,
      `UPDATE mission_attempts SET status = 'expired', finished_at = expires_at WHERE id = $1 RETURNING *`,
      [attempt.id],
    );
    return { kind: 'expired', attempt: attemptView(expired!, config, now) };
  }
  if (attempt.status !== 'active') {
    throw conflict('ATTEMPT_NOT_ACTIVE', `This attempt is already ${attempt.status}`, { status: attempt.status });
  }

  const mission = await queryOne<{ min_completion_s: number }>(tx, 'SELECT min_completion_s FROM missions WHERE id = $1', [attempt.mission_id]);
  const elapsedS = (now.getTime() - attempt.started_at.getTime()) / 1000;
  if (elapsedS < (mission?.min_completion_s ?? 0)) {
    throw new AppError(422, 'COMPLETION_TOO_FAST', 'Mission was completed faster than is possible', {
      elapsedS: Math.floor(elapsedS),
      minimumS: mission?.min_completion_s,
    });
  }

  profile = await changeWallet(tx, profile, {
    cash: attempt.reward_cash,
    gems: attempt.reward_gems,
    reason: 'mission_reward',
    refType: 'mission_attempt',
    refId: attempt.id,
    metadata: { missionId: attempt.mission_id },
  });
  const xp = await grantXp(tx, profile, attempt.reward_xp, config);
  const itemGranted = attempt.reward_item_id ? (await grantItem(tx, userId, attempt.reward_item_id, 1)) > 0 : false;

  const result = {
    reward: { cash: attempt.reward_cash, gems: attempt.reward_gems, xp: attempt.reward_xp, itemId: attempt.reward_item_id, itemGranted },
    levelsGained: xp.levelsGained,
    serverElapsedS: Math.round(elapsedS),
  };
  const completed = await queryOne<AttemptRow>(
    tx,
    `UPDATE mission_attempts SET status = 'completed', finished_at = $2, client_report = $3, result = $4 WHERE id = $1 RETURNING *`,
    [attempt.id, now, clientReport ? JSON.stringify(clientReport) : null, JSON.stringify(result)],
  );
  return { kind: 'completed', attempt: attemptView(completed!, config, now), replayed: false };
}

/** Ends an active attempt without reward. Stamina is not refunded. */
export async function endAttempt(tx: Db, userId: string, attemptId: string, status: 'failed' | 'abandoned', config: GameConfig, clientReport?: Record<string, unknown>) {
  await lockProfile(tx, userId);
  const now = await dbNow(tx);
  const attempt = await loadAttempt(tx, userId, attemptId);
  if (attempt.status === status) return attemptView(attempt, config, now); // repeat-safe
  if (attempt.status !== 'active') {
    throw conflict('ATTEMPT_NOT_ACTIVE', `This attempt is already ${attempt.status}`, { status: attempt.status });
  }
  const updated = await queryOne<AttemptRow>(
    tx,
    `UPDATE mission_attempts SET status = $2, finished_at = LEAST($3::timestamptz, expires_at), client_report = $4 WHERE id = $1 RETURNING *`,
    [attempt.id, status, now, clientReport ? JSON.stringify(clientReport) : null],
  );
  return attemptView(updated!, config, now);
}
