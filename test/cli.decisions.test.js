'use strict';

// The CLI's decision verbs against a real room: recording a decision, and
// its kill slot. Its own file: one identity binding per process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port,
      path: options.path || '/', method: options.method || 'GET', headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once('error', error => {
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

function get(runtime, pathname, session) {
  return call(runtime, { path: pathname, headers: { cookie: session.cookie } });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(registration.status, 200, registration.text);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  assert.equal(elevation.status, 200, elevation.text);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return { cookie: finished.headers['set-cookie'][0].split(';', 1)[0], csrf: finished.json.csrf_token };
}

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

// The owner session must hold a fresh step-up when this is called.
async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  const joined = await waiting;
  assert.equal(joined.status, 200, joined.text);
  return { token: candidate.token, name };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: bearer(token) });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: bearer(token) });
}

function uuid() {
  return crypto.randomUUID();
}

function messageQuery(after) {
  return `/api/ai/messages?after=${after}&limit=100&wait=0`;
}


// A connection the CLI loads by name. The cursor moves like the real profile's.
function connection(runtime, seat) {
  const profile = {
    schema: 2, name: seat.name, product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: runtime.url, request_id: crypto.randomUUID(), token: seat.token,
    selector: 'selectorselectorselecto', digest: 'a'.repeat(64), state: 'admitted',
    created_at: 1, admitted_at: 2, subject_id: 'unused', expires_at: Number.MAX_SAFE_INTEGER, cursor: 0,
  };
  const files = new Map();
  return {
    profile,
    files,
    dependencies: {
      config: { resolveConnectionDir: () => '/unused' },
      profiles: {
        validName: value => value === seat.name,
        openProfiles: () => ({
          load: () => Object.freeze(Object.assign({}, profile)),
          updateCursor(name, requestId, cursor) { profile.cursor = Math.max(profile.cursor, cursor); },
          acquireReadLease: () => ({ release() {} }),
        }),
      },
      readFile: file => {
        if (!files.has(file)) throw new Error('no such file: ' + file);
        return files.get(file);
      },
      // The CLI's requests reach the real server through the same loopback
      // client the route tests use.
      fetch: async (url, init = {}) => {
        const target = new URL(url);
        const response = await call(runtime, {
          path: target.pathname + target.search,
          method: init.method || 'GET',
          body: init.body === undefined ? undefined : JSON.parse(init.body),
          headers: { authorization: init.headers.authorization },
        });
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.json,
        };
      },
    },
  };
}

async function cli(seat, argv) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv.concat(['--connection', seat.profile.name]), {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, seat.dependencies);
  return { code, stdout, stderr };
}

function sentId(result) {
  const match = /Sent as \w+ \(message (\d+)\)\./.exec(result.stdout);
  assert.ok(match, 'ARRANGEMENT: the CLI reports the posted message: ' + result.stdout + result.stderr);
  return Number(match[1]);
}

test('the CLI records a decision, fills its kill slot and replies, through the real routes', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-decisions-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = connection(runtime, await admitSeat(runtime, owner, 'Lead'));
    owner = await elevate(runtime, owner, device);
    const scout = connection(runtime, await admitSeat(runtime, owner, 'Scout'));

    lead.files.set('decision.json', JSON.stringify({
      kind: 'decision', project: 'ops', title: 'Merge the candidate', body: 'Green on both suites.', asked_of: 'Ana',
      scope: 'I merge the candidate to main and nothing else', proposal: 'merge now',
    }));
    const created = await cli(lead, ['work', 'create', '--file', 'decision.json']);
    assert.equal(created.code, EXIT_OK, created.stderr);
    const match = /Created (D-[0-9]+) · Merge the candidate \(awaiting\) in ops\./.exec(created.stdout);
    assert.ok(match, created.stdout);
    const [, id] = match;

    // The asker cannot attack their own decision; Scout can, once.
    lead.files.set('q.txt', 'Would the merge break the hosted room?\n');
    const own = await cli(lead, ['work', 'kill', id, '--file', 'q.txt']);
    assert.equal(own.code, EXIT_RUNTIME);
    assert.match(own.stderr, /refused the command/);
    scout.files.set('q.txt', 'Would the merge break the hosted room?\n');
    const killed = await cli(scout, ['work', 'kill', id, '--file', 'q.txt']);
    assert.equal(killed.code, EXIT_OK, killed.stderr);
    assert.match(killed.stdout, new RegExp(`Asked the kill question on ${id} \\(attacked\\)\\.`));
    const second = await cli(scout, ['work', 'kill', id, '--file', 'q.txt']);
    assert.equal(second.code, EXIT_RUNTIME);
    assert.match(second.stderr, /refused the command: kill-slot-filled/);

    // Only the asker replies.
    scout.dependencies.readStdin = async () => 'It would not.\n';
    const notAsker = await cli(scout, ['work', 'kill-reply', id, '--outcome', 'survived', '--stdin']);
    assert.equal(notAsker.code, EXIT_RUNTIME);
    lead.dependencies.readStdin = async () => 'No: the hosted room runs the release, not main.\n';
    const replied = await cli(lead, ['work', 'kill-reply', id, '--outcome', 'survived', '--stdin']);
    assert.equal(replied.code, EXIT_OK, replied.stderr);
    assert.match(replied.stdout, new RegExp(`Replied to the kill question on ${id} \\(attacked, survived\\)\\.`));

    const got = await cli(scout, ['work', 'get', id]);
    assert.equal(got.code, EXIT_OK, got.stderr);
    assert.match(got.stdout, /  kill slot: attacked, survived · asked by Scout: Would the merge break the hosted room\?\n/);
    assert.match(got.stdout, /  kill reply \(survived\) by Lead: No: the hosted room runs the release, not main\.\n/);
    const listed = await cli(scout, ['work', 'list']);
    assert.match(listed.stdout, new RegExp(`^${id} · awaiting · attacked, survived · asked of Ana by Lead · Merge the candidate$`, 'm'));
  } finally {
    await runtime.close();
  }
});
