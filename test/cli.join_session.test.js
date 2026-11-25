'use strict';

// A join belongs to the host session that started it. Two AI sessions on one
// computer share one connection directory, so a second session that picks
// the same name must never finish, drop or quietly share the first one's
// join. Every arrangement first proves the collision exists: one candidate,
// started by session A, seen from session B.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { run, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } = require('../src/cli.js');
const { openProfiles, sessionDigest } = require('../src/client/profiles.js');

const ROOM = 'https://room.example';
const NAME = 'Wren-Two';
const A = 'host-session-aaaa-1111';
const B = 'host-session-bbbb-2222';

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function body(name = NAME, overrides = {}) {
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

function freshDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-session-')), 'profiles');
}

// Session A's pending join, in the unadmitted form.
function pendingWorld(starter = A) {
  const dir = freshDir();
  const profiles = openProfiles({ connectionDir: dir });
  const candidate = profiles.createUnadmitted(body(),
    { session: starter === null ? null : sessionDigest(starter) });
  return { dir, profiles, candidate };
}

// Session A's pending replacement beside an admitted, expired connection.
function stagedWorld(starter = A) {
  const dir = freshDir();
  const profiles = openProfiles({ connectionDir: dir });
  const first = profiles.createUnadmitted(body());
  profiles.markAdmitted(NAME, admission(first, 'seat-old'));
  const candidate = profiles.createStaged(body(NAME, { created_at: 3_000 }),
    { session: sessionDigest(starter) });
  return { dir, profiles, candidate };
}

// Session A's admitted connection.
function admittedWorld(starter = A) {
  const dir = freshDir();
  const profiles = openProfiles({ connectionDir: dir });
  const candidate = profiles.createUnadmitted(body(), { session: sessionDigest(starter) });
  profiles.markAdmitted(NAME, admission(candidate));
  return { dir, profiles, candidate };
}

function snapshot(dir) {
  return fs.readdirSync(dir).filter(name => !name.startsWith('.')).sort()
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}

async function command(world, argv, env, fetchImpl, extra = {}) {
  let stdout = '';
  let stderr = '';
  const requests = [];
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, Object.assign({
    env,
    config: { resolveConnectionDir: () => world.dir },
    doorbellStateDir: path.join(path.dirname(world.dir), 'doorbells'),
    clock: () => 5_000,
    sleep: async () => {},
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(url, options = {}) {
      requests.push(url);
      if (!fetchImpl) throw new Error('no request expected: ' + url);
      return fetchImpl(url, options);
    },
  }, extra));
  return { code, stdout, stderr, requests };
}

// The room admits whatever knocks, and confirms nothing else.
function admits(url, options) {
  if (url.endsWith('/api/ai/head')) return json(200, { ok: true, head: 0, connection_session: null });
  if (url.endsWith('/api/ai/admissions')) {
    const sent = JSON.parse(options.body);
    const connection = { subject_id: 'seat-9', name: sent.name, product: sent.product,
      product_provenance: sent.product_provenance, expires_at: 900_000 };
    return json(200, { ok: true, state: 'allowed', request_id: sent.request_id, expires_at: 900_000,
      name: sent.name, product: sent.product, product_provenance: sent.product_provenance,
      enrollment: connection });
  }
  return json(401, { ok: false, error: 'invalid-connection' });
}

const joinArgs = ['join', '--url', ROOM, '--product', 'Claude Code', '--name', NAME];

test('ARRANGEMENT: the record names the starting session as a digest, never the id, beside an unchanged profile', () => {
  const world = pendingWorld();
  assert.equal(world.profiles.sessionOf(NAME, world.candidate.request_id), sessionDigest(A));
  assert.notEqual(sessionDigest(A), sessionDigest(B));
  const files = fs.readdirSync(world.dir).filter(name => !name.startsWith('.')).sort();
  assert.deepEqual(files, [`wren-two.${world.candidate.request_id}.token`, 'wren-two.json', 'wren-two.session'].sort());
  const record = fs.readFileSync(path.join(world.dir, 'wren-two.session'), 'utf8');
  assert.ok(!record.includes(A), 'the raw session id is never stored');
  // The session record changes nothing in the profile: its key set is the
  // split profile's, with the token in its own file.
  const profile = JSON.parse(fs.readFileSync(path.join(world.dir, 'wren-two.json'), 'utf8'));
  assert.deepEqual(Object.keys(profile).sort(), [
    'admitted_at', 'created_at', 'cursor', 'digest', 'expires_at', 'name', 'product',
    'product_provenance', 'request_id', 'schema', 'selector', 'server_url', 'state', 'subject_id',
  ]);
});

