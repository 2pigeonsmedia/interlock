'use strict';

// A decision asked of someone reaches them and its answer reaches its asker:
// filing it posts a bound room ask, and an answer on the record goes back to
// the room (as the ask's answer when its addressee gives it, else as a line
// naming the asker), so the asker is rung either way.

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

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('a filed decision is asked in the room, and every answer on the record reaches its asker', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decision-room-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    const ana = await login(runtime, password);
    const messages = async () => (await get(runtime, '/api/messages?after=0&limit=100&wait=0', ana)).json.messages;
    const rows = async () => (await get(runtime, '/api/annotations?after=0&limit=100', ana)).json.rows;

    // Filing: the decision is asked in the room, bound to its record.
    const filed = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Keep the March import?',
      body: 'Two rows look doubled.', asked_of: 'Ana', proposal: 'Keep it and flag the two rows',
    }, scout.token);
    assert.equal(filed.status, 201, filed.text);
    const d = filed.json.item;
    assert.ok(Number.isSafeInteger(d.ask_message_id), 'the record is bound to a room ask');
    const ask = (await rows()).find(row => row.kind === 'post' && row.message_id === d.ask_message_id);
    assert.ok(ask && ask.ask && ask.ask.of === 'Ana', 'the room ask is addressed to Ana');
    assert.equal(ask.ask.means, 'Keep it and flag the two rows', 'a yes means the proposal');
    const posted = (await messages()).find(row => row.id === d.ask_message_id);
    assert.ok(posted && posted.byline === 'Scout' && /Keep the March import\?/.test(posted.text), 'posted by its asker, naming it');

    // Ana answers on the record (the panel): the room hears it and Scout is rung.
    const before = (await messages()).length;
    const yes = await post(runtime, '/api/work/decisions/answer',
      { operation_id: uuid(), id: d.id, expected_revision: (await item(runtime, ana, d.id)).revision, choice: 'yes',
        text: 'Yes, and @Lead can start' }, ana);
    assert.equal(yes.status, 200, yes.text);
    const echoed = (await messages()).slice(before);
    assert.equal(echoed.length, 1, 'one room line for her answer');
    assert.equal(echoed[0].byline, 'Ana');
    assert.ok(echoed[0].delivery.some(row => row.name === 'Scout'), 'it rings the asker');
    assert.deepEqual(echoed[0].delivery.map(row => row.name), ['Scout'], 'and nobody her words @mention');
    assert.equal((await rows()).some(row => row.kind === 'post' && row.message_id === echoed[0].id &&
      row.answers.some(a => a.ask_id === d.ask_message_id && a.choice === 'yes')), true, 'and answers the room ask yes');

    // An answer given on someone's behalf still reaches the asker, by name.
    const other = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rename the export?', body: 'The CPA asked.', asked_of: 'Lead',
    }, scout.token);
    assert.equal(other.status, 201, other.text);
    const mark = (await messages()).length;
    const onBehalf = { operation_id: uuid(), id: other.json.item.id,
      expected_revision: other.json.item.revision, choice: 'no', text: 'No; @Lead decides when back', reason: 'Lead is away today' };
    const forLead = await post(runtime, '/api/work/decisions/answer', onBehalf, ana);
    assert.equal(forLead.status, 200, forLead.text);
    const told = (await messages()).slice(mark);
    assert.equal(told.length, 1, 'one room line');
    assert.match(told[0].text, new RegExp('^@Scout — ' + other.json.item.id + ': No'), 'naming the asker, the record and the answer');
    assert.ok(told[0].delivery.some(row => row.name === 'Scout'), 'it rings the asker');
    assert.deepEqual(told[0].delivery.map(row => row.name), ['Scout'], 'only the asker is rung, not whom the words @mention');
    assert.match(told[0].text, /@\u2060Lead/, 'the copied words still read @Lead');
    // A retried answer is a replay: it is not posted or rung again.
    const replay = await post(runtime, '/api/work/decisions/answer', onBehalf, ana);
    assert.equal(replay.status, 200, replay.text);
    assert.equal((await messages()).length, mark + 1, 'the replay posts nothing');

    // A decision that cites what someone said keeps that citation; its ask replies to it.
    const said = await post(runtime, '/api/messages', { text: 'Use the March cut-off.' }, ana);
    assert.equal(said.status, 201, said.text);
    const cited = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Which cut-off applies?', body: 'Ana named one.',
      asked_of: 'Ana', source_message: { message_id: said.json.message.id, quote: 'March cut-off' },
    }, scout.token);
    assert.equal(cited.status, 201, cited.text);
    assert.deepEqual([cited.json.item.source_message.message_id, cited.json.item.source_message.byline],
      [said.json.message.id, 'Ana'], 'who said it stays on the record');
    assert.ok(cited.json.item.ask_message_id > said.json.message.id, 'and it is still asked in the room');
    assert.match((await messages()).find(row => row.id === cited.json.item.ask_message_id).text,
      new RegExp('^re #' + said.json.message.id + ' Decision: Which cut-off applies\\?'));

    // A retried filing answers from the record as it is now; the same id with a different request conflicts.
    const fileOp = uuid();
    const filing = { operation_id: fileOp, kind: 'decision', project: 'ops', title: 'Archive March?', body: 'b', asked_of: 'Ana' };
    const first = await aiPost(runtime, '/api/ai/work/items/create', filing, scout.token);
    assert.equal(first.status, 201, first.text);
    const n2 = (await messages()).length;
    const retried = await aiPost(runtime, '/api/ai/work/items/create', filing, scout.token);
    assert.deepEqual([retried.status, retried.json.item.id, retried.json.item.ask_message_id],
      [200, first.json.item.id, first.json.item.ask_message_id], 'the same record, bound');
    const changed = await aiPost(runtime, '/api/ai/work/items/create', Object.assign({}, filing, { title: 'Archive April?' }), scout.token);
    assert.deepEqual([changed.status, changed.json.error], [409, 'operation-conflict']);
    assert.equal((await messages()).length, n2, 'neither retry posted');

    // A filing the record would refuse posts nothing to the room.
    const nowhere = await aiPost(runtime, '/api/ai/work/items/create',
      Object.assign({}, filing, { operation_id: uuid(), project: 'nowhere' }), scout.token);
    assert.deepEqual([nowhere.status, nowhere.json.error], [404, 'unknown-project']);
    const extra = await aiPost(runtime, '/api/ai/work/items/create',
      Object.assign({}, filing, { operation_id: uuid(), ask_message_id: 3 }), scout.token);
    assert.equal(extra.status, 400, extra.text);
    assert.equal((await messages()).length, n2, 'no phantom ask');

    // A decision of one's own is recorded with no room ask: nobody to ask or ring.
    const count = (await messages()).length;
    const own = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Do I batch the imports?', body: 'Mine to decide.', asked_of: 'Scout',
    }, scout.token);
    assert.equal(own.status, 201, own.text);
    assert.equal(own.json.item.ask_message_id, null);
    assert.equal((await messages()).length, count, 'nothing posted');
  } finally {
    await runtime.close();
  }
});
