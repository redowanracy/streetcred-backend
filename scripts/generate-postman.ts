// Generates docs/streetcred.postman_collection.json from docs/openapi.yaml.
// Re-run after changing the spec:  npx tsx scripts/generate-postman.ts
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(__dirname, '..');
const spec = parseYaml(fs.readFileSync(path.join(root, 'docs/openapi.yaml'), 'utf8'));
const OUT = path.join(root, 'docs/streetcred.postman_collection.json');

// Real responses recorded by scripts/capture-examples.ts.
const EXAMPLES_PATH = path.join(root, 'docs/examples.json');
const examples: Record<string, { status: number; body: unknown }> = fs.existsSync(EXAMPLES_PATH)
  ? JSON.parse(fs.readFileSync(EXAMPLES_PATH, 'utf8'))
  : {};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 501: 'Not Implemented', 503: 'Service Unavailable',
};

const deref = (node: any): any => (node?.$ref ? deref(resolveRef(node.$ref)) : node);
function resolveRef(ref: string) {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((acc: any, key) => acc[key], spec);
}

/** Smallest believable example body for a request schema. */
function sampleFor(schema: any, name = ''): any {
  const s = deref(schema);
  if (!s) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => sampleFor(x)));
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        // Keep bodies short: required fields plus a few obvious optional ones.
        if (s.required?.includes(key) || ['displayName', 'quantity', 'cash', 'gems'].includes(key)) {
          out[key] = sampleFor(prop, key);
        }
      }
      return out;
    }
    case 'array':
      return [sampleFor(s.items)];
    case 'integer':
    case 'number':
      if (name === 'lat' || name === 'latitude') return 51.508;
      if (name === 'lng' || name === 'longitude') return -0.1281;
      if (name === 'fromLevel') return 0;
      if (name === 'cash') return 100;
      return s.minimum ?? 1;
    case 'boolean':
      return true;
    default:
      if (name === 'email') return '{{email}}';
      if (name === 'displayName') return 'Postman Player';
      if (name === 'idToken' || name === 'identityToken' || name === 'receipt') return 'paste-a-real-token-here';
      if (name === 'productId') return 'founders_pass';
      if (name === 'token') return 'paste-the-token-from-the-reset-email';
      if (name === 'password' || name === 'currentPassword') return '{{password}}';
      if (name === 'newPassword') return 'a-new-strong-password';
      if (name === 'refreshToken') return '{{refreshToken}}';
      if (name === 'note' || name === 'reason') return 'manual test';
      if (name === 'confirm') return 'DELETE';
      if (name === 'itemId') return '{{itemId}}';
      if (name === 'title') return 'Postman mission';
      if (name === 'name') return 'Postman vehicle';
      return 'string';
  }
}

/**
 * Bodies the schema alone cannot produce well: "send any subset" endpoints would
 * otherwise get an empty object and fail validation.
 */
const BODY_OVERRIDES: Record<string, unknown> = {
  'PATCH /garage/{id}/customization': { paintColor: { r: 1, g: 0, b: 0.5, a: 1 }, underglowEnabled: true },
  'POST /admin/missions': {
    title: 'Trafalgar Square Drop',
    description: 'Retrieve the encrypted memory stick before rival syndicates intercept.',
    missionType: 'DeadDropCourier',
    latitude: 51.508,
    longitude: -0.1281,
    triggerRadiusM: 35,
    timeLimitS: 120,
    requiredStamina: 15,
    rewardCash: 750,
    rewardGems: 10,
    rewardXp: 300,
    cooldownS: 3600,
    minCompletionS: 10,
  },
  'PATCH /admin/missions/{id}': { rewardGems: 12, isActive: true },
  'PUT /admin/vehicles/{id}': {
    name: 'Night Interceptor',
    description: 'Fast street racer.',
    priceCash: 4000,
    priceGems: 0,
    maxUpgradeLevel: 5,
    upgradeBaseCostCash: 750,
    minPlayerLevel: 1,
  },
  'PUT /admin/items/{id}': { name: 'Neon Jacket', description: 'Glows in the dark.', category: 'Outfit', rarity: 'Rare', sellValueCash: 400 },
  'PUT /admin/offers/{id}': { title: 'Nitro pack x3', itemId: '{{itemId}}', quantity: 3, priceCash: 300 },
};

