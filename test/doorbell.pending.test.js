'use strict';

// C6: an AI knocks, leaves its join running in the background, arms its
// doorbell and ends its turn. When its person Allows it, the doorbell rings
// ONCE with kind `admitted`, then rings as usual. Against a real room and the
// real join command.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const room = require('./helpers/room_server.js');
const doorbell = require('./helpers/doorbell_room.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'interlock.js');

let shared = null;
test.after(async () => {
  await doorbell.cleanup();
  if (shared) await shared.runtime.close();
});
test.afterEach(doorbell.cleanup);

async function roomOnce() {
  if (!shared) {
    const { runtime } = await room.startRoom('interlock-doorbell-pending-');
    const device = await room.bootstrap(runtime);
    shared = { runtime, device };
  }
  return shared;
}

function aiWorld(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-pending-ai-'));
  const env = Object.assign({}, process.env, {
    INTERLOCK_CONNECTION_DIR: path.join(root, 'connections'),
    INTERLOCK_DOORBELL_PENDING_POLL_MS: '100',
    INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: '50,50,50',
    XDG_DATA_HOME: root, LOCALAPPDATA: root,
  });
  delete env.INTERLOCK_DOORBELL_INTERLOCK;
  return { root, name, stateDir: path.join(root, 'state'), env };
}

function collect(child) {
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { out.stdout += chunk; });
  child.stderr.on('data', chunk => { out.stderr += chunk; });
  return out;
}

async function eventually(check, what, bound = 20_000) {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`never: ${what}`);
}

async function knockFor(runtime, owner, name) {
  const listed = await eventually(async () => {
    const read = await room.get(runtime, '/api/ai/admissions', owner);
    return read.json && read.json.pending.find(row => row.name === name && row.connected === true);
  }, `${name}'s knock is visible and connected`);
  return listed.request_id;
}

// A child's exit, whether or not it has happened yet: waiting for an 'exit'
// event that already fired would never return.
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
}

