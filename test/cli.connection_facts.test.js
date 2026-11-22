'use strict';

// After join and in `interlock status`, a connection is three separate facts:
// admitted · last answered mention (a read-and-reply, not proof the doorbell
// rang) · doorbell running/unverifiable/none.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, run } = require('../src/cli.js');

const ORIGIN = 'https://app.example.test';
const ROOT = path.join(__dirname, '..');

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-facts-'));
  return { root, connectionDir: path.join(root, 'profiles'), stateDir: path.join(root, 'doorbells') };
}

function capture() {
  const io = { out: '', err: '' };
  io.stdout = { write: value => { io.out += String(value); } };
  io.stderr = { write: value => { io.err += String(value); } };
  return io;
}

function roomFetch(answers) {
  return async (target, options) => {
    if (target.endsWith('/api/ai/session')) return answers.session();
    if (target.endsWith('/api/ai/last-answered')) return answers.wake();
    if (target.endsWith('/api/ai/presence-kind')) {
      return answers.kind ? answers.kind() : fakeResponse(404, { ok: false, error: 'not-found' });
    }
    if (target.endsWith('/api/ai/head')) return fakeResponse(200, { ok: true, head: 3, connection_session: null });
    const body = JSON.parse(options.body);
    return fakeResponse(200, {
      ok: true, state: 'allowed', request_id: body.request_id, name: body.name, product: body.product,
      product_provenance: body.product_provenance, expires_at: 50_000,
      enrollment: { subject_id: 'seat-1', name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 50_000 },
    });
  };
}

const ADMITTED = () => fakeResponse(200, { ok: true, connection: {
  subject_id: 'seat-1', name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported', expires_at: 50_000,
} });

async function joined(place, wake) {
  const io = capture();
  const code = await run(['join', '--url', ORIGIN, '--product', 'Codex CLI', '--name', 'Marlow'], io, {
    config: { resolveConnectionDir: () => place.connectionDir },
    clock: (() => { let time = 1_000; return () => ++time; })(),
    fetch: roomFetch({ session: () => fakeResponse(401, { ok: false, error: 'invalid-connection' }), wake }),
    doorbellStateDir: place.stateDir,
    ask: async () => { throw new Error('must not prompt'); },
  });
  return { code, io };
}

async function status(place, answers, extra = []) {
  const io = capture();
  const code = await run(['status', '--connection', 'Marlow', ...extra], io, {
    config: { resolveConnectionDir: () => place.connectionDir },
    fetch: roomFetch(answers),
    doorbellStateDir: place.stateDir,
  });
  return { code, io };
}

// Before any adapter has run for the seat on this computer: a
// hook-driven poller records itself only after its first pass.
const NOT_RUN_YET = dir => `none yet in ${dir} — no doorbell has run yet for Marlow on this computer; ` +
  "a hook-driven poller (e.g. Claude Code's Stop hook) appears after its first pass, and until then " +
  'an @mention is held until it next polls. With no hook, arm the doorbell join printed.';

test('join reports the three facts, before the doorbell step', async () => {
  const place = world();
  const { code, io } = await joined(place, () => fakeResponse(200, { ok: true, last_answered: null }));
  assert.equal(code, EXIT_OK, io.err);
  assert.match(io.out, /^ {2}Admitted: yes — the room accepts this connection until /m);
  assert.match(io.out, /^ {2}Last answered mention: none — the room has no delivered @mention followed by a post from you/m);
  assert.ok(io.out.includes(`\n  Doorbell: ${NOT_RUN_YET(place.stateDir)}\n`), io.out);
  // A fresh seat is not told it is deaf: no 'will not wake', no 'not recorded'.
  assert.doesNotMatch(io.out, /will not wake|no doorbell adapter is recorded/);
  assert.ok(io.out.indexOf('Last answered mention:') < io.out.indexOf('Next, before you say hello'));
});

