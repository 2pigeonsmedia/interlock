'use strict';

// After leave and a fresh join under the same name, the doorbell starts
// clean: leave removed the ended connection's cursor, and nothing else.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_OK } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'integrations', 'doorbell.js');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-leave-doorbell-'));
  const fake = path.join(root, 'fake-interlock.js');
  // A fake `interlock doorbell` that answers the page in FAKE_RING_PAGE.
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.env.FAKE_RING_PAGE, 'utf8'));
`, { mode: 0o700 });
  return { root, fake, stateDir: path.join(root, 'state'), page: path.join(root, 'page.json'),
    connectionDir: path.join(root, 'connections') };
}

function page(w, requestId) {
  fs.writeFileSync(w.page, JSON.stringify({
    ok: true, rings: [], cursor: 5, timed_out: false, connection_session: 1,
    connection_request_id: requestId,
  }) + '\n');
}

function doorbell(w, connection) {
  return childProcess.spawnSync(process.execPath, [RUNNER, 'run', '--adapter', 'stdout',
    '--connection', connection, '--session', 'host-1', '--state-dir', w.stateDir, '--once'], {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, {
      INTERLOCK_DOORBELL_INTERLOCK: w.fake, FAKE_RING_PAGE: w.page,
      XDG_DATA_HOME: w.root, LOCALAPPDATA: w.root,
    }),
  });
}

function admitted(w, name) {
  const profiles = openProfiles({ connectionDir: w.connectionDir });
  const credential = identity.newAiCredential();
  const candidate = profiles.createUnadmitted({
    name, product: 'Claude Code', product_provenance: 'client-reported', server_url: 'http://localhost:8788',
    request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: 1_000,
  });
  return profiles.markAdmitted(name, {
    request_id: candidate.request_id, subject_id: 'seat-1', name, product: 'Claude Code',
    product_provenance: 'client-reported', expires_at: Date.now() + 86_400_000, admitted_at: 2_000,
  });
}

async function leave(w, name) {
  let stderr = '';
  let stdout = '';
  const code = await run(['leave', '--connection', name], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => w.connectionDir },
    doorbellStateDir: w.stateDir,
    codexPolicy: { removePolicy() { throw Object.assign(new Error('none'), { code: 'not-installed' }); } },
    async fetch() {
      return { ok: true, status: 200, async json() { return { ok: true, name, ended_how: 'left' }; } };
    },
  });
  return { code, stdout, stderr };
}

const cursors = w => fs.readdirSync(w.stateDir).filter(name => /^doorbell-.*\.json$/.test(name));

test('after leave and a same-name re-join, the doorbell needs no --replace-connection', async () => {
  const w = world();
  const first = admitted(w, 'Marlow');
  page(w, first.request_id);
  assert.equal(doorbell(w, 'Marlow').status, 0, 'ARRANGEMENT: the first doorbell wrote its cursor');
  assert.equal(cursors(w).length, 1);

  const left = await leave(w, 'Marlow');
  assert.equal(left.code, EXIT_OK, left.stderr);
  assert.deepEqual(cursors(w), [], 'leave removed the ended connection\'s cursor');

  const second = admitted(w, 'Marlow');
  assert.notEqual(second.request_id, first.request_id, 'ARRANGEMENT: a new admission');
  page(w, second.request_id);
  const rerun = doorbell(w, 'Marlow');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(rerun.stderr, /replace-connection/);
});

test('control: leave keeps other connections\' cursors and a same-name cursor of another admission', async () => {
  const w = world();
  const other = admitted(w, 'Rowan');
  page(w, other.request_id);
  assert.equal(doorbell(w, 'Rowan').status, 0);
  // A cursor for Marlow written under a request this profile does not hold.
  page(w, '33333333-3333-4333-8333-333333333333');
  assert.equal(doorbell(w, 'Marlow').status, 0);
  const before = cursors(w).sort();
  assert.equal(before.length, 2, 'ARRANGEMENT: two unrelated cursors');

  admitted(w, 'Marlow');
  const left = await leave(w, 'Marlow');
  assert.equal(left.code, EXIT_OK, left.stderr);
  assert.deepEqual(cursors(w).sort(), before, 'nothing that is not this connection\'s was removed');
});
