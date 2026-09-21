import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { api } from './helpers';
import { adminRouter } from '../src/modules/admin/admin.routes';
import { authRouter } from '../src/modules/auth/auth.routes';
import { economyRouter } from '../src/modules/economy/economy.routes';
import { gameConfigRouter } from '../src/modules/game-config/game-config.routes';
import { garageRouter, vehicleCatalogRouter } from '../src/modules/garage/garage.routes';
import { inventoryRouter, itemCatalogRouter } from '../src/modules/inventory/inventory.routes';
import { missionsRouter } from '../src/modules/missions/missions.routes';
import { profileRouter } from '../src/modules/profile/profile.routes';
import { shopRouter } from '../src/modules/shop/shop.routes';

// Mirrors the mounting in src/app.ts. /docs is the Swagger UI itself and is not part of the API surface.
const MOUNTS: [string, Router][] = [
  ['/auth', authRouter],
  ['/me', profileRouter],
  ['/config', gameConfigRouter],
  ['/catalog/vehicles', vehicleCatalogRouter],
  ['/catalog/items', itemCatalogRouter],
  ['/missions', missionsRouter],
  ['/garage', garageRouter],
  ['/inventory', inventoryRouter],
  ['/shop', shopRouter],
  ['/economy', economyRouter],
  ['/admin', adminRouter],
];
const STANDALONE = ['GET /health', 'GET /health/ready'];

function routesOf(prefix: string, router: Router): string[] {
  const found: string[] = [];
  for (const layer of (router as any).stack ?? []) {
    if (!layer.route) continue;
    const suffix = layer.route.path === '/' ? '' : layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      // Express ":id" → OpenAPI "{id}"
      found.push(`${method.toUpperCase()} ${prefix}${suffix}`.replace(/:(\w+)/g, '{$1}'));
    }
  }
  return found;
}

const implemented = new Set([...STANDALONE, ...MOUNTS.flatMap(([prefix, router]) => routesOf(prefix, router))]);

const spec = parseYaml(fs.readFileSync(path.resolve(__dirname, '../docs/openapi.yaml'), 'utf8'));
const documented = new Set(
  Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([p, ops]) =>
    Object.keys(ops)
      .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map((m) => `${m.toUpperCase()} ${p}`),
  ),
);

describe('OpenAPI specification', () => {
  it('documents every implemented endpoint', () => {
    expect([...implemented].filter((r) => !documented.has(r)).sort()).toEqual([]);
  });

  it('does not document endpoints that do not exist', () => {
    expect([...documented].filter((r) => !implemented.has(r)).sort()).toEqual([]);
  });

  it('covers all 58 endpoints', () => {
    expect(implemented.size).toBe(58);
    expect(documented.size).toBe(58);
  });

  it('is served by the API together with a Swagger UI page', async () => {
    const yaml = await api().get('/api/v1/docs/openapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.headers['content-type']).toContain('yaml');
    expect(parseYaml(yaml.text).info.title).toBe('Street Cred API');

    const page = await api().get('/api/v1/docs');
    expect(page.status).toBe(200);
    expect(page.text).toContain('SwaggerUIBundle');
    // The inline bootstrap must carry the nonce from the page's own CSP header.
    const nonce = /script-src [^;]*'nonce-([^']+)'/.exec(page.headers['content-security-policy'])?.[1];
    expect(nonce).toBeTruthy();
    expect(page.text).toContain(`<script nonce="${nonce}">`);
  });
});
