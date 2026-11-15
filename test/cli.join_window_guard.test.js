'use strict';

// The room answers a still-waiting candidate's own credential exactly like
// one it never admitted. So --discard keeps a candidate while its request may
// still be on the owner's card, and nothing re-knocks a candidate past its
// own join window (a forgotten request would come back as a new card).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_OK, EXIT_RUNTIME } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');
const { openAdmissionService } = require('../src/admission/service.js');

const ROOM = 'https://room.example';
const MIN = 60_000;

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function orphan(createdAt = 1_000) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-window-')), 'profiles');
  const profiles = openProfiles({ connectionDir: dir });
  const credential = identity.newAiCredential();
  const candidate = profiles.createUnadmitted({
    name: 'Rowan', product: 'Codex CLI', product_provenance: 'client-reported', server_url: ROOM,
    request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: createdAt,
  });
  return { dir, profiles, candidate };
}

async function join(world, args, fetchImpl, now) {
  let stdout = '';
  let stderr = '';
  const requests = [];
  const code = await run(['join', ...args], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => world.dir },
    doorbellStateDir: path.join(path.dirname(world.dir), 'doorbells'),
    clock: () => now,
    sleep: async () => {},
    identity: { newAiCredential() { throw new Error('never mints'); } },
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(url, options = {}) { requests.push(url); return fetchImpl(url, options); },
  });
  return { code, stdout, stderr, knocks: requests.filter(url => url.endsWith('/api/ai/admissions')).length };
}

// A fetch that speaks for a real admission service: a knock goes to the
// service; the candidate's credential reads as admitted only once the service
// allowed its request (as the room does), else the room's exact 401.
function roomFor(service, candidate) {
  return async (url, options) => {
    if (url.endsWith('/api/ai/admissions')) {
      const result = await service.knock(JSON.parse(options.body), { timeoutMs: 0 });
      return json(result.ok ? 200 : 409, result.ok ? result : { ok: false, error: result.reason });
    }
    if (url.endsWith('/api/ai/session')) {
      const settled = await service.knock(Object.fromEntries(
        ['request_id', 'name', 'product', 'product_provenance', 'selector', 'digest']
          .map(key => [key, candidate[key]])), { timeoutMs: 0 });
      if (settled.state === 'allowed') return json(200, { ok: true, connection: settled.enrollment });
      return json(401, { ok: false, error: 'invalid-connection' });
    }
    if (url.endsWith('/api/ai/head')) return json(200, { ok: true, head: 0, connection_session: null });
    return json(404, { ok: false, error: 'not-found' });
  };
}

function service() {
  const house = {
    inspectAiAdmission: body => Object.assign({ ok: true, previously_used: false, last_ended_at: null,
      reuse: 'fresh', reuse_session: null }, body),
    allowAiAdmission: (meta, body) => ({ ok: true, subject_id: 'seat-' + body.request_id, name: body.name,
      product: body.product, product_provenance: body.product_provenance, expires_at: 9_000_000_000_000 }),
  };
  return openAdmissionService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-window-room-')), house, clock: () => Date.now(),
  });
}

function knockBody(candidate) {
  return Object.fromEntries(['request_id', 'name', 'product', 'product_provenance', 'selector', 'digest']
    .map(key => [key, candidate[key]]));
}

