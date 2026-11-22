'use strict';

// When the doorbell gives up after its outage retries, its last line says
// where the outage was (this computer's name lookup, a hosted room's side,
// or the local Interlock) and the one command that starts it again.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const profileModule = require('../src/client/profiles.js');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'integrations', 'doorbell.js');
const REQUEST = '11111111-1111-4111-8111-111111111111';

// The lines the real CLI prints for each outage (see cli.refusal_words.test.js).
const CLI_LOOKUP = 'interlock: this computer could not look up app.example.test; the room may be fine. Check this computer\'s DNS.';
const CLI_HOSTED = 'interlock: could not reach https://app.example.test (HTTP 530); the room or the network to it is down.';
const CLI_LOCAL = 'interlock: could not reach http://localhost:8788; make sure Interlock is running.';

function world(serverUrl, cliLine, stateName = 'state') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-doorbell-give-up-'));
  const connectionDir = path.join(root, 'connections');
  const profiles = profileModule.openProfiles({ connectionDir });
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const identity = { name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported' };
  profiles.createUnadmitted(Object.assign({}, identity, {
    server_url: serverUrl, request_id: REQUEST, token: `${selector}.${secret}`, selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'), created_at: 1,
  }));
  profiles.markAdmitted('Marlow', Object.assign({}, identity, {
    request_id: REQUEST, subject_id: 'seat-1', admitted_at: 2, expires_at: Date.now() + 60 * 60 * 1000,
  }));
  // A stand-in for `interlock doorbell` that cannot reach the room: the
  // CLI's own unreachable exit status and its stderr line.
  const fake = path.join(root, 'fake-interlock.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(cliLine + '\n')});
process.exit(3);
`, { mode: 0o755 });
  const env = Object.assign({}, process.env, {
    INTERLOCK_CONNECTION_DIR: connectionDir,
    INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: '20',
    INTERLOCK_DOORBELL_INTERLOCK: fake,
  });
  return { root, stateDir: path.join(root, stateName), env };
}

function giveUp(place) {
  const result = childProcess.spawnSync(process.execPath, [
    RUNNER, 'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', 'host-session-1', '--state-dir', place.stateDir, '--once',
  ], { cwd: ROOT, env: place.env, encoding: 'utf8', timeout: 30_000 });
  const last = result.stderr.trimEnd().split('\n').pop();
  return { code: result.status, stdout: result.stdout, last };
}

// The runner's quoting for a shell argument: bare when every character is in
// the safe set, else single-quoted. A Windows temp path (backslashes, a ~
// short name) is quoted; a plain Linux one is bare.
function shellArg(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function restartLine(place) {
  return 'Restart your doorbell when it\'s back: interlock-doorbell run --adapter stdout --connection Marlow ' +
    `--session host-session-1 --state-dir ${shellArg(place.stateDir)}`;
}

test('a hosted room that cannot be reached is named as the room\'s side, with the restart command', () => {
  const place = world('https://app.example.test', CLI_HOSTED);
  const done = giveUp(place);
  assert.equal(done.code, 1, done.last);
  assert.equal(done.stdout, '');
  assert.match(done.last, /^interlock doorbell adapter: the room at app\.example\.test could not be reached for [\d.]+ min; this is the room's side, not your machine \(/);
  assert.doesNotMatch(done.last, /make sure Interlock is running/);
  assert.ok(done.last.endsWith(restartLine(place)), done.last);
});

test('a failed name lookup is named as this computer\'s DNS, not the room', () => {
  const place = world('https://app.example.test', CLI_LOOKUP);
  const done = giveUp(place);
  assert.equal(done.code, 1, done.last);
  assert.match(done.last, /^interlock doorbell adapter: this computer could not look up app\.example\.test for [\d.]+ min; the room may be fine\. Check this computer's DNS/);
  assert.doesNotMatch(done.last, /room's side/);
  assert.ok(done.last.endsWith(restartLine(place)), done.last);
});

test('a local room keeps "make sure Interlock is running" and adds the restart command', () => {
  const place = world('http://localhost:8788', CLI_LOCAL);
  const done = giveUp(place);
  assert.equal(done.code, 1, done.last);
  assert.match(done.last, /^interlock doorbell adapter: the Interlock room was unreachable for [\d.]+ seconds \(.*\); make sure Interlock is running\./);
  assert.doesNotMatch(done.last, /room's side|look up/);
  assert.ok(done.last.endsWith(restartLine(place)), done.last);
});

test('a state dir outside the safe characters is quoted in the restart command', () => {
  // A "~" as in a Windows short name: the quoted branch on every platform.
  const place = world('https://app.example.test', CLI_HOSTED, 'run~1');
  const done = giveUp(place);
  assert.equal(done.code, 1, done.last);
  assert.ok(/[~]/.test(place.stateDir), 'ARRANGEMENT: the state dir holds a character outside the safe set');
  assert.ok(done.last.endsWith(`--state-dir '${place.stateDir}'`), done.last);
});