/** Express-style path params become Postman variables that earlier requests fill in. */
const PATH_VARIABLE: [RegExp, string][] = [
  [/^\/missions\/attempts\/\{id\}/, 'attemptId'],
  [/^\/garage\/\{id\}\/purchase/, 'purchasableVehicleId'],
  [/^\/inventory\/\{id\}\/equip/, 'outfitItemId'],
  [/^\/missions\/\{id\}/, 'missionId'],
  [/^\/admin\/missions\/\{id\}/, 'missionId'],
  [/^\/garage\/\{id\}/, 'vehicleId'],
  [/^\/admin\/vehicles\/\{id\}/, 'vehicleId'],
  [/^\/inventory\/\{id\}/, 'itemId'],
  [/^\/admin\/items\/\{id\}/, 'itemId'],
  [/^\/shop\/offers\/\{id\}/, 'offerId'],
  [/^\/admin\/offers\/\{id\}/, 'offerId'],
  [/^\/admin\/users\/\{id\}/, 'playerId'],
  [/^\/admin\/config\/\{key\}/, 'configKey'],
];

const variableFor = (p: string) => PATH_VARIABLE.find(([re]) => re.test(p))?.[1] ?? 'id';

// Requests that end the session or delete data: kept in their own folder so a full
// automated run does not sign itself out halfway through.
const DESTRUCTIVE = new Set([
  'POST /auth/logout',
  'POST /auth/logout-all',
  'POST /auth/password/change',
  'POST /auth/password/reset',
  'POST /me/delete',
  'POST /admin/users/{id}/ban',
]);

/** Test scripts that chain requests together by saving ids and tokens. */
function scriptFor(key: string, responses: Record<string, unknown>): string[] | null {
  const documented = Object.keys(responses).filter((c) => /^\d+$/.test(c));
  const lines = [
    `// Every endpoint may also answer 429 when a rate limit is hit.`,
    `const documented = ${JSON.stringify([...new Set([...documented, '429'])])};`,
    `pm.test("responds with a documented status", () => pm.expect(documented).to.include(String(pm.response.code)));`,
  ];
  if (['POST /auth/guest', 'POST /auth/signup', 'POST /auth/login', 'POST /auth/refresh'].includes(key)) {
    lines.push(
      'if (pm.response.code < 300) {',
      '  const b = pm.response.json();',
      '  pm.collectionVariables.set("accessToken", b.accessToken);',
      '  pm.collectionVariables.set("refreshToken", b.refreshToken);',
      '  pm.collectionVariables.set("playerId", b.user.id);',
      '}',
    );
  }
  if (key === 'GET /missions/nearby') {
    lines.push(
      'const startable = pm.response.code === 200 && pm.response.json().missions.find(m => m.availability.canStart);',
      'if (startable) pm.collectionVariables.set("missionId", startable.id);',
    );
  }
  if (key === 'POST /missions/{id}/attempts' || key === 'POST /missions/attempts/{id}/retry') {
    lines.push('if (pm.response.code === 201) pm.collectionVariables.set("attemptId", pm.response.json().attempt.id);');
  }
  if (key === 'GET /shop/offers') {
    lines.push('if (pm.response.code === 200 && pm.response.json().offers[0]) pm.collectionVariables.set("offerId", pm.response.json().offers[0].id);');
  }
  if (key === 'GET /inventory') {
    lines.push(
      'if (pm.response.code === 200) {',
      '  const items = pm.response.json().items;',
      '  const sellable = items.find(i => i.sellValueCash > 0 && !i.isEquipped) || items[0];',
      '  const outfit = items.find(i => i.category === "Outfit") || items[0];',
      '  if (sellable) pm.collectionVariables.set("itemId", sellable.itemId);',
      '  if (outfit) pm.collectionVariables.set("outfitItemId", outfit.itemId);',
      '}',
    );
  }
  if (key === 'GET /catalog/vehicles') {
    lines.push(
      'if (pm.response.code === 200) {',
      '  const vehicles = pm.response.json().vehicles;',
      '  const owned = vehicles.find(v => v.isStarter) || vehicles[0];',
      '  // Cheapest vehicle that is not the one every player already owns.',
      '  const buyable = vehicles.filter(v => !v.isStarter).sort((a, b) => (a.priceCash + a.priceGems * 100) - (b.priceCash + b.priceGems * 100))[0];',
      '  if (owned) pm.collectionVariables.set("vehicleId", owned.id);',
      '  if (buyable) pm.collectionVariables.set("purchasableVehicleId", buyable.id);',
      '}',
    );
  }
  if (key === 'POST /garage/{id}/purchase') {
    lines.push('if (pm.response.code === 201) pm.collectionVariables.set("vehicleId", pm.response.json().vehicle.vehicleId);');
  }
  return lines;
}

