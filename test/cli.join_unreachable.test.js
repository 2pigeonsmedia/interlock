'use strict';

// A join that cannot reach its room says so and stops in bounded time; the
// client honours HTTPS_PROXY without NODE_USE_ENV_PROXY.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run, EXIT_RUNTIME, EXIT_OK } = require('../src/cli.js');

const ROOT = path.join(__dirname, '..');

function connectionDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-unreachable-')), 'profiles');
}

function refused() {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  return error;
}

async function joinWith(fetchImpl, env, url = 'https://room.example') {
  let stdout = '';
  let stderr = '';
  let time = 1_000;
  const dir = connectionDir();
  const code = await run(['join', '--url', url, '--product', 'Codex CLI', '--name', 'Probe'], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveConnectionDir: () => dir },
    doorbellStateDir: path.join(path.dirname(dir), 'doorbells'),
    clock: () => time,
    sleep: async ms => { time += ms; },
    env,
    fetch: async (target, options) => {
      time += 100;
      return fetchImpl(target, options);
    },
    ask: async () => { throw new Error('must not prompt'); },
  });
  return { code, stdout, stderr, elapsed: time - 1_000, dir };
}

test('a join whose room never answers stops within the bound and names the way forward', async () => {
  const result = await joinWith(async () => { throw refused(); }, {});
  assert.equal(result.code, EXIT_RUNTIME, result.stderr);
  assert.ok(result.elapsed >= 30_000, 'it retried for the whole bound first');
  assert.ok(result.elapsed < 45_000, `it stopped soon after the bound, not at the join window (${result.elapsed} ms)`);
  assert.match(result.stdout, /has not reached https:\/\/room\.example yet \(connection refused\)/);
  assert.equal(result.stdout.match(/has not reached/g).length, 1, 'said once, not per retry');
  assert.match(result.stderr, /could not reach https:\/\/room\.example \(connection refused\)/);
  assert.match(result.stderr, /nobody has been asked to Allow this yet/);
  assert.match(result.stderr, /If this computer reaches the internet only through a proxy, set HTTPS_PROXY/);
  assert.match(result.stderr, /interlock join --resume --name Probe/);
  assert.match(result.stderr, /interlock join --discard --name Probe/);
  assert.ok(fs.existsSync(path.join(result.dir, 'probe.json')), 'the candidate is kept');
});

test('the refusal names the proxy it used: scheme, host and port only', async () => {
  const proxy = require('../src/client/proxy.js');
  const env = { HTTPS_PROXY: 'http://user:s3cret@127.0.0.1:3128/path?key=k3y' };
  // Records an install without touching this process's real dispatcher.
  assert.equal(proxy.useEnvProxy(env, { setGlobalProxyFromEnv() {} }).installed, true);
  const result = await joinWith(async () => { throw refused(); }, env);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /This computer sets HTTPS_PROXY=http:\/\/127\.0\.0\.1:3128, and Interlock sent the request through it/);
  assert.doesNotMatch(result.stderr, /s3cret|user|k3y|path/);
});

test('a proxy that could not be applied is not claimed as used', async () => {
  const proxy = require('../src/client/proxy.js');
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3128' };
  assert.equal(proxy.useEnvProxy(env, {}).installed, false, 'ARRANGEMENT: the runtime lacks the call');
  const result = await joinWith(async () => { throw refused(); }, env);
  assert.match(result.stderr, /could not apply it; set NODE_USE_ENV_PROXY=1/);
  assert.doesNotMatch(result.stderr, /sent the request through it/);
});

test('a proxy value that is not an http(s) URL is never printed', () => {
  const { redact } = require('../src/client/proxy.js');
  assert.equal(redact('socks5://u:p@host:1080'), '(set, not shown)');
  assert.equal(redact('not a url k3y'), '(set, not shown)');
  assert.equal(redact('https://u:p@proxy.example:8443/x?y=z'), 'https://proxy.example:8443');
});

