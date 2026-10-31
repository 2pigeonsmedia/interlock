'use strict';

// The side-car over HTTP: an annotated post from each door, the reads, the
// lifecycle rows, and a clear that carries an open ask. The message object
// and the plain post routes are unchanged.

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

test('asks, answers and status ride the side-car routes; the message and the plain routes are unchanged', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-annotations-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');

    const refused = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'merge?', client_message_id: uuid(), annotation: { ask: { of: 'Ana' } },
    }, lead.token);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error, 'means-required');

    const asked = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'merge the candidate?', client_message_id: uuid(),
      annotation: { ask: { of: 'Ana', means: 'I merge the candidate to main and nothing else' } },
    }, lead.token);
    assert.equal(asked.status, 201, asked.text);
    assert.deepEqual(Object.keys(asked.json.message).sort(), ['byline', 'delivery', 'id', 'kind',
      'product', 'product_provenance', 'session', 'text', 'ts']);

    const plainWithAnnotation = await aiPost(runtime, '/api/ai/messages', {
      text: 'x', client_message_id: uuid(), annotation: { status: 'done', read_through: 0 },
    }, lead.token);
    assert.equal(plainWithAnnotation.status, 400, 'the plain AI post route keeps its closed body');
    const plainBrowser = await post(runtime, '/api/messages', { text: 'x', annotation: {} }, owner);
    assert.equal(plainBrowser.status, 400, 'the plain browser post route keeps its closed body');

    // Ana asks Scout without naming it: Scout is rung all the same.
    const toScout = await post(runtime, '/api/annotated-messages',
      { text: 'can you check the import?', annotation: { ask: { of: 'Scout' } } }, owner);
    assert.equal(toScout.status, 201, toScout.text);
    assert.deepEqual(toScout.json.message.delivery.map(row => row.name), ['Scout']);
    const scoutAsks = await aiGet(runtime, '/api/ai/asks', scout.token);
    assert.equal(scoutAsks.status, 200, scoutAsks.text);
    assert.deepEqual(scoutAsks.json.addressed.map(ask => [ask.ask_id, ask.by]), [[toScout.json.message.id, 'Ana']]);

    const stale = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'done', client_message_id: uuid(), annotation: { status: 'done', read_through: asked.json.message.id },
    }, scout.token);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error, 'unread-addressed');
    assert.deepEqual(stale.json.unread_ids, [toScout.json.message.id]);

    const answered = await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: asked.json.message.id, choice: 'yes' }] },
    }, owner);
    assert.equal(answered.status, 201, answered.text);
    assert.deepEqual((await aiGet(runtime, '/api/ai/asks', lead.token)).json.asked, [],
      'a plain ask she answered yes is answered: off his list, nobody is on anything');

    const notMine = await post(runtime, '/api/annotations',
      { kind: 'withdraw', ask_id: asked.json.message.id }, owner);
    assert.equal(notMine.status, 403, notMine.text);
    assert.equal(notMine.json.error, 'not-asker');
    const kept = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'keep_open', ask_id: asked.json.message.id }, lead.token);
    assert.equal(kept.status, 201, kept.text);
    assert.equal(kept.json.row.kind, 'keep_open');

    const browserRows = await get(runtime, '/api/annotations?after=0&limit=100', owner);
    assert.equal(browserRows.status, 200, browserRows.text);
    // Each ask is stamped with its project right after its post (0.3.1).
    assert.deepEqual(browserRows.json.rows.map(row => row.kind),
      ['post', 'stamp', 'post', 'stamp', 'post', 'keep_open']);
    const aiRows = await aiGet(runtime, '/api/ai/annotations?after=4&limit=100', scout.token);
    assert.deepEqual(aiRows.json.rows.map(row => row.seq), [5, 6]);
    assert.equal(aiRows.json.cursor, 6);
    assert.equal((await get(runtime, '/api/annotations?after=0', owner)).status, 400);
    assert.equal((await call(runtime, { path: '/api/annotations?after=0&limit=1' })).status, 401,
      'the browser read needs a session');

    // The clear carries the two open asks (Scout's, and Lead's kept open).
    owner = await elevate(runtime, owner, device);
    const cleared = await post(runtime, '/api/transcript/clear', {}, owner);
    assert.equal(cleared.status, 200, cleared.text);
    const sidecarArchive = path.join(dataDir, 'archives', cleared.json.archive_id + '.annotations.jsonl');
    assert.equal(fs.readFileSync(sidecarArchive, 'utf8').trim().split('\n').length, 6);
    const after = await get(runtime, '/api/annotations?after=0&limit=100', owner);
    assert.deepEqual(after.json.rows.map(row => [row.kind, row.ask_id]),
      [['carry', asked.json.message.id], ['carry', toScout.json.message.id]]);
    assert.equal(after.json.first_id, cleared.json.next_id);
    const history = await get(runtime, '/api/history/archives', owner);
    assert.equal(history.status, 200, history.text);
    assert.deepEqual(history.json.archives.map(row => row.archive_id), [cleared.json.archive_id],
      'the side-car archive file is not listed as an archive of its own');
    assert.equal(history.json.archives[0].downloads.annotations,
      `/api/transcript/exports/${cleared.json.archive_id}.annotations.jsonl`,
      'History lists the side-car download beside Markdown and JSON');
    const download = await get(runtime,
      `/api/transcript/exports/${cleared.json.archive_id}.annotations.jsonl`, owner);
    assert.equal(download.status, 200, download.text);
    assert.match(download.headers['content-type'], /^application\/x-ndjson/);
    assert.equal(download.text, fs.readFileSync(sidecarArchive, 'utf8'));
    assert.equal((await call(runtime, {
      path: `/api/transcript/exports/${cleared.json.archive_id}.annotations.jsonl`,
    })).status, 401, 'the download needs a session');
    fs.writeFileSync(sidecarArchive, '{"seq":1,"kind":"post","subject_id":"x"}\n');
    assert.equal((await get(runtime,
      `/api/transcript/exports/${cleared.json.archive_id}.annotations.jsonl`, owner)).status, 404,
    'a side-car archive carrying a subject id is never served');
    assert.equal((await get(runtime, '/api/history/archives', owner)).json.archives[0].downloads.annotations,
      null, 'and History lists no link for it');
    fs.unlinkSync(sidecarArchive);
    assert.equal((await get(runtime,
      `/api/transcript/exports/${cleared.json.archive_id}.annotations.jsonl`, owner)).status, 404,
    'an archive without a side-car file has no such download');
    const withoutSidecar = await get(runtime, '/api/history/archives', owner);
    assert.equal(withoutSidecar.status, 200, withoutSidecar.text);
    assert.equal(withoutSidecar.json.archives[0].downloads.annotations, null,
      'an archive from before the side-car still lists, with no side-car link');
    const read = await aiGet(runtime, messageQuery(0), scout.token);
    assert.equal(read.status, 200, read.text);
  } finally {
    await runtime.close();
  }
});