/** Markdown shown in Postman's documentation pane for one request. */
function describe(key: string, op: any, params: any[], needsAuth: boolean): string {
  const parts: string[] = [`**${key}**`, '', op.description ?? op.summary ?? ''];

  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  if (pathParams.length || queryParams.length) {
    parts.push('', '**Parameters**');
    for (const p of [...pathParams, ...queryParams]) {
      const bits = [p.required ? 'required' : 'optional'];
      if (p.schema?.default !== undefined) bits.push(`default ${JSON.stringify(p.schema.default)}`);
      parts.push(`- \`${p.name}\` (${p.in}, ${bits.join(', ')})${p.description ? ` — ${p.description}` : ''}`);
    }
  }

  parts.push('', needsAuth ? '**Auth**: send a bearer access token.' : '**Auth**: none — this endpoint is public.');

  const idempotency = params.find((p) => p.name === 'Idempotency-Key');
  if (idempotency) {
    parts.push(
      '',
      `**Idempotency-Key**: ${idempotency.required ? 'required' : 'recommended'}. ` +
        'A new GUID per user action; resending the same key returns the first response instead of charging or granting twice. ' +
        'Postman fills it with `{{$guid}}` automatically.',
    );
  }

  const failures = Object.entries(op.responses ?? {}).filter(([code]) => Number(code) >= 400);
  if (failures.length) {
    parts.push('', '**Failures**');
    for (const [code, response] of failures as [string, any][]) {
      const note = response.description && response.description !== 'Failure' ? ` — ${response.description}` : '';
      parts.push(`- \`${code}\`${note}`);
    }
  }

  const example = examples[key];
  if (example) parts.push('', `A saved example response (${example.status}) captured from a running server is attached below.`);
  return parts.join('\n');
}

/** Attaches the captured response as a Postman example. */
function exampleFor(key: string, request: any) {
  const captured = examples[key];
  if (!captured) return [];
  const hasBody = captured.body !== null && captured.body !== undefined && !(typeof captured.body === 'object' && Object.keys(captured.body as object).length === 0);
  return [
    {
      name: `${captured.status} ${STATUS_TEXT[captured.status] ?? ''}`.trim(),
      originalRequest: request,
      status: STATUS_TEXT[captured.status] ?? '',
      code: captured.status,
      _postman_previewlanguage: 'json',
      header: hasBody ? [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }] : [],
      cookie: [],
      body: hasBody ? JSON.stringify(captured.body, null, 2) : '',
    },
  ];
}

const folders = new Map<string, any[]>();

for (const [rawPath, operations] of Object.entries(spec.paths as Record<string, any>)) {
  for (const [method, op] of Object.entries(operations as Record<string, any>)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const key = `${method.toUpperCase()} ${rawPath}`;
    const params = (op.parameters ?? []).map(deref);
    const pathVar = variableFor(rawPath);
    const postmanPath = rawPath.replace(/\{[^}]+\}/g, `{{${pathVar}}}`).split('/').filter(Boolean);

    const query = params
      .filter((p: any) => p.in === 'query')
      .map((p: any) => ({
        key: p.key ?? p.name,
        value: String(p.example ?? p.schema?.default ?? sampleFor(p.schema, p.name)),
        disabled: !p.required,
      }));

    const headers: any[] = [];
    const idempotency = params.find((p: any) => p.name === 'Idempotency-Key');
    if (idempotency) headers.push({ key: 'Idempotency-Key', value: '{{$guid}}', description: idempotency.description });

    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    let body;
    if (bodySchema) {
      headers.push({ key: 'Content-Type', value: 'application/json' });
      const raw = BODY_OVERRIDES[key] ?? sampleFor(bodySchema);
      body = { mode: 'raw', raw: JSON.stringify(raw, null, 2), options: { raw: { language: 'json' } } };
    }

    // security: [] in the spec means the endpoint takes no token.
    const needsAuth = op.security?.length !== 0;
    const request = {
      method: method.toUpperCase(),
      header: headers,
      url: {
        raw: `{{baseUrl}}${rawPath.replace(/\{[^}]+\}/g, `{{${pathVar}}}`)}${query.length ? '?' + query.filter((q: any) => !q.disabled).map((q: any) => `${q.key}=${q.value}`).join('&') : ''}`,
        host: ['{{baseUrl}}'],
        path: postmanPath,
        ...(query.length ? { query } : {}),
      },
      ...(body ? { body } : {}),
      description: describe(key, op, params, needsAuth),
      ...(needsAuth ? {} : { auth: { type: 'noauth' } }),
    };

    const events: any[] = [];
    if (key === 'POST /auth/signup') {
      // A unique email per run, so the collection can be run repeatedly.
      events.push({
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            'const unique = "player-" + pm.variables.replaceIn("{{$guid}}").slice(0, 8) + "@example.com";',
            'pm.collectionVariables.set("email", unique);',
          ],
        },
      });
    }
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: scriptFor(key, op.responses ?? {}) } });

    const item: any = {
      name: op.summary ?? key,
      request,
      response: exampleFor(key, request),
      event: events,
    };
    // Admin endpoints need an admin's token, which is a different account.
    if (rawPath.startsWith('/admin')) {
      item.request.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{adminToken}}', type: 'string' }] };
    }

    const folder = DESTRUCTIVE.has(key) ? 'Destructive (run manually)' : (op.tags?.[0] ?? 'Other');
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(item);
  }
}