for (const [form, make] of [['unadmitted', pendingWorld], ['staged', stagedWorld]]) {
  test(`(${form}) another session's plain join under the same name is told to pick another name, with no resume advice`, async () => {
    const world = make();
    assert.ok(world.profiles.sessionOf(NAME, world.candidate.request_id), 'ARRANGEMENT: A started it');
    const before = snapshot(world.dir);
    const result = await command(world, joinArgs, { CLAUDE_CODE_SESSION_ID: B });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /someone on this computer is already joining as Wren-Two\. Pick another name: interlock join --name/);
    assert.doesNotMatch(result.stderr + result.stdout, /--resume|--discard|resume it|drop it/i);
    assert.equal(result.requests.length, 0, 'nothing was sent for the other session');
    assert.deepEqual(snapshot(world.dir), before, 'the first session\'s candidate is untouched');
  });

  test(`(${form}) another session's --resume is refused and changes nothing`, async () => {
    const world = make();
    const before = snapshot(world.dir);
    const result = await command(world, ['join', '--resume', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /Wren-Two's join was started by another session on this computer, so it is not yours to resume/);
    assert.match(result.stderr, /Choose your own name: interlock join --name/);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(snapshot(world.dir), before);
  });

  test(`(${form}) another session's --discard is refused and removes nothing`, async () => {
    const world = make();
    const before = snapshot(world.dir);
    const result = await command(world, ['join', '--discard', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B });
    assert.equal(result.code, EXIT_RUNTIME);
    assert.match(result.stderr, /not yours to drop\. Nothing was removed/);
    assert.equal(result.requests.length, 0);
    assert.deepEqual(snapshot(world.dir), before);
  });

  test(`(${form}) the starting session resumes its own join`, async () => {
    const world = make();
    const result = await command(world, ['join', '--resume', '--name', NAME], { CLAUDE_CODE_SESSION_ID: A }, admits);
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.match(result.stdout, /Connected as Wren-Two/);
    assert.equal(world.profiles.load(NAME).state, 'admitted');
    assert.equal(world.profiles.sessionOf(NAME, world.candidate.request_id), sessionDigest(A),
      'the admitted connection keeps its starter');
  });
}

test('INTERLOCK_SESSION wins over the Claude Code variable, and --session over both', async () => {
  const viaEnv = pendingWorld();
  const a = await command(viaEnv, ['join', '--resume', '--name', NAME],
    { INTERLOCK_SESSION: A, CLAUDE_CODE_SESSION_ID: B }, admits);
  assert.equal(a.code, EXIT_OK, a.stderr);

  const viaFlag = pendingWorld();
  const b = await command(viaFlag, ['join', '--resume', '--name', NAME, '--session', A],
    { INTERLOCK_SESSION: B }, admits);
  assert.equal(b.code, EXIT_OK, b.stderr);

  const refused = pendingWorld();
  const c = await command(refused, ['join', '--resume', '--name', NAME, '--session', B],
    { INTERLOCK_SESSION: A });
  assert.equal(c.code, EXIT_RUNTIME, 'control: the flag is what decides');
});

test('an invalid --session is a usage error before anything is read or sent', async () => {
  const world = pendingWorld();
  const result = await command(world, ['join', '--resume', '--name', NAME, '--session', 'has space'], {});
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /--session takes your host session id/);
  assert.equal(result.requests.length, 0);
});

test('with no session known on either side, today\'s behaviour holds', async () => {
  // Started with no session known: anyone may resume it, as before.
  const unknownStarter = pendingWorld(null);
  assert.equal(unknownStarter.profiles.sessionOf(NAME, unknownStarter.candidate.request_id), null,
    'ARRANGEMENT: no starter recorded');
  const a = await command(unknownStarter, ['join', '--resume', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B }, admits);
  assert.equal(a.code, EXIT_OK, a.stderr);

  // This session unknown: nothing to compare, so nothing is refused.
  const knownStarter = pendingWorld(A);
  const b = await command(knownStarter, ['join', '--resume', '--name', NAME], {}, admits);
  assert.equal(b.code, EXIT_OK, b.stderr);
});

test('an unreadable record means "not known", never "someone else\'s"', async () => {
  const world = pendingWorld();
  fs.writeFileSync(path.join(world.dir, 'wren-two.session'), '{not json');
  const result = await command(world, ['join', '--resume', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B }, admits);
  assert.equal(result.code, EXIT_OK, result.stderr);
});

test('a join records the session it ran in, and only a digest of it', async () => {
  const world = { dir: freshDir() };
  const result = await command(world, joinArgs, { CLAUDE_CODE_SESSION_ID: A }, admits,
    { identity: identity });
  assert.equal(result.code, EXIT_OK, result.stderr);
  const profiles = openProfiles({ connectionDir: world.dir });
  const profile = profiles.load(NAME);
  assert.equal(profile.state, 'admitted');
  assert.equal(profiles.sessionOf(NAME, profile.request_id), sessionDigest(A));
  assert.ok(!fs.readFileSync(path.join(world.dir, 'wren-two.session'), 'utf8').includes(A));
});

