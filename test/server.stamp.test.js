'use strict';

// The project stamp over HTTP: each derivation rule on a real server, the
// author's re-stamp, and a stamp write that fails without failing the post.

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

async function createProject(runtime, owner, device, id, displayName) {
  const elevated = await elevate(runtime, owner, device);
  const created = await post(runtime, '/api/work/projects/create',
    { operation_id: uuid(), id, display_name: displayName }, elevated);
  assert.equal(created.status, 201, created.text);
  return elevated;
}

async function stamps(runtime, session) {
  const page = await get(runtime, '/api/annotations?after=0&limit=100', session);
  assert.equal(page.status, 200, page.text);
  return page.json.rows.filter(row => row.kind === 'stamp');
}

function stampOf(rows, messageId) {
  const mine = rows.filter(row => row.message_id === messageId);
  return mine.length === 0 ? null : mine[mine.length - 1];
}

test('every append path stamps its message by the first rule that applies, and the author may re-stamp', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-stamp-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    const wren = await admitSeat(runtime, owner, 'Wren');
    owner = await createProject(runtime, owner, device, 'orchard', 'Orchard');
    owner = await createProject(runtime, owner, device, 'household', 'Household');
    const w1 = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'orchard', title: 'Prune the rows', body: 'Before spring.',
    }, wren.token);
    assert.equal(w1.json && w1.json.item.id, 'W-1', 'ARRANGEMENT: W-1 is an orchard record ' + w1.text);
    const w2 = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'household', title: 'Fix the gate', body: 'Latch sticks.',
    }, wren.token);
    assert.equal(w2.json && w2.json.item.id, 'W-2', 'ARRANGEMENT: W-2 is a household record ' + w2.text);
    const assigned = await post(runtime, '/api/people/assign', { seat_name: 'Scout', project: 'orchard' }, owner);
    assert.equal(assigned.status, 200, assigned.text);
    const people = await get(runtime, '/api/participants', owner);
    const projectOf = name => people.json.participants.find(row => row.name === name).project;
    assert.deepEqual([projectOf('Scout'), projectOf('Wren'), projectOf('Ana')], ['orchard', null, null],
      'ARRANGEMENT: Scout is assigned to the orchard; Wren and Ana have no assignment');

    // 1. An ask: its project, from the browser's annotated route.
    const asked = await post(runtime, '/api/annotated-messages',
      { text: 'can you look at W-1?', annotation: { ask: { of: 'Wren', project: 'household' } } }, owner);
    assert.equal(asked.status, 201, asked.text);
    // 2. A cited record, from the plain browser route: the record's project.
    const cited = await post(runtime, '/api/messages', { text: 'notes on W-1 today' }, owner);
    assert.equal(cited.status, 201, cited.text);
    // A citation across two projects falls through: a person has no assignment, so none.
    const both = await post(runtime, '/api/messages', { text: 'W-1 and W-2 both slipped' }, owner);
    assert.equal(both.status, 201, both.text);
    // An id that names no record is not a citation.
    const unknown = await post(runtime, '/api/messages', { text: 'what about W-99?' }, owner);
    assert.equal(unknown.status, 201, unknown.text);
    // 3. An AI's assignment, from the plain AI route, and past a two-project citation.
    const plainAi = await aiPost(runtime, '/api/ai/messages', { text: 'pruning now', client_message_id: uuid() }, scout.token);
    assert.equal(plainAi.status, 201, plainAi.text);
    const scoutBoth = await aiPost(runtime, '/api/ai/annotated-messages',
      { text: 'W-1 and W-2 both slipped', client_message_id: uuid(), annotation: { status: 'ready', read_through: 0 } },
      scout.token);
    assert.equal(scoutBoth.status, 201, scoutBoth.text);
    // An AI ask with no project: the ask rule, with the project the room chose for it.
    const aiAsk = await aiPost(runtime, '/api/ai/annotated-messages',
      { text: 'ok to cut?', client_message_id: uuid(), annotation: { ask: { of: 'Ana', means: 'I cut row 3' } } },
      scout.token);
    assert.equal(aiAsk.status, 201, aiAsk.text);
    // 4. Nothing applies: no row.
    const none = await aiPost(runtime, '/api/ai/messages', { text: 'hello', client_message_id: uuid() }, wren.token);
    assert.equal(none.status, 201, none.text);

    const rows = await stamps(runtime, owner);
    const view = id => { const row = stampOf(rows, id); return row && [row.project, row.reason, row.record_id, row.by]; };
    assert.deepEqual(view(asked.json.message.id), ['household', 'ask', null, 'Ana'], 'an ask stamps with its project');
    assert.deepEqual(view(cited.json.message.id), ['orchard', 'record', 'W-1', 'Ana'], 'a cited record stamps with its project');
    assert.equal(view(both.json.message.id), null, 'records in two projects: the cite rule is skipped');
    assert.equal(view(unknown.json.message.id), null, 'an id that is not a record is not a citation');
    assert.deepEqual(view(plainAi.json.message.id), ['orchard', 'assignment', null, 'Scout'], 'an AI\'s assignment');
    assert.deepEqual(view(scoutBoth.json.message.id), ['orchard', 'assignment', null, 'Scout'],
      'a two-project citation falls through to the assignment');
    assert.deepEqual(view(aiAsk.json.message.id), ['orchard', 'ask', null, 'Scout'],
      'an AI ask with no project takes the project the room gave the ask (its assignment)');
    assert.equal(view(none.json.message.id), null, 'no rule applies: the message is unstamped');
    assert.ok(rows.every(row => !Object.hasOwn(row, 'subject_id')), 'a stamp leaves the store by name only');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['by', 'kind', 'message_id', 'project', 'reason', 'record_id', 'seq', 'ts']);
    assert.deepEqual(asked.json.message && Object.keys(asked.json.message).sort(), ['byline', 'delivery', 'id', 'kind',
      'product', 'product_provenance', 'session', 'text', 'ts'], 'the message object is unchanged');

    // Re-stamp: the author only, to a live project or the whole room.
    const restamped = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'stamp', message_id: plainAi.json.message.id, project: 'household' }, scout.token);
    assert.equal(restamped.status, 201, restamped.text);
    assert.deepEqual([restamped.json.row.project, restamped.json.row.reason, restamped.json.row.by], ['household', 'set', 'Scout']);
    assert.deepEqual(view(plainAi.json.message.id), ['orchard', 'assignment', null, 'Scout'],
      'ARRANGEMENT: the earlier read still shows the derived stamp');
    assert.deepEqual(stampOf(await stamps(runtime, owner), plainAi.json.message.id).reason, 'set', 'the newest stamp wins');
    const notAuthor = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'stamp', message_id: plainAi.json.message.id, project: 'orchard' }, wren.token);
    assert.deepEqual([notAuthor.status, notAuthor.json.error], [403, 'not-author']);
    const notAuthorBrowser = await post(runtime, '/api/annotations',
      { kind: 'stamp', message_id: plainAi.json.message.id, project: 'orchard' }, owner);
    assert.deepEqual([notAuthorBrowser.status, notAuthorBrowser.json.error], [403, 'not-author']);
    const unknownProject = await post(runtime, '/api/annotations',
      { kind: 'stamp', message_id: cited.json.message.id, project: 'orchrad' }, owner);
    assert.deepEqual([unknownProject.status, unknownProject.json.error], [400, 'unknown-project']);
    const wholeRoom = await post(runtime, '/api/annotations',
      { kind: 'stamp', message_id: cited.json.message.id, project: null }, owner);
    assert.equal(wholeRoom.status, 201, wholeRoom.text);
    assert.deepEqual([wholeRoom.json.row.project, wholeRoom.json.row.reason], [null, 'set']);
    const missing = await post(runtime, '/api/annotations', { kind: 'stamp', message_id: 9999, project: null }, owner);
    assert.deepEqual([missing.status, missing.json.error], [404, 'message-not-found']);
    const aiRows = (await aiGet(runtime, '/api/ai/annotations?after=0&limit=100', wren.token)).json.rows;
    assert.ok(aiRows.some(row => row.kind === 'stamp' && row.message_id === cited.json.message.id && row.project === null),
      'the AI side-car read carries stamp rows too');

    // A retried AI post keeps its stamp: the author's set is not undone.
    const clientId = uuid();
    const first = await aiPost(runtime, '/api/ai/messages', { text: 'retry me', client_message_id: clientId }, scout.token);
    assert.equal(first.status, 201, first.text);
    const set = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'stamp', message_id: first.json.message.id, project: 'household' }, scout.token);
    assert.equal(set.status, 201, set.text);
    const retried = await aiPost(runtime, '/api/ai/messages', { text: 'retry me', client_message_id: clientId }, scout.token);
    assert.equal(retried.json && retried.json.message.id, first.json.message.id, 'ARRANGEMENT: the retry is the same message');
    assert.equal(stampOf(await stamps(runtime, owner), first.json.message.id).reason, 'set');
  } finally {
    await runtime.close();
  }
});
