'use strict';

// join --resume and join --discard: one recovery verb each for a join that
// stopped before it finished. Every branch, in both candidate forms.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } = require('../src/cli.js');
const { openProfiles } = require('../src/client/profiles.js');

const ROOM = 'https://room.example';

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function refused() {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  return error;
}

function body(name, overrides = {}) {
  const credential = identity.newAiCredential();
  return Object.assign({
    name, product: 'Claude Code', product_provenance: 'client-reported', server_url: ROOM,
    request_id: crypto.randomUUID(), token: credential.token, selector: credential.selector,
    digest: credential.digest, created_at: 1_000,
  }, overrides);
}

function admission(candidate, subject = 'seat-1') {
  return {
    request_id: candidate.request_id, subject_id: subject, name: candidate.name,
    product: candidate.product, product_provenance: candidate.product_provenance,
    expires_at: 9_000_000, admitted_at: 2_000,
  };
}

function connectionFor(candidate, subject = 'seat-2') {
  return {
    subject_id: subject, name: candidate.name, product: candidate.product,
    product_provenance: candidate.product_provenance, expires_at: 9_000_000,
  };
}

// An orphan like the ones a killed join leaves: an unadmitted profile.
function orphanWorld(name = 'Wren-Two') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-resume-')), 'profiles');
  const profiles = openProfiles({ connectionDir: dir });
  const candidate = profiles.createUnadmitted(body(name));
  return { dir, profiles, candidate, staged: false };
}

// A replacement waiting beside an admitted (expired) connection.
function stagedWorld(name = 'Wren-Two') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-resume-')), 'profiles');
  const profiles = openProfiles({ connectionDir: dir });
  const first = profiles.createUnadmitted(body(name));
  profiles.markAdmitted(name, admission(first, 'seat-old'));
  const candidate = profiles.createStaged(Object.assign(body(name), { created_at: 3_000 }));
  return { dir, profiles, candidate, staged: true, predecessor: profiles.load(name) };
}

async function join(world, args, fetchImpl, extra = {}) {
  let stdout = '';
  let stderr = '';
  const requests = [];
  const code = await run(['join', ...args], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, Object.assign({
    config: { resolveConnectionDir: () => world.dir },
    doorbellStateDir: path.join(path.dirname(world.dir), 'doorbells'),
    clock: () => 5_000,
    sleep: async () => {},
    identity: { newAiCredential() { throw new Error('resume and discard never mint a credential'); } },
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(url, options = {}) {
      requests.push({ url, options });
      return fetchImpl(url, options, requests);
    },
  }, extra));
  return { code, stdout, stderr, requests };
}

function answers(map) {
  return async (url, options) => {
    for (const [suffix, handler] of Object.entries(map)) {
      if (url.endsWith(suffix)) return handler(url, options);
    }
    if (url.endsWith('/api/ai/head')) return json(200, { ok: true, head: 0, connection_session: null });
    return json(404, { ok: false, error: 'not-found' });
  };
}

const knocks = requests => requests.filter(r => r.url.endsWith('/api/ai/admissions'));

test('usage: --resume and --discard take a name and never --url or --product', async () => {
  const world = orphanWorld();
  for (const args of [
    ['--resume'], ['--discard'], ['--resume', '--discard', '--name', 'Wren-Two'],
    ['--resume', '--name', 'Wren-Two', '--url', ROOM],
    ['--discard', '--name', 'Wren-Two', '--product', 'Claude Code'],
  ]) {
    const result = await join(world, args, async () => { throw new Error('no request'); });
    assert.equal(result.code, EXIT_USAGE, args.join(' '));
    assert.match(result.stderr, /join --resume --name NAME/);
    assert.equal(result.requests.length, 0);
  }
});