test('--discard keeps a candidate while a second holder still waits on its request, and the Allow is recovered', async () => {
  const room = service();
  const world = orphan(Date.now());
  try {
    assert.equal((await room.knock(knockBody(world.candidate), { timeoutMs: 0 })).state, 'waiting');
    // Another process (a pending doorbell, a background join) holds the knock.
    const held = room.knock(knockBody(world.candidate), { timeoutMs: 20_000 });
    assert.equal(room.list()[0].connected, true, 'ARRANGEMENT: a second holder is waiting');

    const discarded = await join(world, ['--discard', '--name', 'Rowan'], roomFor(room, world.candidate),
      world.candidate.created_at + 5_000);
    assert.equal(discarded.code, EXIT_RUNTIME);
    assert.match(discarded.stderr, /request may still be waiting on the owner's card until/);
    assert.match(discarded.stderr, /owner can Decline it in People/);
    assert.equal(world.profiles.load('Rowan').state, 'unadmitted', 'the candidate is kept');

    const allowed = room.allow(world.candidate.request_id, { fresh: true });
    assert.equal(allowed.state, 'allowed');
    assert.equal((await held).state, 'allowed', 'ARRANGEMENT: the holder was admitted');
    const resumed = await join(world, ['--resume', '--name', 'Rowan'], roomFor(room, world.candidate),
      world.candidate.created_at + 6_000);
    assert.equal(resumed.code, EXIT_OK, resumed.stderr);
    assert.equal(world.profiles.load('Rowan').state, 'admitted', 'the admitted seat has its credential on disk');
  } finally {
    room.close();
  }
});

test('--discard keeps a candidate inside the just-answered window, with nobody holding', async () => {
  const room = service();
  const world = orphan(Date.now());
  try {
    assert.equal((await room.knock(knockBody(world.candidate), { timeoutMs: 0 })).state, 'waiting');
    assert.equal(room.list()[0].connected, true, 'ARRANGEMENT: the request is Allow-able with no holder');
    const discarded = await join(world, ['--discard', '--name', 'Rowan'], roomFor(room, world.candidate),
      world.candidate.created_at + 2_000);
    assert.equal(discarded.code, EXIT_RUNTIME);
    assert.equal(discarded.knocks, 0);
    assert.ok(world.profiles.exists('Rowan'));
  } finally {
    room.close();
  }
});

test('--discard drops the candidate once its request can no longer be waiting', async () => {
  const world = orphan(1_000);
  const answers = async url => url.endsWith('/api/ai/session')
    ? json(401, { ok: false, error: 'invalid-connection' }) : json(404, { ok: false, error: 'not-found' });
  const edge = 1_000 + 32 * MIN;
  const early = await join(world, ['--discard', '--name', 'Rowan'], answers, edge - 1);
  assert.equal(early.code, EXIT_RUNTIME, 'one millisecond before the bound it is kept');
  assert.match(early.stderr, new RegExp(new Date(edge).toISOString().replace(/\./g, '\\.')));
  const late = await join(world, ['--discard', '--name', 'Rowan'], answers, edge);
  assert.equal(late.code, EXIT_OK, late.stderr);
  assert.equal(world.profiles.exists('Rowan'), false);
});

test('--resume and a plain join never re-knock a candidate past its window (a purged decline at +25 h)', async () => {
  const world = orphan(1_000);
  // A room that forgot the declined request would take the same knock as new.
  const forgetful = async (url, options) => {
    if (url.endsWith('/api/ai/session')) return json(401, { ok: false, error: 'invalid-connection' });
    if (url.endsWith('/api/ai/admissions')) {
      return json(200, Object.assign({ ok: true, state: 'waiting', expires_at: 9e15 }, JSON.parse(options.body)));
    }
    return json(404, { ok: false, error: 'not-found' });
  };
  const at = 1_000 + 25 * 60 * MIN;
  for (const args of [['--resume', '--name', 'Rowan'], ['--product', 'Codex CLI', '--name', 'Rowan', '--url', ROOM]]) {
    const result = await join(world, args, forgetful, at);
    assert.equal(result.code, EXIT_RUNTIME, args.join(' '));
    assert.equal(result.knocks, 0, 'nothing went back on the owner\'s card: ' + args.join(' '));
    assert.match(result.stderr, /is past its join window/);
    assert.match(result.stderr, /interlock join --discard --name Rowan, then interlock join --product "Codex CLI" --name Rowan/);
    assert.equal(world.profiles.load('Rowan').state, 'unadmitted');
  }
});

test('control: inside its window, --resume still re-knocks', async () => {
  const world = orphan(1_000);
  let knocked = 0;
  const room = async (url, options) => {
    if (url.endsWith('/api/ai/session')) return json(401, { ok: false, error: 'invalid-connection' });
    if (url.endsWith('/api/ai/admissions')) {
      knocked += 1;
      const sent = JSON.parse(options.body);
      return json(200, { ok: true, state: 'declined', request_id: sent.request_id, name: sent.name,
        product: sent.product, product_provenance: sent.product_provenance, expires_at: 9e15 });
    }
    return json(404, { ok: false, error: 'not-found' });
  };
  const result = await join(world, ['--resume', '--name', 'Rowan'], room, 1_000 + 14 * MIN);
  assert.equal(knocked, 1, 'ARRANGEMENT/OUTCOME: the knock was sent');
  assert.match(result.stderr, /owner declined/);
});

test('between the join window and the discard bound, --resume names when --discard will work, not a refusing one', async () => {
  const world = orphan(1_000);
  const room = async url => url.endsWith('/api/ai/session')
    ? json(401, { ok: false, error: 'invalid-connection' }) : json(404, { ok: false, error: 'not-found' });
  const bound = new Date(1_000 + 32 * MIN).toISOString();
  const mid = await join(world, ['--resume', '--name', 'Rowan'], room, 1_000 + 20 * MIN);
  assert.equal(mid.code, EXIT_RUNTIME);
  assert.equal(mid.knocks, 0);
  assert.ok(mid.stderr.includes(`The owner may still see it until ${bound}. After ${bound}, start over: interlock join --discard --name Rowan`), mid.stderr);
  assert.match(mid.stderr, /ask the owner to Decline it in People now/);
  assert.doesNotMatch(mid.stderr, /To ask again, start over/);
  // The advice holds: --discard at that moment refuses, and at the bound it works.
  assert.equal((await join(world, ['--discard', '--name', 'Rowan'], room, 1_000 + 20 * MIN)).code, EXIT_RUNTIME);
  const late = await join(world, ['--resume', '--name', 'Rowan'], room, 1_000 + 32 * MIN);
  assert.match(late.stderr, /To ask again, start over: interlock join --discard --name Rowan/);
  assert.equal((await join(world, ['--discard', '--name', 'Rowan'], room, 1_000 + 32 * MIN)).code, EXIT_OK);
});