test('status names each fact from its own evidence, and says how it knows', async () => {
  const place = world();
  assert.equal((await joined(place, () => fakeResponse(200, { ok: true, last_answered: null }))).code, EXIT_OK,
    'arrangement: an admitted local profile');

  const proven = await status(place, { session: ADMITTED,
    wake: () => fakeResponse(200, { ok: true, last_answered: { ring_id: 4, reply_id: 6, replied_at: 1_800_000_000_000 } }),
    kind: () => fakeResponse(200, { ok: true, presence_kind: { kind: 'working', since: 1_800_000_000_000, next: 'picks up after its turn' }, session: 4 }) });
  assert.equal(proven.code, EXIT_OK, proven.io.err);
  assert.deepEqual(proven.io.out.trimEnd().split('\n').map(text => text.split(' — ')[0]), [
    'Admitted: yes',
    'The room shows: working since 2027-01-15T08:00:00.000Z',
    'Last answered mention: #4 → reply #6 (2027-01-15T08:00:00.000Z) · Session 4.',
    '  (A read-and-reply, not proof the doorbell rang.)',
    `Doorbell: none yet in ${place.stateDir}`,
  ]);

  // LOW-4: status says People's words, not the raw kind.
  // One status line per kind, each with "since" once: "unknown" already
  // says "since the room restarted", so its time reads "at".
  for (const [kind, words] of [
    ['listening', 'listening since'], ['working', 'working since'], ['rung', 'rung by webhook since'],
    ['pending', 'waiting to be let in since'], ['away', 'not listening since'], ['left', 'left since'],
    ['ended', 'ended since'], ['unreachable', 'unreachable since'],
    ['unknown', 'not known since the room restarted at'],
  ]) {
    const said = await status(place, { session: ADMITTED, wake: () => fakeResponse(200, { ok: true, last_answered: null }),
      kind: () => fakeResponse(200, { ok: true, presence_kind: { kind, since: 1_800_000_000_000, next: null }, session: null }) });
    assert.match(said.io.out, new RegExp(`^The room shows: ${words} 2027-01-15T08:00:00\\.000Z\\.$`, 'm'), kind);
    const shown = /^The room shows: .*$/m.exec(said.io.out)[0];
    assert.equal(shown.split(' since ').length - 1, 1, `${kind}: "since" once: ${shown}`);
  }

  const older = await status(place, { session: ADMITTED,
    wake: () => fakeResponse(404, { ok: false, error: 'not-found' }) });
  assert.match(older.io.out, /^Last answered mention: unknown — this room does not report it/m);
  assert.match(older.io.out, /^The room shows: this room does not report it \(Interlock 0\.3\.11 or older\)\./m,
    'an older room has no presence-kind route');
  assert.match(proven.io.out, /^The room shows: working since 2027-01-15T08:00:00\.000Z — picks up after its turn\.$/m);

  const refused = await status(place, { session: () => fakeResponse(401, { ok: false, error: 'invalid-connection' }),
    wake: () => fakeResponse(401, { ok: false, error: 'invalid-connection' }) }, ['--json']);
  assert.equal(refused.code, EXIT_RUNTIME);
  const json = JSON.parse(refused.io.out);
  assert.deepEqual([json.facts.admitted.state, json.facts.last_answered.state, json.facts.doorbell.state, json.facts.room_shows.state],
    ['no', 'unknown', 'none', 'unknown']);
});

test('interlock-doorbell status prints the three facts after the adapter line', () => {
  const place = world();
  const result = childProcess.spawnSync(process.execPath, [
    path.join(ROOT, 'integrations', 'doorbell.js'), 'status', '--connection', 'Marlow', '--state-dir', place.stateDir,
  ], { encoding: 'utf8', env: Object.assign({}, process.env, { XDG_DATA_HOME: place.root, LOCALAPPDATA: place.root }) });
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^Marlow: absent — /, 'arrangement: no adapter recorded');
  assert.deepEqual(lines.filter(text => /^(Admitted|Last answered mention|Doorbell):/.test(text)).map(text => text.split(' — ')[0]),
    ['Admitted: unknown', 'Last answered mention: unknown', `Doorbell: none yet in ${place.stateDir}`]);
  assert.match(result.stdout, /Admitted: unknown — no local connection with this name on this computer\./);
});

test('the doorbell fact says where it looked, and a live adapter whose polls fail is still running', async () => {
  const { connectionFactsFor, factLines } = require('../src/cli.js');
  const place = world();
  const dependencies = { config: { resolveConnectionDir: () => place.connectionDir } };
  const retrying = await connectionFactsFor('Marlow', { dependencies, stateDir: place.stateDir, inspect: () => ({
    state: 'retrying', state_dir: place.stateDir,
    detail: 'the adapter is running but has not reached the room for 90 s; it keeps retrying',
  }) });
  assert.equal(retrying.doorbell.state, 'running');
  assert.match(factLines(retrying).at(-1), /^Doorbell: running, polls failing — the adapter is running but has not reached the room for 90 s/);
  // The word an older adapter used for the same thing.
  const failing = await connectionFactsFor('Marlow', { dependencies, stateDir: place.stateDir, inspect: () => ({
    state: 'mismatch', state_dir: place.stateDir,
    detail: 'no successful poll in the last 75 s; the adapter may be retrying an unreachable room',
  }) });
  assert.equal(failing.doorbell.state, 'running');
  assert.match(factLines(failing).at(-1),
    /^Doorbell: running, polls failing — no successful poll in the last 75 s; the adapter may be retrying an unreachable room\.$/);
  const none = await connectionFactsFor('Marlow', { dependencies, stateDir: place.stateDir });
  assert.equal(factLines(none).at(-1), `Doorbell: ${NOT_RUN_YET(place.stateDir)}`);
  assert.equal(none.doorbell.state, 'none', 'the --json state word is unchanged');
});
