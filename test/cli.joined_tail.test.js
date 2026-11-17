'use strict';

// The first ordinary read after a seat is let in shows a short tail of what
// was said before it joined, once. The tail is never marked delivered or
// acknowledged and never moves the seat's cursor; later reads are as before.

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
const { splitRoomTime } = require('./helpers/room_time.js');

const { reserveTestPort } = require('./helpers/reserve_port.js');

function reservePort() {
  return reserveTestPort();
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

// A connection the CLI loads by name, joined at `knockedAt`/`admittedAt`.
// The cursor moves like the real profile's; the shown-once marks are kept here.
function connection(runtime, seat, knockedAt, admittedAt) {
  const profile = {
    schema: 2, name: seat.name, product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: runtime.url, request_id: crypto.randomUUID(), token: seat.token,
    selector: 'selectorselectorselecto', digest: 'a'.repeat(64), state: 'admitted',
    created_at: knockedAt, admitted_at: admittedAt, subject_id: 'unused', expires_at: Number.MAX_SAFE_INTEGER, cursor: 0,
  };
  const marks = new Set();
  const requests = [];
  const cursorWrites = [];
  return {
    profile, marks, requests, cursorWrites,
    dependencies: {
      config: { resolveConnectionDir: () => '/unused' },
      profiles: {
        validName: value => value === seat.name,
        openProfiles: () => ({
          load: () => Object.freeze(Object.assign({}, profile)),
          updateCursor(name, requestId, cursor) {
            cursorWrites.push(cursor);
            profile.cursor = Math.max(profile.cursor, cursor);
          },
          acquireReadLease: () => ({ release() {} }),
        }),
      },
      joinedTailMarks: { has: id => marks.has(id), add: id => { marks.add(id); } },
      fetch: async (url, init = {}) => {
        const target = new URL(url);
        requests.push({ method: init.method || 'GET', path: target.pathname + target.search, body: init.body });
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
  return { code, stdout: splitRoomTime(stdout).rest, stderr };
}

test('the first read after joining shows what came before, once, unread and without moving the cursor', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-joined-tail-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const say = async text => {
      const sent = await post(runtime, '/api/messages', { text }, owner);
      assert.equal(sent.status, 201, sent.text);
      return sent.json.message.id;
    };
    const early = await say('early news @all, before anyone knocked');
    for (let index = 0; index < 11; index += 1) await say(`old chatter ${index}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    const knockedAt = Date.now();
    const reportIn = await say('@all new crew: report in to the lead');
    const recent = [];
    for (let index = 0; index < 12; index += 1) recent.push(await say(`recent chatter ${index}`));
    const scoutSeat = await admitSeat(runtime, owner, 'Scout');
    const scout = connection(runtime, scoutSeat, knockedAt, Date.now());
    // As join does: the seat starts at the room's current moment.
    const skipped = await cli(scout, ['history', '--skip-to-current']);
    assert.equal(skipped.code, EXIT_OK, skipped.stderr);
    const joinedAt = scout.profile.cursor;
    assert.equal(joinedAt, recent.at(-1), 'the arrangement: the cursor sits at the room\'s moment of joining');
    const after = await say('@Scout welcome, read W-1');

    scout.cursorWrites.length = 0;
    const first = await cli(scout, ['history']);
    assert.equal(first.code, EXIT_OK, first.stderr);
    const [before, since] = first.stdout.split(/^Since you joined:$/m);
    assert.ok(since !== undefined, first.stdout);
    assert.match(before, /^Before you joined \(\d+ posts, shown once; not marked read\. Earlier: interlock history --connection Scout --before \d+\):$/m);
    assert.match(before, new RegExp(`^\\[${reportIn}\\] `, 'm'), 'the @all since the knock, though older than the last ten');
    for (const id of recent.slice(-10)) assert.match(before, new RegExp(`^\\[${id}\\] `, 'm'));
    assert.doesNotMatch(before, new RegExp(`^\\[${early}\\] `, 'm'), 'an @all before the knock is not pulled in');
    assert.doesNotMatch(before, new RegExp(`^\\[${after}\\] `, 'm'));
    assert.match(since, new RegExp(`^\\[${after}\\] `, 'm'), 'the ordinary read follows, as before');

    // Not acknowledged, not delivered: the only receipt is for the ordinary read's own ring.
    const receipts = scout.requests.filter(row => row.path.startsWith('/api/ai/receipts'));
    assert.deepEqual(receipts.map(row => JSON.parse(row.body).message_ids), [[after]]);
    const page = (await aiGet(runtime, messageQuery(reportIn - 1), scoutSeat.token)).json;
    const rowsForScout = page.messages.filter(message => message.id <= joinedAt)
      .flatMap(message => message.delivery.filter(entry => entry.name === 'Scout'));
    assert.deepEqual(rowsForScout, [], 'nothing before joining was delivered to the seat');
    assert.equal(page.messages.find(message => message.id === after).delivery
      .find(entry => entry.name === 'Scout').acknowledged_at !== null, true, 'the ordinary ring is acknowledged as before');
    // The cursor moved only by the ordinary read: one write, to its own page's end.
    assert.deepEqual(scout.cursorWrites, [after]);
    assert.equal(scout.profile.cursor, after);

    // The route takes exactly its three numbers, and only GET.
    assert.equal((await aiGet(runtime, `/api/ai/joined-tail?before=${joinedAt + 1}&since=5`, scoutSeat.token)).status, 400);
    assert.equal((await aiGet(runtime, `/api/ai/joined-tail?before=1&since=9&until=5`, scoutSeat.token)).status, 400);
    assert.equal((await aiPost(runtime, `/api/ai/joined-tail?before=1&since=1&until=5`, {}, scoutSeat.token)).status, 405);
    assert.equal((await call(runtime, { path: `/api/ai/joined-tail?before=1&since=1&until=5` })).status, 401);

    // Shown once: the next read is exactly today's.
    const second = await cli(scout, ['history']);
    assert.equal(second.code, EXIT_OK, second.stderr);
    assert.equal(second.stdout, 'No new messages.\n');
    assert.equal(scout.profile.cursor, after);

    // A seat let in long ago (an upgrade) is not shown a tail, and does not ask for one.
    owner = await elevate(runtime, owner, device);
    const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const veteran = connection(runtime, await admitSeat(runtime, owner, 'Veteran'), longAgo - 1000, longAgo);
    assert.equal((await cli(veteran, ['history', '--skip-to-current'])).code, EXIT_OK);
    const old = await cli(veteran, ['history']);
    assert.equal(old.stdout, 'No new messages.\n');
    assert.equal(veteran.requests.some(row => row.path.startsWith('/api/ai/joined-tail')), false);

    // A --json read is unchanged and leaves the tail for the first text read.
    owner = await elevate(runtime, owner, device);
    const fresh = connection(runtime, await admitSeat(runtime, owner, 'Newbie'), Date.now() - 1000, Date.now());
    assert.equal((await cli(fresh, ['history', '--skip-to-current'])).code, EXIT_OK);
    const json = await cli(fresh, ['history', '--json']);
    assert.equal(json.code, EXIT_OK, json.stderr);
    assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(),
      ['connection_session', 'cursor', 'messages', 'ok', 'timed_out']);
    assert.equal(fresh.marks.size, 0);
    const text = await cli(fresh, ['history']);
    assert.match(text.stdout, /^Before you joined \(/m);
    assert.equal(fresh.marks.size, 1);
  } finally {
    await runtime.close();
  }
});
