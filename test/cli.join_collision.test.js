'use strict';

// A same-name profile for another room names the way forward, says whether
// it expired, and points to a directory that holds this name for this room.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_RUNTIME } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');

const HOSTED = 'https://app.example';
const LOCAL = 'http://localhost:8788';

function profileIn(dir, name, serverUrl, { admitted = true, expiresAt = 2_000 } = {}) {
  const profiles = openProfiles({ connectionDir: dir });
  const credential = identity.newAiCredential();
  const candidate = profiles.createUnadmitted({
    name, product: 'Grok', product_provenance: 'client-reported', server_url: serverUrl,
    request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: 1_000,
  });
  if (admitted) {
    profiles.markAdmitted(name, {
      request_id: candidate.request_id, subject_id: 'seat-1', name, product: 'Grok',
      product_provenance: 'client-reported', expires_at: expiresAt, admitted_at: 1_500,
    });
  }
}

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-collision-'));
  return { root, dir: path.join(root, 'connections'), hosted: path.join(root, 'connections-hosted') };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return fs.statSync(file).isFile() ? [name, fs.readFileSync(file, 'utf8')] : [name, 'dir'];
  });
}

async function join(world, args, fetchImpl = async () => { throw new Error('no request'); }) {
  let stdout = '';
  let stderr = '';
  const requests = [];
  const code = await run(['join', ...args], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => world.dir },
    clock: () => 10_000,
    sleep: async () => {},
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(url, options) { requests.push(url); return fetchImpl(url, options); },
  });
  return { code, stdout, stderr, requests };
}

test('a same-name profile for another room names the ways forward and says it expired', async () => {
  const world = home();
  profileIn(world.dir, 'Grok', LOCAL, { expiresAt: 2_000 });
  const result = await join(world, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok']);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /local connection Grok belongs to http:\/\/localhost:8788, not this Interlock\. It expired at 1970-01-01T00:00:02\.000Z\./);
  assert.match(result.stderr, /join this room under another name \(--name\)/);
  assert.match(result.stderr, /INTERLOCK_CONNECTION_DIR=\/another\/dir interlock join/);
  assert.match(result.stderr, /if http:\/\/localhost:8788 still runs and you are done there: interlock leave --connection Grok/);
  assert.doesNotMatch(result.stderr, /Another connection directory/, 'control: no other directory holds it');
});

test('it points to another connection directory that holds this name for this room, without touching it', async () => {
  const world = home();
  profileIn(world.dir, 'Grok', LOCAL, { expiresAt: 2_000 });
  profileIn(world.hosted, 'Grok', HOSTED, { expiresAt: 3_000 });
  const before = snapshot(world.hosted);
  const result = await join(world, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok']);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.ok(result.stderr.includes(`Another connection directory holds this name for this room: ${world.hosted}. It expired at 1970-01-01T00:00:03.000Z.`), result.stderr);
  assert.ok(result.stderr.includes(`Use it: INTERLOCK_CONNECTION_DIR=${world.hosted} interlock join`), result.stderr);
  assert.deepEqual(snapshot(world.hosted), before, 'the other directory is read, never changed');
});

test('control: a directory holding the name for a different room is not mentioned', async () => {
  const world = home();
  profileIn(world.dir, 'Grok', LOCAL);
  profileIn(world.hosted, 'Grok', 'https://other.example');
  const result = await join(world, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok']);
  assert.ok(fs.existsSync(path.join(world.hosted, 'grok.json')), 'ARRANGEMENT: the sibling holds Grok');
  assert.doesNotMatch(result.stderr, /Another connection directory/);
});

test('a live profile says until when; an unadmitted one offers --discard', async () => {
  const live = home();
  profileIn(live.dir, 'Grok', LOCAL, { expiresAt: 99_000 });
  const a = await join(live, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok']);
  assert.match(a.stderr, /It is admitted there until 1970-01-01T00:01:39\.000Z\./);

  const orphan = home();
  profileIn(orphan.dir, 'Grok', LOCAL, { admitted: false });
  const b = await join(orphan, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok']);
  assert.equal(b.code, EXIT_RUNTIME);
  assert.match(b.stderr, /It was never admitted\./);
  assert.match(b.stderr, /drop the unfinished one: interlock join --discard --name Grok/);
});

test('a name the room already holds points to the directory that holds it', async () => {
  const world = home();
  profileIn(world.hosted, 'Grok', HOSTED, { expiresAt: 99_000 });
  const result = await join(world, ['--url', HOSTED, '--product', 'Grok', '--name', 'Grok'], async url => {
    if (url.endsWith('/api/ai/admissions')) {
      return { ok: false, status: 409, async json() { return { ok: false, error: 'name-taken' }; } };
    }
    return { ok: false, status: 401, async json() { return { ok: false, error: 'invalid-connection' }; } };
  });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /that name is already used or waiting in this Interlock/);
  assert.ok(result.stderr.includes(`Another connection directory holds this name for this room: ${world.hosted}. It is admitted there until`), result.stderr);
});
