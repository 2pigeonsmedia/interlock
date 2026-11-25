'use strict';

// A token is dropped only when the room itself says the connection is gone,
// never on this computer's clock alone. A token file left without a record by
// a crash is removed on the next run, under the lock.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_RUNTIME, run } = require('../src/cli.js');
const profileModule = require('../src/client/profiles.js');

function credential() {
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return {
    token: `${selector}.${secret}`, selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function seat(connectionDir, name, expiresAt) {
  const profiles = profileModule.openProfiles({ connectionDir });
  const body = Object.assign({
    name, product: 'Codex CLI', product_provenance: 'client-reported', server_url: 'https://app.example.test',
    request_id: crypto.randomUUID(), created_at: 1,
  }, credential());
  profiles.createUnadmitted(body);
  profiles.markAdmitted(name, {
    request_id: body.request_id, subject_id: 'seat-1', name, product: body.product,
    product_provenance: body.product_provenance, admitted_at: 2, expires_at: expiresAt,
  });
  return body;
}

function tokenFiles(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.token')).sort();
}

function refusing() {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: false, error: 'invalid-connection' }),
      { status: 401, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

function answering() {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, head: 4, connection_session: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

async function cli(argv, connectionDir, fetch, clock) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => connectionDir }, fetch, clock,
    joinedTailMarks: { has: () => true, add() {} },
    doorbellStateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-life-state-')),
  });
  return { code, stdout, stderr };
}

test('a clock that reads past the expiry refuses as before and keeps the token', async () => {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-life-'));
  const body = seat(connectionDir, 'Marlow', 5_000_000);
  const room = answering();
  // This computer's clock runs ahead of the expiry; the room has not said a word.
  const said = await cli(['history', '--connection', 'Marlow', '--skip-to-current'], connectionDir, room.fetch, () => 9_000_000);
  assert.equal(said.code, EXIT_RUNTIME);
  assert.match(said.stderr, /has expired/);
  assert.deepEqual(tokenFiles(connectionDir), [`marlow.${body.request_id}.token`], 'the token is kept');
  // With the clock put right, the connection works again.
  const fixed = await cli(['history', '--connection', 'Marlow', '--skip-to-current'], connectionDir, room.fetch, () => 1_000);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.ok(room.calls.length > 0, 'ARRANGEMENT: the fixed run reached the room');
});

test('the room\'s own "invalid connection" drops the token, and the profile then reads as ended', async () => {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-life-'));
  const body = seat(connectionDir, 'Marlow', 9_000_000_000_000);
  const room = refusing();
  const said = await cli(['status', '--connection', 'Marlow'], connectionDir, room.fetch, () => 1_000);
  assert.ok(room.calls.length > 0, 'ARRANGEMENT: the room was asked and refused');
  assert.match(said.stdout, /released this connection|removed it/);
  assert.deepEqual(tokenFiles(connectionDir), [], 'the room confirmed it ended: the token goes');
  assert.equal(fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8').includes(body.token), false);
  // The profile still reads, with no token, and a command says so without
  // sending anything.
  const profile = profileModule.openProfiles({ connectionDir }).load('Marlow');
  assert.equal(profile.token, null);
  const quiet = answering();
  const again = await cli(['history', '--connection', 'Marlow', '--skip-to-current'], connectionDir, quiet.fetch, () => 1_000);
  assert.equal(again.code, EXIT_RUNTIME);
  assert.match(again.stderr, /refused|rejoin|join/i);
  assert.deepEqual(quiet.calls, [], 'no request leaves without a token');
});

test('a refusal for an earlier request never drops a newer rejoin\'s token', () => {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-life-'));
  const first = seat(connectionDir, 'Marlow', 9_000_000_000_000);
  const profiles = profileModule.openProfiles({ connectionDir });
  assert.equal(profiles.dropDeadToken('Marlow', crypto.randomUUID()), false, 'another request: nothing dropped');
  assert.deepEqual(tokenFiles(connectionDir), [`marlow.${first.request_id}.token`]);
  assert.equal(profiles.dropDeadToken('Marlow', first.request_id), true);
  assert.deepEqual(tokenFiles(connectionDir), []);
});

test('a token file left without a record is removed on the next run', () => {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-life-'));
  const gone = seat(connectionDir, 'Marlow', 9_000_000_000_000);
  const kept = seat(connectionDir, 'Ana', 9_000_000_000_000);
  // A crash between removing the record and pruning its token.
  fs.unlinkSync(path.join(connectionDir, 'marlow.json'));
  assert.deepEqual(tokenFiles(connectionDir), [`ana.${kept.request_id}.token`, `marlow.${gone.request_id}.token`].sort(),
    'ARRANGEMENT: an orphaned token file is on disk');
  profileModule.openProfiles({ connectionDir });
  assert.deepEqual(tokenFiles(connectionDir), [`ana.${kept.request_id}.token`], 'only the orphan goes');
  assert.equal(profileModule.openProfiles({ connectionDir }).load('Ana').token, kept.token);
});