const ORDER = ['Health', 'Auth', 'Player', 'Config & catalogs', 'Missions', 'Garage', 'Inventory & shop', 'Economy', 'Admin', 'Destructive (run manually)'];

const FOLDER_NOTES: Record<string, string> = {
  Auth: 'Run "Create a guest account" or "Create an email + password account" first: both store `accessToken` and `refreshToken` as collection variables, and every other request uses them automatically. Signup invents a fresh email each run.',
  Player: 'The signed-in player. `GET /me` is what the game calls at launch.',
  'Config & catalogs': 'Public reference data. No token needed. The catalog requests also fill in the `vehicleId` and `purchasableVehicleId` variables used by the Garage folder.',
  Missions: 'Run in order: nearby (stores `missionId`) → start an attempt (stores `attemptId`) → complete/fail/abandon/retry.',
  Garage: 'Buying uses the cheapest vehicle the player does not own yet; it fails with INSUFFICIENT_FUNDS if the player cannot afford it, which is the documented behaviour.',
  'Inventory & shop': 'The inventory request fills in `itemId` (something sellable) and `outfitItemId` (an outfit to wear).',
  Economy: 'Ads and the Founders Pass only work when the server runs with ENABLE_DEV_MONETIZATION=true outside production; otherwise they answer 501. Real store receipts are not verified yet.',
  Admin: 'These use the separate `{{adminToken}}` variable, because admin is a different account. Create one: sign up, run `npm run admin:promote -- <email>`, sign in with that account and copy its accessToken into the `adminToken` variable. Without it every request here answers 403.',
  'Destructive (run manually)': 'These end the session or delete data (logout, password change, account deletion, ban). They are kept out of the main flow so a full run does not sign itself out.',
};

const collection = {
  info: {
    name: 'Street Cred API',
    description:
      'Generated from docs/openapi.yaml. Start with Auth → "Create a guest account": it stores the tokens in ' +
      'collection variables, and every later request uses them automatically. Requests that need an id ' +
      '(missionId, attemptId, offerId …) are filled in by the list requests above them.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
  item: ORDER.filter((name) => folders.has(name)).map((name) => ({
    name,
    description: FOLDER_NOTES[name],
    item: folders.get(name),
  })),
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000/api/v1' },
    { key: 'email', value: 'player@example.com' },
    { key: 'password', value: 'correct-horse-battery' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'playerId', value: '' },
    { key: 'missionId', value: '' },
    { key: 'attemptId', value: '' },
    { key: 'vehicleId', value: 'veh_starter_drifter' },
    { key: 'purchasableVehicleId', value: '' },
    { key: 'itemId', value: 'outfit_street_jacket' },
    { key: 'outfitItemId', value: 'outfit_street_jacket' },
    { key: 'offerId', value: '' },
    { key: 'adminToken', value: '' },
    { key: 'configKey', value: 'stamina_regen_seconds' },
  ],
};

fs.writeFileSync(OUT, JSON.stringify(collection, null, 2) + '\n');
const count = [...folders.values()].reduce((n, items) => n + items.length, 0);
console.log(`[postman] ${count} requests in ${folders.size} folders → ${path.relative(root, OUT)}`);