test('control: a room that answered once is not abandoned at the bound', async () => {
  let calls = 0;
  const result = await joinWith(async (target, options) => {
    calls += 1;
    if (target.endsWith('/api/ai/admissions') && calls === 1) {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return Object.assign({ ok: true, state: 'waiting', expires_at: 2_000_000 }, body); } };
    }
    if (target.endsWith('/api/ai/session') && calls > 200) {
      return { ok: true, status: 200, async json() {
        return { ok: true, connection: { subject_id: 'seat-1', name: 'Probe', product: 'Codex CLI',
          product_provenance: 'client-reported', expires_at: 9_000_000 } };
      } };
    }
    if (target.endsWith('/api/ai/head')) {
      return { ok: true, status: 200, async json() { return { ok: true, head: 0, connection_session: null }; } };
    }
    throw refused();
  }, {});
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.ok(result.elapsed > 30_000, `ARRANGEMENT: it kept trying past the bound (${result.elapsed} ms)`);
  assert.doesNotMatch(result.stderr, /could not reach/);
});

// A proxy that records the hosts asked for and refuses the tunnel. The room's
// host does not resolve, so the proxy is the only way the request can leave.
async function recordingProxy() {
  const seen = [];
  const server = net.createServer(socket => {
    socket.once('data', chunk => {
      const first = String(chunk).split('\r\n')[0];
      seen.push(first);
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, seen, port: server.address().port };
}

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(https?_proxy|no_proxy|all_proxy|node_use_env_proxy)$/i.test(key)) env[key] = value;
  }
  return Object.assign(env, extra);
}

// Runs the real entry point until its stdout says the first attempt failed.
async function joinUntilFirstFailure(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin/interlock.js'), 'join',
    '--url', 'https://room.invalid', '--product', 'Codex CLI', '--name', 'Probe'],
  { env: Object.assign(env, { INTERLOCK_CONNECTION_DIR: connectionDir() }), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  while (!/has not reached/.test(stdout) && Date.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  return stdout;
}

test('join reaches the room through HTTPS_PROXY without NODE_USE_ENV_PROXY', async () => {
  const proxy = await recordingProxy();
  try {
    const stdout = await joinUntilFirstFailure(cleanEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }));
    assert.match(stdout, /has not reached https:\/\/room\.invalid yet/, 'ARRANGEMENT: the first attempt ran');
    assert.ok(proxy.seen.some(lineSeen => lineSeen.startsWith('CONNECT room.invalid:443 ')),
      `the request went through the proxy: ${JSON.stringify(proxy.seen)}`);
  } finally {
    proxy.server.close();
  }
});

test('control: without HTTPS_PROXY the proxy sees nothing', async () => {
  const proxy = await recordingProxy();
  try {
    const stdout = await joinUntilFirstFailure(cleanEnv({}));
    assert.match(stdout, /has not reached https:\/\/room\.invalid yet/, 'ARRANGEMENT: the first attempt ran');
    assert.deepEqual(proxy.seen, []);
  } finally {
    proxy.server.close();
  }
});

test('a room on this computer is reached directly even when a proxy is set', async () => {
  const proxy = await recordingProxy();
  const room = net.createServer(socket => socket.destroy());
  room.listen(0, '127.0.0.1');
  await once(room, 'listening');
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/interlock.js'), 'join',
      '--url', `http://localhost:${room.address().port}`, '--product', 'Codex CLI', '--name', 'Probe'],
    { env: cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
      INTERLOCK_CONNECTION_DIR: connectionDir() }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const deadline = Date.now() + 60_000;
    while (!/has not reached/.test(stdout) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    assert.match(stdout, /has not reached http:\/\/localhost:\d+ yet/, 'ARRANGEMENT: the attempt ran');
    assert.deepEqual(proxy.seen, [], 'the loopback room was not sent to the proxy');
  } finally {
    proxy.server.close();
    room.close();
  }
});