test('the neutral wording when a candidate appears mid-join says "if it is yours"', async () => {
  // A staged file created between the check and the write: the race the
  // profile lock settles. The losing join is told both ways forward.
  const world = admittedWorld();
  const profiles = world.profiles;
  const result = await command(world, joinArgs, {}, admits, {
    profiles: Object.assign({}, require('../src/client/profiles.js'), {
      openProfiles(options) {
        const real = openProfiles(options);
        return Object.assign({}, real, {
          load(name) {
            const loaded = real.load(name);
            return Object.assign({}, loaded, { expires_at: 1 });
          },
          createStaged() {
            const error = new Error('client.profiles: staged-profile-exists');
            error.code = 'staged-profile-exists';
            throw error;
          },
        });
      },
    }),
  });
  assert.ok(profiles.exists(NAME), 'ARRANGEMENT: an admitted connection by that name exists');
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /an unfinished join for that name already exists on this computer\. If it is yours, resume it/);
  assert.match(result.stderr, /If it is not, pick another name: interlock join --name/);
});

test('removing a candidate removes its record; the directory holds nothing for it after', async () => {
  const world = pendingWorld();
  world.profiles.removeUnadmitted(NAME, world.candidate.request_id);
  assert.deepEqual(snapshot(world.dir), []);
  const staged = stagedWorld();
  staged.profiles.removeStaged(NAME, staged.candidate.request_id);
  assert.equal(staged.profiles.sessionOf(NAME, staged.candidate.request_id), null);
  assert.ok(!fs.existsSync(path.join(staged.dir, 'wren-two.session')));
});

function grantsReply(url) {
  if (url.endsWith('/api/ai/grants')) return json(200, { ok: true, grants: [] });
  return json(404, { ok: false, error: 'not-found' });
}

test('another session using an admitted connection is warned once; its starter never is', async () => {
  const world = admittedWorld();
  const argv = ['grants', '--connection', NAME];
  const warning = /Wren-Two was joined by another session on this computer; two sessions may be sharing it\. Use your own name: interlock join --name/;

  const own = await command(world, argv, { CLAUDE_CODE_SESSION_ID: A }, grantsReply);
  assert.equal(own.code, EXIT_OK, own.stderr);
  assert.doesNotMatch(own.stderr, warning, 'the starter is never warned');

  const first = await command(world, argv, { CLAUDE_CODE_SESSION_ID: B }, grantsReply);
  assert.equal(first.code, EXIT_OK, first.stderr);
  assert.match(first.stderr, warning);

  const second = await command(world, argv, { CLAUDE_CODE_SESSION_ID: B }, grantsReply);
  assert.equal(second.code, EXIT_OK);
  assert.doesNotMatch(second.stderr, warning, 'once per other session');

  const third = await command(world, argv, { INTERLOCK_SESSION: 'host-session-cccc-3333' }, grantsReply);
  assert.match(third.stderr, warning, 'a third session is warned in its own right');

  const unknown = await command(world, argv, {}, grantsReply);
  assert.doesNotMatch(unknown.stderr, warning, 'no session known: nothing to compare');
});