for (const make of [orphanWorld, stagedWorld]) {
  const form = make === orphanWorld ? 'unadmitted' : 'staged';

  test(`--resume confirms a candidate the room admitted, from its own room, without knocking (${form})`, async () => {
    const world = make();
    const result = await join(world, ['--resume', '--name', 'Wren-Two'], answers({
      '/api/ai/session': () => json(200, { ok: true, connection: connectionFor(world.candidate) }),
    }));
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.ok(result.requests.every(r => r.url.startsWith(ROOM + '/')), 'only the candidate\'s own room');
    assert.equal(knocks(result.requests).length, 0, 'nothing to knock for');
    assert.match(result.stdout, /Resuming the unfinished candidate Wren-Two \(Claude Code\)/);
    assert.match(result.stdout, /Connected as Wren-Two \(Claude Code\)/);
    const saved = world.profiles.load('Wren-Two');
    assert.equal(saved.state, 'admitted');
    assert.equal(saved.request_id, world.candidate.request_id);
    assert.equal(saved.subject_id, 'seat-2');
    assert.equal(world.profiles.stagedExists('Wren-Two'), false);
  });

  test(`--resume re-knocks a candidate the room does not hold, with the same request (${form})`, async () => {
    const world = make();
    let knocked = 0;
    const result = await join(world, ['--resume', '--name', 'Wren-Two'], answers({
      '/api/ai/session': () => json(401, { ok: false, error: 'invalid-connection' }),
      '/api/ai/admissions': (url, options) => {
        knocked += 1;
        const sent = JSON.parse(options.body);
        assert.equal(sent.request_id, world.candidate.request_id, 'the same request, not a new one');
        assert.equal(sent.selector, world.candidate.selector);
        assert.equal(sent.token, undefined);
        return knocked === 1
          ? json(200, Object.assign({ ok: true, state: 'waiting', expires_at: 900_000 }, sent))
          : json(200, Object.assign({ ok: true, state: 'allowed', expires_at: 900_000,
            enrollment: connectionFor(world.candidate) }, {
            request_id: sent.request_id, name: sent.name, product: sent.product,
            product_provenance: sent.product_provenance }));
      },
    }));
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.ok(knocked >= 1, 'ARRANGEMENT: it knocked');
    assert.match(result.stdout, /The room has the request\. Match code:/);
    assert.equal(world.profiles.load('Wren-Two').state, 'admitted');
  });

  test(`--resume against an unreachable room says why and keeps the candidate (${form})`, async () => {
    const world = make();
    const before = fs.readdirSync(world.dir).sort();
    const result = await join(world, ['--resume', '--name', 'Wren-Two'], async () => { throw refused(); });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /was not confirmed \(the room could not be reached: connection refused\)/);
    assert.match(result.stderr, /interlock join --resume --name Wren-Two/);
    assert.match(result.stderr, /interlock join --discard --name Wren-Two/);
    assert.equal(knocks(result.requests).length, 0, 'no knock while the credential cannot be checked');
    assert.deepEqual(fs.readdirSync(world.dir).sort(), before, 'nothing was added or removed');
  });

  test(`--discard drops a candidate the room has not admitted (${form})`, async () => {
    const world = make();
    const result = await join(world, ['--discard', '--name', 'Wren-Two'], answers({
      '/api/ai/session': () => json(401, { ok: false, error: 'invalid-connection' }),
    }));
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.equal(knocks(result.requests).length, 0);
    assert.ok(result.requests.some(r => r.url === ROOM + '/api/ai/session'),
      'ARRANGEMENT: it asked the candidate\'s own room first');
    assert.match(result.stdout, /Discarded the unfinished candidate Wren-Two/);
    if (world.staged) {
      assert.equal(world.profiles.stagedExists('Wren-Two'), false);
      assert.deepEqual(world.profiles.load('Wren-Two'), world.predecessor,
        'the admitted connection it would have replaced is unchanged');
    } else {
      assert.equal(world.profiles.exists('Wren-Two'), false);
    }
  });

  test(`--discard keeps a candidate the room did admit, and says to leave (${form})`, async () => {
    const world = make();
    const result = await join(world, ['--discard', '--name', 'Wren-Two'], answers({
      '/api/ai/session': () => json(200, { ok: true, connection: connectionFor(world.candidate) }),
    }));
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /the room had admitted Wren-Two, so it was kept and is now saved as connected/);
    assert.match(result.stderr, /interlock leave --connection Wren-Two/);
    const saved = world.profiles.load('Wren-Two');
    assert.equal(saved.state, 'admitted');
    assert.equal(saved.request_id, world.candidate.request_id);
  });

  test(`--discard against an unreachable room keeps the candidate (${form})`, async () => {
    const world = make();
    const before = fs.readdirSync(world.dir).sort();
    const result = await join(world, ['--discard', '--name', 'Wren-Two'], async () => { throw refused(); });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /could not confirm that https:\/\/room\.example never admitted Wren-Two \(the room could not be reached: connection refused\)/);
    assert.deepEqual(fs.readdirSync(world.dir).sort(), before);
  });

  test(`--discard against a room error (not a clear "not admitted") keeps the candidate (${form})`, async () => {
    const world = make();
    const result = await join(world, ['--discard', '--name', 'Wren-Two'], answers({
      '/api/ai/session': () => json(503, { ok: false, error: 'chat-unavailable' }),
    }));
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /\(the room answered 503 chat-unavailable\)/);
    assert.ok(world.staged ? world.profiles.stagedExists('Wren-Two') : world.profiles.exists('Wren-Two'));
  });
}

