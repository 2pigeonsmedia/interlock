'use strict';

// `interlock doorbell pause|resume` (C1, v0.4.0): the seat tells the room it
// is working a turn, or is back. A room from before the pause refuses the
// field with 400 invalid-request; the CLI says so and exits 0 (C7), so the
// host hook that calls it carries on.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

const profile = Object.freeze({
  schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
  server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
  state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
});

async function doorbell(argv, answer) {
  const calls = [];
  let stdout = '';
  let stderr = '';
  const code = await run(['doorbell', ...argv], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    clock: () => 100,
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: {
      validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
      openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
    },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      const { status, json } = answer(JSON.parse(init.body));
      return { ok: status < 300, status, headers: { get: () => null }, json: async () => json };
    },
  });
  return { code, stdout, stderr, calls };
}

const PAUSE = { reason: 'turn', since: 1_800_000_000_000, expires_at: 1_800_010_800_000 };

test('pause posts {pause:{reason:"turn"}} on its own; resume posts {pause:null}', async () => {
  const paused = await doorbell(['pause', '--connection', 'Marlow'], () => ({ status: 200, json: { ok: true, pause: PAUSE } }));
  assert.equal(paused.code, EXIT_OK, paused.stderr);
  assert.deepEqual(paused.calls, [{ url: 'http://localhost:8788/api/ai/presence', method: 'POST', body: { pause: { reason: 'turn' } } }]);
  assert.match(paused.stdout, /working until it polls again, for up to 3 hours/);
  const resumed = await doorbell(['resume', '--connection', 'Marlow', '--json'], () => ({ status: 200, json: { ok: true, pause: null } }));
  assert.equal(resumed.code, EXIT_OK, resumed.stderr);
  assert.deepEqual(resumed.calls[0].body, { pause: null });
  assert.deepEqual(JSON.parse(resumed.stdout), { ok: true, connection: 'Marlow', supported: true, pause: null });
});

test('an older room refusing the field is said plainly and exits 0 (C7)', async () => {
  const old = await doorbell(['pause', '--connection', 'Marlow', '--reason', 'turn'],
    () => ({ status: 400, json: { ok: false, error: 'invalid-request' } }));
  assert.equal(old.code, EXIT_OK, old.stderr);
  assert.match(old.stdout, /does not support pause \(Interlock 0\.3\.11 or older\); nothing changed/);
  const json = await doorbell(['resume', '--connection', 'Marlow', '--json'],
    () => ({ status: 400, json: { ok: false, error: 'invalid-request' } }));
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, connection: 'Marlow', supported: false, pause: null });
  // Control: any other refusal is still a failure.
  const revoked = await doorbell(['pause', '--connection', 'Marlow'],
    () => ({ status: 401, json: { ok: false, error: 'invalid-connection' } }));
  assert.equal(revoked.code, EXIT_RUNTIME);
});

test('usage: a connection is required; --reason is pause-only and only "turn"', async () => {
  const answer = () => ({ status: 200, json: { ok: true, pause: PAUSE } });
  for (const argv of [
    ['pause'], ['pause', '--reason', 'turn'], ['pause', '--connection', 'Marlow', '--reason', 'lunch'],
    ['resume', '--connection', 'Marlow', '--reason', 'turn'], ['pause', '--connection', 'Marlow', '--connection', 'X'],
  ]) {
    const result = await doorbell(argv, answer);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.equal(result.calls.length, 0, argv.join(' '));
  }
});
