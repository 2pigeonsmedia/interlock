'use strict';

// A fake room that answers `GET /api/ai/rings`, a connection profile that
// points at it, and a tracked adapter process. Shared by the doorbell tests
// that need a real poll over HTTP rather than a fake `interlock` command.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const profileModule = require('../../src/client/profiles.js');

const ROOT = path.join(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'integrations', 'doorbell.js');
const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const STOP_BOUND_MS = 10_000;
const WAIT_BOUND_MS = 15_000;

const liveChildren = new Set();
const liveRooms = new Set();

function track(child) {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

async function stopChild(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  let timer;
  const bound = new Promise(resolve => { timer = setTimeout(resolve, STOP_BOUND_MS); });
  await Promise.race([exited, bound]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// Kills a process by pid that this test started indirectly (an adapter
// whose parent was killed). Never a pid the test did not create.
function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ }
}
const livePids = new Set();

async function cleanup() {
  for (const child of [...liveChildren]) await stopChild(child, 'SIGKILL');
  liveChildren.clear();
  for (const pid of [...livePids]) killPid(pid);
  livePids.clear();
  for (const room of [...liveRooms]) await room.close();
  liveRooms.clear();
}

function fakeRoom() {
  const room = {
    port: null,
    afters: [],
    others: [],
    respond: () => ({ status: 200, body: { ok: true, rings: [], cursor: 0, timed_out: true, connection_session: null } }),
    server: null,
  };
  room.listen = async port => {
    room.server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      // `status` also asks the room about the connection; this fake room
      // knows only rings, and says so at once rather than hanging the read.
      if (url.pathname !== '/api/ai/rings') {
        room.others.push(url.pathname);
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'not-found' }));
        return;
      }
      const after = Number(url.searchParams.get('after'));
      room.afters.push(after);
      const answer = room.respond(after, room.afters.length);
      if (answer === null) return;
      const send = () => {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      };
      if (answer.delay) setTimeout(send, answer.delay); else send();
    });
    room.server.listen(port, '127.0.0.1');
    await once(room.server, 'listening');
    liveRooms.add(room);
    room.port = room.server.address().port;
  };
  room.close = async () => {
    liveRooms.delete(room);
    if (!room.server || !room.server.listening) return;
    room.server.closeAllConnections();
    room.server.close();
    await once(room.server, 'close');
  };
  return room;
}

function ringsAfter(after, rings, cursor, delay = 0) {
  return {
    status: 200,
    delay,
    body: {
      ok: true,
      rings: rings.filter(ring => ring.id > after),
      cursor: Math.max(after, cursor),
      timed_out: rings.every(ring => ring.id <= after),
      connection_session: 3,
    },
  };
}

function roomWorld(port, name = 'Marlow') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-doorbell-room-'));
  const connectionDir = path.join(root, 'connections');
  const profiles = profileModule.openProfiles({ connectionDir });
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const identity = { name, product: 'Codex CLI', product_provenance: 'client-reported' };
  profiles.createUnadmitted(Object.assign({}, identity, {
    server_url: `http://localhost:${port}`,
    request_id: REQUEST_A,
    token: `${selector}.${secret}`,
    selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
    created_at: 1,
  }));
  profiles.markAdmitted(name, Object.assign({}, identity, {
    request_id: REQUEST_A, subject_id: 'seat-1', admitted_at: 2,
    expires_at: Date.now() + 60 * 60 * 1000,
  }));
  const env = Object.assign({}, process.env, {
    INTERLOCK_CONNECTION_DIR: connectionDir,
    INTERLOCK_DOORBELL_RETRY_SCHEDULE_MS: '50,50,50',
    XDG_DATA_HOME: root,
    LOCALAPPDATA: root,
  });
  delete env.INTERLOCK_DOORBELL_INTERLOCK;
  return { root, name, stateDir: path.join(root, 'state'), env };
}

function adapterArgs(world, extra = []) {
  return [RUNNER, 'run', '--adapter', 'stdout', '--connection', world.name,
    '--session', 'host-session-1', '--state-dir', world.stateDir, ...extra];
}

function startAdapter(world, extra = [], spawnOptions = {}) {
  const child = track(childProcess.spawn(process.execPath, adapterArgs(world, extra),
    Object.assign({ cwd: ROOT, env: world.env }, spawnOptions)));
  const result = { stdout: '', stderr: '', code: null, child };
  if (child.stdout) child.stdout.on('data', chunk => { result.stdout += chunk; });
  if (child.stderr) child.stderr.on('data', chunk => { result.stderr += chunk; });
  result.exited = new Promise(resolve => child.on('close', code => {
    result.code = code;
    resolve(result);
  }));
  return result;
}

async function waitUntil(check, bound = WAIT_BOUND_MS) {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return await check();
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function onlyStateFile(directory) {
  if (!fs.existsSync(directory)) return undefined;
  return fs.readdirSync(directory).find(name => /^doorbell-[0-9a-f]{24}\.json$/.test(name));
}

function savedCursor(stateDir) {
  const name = onlyStateFile(stateDir);
  return name === undefined ? null
    : JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')).cursor;
}

function lockDirOf(world) {
  const key = crypto.createHash('sha256').update(world.name).digest('hex').slice(0, 24);
  return path.join(world.stateDir, '.locks', key);
}

function lockHeld(world) {
  return fs.existsSync(path.join(lockDirOf(world), 'instance.lock'));
}

function runtimeOf(world) {
  try { return JSON.parse(fs.readFileSync(path.join(lockDirOf(world), 'runtime.json'), 'utf8')); }
  catch (_) { return null; }
}

// Async: the fake room answers from this process, so a synchronous child
// would block the very server it is asking.
function runRunner(world, args) {
  const child = track(childProcess.spawn(process.execPath, [RUNNER, ...args],
    { cwd: ROOT, env: world.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  const result = { stdout: '', stderr: '', status: null };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  return new Promise(resolve => child.on('close', code => { result.status = code; resolve(result); }));
}

async function status(world, extra = []) {
  const result = await runRunner(world,
    ['status', '--connection', world.name, '--state-dir', world.stateDir, '--json', ...extra]);
  let json = null;
  try { json = JSON.parse(result.stdout); } catch (_) { /* reported by the caller */ }
  return { result, json };
}

module.exports = {
  REQUEST_A, ROOT, RUNNER, adapterArgs, cleanup, fakeRoom, livePids, lockDirOf, lockHeld,
  onlyStateFile, pidAlive, ringsAfter, roomWorld, runtimeOf, savedCursor, startAdapter,
  runRunner, status, stopChild, track, waitUntil,
};
