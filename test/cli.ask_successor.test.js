'use strict';

// A withdrawn ask linked to the ask that replaces it, through the CLI against a
// real room. Its own file: one server per process.

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

// The asker withdraws an ask and names the one that replaces it; a reply on
// the old one reads with the new one's number. Linking an ask that is still
// open, or to someone else's ask, is refused.
test('withdraw --replaced-by links the replacement, and a late reply names it', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-successor-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = connection(runtime, await admitSeat(runtime, owner, 'Lead'));
    owner = await elevate(runtime, owner, device);
    const scout = connection(runtime, await admitSeat(runtime, owner, 'Scout'));
    for (const seat of [lead, scout]) {
      seat.files.set('q.md', 'Carry the old questions over?\n');
      seat.files.set('scope.txt', 'I carry the open questions into the new list\n');
    }
    const say = seat => cli(seat, ['say', '--file', 'q.md', '--asks-of', 'Ana', '--means-file', 'scope.txt']);
    const old = sentId(await say(lead));
    const fresh = sentId(await say(lead));
    const other = sentId(await say(scout));

    const usage = await cli(lead, ['ask', 'withdraw', String(old), '--replaced-by', String(old)]);
    assert.equal(usage.code, EXIT_USAGE, 'an ask does not replace itself');
    const notMine = await cli(lead, ['ask', 'withdraw', String(old), '--replaced-by', String(other)]);
    assert.equal(notMine.code, EXIT_RUNTIME);
    assert.match(notMine.stderr, /only the person or AI that made an ask/);
    assert.match(notMine.stderr, new RegExp(`ask ${old} was withdrawn, but it was not linked to ask ${other}`));
    // The refused link left the withdraw standing; linking again works.
    const linked = await cli(lead, ['ask', 'withdraw', String(old), '--replaced-by', String(fresh)]);
    assert.equal(linked.code, EXIT_OK, linked.stderr);
    assert.equal(linked.stdout, `Ask ${old} was already withdrawn; it now points at ask ${fresh}.\n`);
    const answered = sentId(await say(lead));
    const yes = await post(runtime, '/api/messages', { text: 'yes' }, owner);
    assert.equal(yes.status, 201, yes.text);
    const direct = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'successor', ask_id: fresh, successor_id: answered }, lead.profile.token);
    assert.equal(direct.status, 409, 'an open ask has no successor: ' + direct.text);
    assert.equal(direct.json.error, 'ask-not-withdrawn');

    const late = await post(runtime, '/api/messages', { text: `re #${old} @Lead start fresh` }, owner);
    assert.equal(late.status, 201, late.text);
    assert.ok(late.json.message.delivery.some(entry => entry.name === 'Lead'), 'the asker is still rung');
    const read = await cli(lead, ['history', '--drain']);
    assert.equal(read.code, EXIT_OK, read.stderr);
    assert.match(read.stdout, new RegExp(`re #${old} @Lead start fresh\\n+` +
      `  ↳ discusses ask ${old} \\(withdrawn before this reply; re-asked as ask ${fresh}\\)\\n`));
  } finally {
    await runtime.close();
  }
});
