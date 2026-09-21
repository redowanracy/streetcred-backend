import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { invalidateConfigCache } from '../src/modules/game-config/game-config.service';

export const app = createApp();
export const api = () => request(app);
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idemKey = () => `test-${crypto.randomUUID()}`;
export const uniqueEmail = () => `player-${crypto.randomUUID().slice(0, 8)}@example.com`;

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string | null; isGuest: boolean; displayName: string };
  profile: { cash: number; gems: number; level: number; xp: number; stamina: { current: number; max: number } };
}

export async function newGuest(displayName?: string): Promise<Session> {
  const res = await api().post('/api/v1/auth/guest').send(displayName ? { displayName } : {});
  if (res.status !== 201) throw new Error(`guest failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function newUser(email = uniqueEmail(), password = 'correct-horse-battery'): Promise<Session & { email: string; password: string }> {
  const res = await api().post('/api/v1/auth/signup').send({ email, password });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, email, password };
}

export async function newAdmin() {
  const admin = await newUser();
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.user.id]);
  return admin;
}

export async function setConfig(key: string, value: unknown) {
  await pool.query(
    `INSERT INTO game_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
  invalidateConfigCache();
}

let missionCounter = 0;
/** Inserts a mission near Trafalgar Square with test-friendly defaults (no minimum completion time). */
export async function createMission(overrides: Record<string, unknown> = {}) {
  const m = {
    title: `Test mission ${++missionCounter}`,
    mission_type: 'DeadDropCourier',
    lat: 51.508,
    lng: -0.1281,
    trigger_radius_m: 35,
    time_limit_s: 120,
    required_stamina: 15,
    reward_cash: 750,
    reward_gems: 10,
    reward_xp: 300,
    reward_item_id: null,
    cooldown_s: 3600,
    min_completion_s: 0,
    min_player_level: 1,
    ...overrides,
  };
  const { rows } = await pool.query(
    `INSERT INTO missions (title, mission_type, location, trigger_radius_m, time_limit_s, required_stamina,
       reward_cash, reward_gems, reward_xp, reward_item_id, cooldown_s, min_completion_s, min_player_level)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [m.title, m.mission_type, m.lat, m.lng, m.trigger_radius_m, m.time_limit_s, m.required_stamina, m.reward_cash,
      m.reward_gems, m.reward_xp, m.reward_item_id, m.cooldown_s, m.min_completion_s, m.min_player_level],
  );
  return { id: rows[0].id as string, lat: m.lat, lng: m.lng };
}

export const AT_TRAFALGAR = { lat: 51.508, lng: -0.1281 };
