'use strict';

// Each authenticated request names its host session as a digest salted with
// the connection's request id, so the room can see a connection used from
// another session (a tripwire, not a lock). No session known: no header. The
// doorbell's own requests carry the session it was started with, and status
// says when the room saw another session.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');
const profileModule = require('../src/client/profiles.js');

const ROOT = path.join(__dirname, '..');
const SESSION = '0b6f1d7e-3c2a-4e5f-8a9b-1c2d3e4f5a6b';
const HEADER = 'x-interlock-session';

function expectedDigest(requestId, session) {
  return crypto.createHash('sha256').update(`${requestId}:${profileModule.sessionDigest(session)}`, 'utf8').digest('hex');
}

function connection(requestId = crypto.randomUUID(), env = {}) {
  const profile = {
    schema: 3, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'https://app.example.test', request_id: requestId,
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999_999_999_999, cursor: 0,
  };
  const profiles = {
    load: () => Object.freeze(Object.assign({}, profile)), updateCursor() {},
    acquireReadLease() { return { release() {} }; },
  };
  return {
    clock: () => 1_000,
    env,
    config: { resolveConnectionDir: () => path.join(os.tmpdir(), 'interlock-session-header') },
    joinedTailMarks: { has: () => true, add() {} },
    profiles: Object.assign({}, profileModule, { openProfiles: () => profiles }),
    doorbellStateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-session-header-')),
  };
}

async function cli(argv, dependencies) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stdout, stderr };
}