test('a plain join that reconnects an admitted connection from another session warns, and still reconnects', async () => {
  const world = admittedWorld();
  const result = await command(world, joinArgs, { CLAUDE_CODE_SESSION_ID: B }, url => {
    if (url.endsWith('/api/ai/session')) {
      return json(200, { ok: true, connection: { subject_id: 'seat-1', name: NAME, product: 'Claude Code',
        product_provenance: 'client-reported', expires_at: 9_000_000 } });
    }
    if (url.endsWith('/api/ai/head')) return json(200, { ok: true, head: 0, connection_session: null });
    return json(404, { ok: false, error: 'not-found' });
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stderr, /Wren-Two was joined by another session on this computer/);
});

test('the session digest is a fixed SHA-256, not a reversible encoding (known answer)', () => {
  // sha256("interlock-host-session\0host-session-aaaa-1111"), computed outside Node.
  assert.equal(sessionDigest(A), '4bcc29db5761b2b53c14b0d0985856395725863df46644c0eaf86dee1f238b7a');
  assert.ok(!Buffer.from(sessionDigest(A), 'hex').toString('latin1').includes(A));
});

// The race the first check alone leaves open: another session's candidate
// appears between that check and the step that would resume or complete it.
// The candidate is created on the second existence check, after the first.
function racingProfiles(dir, form) {
  const real = require('../src/client/profiles.js');
  let injected = null;
  let calls = 0;
  return {
    get injected() { return injected; },
    module: Object.assign({}, real, {
      openProfiles(options) {
        const inner = real.openProfiles(options);
        const probe = form === 'staged' ? 'stagedExists' : 'exists';
        return Object.assign({}, inner, {
          [probe](name) {
            calls += 1;
            if (calls === 2 && injected === null) {
              const make = form === 'staged' ? inner.createStaged : inner.createUnadmitted;
              injected = make(body(NAME, { created_at: 4_000 }), { session: sessionDigest(A) });
            }
            return inner[probe](name);
          },
        });
      },
    }),
  };
}

for (const form of ['unadmitted', 'staged']) {
  test(`(${form}) a candidate another session creates mid-join is refused, never completed`, async () => {
    const world = form === 'staged' ? (() => {
      const dir = freshDir();
      const profiles = openProfiles({ connectionDir: dir });
      const first = profiles.createUnadmitted(body());
      profiles.markAdmitted(NAME, Object.assign(admission(first, 'seat-old'), { expires_at: 3_000 }));
      return { dir };
    })() : { dir: freshDir() };
    const race = racingProfiles(world.dir, form);
    const sent = [];
    const result = await command(world, joinArgs, { CLAUDE_CODE_SESSION_ID: B }, (url, options) => {
      if (options && options.body) sent.push(JSON.parse(options.body).request_id);
      return admits(url, options);
    }, { profiles: race.module, identity });
    assert.ok(race.injected, 'ARRANGEMENT: the other session\'s candidate appeared mid-join');
    assert.equal(result.code, EXIT_RUNTIME, result.stdout + result.stderr);
    assert.match(result.stderr, /someone on this computer is already joining as Wren-Two\. Pick another name/);
    assert.ok(!sent.includes(race.injected.request_id), 'the other session\'s request was never sent');
    const after = openProfiles({ connectionDir: world.dir });
    const current = form === 'staged' ? after.loadStaged(NAME) : after.load(NAME);
    assert.equal(current.request_id, race.injected.request_id);
    assert.equal(current.state, 'unadmitted', 'it was not completed');
  });
}

test('a stranded join: the refusal says how its starter gets it back, and once it can admit nothing, it can be dropped', async () => {
  const world = pendingWorld();
  const refused = await command(world, ['join', '--resume', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B });
  assert.equal(refused.code, EXIT_RUNTIME);
  // created_at 1_000 + 15 + 15 + 2 minutes.
  assert.ok(refused.stderr.includes('If it was your own join from an earlier conversation, run this again with ' +
    "--session <that conversation's session id>, or after 1970-01-01T00:32:01.000Z drop it: interlock join --discard --name Wren-Two"),
  refused.stderr);
  // Past that time the room cannot admit it, so another session may drop it.
  const late = await command(world, ['join', '--discard', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B },
    url => (url.endsWith('/api/ai/head') ? json(200, { ok: true, head: 0, connection_session: null })
      : json(401, { ok: false, error: 'invalid-connection' })), { clock: () => 40 * 60_000 });
  assert.doesNotMatch(late.stderr, /not yours/);
  assert.match(late.stdout, /Discarded the unfinished candidate Wren-Two/, late.stdout + late.stderr);
});

test('the guard holds until the room can admit nothing, and lifts exactly then', async () => {
  // created_at 1_000; the room may still admit it until 1_000 + 15 + 15 + 2 minutes.
  const bound = 1_000 + 32 * 60_000;
  const roomSaysNo = url => (url.endsWith('/api/ai/head') ? json(200, { ok: true, head: 0, connection_session: null })
    : json(401, { ok: false, error: 'invalid-connection' }));
  for (const [argv, label] of [[['join', '--discard', '--name', NAME], 'discard'], [joinArgs, 'plain join']]) {
    const before = await command(pendingWorld(), argv, { CLAUDE_CODE_SESSION_ID: B }, roomSaysNo, { clock: () => bound - 1 });
    assert.equal(before.code, EXIT_RUNTIME, label);
    assert.match(before.stderr, /not yours to drop|already joining as Wren-Two/, `${label}: still refused 1 ms before`);
    const after = await command(pendingWorld(), argv, { CLAUDE_CODE_SESSION_ID: B }, roomSaysNo, { clock: () => bound });
    assert.doesNotMatch(after.stderr, /not yours|already joining/, `${label}: lifted at the bound`);
  }
  // A guard lifted at the join window alone (15 minutes) would let another
  // session act while the owner can still Allow it.
  const midway = await command(pendingWorld(), ['join', '--discard', '--name', NAME], { CLAUDE_CODE_SESSION_ID: B },
    roomSaysNo, { clock: () => 1_000 + 15 * 60_000 + 1 });
  assert.match(midway.stderr, /not yours to drop/);
});