test('--discard that loses a race to a finishing doorbell removes nothing', async () => {
  const world = orphanWorld();
  const result = await join(world, ['--discard', '--name', 'Wren-Two'], answers({
    '/api/ai/session': () => {
      // Another process records the admission while this one is asking.
      world.profiles.admitCandidate('Wren-Two', admission(world.candidate, 'seat-race'));
      return json(401, { ok: false, error: 'invalid-connection' });
    },
  }));
  assert.equal(world.profiles.load('Wren-Two').state, 'admitted', 'ARRANGEMENT: the other writer finished first');
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /changed while discarding/);
  assert.equal(world.profiles.load('Wren-Two').subject_id, 'seat-race', 'the admitted profile survived');
});

test('--resume and --discard name what is there when no candidate is', async () => {
  const empty = { dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-resume-')), 'profiles') };
  for (const verb of ['--resume', '--discard']) {
    const result = await join(empty, [verb, '--name', 'Nobody'], async () => { throw new Error('no request'); });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /there is no unfinished candidate named Nobody/);
    assert.equal(result.requests.length, 0);
  }
  const world = orphanWorld();
  world.profiles.markAdmitted('Wren-Two', admission(world.candidate));
  const resumed = await join(world, ['--resume', '--name', 'Wren-Two'], async () => { throw new Error('no request'); });
  assert.equal(resumed.code, EXIT_OK);
  assert.match(resumed.stderr, /already admitted; there is nothing to resume/);
  const discarded = await join(world, ['--discard', '--name', 'Wren-Two'], async () => { throw new Error('no request'); });
  assert.equal(discarded.code, EXIT_RUNTIME);
  assert.match(discarded.stderr, /is admitted, not an unfinished candidate\. To end it: interlock leave --connection Wren-Two/);
  assert.equal(world.profiles.load('Wren-Two').state, 'admitted', 'an admitted profile is never discarded');
});

test('a plain join that cannot confirm its candidate names both verbs and says why', async () => {
  const world = orphanWorld();
  const result = await join(world, ['--product', 'Claude Code', '--name', 'Wren-Two', '--url', ROOM], answers({
    '/api/ai/session': () => json(503, { ok: false, error: 'chat-unavailable' }),
  }));
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /the exact unfinished candidate Wren-Two was not confirmed \(the room answered 503 chat-unavailable\)/);
  assert.match(result.stderr, /Resume it: interlock join --resume --name Wren-Two/);
  assert.match(result.stderr, /Or drop it: interlock join --discard --name Wren-Two/);
});