function startJoin(runtime, world) {
  const child = doorbell.track(childProcess.spawn(process.execPath,
    [CLI, 'join', '--url', runtime.url, '--product', 'Codex CLI', '--name', world.name],
    { cwd: ROOT, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  return { child, out: collect(child) };
}

const ADMITTED = name => new RegExp(`^Interlock rang for ${name}: admitted · Room time: [^·]+ · ` +
  `Run: interlock history --connection ${name} · You are admitted to http://localhost:\\d+ as ${name}\\. ` +
  'Say hello; your doorbell is armed\\.$', 'm');

test('armed before the Allow, the doorbell rings admitted once, then rings mentions', async () => {
  const { runtime, device } = await roomOnce();
  const world = aiWorld('Pip');
  let owner = await room.login(runtime);
  const join = startJoin(runtime, world);
  const requestId = await knockFor(runtime, owner, 'Pip');

  const running = doorbell.startAdapter(world);
  await eventually(() => /waiting for a person to Allow Pip/.test(running.stderr), 'the doorbell says it waits');
  const waiting = await doorbell.status(world);
  assert.equal(waiting.json.state, 'starting', JSON.stringify(waiting.json));
  assert.match(waiting.json.detail, /waiting for a person to Allow Pip/);
  assert.equal(Number.isSafeInteger(waiting.json.pending_until), true);
  assert.equal(running.stdout, '', 'nothing rings before the Allow');

  owner = await room.elevate(runtime, owner, device);
  const allowed = await room.post(runtime, `/api/ai/admissions/${requestId}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  await eventually(() => ADMITTED('Pip').test(running.stdout), `the admitted ring: ${running.stdout}${running.stderr}`);
  await exited(join.child);

  owner = await room.login(runtime);
  const mention = await room.post(runtime, '/api/messages', { text: '@Pip welcome in' }, owner);
  assert.equal(mention.status, 201, mention.text);
  await eventually(() => new RegExp(`^Interlock rang for Pip: mention ${mention.json.message.id} from Ana `, 'm')
    .test(running.stdout), `the mention after: ${running.stdout}`);
  assert.equal(running.stdout.match(/: admitted · /g).length, 1, 'admitted rings once');
});

test('a knock no one allows ends the wait with one line naming join --resume', async () => {
  const { runtime } = await roomOnce();
  const world = aiWorld('Quill');
  world.env.INTERLOCK_DOORBELL_PENDING_TTL_MS = '600';
  const owner = await room.login(runtime);
  const join = startJoin(runtime, world);
  await knockFor(runtime, owner, 'Quill');
  const running = doorbell.startAdapter(world);
  const done = await running.exited;
  assert.equal(done.code, 1);
  assert.equal(done.stdout, '');
  const lines = done.stderr.split('\n').filter(text => /join --resume/.test(text));
  assert.equal(lines.length, 1, done.stderr);
  assert.match(lines[0], /interlock join --resume --name Quill/);
  join.child.kill('SIGKILL');
});

test('a doorbell for a name with no join on this computer says so', async () => {
  const world = aiWorld('Nobody');
  const done = await doorbell.startAdapter(world, ['--once']).exited;
  assert.equal(done.code, 1);
  assert.equal(done.stdout, '');
  assert.doesNotMatch(done.stderr, /waiting for a person/);
});

// A18: the doorbell holds the knock, so a join the host killed can still be
// allowed in.
test('with the join killed, the doorbell holds the knock and the Allow still lands', async () => {
  const { runtime, device } = await roomOnce();
  const world = aiWorld('Rook');
  let owner = await room.login(runtime);
  const join = startJoin(runtime, world);
  const requestId = await knockFor(runtime, owner, 'Rook');
  join.child.kill('SIGKILL');
  await exited(join.child);
  // Arrangement: with no one holding the knock, the room no longer offers it.
  await eventually(async () => {
    const read = await room.get(runtime, '/api/ai/admissions', owner);
    const row = read.json.pending.find(entry => entry.request_id === requestId);
    return row && row.connected === false;
  }, 'the killed join leaves the knock unheld', 30_000);

  const running = doorbell.startAdapter(world);
  await eventually(async () => {
    const read = await room.get(runtime, '/api/ai/admissions', owner);
    const row = read.json.pending.find(entry => entry.request_id === requestId);
    return row && row.connected === true;
  }, 'the doorbell holds the knock');
  owner = await room.elevate(runtime, owner, device);
  const allowed = await room.post(runtime, `/api/ai/admissions/${requestId}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  await eventually(() => ADMITTED('Rook').test(running.stdout), `the admitted ring: ${running.stdout}${running.stderr}`);
});

test('a declined knock ends the hold on the first answer, with one join --resume line', async () => {
  const { runtime, device } = await roomOnce();
  const world = aiWorld('Wren2');
  let owner = await room.login(runtime);
  const join = startJoin(runtime, world);
  const requestId = await knockFor(runtime, owner, 'Wren2');
  join.child.kill('SIGKILL');
  const running = doorbell.startAdapter(world);
  await eventually(() => /keeps the knock open/.test(running.stderr), 'the doorbell holds');
  owner = await room.elevate(runtime, owner, device);
  const declined = await room.post(runtime, `/api/ai/admissions/${requestId}/decline`, {}, owner);
  assert.equal(declined.status, 200, declined.text);
  const done = await running.exited;
  assert.equal(done.code, 1);
  assert.equal(done.stdout, '');
  const lines = done.stderr.split('\n').filter(text => /join --resume/.test(text));
  assert.equal(lines.length, 1, done.stderr);
  assert.match(lines[0], /was declined; this doorbell stops knocking/);
});

test('a candidate past its window is never re-posted, even to a room that would take it', async () => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const posts = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') posts.push(request.url);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, state: 'waiting', match_code: 'K7Q2X' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const world = aiWorld('Late');
    const profiles = require('../src/client/profiles.js').openProfiles({ connectionDir: world.env.INTERLOCK_CONNECTION_DIR });
    const secret = crypto.randomBytes(32).toString('base64url');
    const selector = crypto.randomBytes(16).toString('base64url');
    profiles.createUnadmitted({
      name: 'Late', product: 'Codex CLI', product_provenance: 'client-reported',
      server_url: `http://localhost:${server.address().port}`, request_id: crypto.randomUUID(),
      token: `${selector}.${secret}`, selector,
      digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
      created_at: Date.now() - 20 * 60 * 1000,
    });
    const done = await doorbell.startAdapter(world).exited;
    assert.equal(done.code, 1);
    assert.deepEqual(posts, [], 'no knock was sent');
    assert.match(done.stderr, /older than its knock .*join --resume --name Late/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the test waits can only shorten the contract: a long INTERLOCK_DOORBELL_PENDING_TTL_MS is clamped', () => {
  const doorbellModule = require('../integrations/doorbell.js');
  const saved = process.env.INTERLOCK_DOORBELL_PENDING_TTL_MS;
  try {
    process.env.INTERLOCK_DOORBELL_PENDING_TTL_MS = String(1_000_000_000);  // about 11.5 days
    assert.equal(doorbellModule.positiveEnv('INTERLOCK_DOORBELL_PENDING_TTL_MS', doorbellModule.PENDING_TTL_MS),
      doorbellModule.PENDING_TTL_MS);
    process.env.INTERLOCK_DOORBELL_PENDING_TTL_MS = '600';
    assert.equal(doorbellModule.positiveEnv('INTERLOCK_DOORBELL_PENDING_TTL_MS', doorbellModule.PENDING_TTL_MS), 600);
    assert.equal(doorbellModule.PENDING_TTL_MS, 15 * 60 * 1000 + 30 * 1000);
  } finally {
    if (saved === undefined) delete process.env.INTERLOCK_DOORBELL_PENDING_TTL_MS;
    else process.env.INTERLOCK_DOORBELL_PENDING_TTL_MS = saved;
  }
});
