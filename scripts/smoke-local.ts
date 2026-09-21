// Tests the running local HTTP service with a synthetic account created here.
// Never reads or prints player credentials; deletes only this synthetic account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3000/api/v1/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
  throw new Error('This smoke test is restricted to a local development API');
}
if (!base.pathname.endsWith('/')) base.pathname += '/';

async function main() {
  let accessToken: string | undefined;
  let userId: string | undefined;
  async function call(path: string, body?: unknown) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : await response.json();
  }
  try {
    assert.equal((await call('health/ready')).status, 'ready');
    const session = await call('auth/guest', { displayName: `Smoke-${randomUUID().slice(0, 8)}` });
    assert.equal(session.user.isGuest, true);
    assert.equal(typeof session.accessToken, 'string');
    accessToken = session.accessToken;
    userId = session.user.id;
    const me = await call('me');
    assert.equal(me.user.id, userId);
    assert(Number.isSafeInteger(me.profile.cash));
    const nearby = await call('missions/nearby?lat=51.508&lng=-0.1281&radius=3000');
    assert(nearby.missions.some((mission: { missionType: string }) => mission.missionType === 'TurfSkirmishAR'));
    const refreshed = await call('auth/refresh', { refreshToken: session.refreshToken });
    assert.equal(typeof refreshed.accessToken, 'string');
    accessToken = refreshed.accessToken;
    assert.notEqual(refreshed.refreshToken, session.refreshToken);
    assert.equal((await call('me')).user.id, userId);
    console.log('PASS: live local HTTP readiness, guest auth, profile, AR mission discovery and session refresh.');
  } finally {
    if (userId && accessToken) {
      await call('me/delete', { confirm: 'DELETE' });
      console.log('Removed only the temporary smoke-test guest account created by this run.');
    }
  }
}

main().catch(() => {
  // Never print a request, response or nested exception that could contain tokens.
  console.error('Local smoke test failed. Check service/database readiness and the test assertions.');
  process.exitCode = 1;
});
