'use strict';

// A join with no --url goes to this computer's own room. When every admitted
// connection on this computer belongs to one other room, join names that
// room's address, so an AI never has to open another connection's profile
// (which holds its token) to find it.

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
const OTHER = 'https://other.example';
const LOCAL = 'http://localhost:8788';
const HINT = /This computer already joins (\S+); to join it too: interlock join --url (\S+) --name …/;

function world() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hint-')), 'profiles');
  return { dir, profiles: openProfiles({ connectionDir: dir }), tokens: [] };
}

function profile(w, name, room, { admitted = true, expiresAt = 900_000 } = {}) {
  const credential = identity.newAiCredential();
  const candidate = w.profiles.createUnadmitted({
    name, product: 'Claude Code', product_provenance: 'client-reported', server_url: room,
    request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: 1_000,
  });
  w.tokens.push(credential.token);
  if (admitted) {
    w.profiles.markAdmitted(name, {
      request_id: candidate.request_id, subject_id: 'seat-' + name, name, product: 'Claude Code',
      product_provenance: 'client-reported', expires_at: expiresAt, admitted_at: 1_500,
    });
  }
}

async function join(w, extraArgs = []) {
  let stdout = '';
  let stderr = '';
  const code = await run(['join', '--product', 'Claude Code', '--name', 'Newcomer', ...extraArgs], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    env: {},
    config: { resolveConnectionDir: () => w.dir },
    clock: () => 5_000,
    sleep: async () => {},
    ask: async () => { throw new Error('must not prompt'); },
    // The room refuses the name, so the join ends at once.
    async fetch() {
      return { ok: false, status: 409, async json() { return { ok: false, error: 'name-taken' }; } };
    },
  });
  return { code, stdout, stderr };
}

test('no --url, and this computer\'s admitted connections are all in one other room: join names it', async () => {
  const w = world();
  profile(w, 'Alder', HOSTED);
  profile(w, 'Birch', HOSTED);
  assert.equal(w.profiles.summaries().filter(p => p.state === 'admitted').length, 2,
    'ARRANGEMENT: two admitted connections, one room');
  const result = await join(w);
  assert.equal(result.code, EXIT_RUNTIME);
  const match = result.stdout.match(HINT);
  assert.ok(match, result.stdout);
  assert.equal(match[1], HOSTED);
  assert.equal(match[2], HOSTED);
  for (const token of w.tokens) {
    assert.ok(!(result.stdout + result.stderr).includes(token), 'no token is ever printed');
    assert.ok(!(result.stdout + result.stderr).includes(token.split('.')[0]), 'not even its selector');
  }
});

test('control: with --url given, no hint', async () => {
  const w = world();
  profile(w, 'Alder', HOSTED);
  const result = await join(w, ['--url', LOCAL]);
  assert.doesNotMatch(result.stdout, HINT);
});

test('no hint when the connections are in two rooms, or none is admitted and current, or the room is this one', async () => {
  const two = world();
  profile(two, 'Alder', HOSTED);
  profile(two, 'Birch', OTHER);
  assert.doesNotMatch((await join(two)).stdout, HINT, 'two rooms: no single answer');

  const stale = world();
  profile(stale, 'Alder', HOSTED, { expiresAt: 2_000 });
  profile(stale, 'Birch', HOSTED, { admitted: false });
  assert.doesNotMatch((await join(stale)).stdout, HINT, 'expired or never admitted');

  const local = world();
  profile(local, 'Alder', LOCAL);
  assert.doesNotMatch((await join(local)).stdout, HINT, 'already the target');

  const empty = world();
  assert.doesNotMatch((await join(empty)).stdout, HINT);
});
