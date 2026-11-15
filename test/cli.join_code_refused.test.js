'use strict';

// A join with a member's code keeps its candidate when the room refuses the
// code AFTER it answered "waiting" (or on a resume): the request may still be
// held. The current room never sends that refusal for a held request; this
// guard is for a room that does. A fake room answers waiting, then the code
// refusal.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_OK, EXIT_RUNTIME } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');

const ROOM = 'https://room.example';

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
const refusedCode = () => json(400, { ok: false, error: 'invalid-join-code' });

async function join(dir, args, fetchImpl, now = 5_000) {
  let stdout = '';
  let stderr = '';
  let knocks = 0;
  const code = await run(['join', ...args], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => dir },
    doorbellStateDir: path.join(path.dirname(dir), 'doorbells'),
    env: {}, clock: () => now, sleep: async () => {},
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/admissions')) knocks += 1;
      return fetchImpl(url, options, knocks);
    },
  });
  return { code, stdout, stderr, knocks };
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-code-guard-')), 'profiles');

test('a code refused after "waiting" keeps the candidate; --resume records a later Allow', async () => {
  const dir = tmp();
  let sent = null;
  const first = await join(dir, ['--url', ROOM, '--product', 'Claude Code', '--name', 'Kestrel', '--code', 'AAAAA-BBBBB'],
    async (url, options, knocks) => {
      if (url.endsWith('/api/ai/admissions')) {
        sent = JSON.parse(options.body);
        return knocks === 1 ? json(200, Object.assign({ ok: true, state: 'waiting', expires_at: 9e15 }, sent)) : refusedCode();
      }
      return json(401, { ok: false, error: 'invalid-connection' });
    });
  assert.equal(first.knocks, 2, 'ARRANGEMENT: answered waiting, then refused on the re-knock');
  assert.equal(sent.join_code, 'AAAAA-BBBBB', 'ARRANGEMENT: the knock carried the code');
  assert.equal(first.code, EXIT_RUNTIME);
  assert.match(first.stderr, /refused the join code when Kestrel knocked again/);
  assert.match(first.stderr, /interlock join --resume --name Kestrel/);
  const profiles = openProfiles({ connectionDir: dir });
  assert.equal(profiles.load('Kestrel').state, 'unadmitted', 'the candidate is kept');

  const resumed = await join(dir, ['--resume', '--name', 'Kestrel'], async url => url.endsWith('/api/ai/session')
    ? json(200, { ok: true, connection: { subject_id: 'seat-k', name: 'Kestrel', product: 'Claude Code',
      product_provenance: 'client-reported', expires_at: 9_000_000 } })
    : json(200, { ok: true, head: 0, connection_session: null }));
  assert.equal(resumed.code, EXIT_OK, resumed.stderr);
  assert.equal(profiles.load('Kestrel').state, 'admitted');
});

test('a resumed candidate whose knock is refused its code is kept', async () => {
  const dir = tmp();
  const profiles = openProfiles({ connectionDir: dir });
  const credential = identity.newAiCredential();
  profiles.createUnadmitted({ name: 'Kestrel', product: 'Claude Code', product_provenance: 'client-reported',
    server_url: ROOM, request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: 1_000 });
  const result = await join(dir, ['--resume', '--name', 'Kestrel', '--code', 'AAAAA-BBBBB'],
    async url => url.endsWith('/api/ai/admissions') ? refusedCode() : json(401, { ok: false, error: 'invalid-connection' }));
  assert.equal(result.knocks, 1, 'ARRANGEMENT: the resume knocked');
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(profiles.load('Kestrel').state, 'unadmitted', 'kept');
});

test('control: a first knock refused for its code (the room holds nothing) still removes the candidate', async () => {
  const dir = tmp();
  const result = await join(dir, ['--url', ROOM, '--product', 'Claude Code', '--name', 'Kestrel', '--code', 'WRONG-CODE1'],
    async url => url.endsWith('/api/ai/admissions') ? refusedCode() : json(401, { ok: false, error: 'invalid-connection' }));
  assert.equal(result.knocks, 1);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /the room refused that join code/);
  assert.equal(fs.existsSync(path.join(dir, 'kestrel.json')), false);
});