// Runs with exactly these host-session variables set, the rest removed.
async function withSessionEnv(values, operation) {
  const saved = {};
  for (const key of ['INTERLOCK_SESSION', 'CLAUDE_CODE_SESSION_ID']) {
    saved[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  try { return await operation(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function headRecorder(seen) {
  return async (url, options) => {
    seen.push(options.headers);
    return new Response(JSON.stringify({ ok: true, head: 4, connection_session: null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('a request names its host session as a digest salted with the connection', async () => {
  const requestId = crypto.randomUUID();
  const seen = [];
  const dependencies = connection(requestId);
  dependencies.fetch = headRecorder(seen);
  const result = await withSessionEnv({ INTERLOCK_SESSION: SESSION },
    () => cli(['history', '--connection', 'Marlow', '--skip-to-current'], dependencies));
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.ok(seen.length > 0, 'ARRANGEMENT: the command reached the room');
  for (const headers of seen) {
    assert.equal(headers[HEADER], expectedDigest(requestId, SESSION));
    assert.equal(Object.values(headers).some(value => String(value).includes(SESSION)), false, 'never the raw session id');
  }

  // The same session in another connection gives another digest.
  const otherSeen = [];
  const other = connection(crypto.randomUUID());
  other.fetch = headRecorder(otherSeen);
  await withSessionEnv({ INTERLOCK_SESSION: SESSION },
    () => cli(['history', '--connection', 'Marlow', '--skip-to-current'], other));
  assert.notEqual(otherSeen[0][HEADER], seen[0][HEADER]);

  // Claude Code's own variable counts when INTERLOCK_SESSION is unset.
  const claudeSeen = [];
  const claude = connection(requestId);
  claude.fetch = headRecorder(claudeSeen);
  await withSessionEnv({ CLAUDE_CODE_SESSION_ID: SESSION },
    () => cli(['history', '--connection', 'Marlow', '--skip-to-current'], claude));
  assert.equal(claudeSeen[0][HEADER], expectedDigest(requestId, SESSION));
});

test('no host session known: no header (the room reads it as unknown)', async () => {
  const seen = [];
  const dependencies = connection();
  dependencies.fetch = headRecorder(seen);
  const result = await withSessionEnv({}, () => cli(['history', '--connection', 'Marlow', '--skip-to-current'], dependencies));
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.ok(seen.length > 0, 'ARRANGEMENT: the command reached the room');
  assert.equal(seen.some(headers => Object.prototype.hasOwnProperty.call(headers, HEADER)), false);
});

function statusFetch(sessionUse) {
  return async url => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/ai/session')) {
      return json(200, { ok: true, connection: { subject_id: 'seat-1', name: 'Marlow', product: 'Codex CLI',
        product_provenance: 'client-reported', expires_at: 99_999_999_999_999 } });
    }
    if (url.endsWith('/api/ai/last-answered')) return json(200, { ok: true, last_answered: null });
    if (url.endsWith('/api/ai/presence-kind')) {
      return json(200, { ok: true, presence_kind: { kind: 'listening', since: 1_000, next: null }, session: null });
    }
    if (url.endsWith('/api/ai/session-use')) {
      return sessionUse === 404 ? json(404, { ok: false, error: 'not-found' }) : json(200, { ok: true, session_use: sessionUse });
    }
    throw new Error('unexpected ' + url);
  };
}

test('status says when the room saw this connection used from another session', async () => {
  const flagged = connection();
  flagged.fetch = statusFetch({ first_seen_at: 1_000, other_session_at: 1_800_000_000_000 });
  const said = await cli(['status', '--connection', 'Marlow'], flagged);
  assert.equal(said.code, EXIT_OK, said.stderr);
  assert.match(said.stdout, /^Used from another session: yes, last at 2027-01-15T08:00:00\.000Z — a host session other than the one that first used this connection used it\. If that was not you, another AI on this computer may be using your connection; tell your person\. \(A tripwire, not a lock\.\)$/m);
  const json = JSON.parse((await cli(['status', '--connection', 'Marlow', '--json'], flagged)).stdout);
  assert.deepEqual(json.facts.session_use, { state: 'other', first_seen_at: 1_000, other_session_at: 1_800_000_000_000 });

  // Nothing seen: no line, and --json says so.
  const clean = connection();
  clean.fetch = statusFetch({ first_seen_at: 1_000, other_session_at: null });
  const quiet = await cli(['status', '--connection', 'Marlow'], clean);
  assert.doesNotMatch(quiet.stdout, /another session/);
  assert.deepEqual(JSON.parse((await cli(['status', '--connection', 'Marlow', '--json'], clean)).stdout).facts.session_use,
    { state: 'own', first_seen_at: 1_000, other_session_at: null });

  // An older room has no record: unknown, no line.
  const older = connection();
  older.fetch = statusFetch(404);
  const old = await cli(['status', '--connection', 'Marlow', '--json'], older);
  assert.deepEqual(JSON.parse(old.stdout).facts.session_use, { state: 'unknown', first_seen_at: null, other_session_at: null });
});

test('the doorbell\'s own requests carry the session it was started with', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-session-doorbell-'));
  const connectionDir = path.join(root, 'connections');
  const profiles = profileModule.openProfiles({ connectionDir });
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const requestId = crypto.randomUUID();
  const identity = { name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported' };
  profiles.createUnadmitted(Object.assign({}, identity, {
    server_url: 'https://app.example.test', request_id: requestId, token: `${selector}.${secret}`, selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'), created_at: 1,
  }));
  profiles.markAdmitted('Marlow', Object.assign({}, identity, {
    request_id: requestId, subject_id: 'seat-1', admitted_at: 2, expires_at: Date.now() + 60 * 60 * 1000,
  }));
  // A stand-in for `interlock doorbell` that records the session it was given.
  const seenFile = path.join(root, 'seen.txt');
  const fake = path.join(root, 'fake-interlock.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(seenFile)}, String(process.env.INTERLOCK_SESSION));
process.stderr.write('interlock: could not reach https://app.example.test; the room or the network to it is down.\\n');
process.exit(3);
`, { mode: 0o755 });
  const env = Object.assign({}, process.env, {
    INTERLOCK_CONNECTION_DIR: connectionDir, INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: '20',
    INTERLOCK_DOORBELL_INTERLOCK: fake, INTERLOCK_SESSION: 'some-other-session',
  });
  const result = childProcess.spawnSync(process.execPath, [
    path.join(ROOT, 'integrations', 'doorbell.js'), 'run', '--adapter', 'stdout', '--connection', 'Marlow',
    '--session', SESSION, '--state-dir', path.join(root, 'state'), '--once',
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(fs.existsSync(seenFile), 'ARRANGEMENT: the doorbell ran its interlock command');
  assert.equal(fs.readFileSync(seenFile, 'utf8'), SESSION);
});
