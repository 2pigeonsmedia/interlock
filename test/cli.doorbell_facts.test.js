'use strict';

// `interlock doorbell` asks for the one ring shape (facts=1, 0.4.0). A room
// older than 0.4.0 refuses the parameter; the CLI asks once more without it.
// A room that ignores it answers the 0.3 page, which stays valid.

const assert = require('node:assert/strict');
const test = require('node:test');

const { run, EXIT_OK, EXIT_RUNTIME } = require('../src/cli.js');
const Ring = require('../src/rings.js');

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, async json() { return body; } };
}

function world() {
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const profiles = { load: () => profile, updateCursor() {}, acquireReadLease: () => ({ release() {} }) };
  const urls = [];
  return {
    urls,
    dependencies: {
      clock: () => 100,
      config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
      profiles: { validName: () => true, openProfiles: () => profiles },
    },
  };
}

async function doorbell(dependencies, args = ['--json']) {
  let stdout = '';
  let stderr = '';
  const code = await run(['doorbell', '--connection', 'Marlow', '--after', '7', ...args], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stdout, stderr };
}

const ROW = Object.freeze({ id: 9, ts: 1_788_379_200_000, byline: 'Ana', kind: 'person', session: null });
const OLD_PAGE = Object.freeze({ ok: true, rings: [ROW], cursor: 9, timed_out: false, connection_session: 3 });
const RING = Ring.buildRing({
  kind: 'mention', message_id: 9, from: 'Ana', at: ROW.ts, connection: 'Marlow',
  room: { room_time: 'Sat 14 Nov, 7:10 PM for Ana (America/New_York)', last_person_message_ago: 'now' },
});
const FACTS_PAGE = Object.freeze(Object.assign({}, OLD_PAGE, {
  rings: [Object.assign({}, ROW, { ring: RING })],
  room: { room_time: RING.room_time, last_person_message_ago: 'now' },
}));

test('a 0.4.0 room answers facts=1 with the ring shape, passed through to the adapter', async () => {
  const w = world();
  w.dependencies.fetch = async url => { w.urls.push(url); return fakeResponse(200, FACTS_PAGE); };
  const result = await doorbell(w.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(w.urls, ['http://localhost:8788/api/ai/rings?after=7&limit=100&wait=1&facts=1']);
  const page = JSON.parse(result.stdout);
  assert.deepEqual(page.rings[0].ring, RING);
  assert.deepEqual(page.room, FACTS_PAGE.room);
  const text = await doorbell(w.dependencies, []);
  assert.match(text.stdout, /Interlock ring 9: mention from Ana .*Room time: Sat 14 Nov, 7:10 PM for Ana/);
});

test('a 0.3.11 room refuses facts=1 at once; the CLI asks once more without it', async () => {
  const w = world();
  w.dependencies.fetch = async url => {
    w.urls.push(url);
    return url.endsWith('&facts=1')
      ? fakeResponse(400, { ok: false, error: 'invalid-ring-query' })
      : fakeResponse(200, OLD_PAGE);
  };
  const result = await doorbell(w.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(w.urls, [
    'http://localhost:8788/api/ai/rings?after=7&limit=100&wait=1&facts=1',
    'http://localhost:8788/api/ai/rings?after=7&limit=100&wait=1',
  ]);
  assert.deepEqual(JSON.parse(result.stdout).rings, [ROW]);
});

test('any other refusal is not retried', async () => {
  const w = world();
  w.dependencies.fetch = async url => { w.urls.push(url); return fakeResponse(401, { ok: false, error: 'invalid-connection' }); };
  const result = await doorbell(w.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(w.urls.length, 1);
});

test('a room that ignores the parameter answers the 0.3 page, which stays valid', async () => {
  const w = world();
  w.dependencies.fetch = async url => { w.urls.push(url); return fakeResponse(200, OLD_PAGE); };
  const result = await doorbell(w.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(w.urls.length, 1);
});

test('a facts page with a bad or missing ring shape is refused, not half-read', async () => {
  for (const page of [
    Object.assign({}, FACTS_PAGE, { rings: [ROW] }),
    Object.assign({}, FACTS_PAGE, { rings: [Object.assign({}, ROW, { ring: Object.assign({}, RING, { kind: 'shout' }) })] }),
    Object.assign({}, FACTS_PAGE, { room: { room_time: '' , last_person_message_ago: null } }),
    Object.assign({}, FACTS_PAGE, { extra: 1 }),
  ]) {
    const w = world();
    w.dependencies.fetch = async () => fakeResponse(200, page);
    const result = await doorbell(w.dependencies);
    assert.equal(result.code, EXIT_RUNTIME, JSON.stringify(page));
  }
});
