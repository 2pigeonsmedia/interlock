'use strict';

// A yes binds to the scope she saw: an answer names the revision it was given
// against, on the person's door and the AI's, and the record's own answer
// reaches the room as what it is.

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

// What an earlier build's "Ask a decision" left: a room ask of Ana and the
// decision bound to it. Nothing binds one today, so the binding is written
// into the stored record and the room reopened, as an upgrade would open it.
async function askedEarlier(runtime, token, title, means) {
  const asked = await aiPost(runtime, '/api/ai/annotated-messages', {
    text: `Decision: ${title}`, client_message_id: uuid(), annotation: { ask: { of: 'Ana', means, project: 'ops' } },
  }, token);
  assert.equal(asked.status, 201, asked.text);
  const recorded = await aiPost(runtime, '/api/ai/work/items/create', {
    operation_id: uuid(), kind: 'decision', project: 'ops', title, body: 'b', asked_of: 'Ana', scope: means,
    source_message: { message_id: asked.json.message.id, quote: `Decision: ${title}` },
  }, token);
  assert.equal(recorded.status, 201, recorded.text);
  return { json: { message: asked.json.message, item: recorded.json.item } };
}

function bindAsEarlierBuild(dataDir, asks) {
  const storeFile = path.join(dataDir, 'work', 'store.json');
  const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  for (const ask of asks) {
    const row = stored.items.find(entry => entry.id === ask.json.item.id);
    row.ask_message_id = ask.json.message.id;
    row.ask_revision = 1;
    row.revision += 1;
  }
  fs.writeFileSync(storeFile, JSON.stringify(stored));
}

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('a yes binds to the revision she saw, on both doors; the record\'s answer reaches the room as what it is', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decisions-'));
  let runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await login(runtime, password);
    const rollers = await askedEarlier(runtime, lead.token, 'Rollers', 'I order the OEM rollers');
    const wipe = await askedEarlier(runtime, lead.token, 'Wipe', 'I wipe the old disk');
    const drum = await askedEarlier(runtime, lead.token, 'Drum', 'I order a drum');
    const lanes = await askedEarlier(runtime, lead.token, 'Lanes', 'I order the lanes by priority');
    const grit = await askedEarlier(runtime, lead.token, 'Grit', 'I buy one bag of grit');
    await runtime.close();
    bindAsEarlierBuild(dataDir, [rollers, wipe, drum, lanes, grit]);
    runtime = await startInterlockServer({ port, dataDir });
    owner = await login(runtime, password);
    assert.equal((await item(runtime, owner, rollers.json.item.id)).ask_message_id, rollers.json.message.id,
      'ARRANGEMENT: the earlier build\'s binding opened');
    const leadTurn = async askId => (await aiGet(runtime, '/api/ai/asks', lead.token)).json.asked
      .find(row => row.ask_id === askId);

    // The person's door: Lead revises between her reading and her tap.
    const askId = rollers.json.message.id;
    const revised = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'revise', ask_id: askId, means: 'I order the third-party rollers from eBay' }, lead.token);
    assert.equal(revised.status, 201, revised.text);
    assert.deepEqual(Object.keys(revised.json).sort(), ['ok', 'row'], 'the record followed: nothing to report');
    const stale = await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 1 }] },
    }, owner);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error, 'ask-revised');
    let decision = await item(runtime, owner, rollers.json.item.id);
    assert.deepEqual([decision.state, decision.answer], ['awaiting', null], 'neither the room nor the record took it');
    const yes = await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: askId, choice: 'yes', revision: 2 }] },
    }, owner);
    assert.equal(yes.status, 201, yes.text);
    decision = await item(runtime, owner, rollers.json.item.id);
    assert.deepEqual([decision.state, decision.scope, decision.answer.ask_revision],
      ['answered', 'I order the third-party rollers from eBay', 2]);
    assert.equal(await leadTurn(askId), undefined, 'a decision ask is a plain ask: her yes answers it');

    // The AI's door: the same rule when a person asks an AI.
    const rerun = await post(runtime, '/api/annotated-messages', {
      text: 'Rerun the suite?', annotation: { ask: { of: 'Scout' } },
    }, owner);
    assert.equal(rerun.status, 201, rerun.text);
    assert.equal((await post(runtime, '/api/annotations',
      { kind: 'revise', ask_id: rerun.json.message.id, means: 'rerun at the release head' }, owner)).status, 201);
    const seatStale = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes', client_message_id: uuid(), annotation: { answers: [{ ask_id: rerun.json.message.id, choice: 'yes' }] },
    }, scout.token);
    assert.equal(seatStale.status, 409, seatStale.text);
    assert.equal(seatStale.json.error, 'ask-revised', 'an AI that names no revision answered the first');
    const seatYes = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: rerun.json.message.id, choice: 'yes', revision: 2 }] },
    }, scout.token);
    assert.equal(seatYes.status, 201, seatYes.text);

    // Her "no" written on the record: the room's copy is an answer, never a yes.
    let fresh = await item(runtime, owner, wipe.json.item.id);
    const no = await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: fresh.id, expected_revision: fresh.revision, text: 'No, do not wipe it.',
    }, owner);
    assert.equal(no.status, 200, no.text);
    const echo = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows
      .find(row => row.kind === 'post' && row.answers.some(entry => entry.ask_id === wipe.json.message.id));
    assert.deepEqual(echo.answers.map(entry => [entry.choice, entry.revision, entry.closes]), [[null, 1, true]],
      'the arrangement: the room took her record answer as closing');
    assert.equal(await leadTurn(wipe.json.message.id), undefined, 'answered, a plain ask: nobody is on it');

    // Answered on the record after a revision: the copy names the revision the record follows.
    await aiPost(runtime, '/api/ai/annotations', { kind: 'revise', ask_id: drum.json.message.id, means: 'I order two drums' }, lead.token);
    fresh = await item(runtime, owner, drum.json.item.id);
    assert.equal(fresh.ask_revision, 2, 'the arrangement: the record follows revision 2');
    await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: fresh.id, expected_revision: fresh.revision, text: 'two is fine',
    }, owner);
    const drumEcho = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows
      .find(row => row.kind === 'post' && row.answers.some(entry => entry.ask_id === drum.json.message.id));
    assert.deepEqual(drumEcho.answers.map(entry => entry.revision), [2]);

    // A yes said on the record agrees in the room too; it binds to the scope the record showed her.
    fresh = await item(runtime, owner, lanes.json.item.id);
    const maybe = await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: fresh.id, expected_revision: fresh.revision, text: 'sure', choice: 'maybe',
    }, owner);
    assert.equal(maybe.status, 400, maybe.text);
    const recordYes = await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: fresh.id, expected_revision: fresh.revision, text: 'yes, by priority', choice: 'yes',
    }, owner);
    assert.equal(recordYes.status, 200, recordYes.text);
    assert.equal(recordYes.json.item.answer.choice, 'yes');
    const lanesEcho = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows
      .find(row => row.kind === 'post' && row.answers.some(entry => entry.ask_id === lanes.json.message.id));
    assert.deepEqual(lanesEcho.answers.map(entry => [entry.choice, entry.revision]), [['yes', 1]]);
    assert.equal(await leadTurn(lanes.json.message.id), undefined, 'her record yes answers the plain ask');
    // She had the record open at the old scope when Lead revised: her yes is refused, nothing reaches the room.
    const seen = await item(runtime, owner, grit.json.item.id);
    await aiPost(runtime, '/api/ai/annotations', { kind: 'revise', ask_id: grit.json.message.id, means: 'I buy ten bags of grit' }, lead.token);
    const lateYes = await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: seen.id, expected_revision: seen.revision, text: 'yes', choice: 'yes',
    }, owner);
    assert.equal(lateYes.status, 409, lateYes.text);
    assert.equal((await item(runtime, owner, grit.json.item.id)).answer, null);
    assert.equal((await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows
      .some(row => row.kind === 'post' && row.answers.some(entry => entry.ask_id === grit.json.message.id)), false,
    'no copy in the room');
  } finally {
    await runtime.close();
  }
});
