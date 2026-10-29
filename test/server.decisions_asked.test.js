'use strict';

// Decisions asked in the room: the ask posted first, the record citing it,
// the kill slot, and the room answer recorded as the decision's answer.

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

async function askOf(runtime, token, body) {
  return aiPost(runtime, '/api/ai/work/decisions/ask', Object.assign({ operation_id: uuid() }, body), token);
}

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('a decision asked in the room: the ask first, the record citing it, the kill slot, and the room answer recorded', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-decisions-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await login(runtime, password);

    const about = await post(runtime, '/api/messages', { text: 'the candidate is green' }, owner);
    const body = {
      operation_id: uuid(), project: 'ops', title: 'Merge the candidate', body: 'Green on both suites.', asked_of: 'Ana',
      scope: 'I merge the candidate to main and nothing else', proposal: 'merge now',
      about_message: about.json.message.id,
    };
    const asked = await aiPost(runtime, '/api/ai/work/decisions/ask', body, lead.token);
    assert.equal(asked.status, 201, asked.text);
    const decision = asked.json.item;
    assert.equal(decision.kind, 'decision');
    assert.equal(decision.state, 'awaiting');
    assert.equal(decision.kill_state, 'unattacked');
    assert.equal(asked.json.message.text, `re #${about.json.message.id} Decision: Merge the candidate`);
    assert.equal(decision.source_message.message_id, asked.json.message.id, 'the record cites the ask');
    const rows = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows;
    assert.deepEqual(rows.map(row => [row.message_id, row.ask && row.ask.of, row.ask && row.ask.means]),
      [[asked.json.message.id, 'Ana', 'I merge the candidate to main and nothing else']]);

    const again = await aiPost(runtime, '/api/ai/work/decisions/ask', body, lead.token);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.item.id, decision.id);
    assert.equal(again.json.message.id, asked.json.message.id, 'an AI retry posts nothing twice');

    // The kill slot: anyone but the asker asks; only the asker replies.
    const kill = (token, extra) => aiPost(runtime, '/api/ai/work/decisions/kill',
      Object.assign({ operation_id: uuid(), id: decision.id }, extra), token);
    const reply = (token, extra) => aiPost(runtime, '/api/ai/work/decisions/kill-reply',
      Object.assign({ operation_id: uuid(), id: decision.id }, extra), token);
    let current = await item(runtime, owner, decision.id);
    const own = await kill(lead.token, { expected_revision: current.revision, question: 'mine?' });
    assert.equal(own.status, 403, own.text);
    assert.equal(own.json.error, 'kill-own-pick');
    const attacked = await kill(scout.token, {
      expected_revision: current.revision, question: 'Is the parity gate still summing marked rows?',
    });
    assert.equal(attacked.status, 201, attacked.text);
    assert.equal(attacked.json.item.kill_state, 'attacked');
    current = attacked.json.item;
    assert.equal((await kill(scout.token, { expected_revision: current.revision, question: 'again' })).json.error,
      'kill-slot-filled');
    assert.equal((await reply(scout.token, {
      expected_revision: current.revision, words: 'x', outcome: 'survived',
    })).json.error, 'not-asker');
    const survived = await reply(lead.token, {
      expected_revision: current.revision, words: 'Ran it: 0 marked rows summed.', outcome: 'survived',
    });
    assert.equal(survived.status, 200, survived.text);
    assert.equal(survived.json.item.kill_state, 'survived');
    assert.equal(survived.json.item.kill.reply.words, 'Ran it: 0 marked rows summed.');

    // A bystander's room answer records nothing; the addressee's is her answer.
    const bystander = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes from me', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: asked.json.message.id, choice: 'yes' }] },
    }, scout.token);
    assert.equal(bystander.status, 201, bystander.text);
    assert.equal((await item(runtime, owner, decision.id)).state, 'awaiting');
    const yes = await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: asked.json.message.id, choice: 'yes' }] },
    }, owner);
    assert.equal(yes.status, 201, yes.text);
    assert.deepEqual(Object.keys(yes.json).sort(), ['message', 'ok'], 'the post response is unchanged');
    const answered = await item(runtime, owner, decision.id);
    assert.equal(answered.state, 'answered');
    assert.equal(answered.answer.kind, 'direct');
    assert.equal(answered.answer.by.name, 'Ana');
    assert.equal(answered.answer.source, `answered in the room #${yes.json.message.id}`);

    // An admin who is not the addressee records nothing either.
    const ofScout = await askOf(runtime, lead.token, {
      project: 'ops', title: 'Rerun on Windows', body: 'The suite flaked once.', asked_of: 'Scout',
    });
    assert.equal(ofScout.status, 201, ofScout.text);
    const byOwner = await post(runtime, '/api/annotated-messages', {
      text: 'yes, do it', annotation: { answers: [{ ask_id: ofScout.json.message.id, choice: 'yes' }] },
    }, owner);
    assert.equal(byOwner.status, 201, byOwner.text);
    assert.equal((await item(runtime, owner, ofScout.json.item.id)).state, 'awaiting',
      'the owner answering an ask of Scout is not Scout\'s answer');
    const byScout = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: ofScout.json.message.id, choice: 'yes' }] },
    }, scout.token);
    assert.equal(byScout.status, 201, byScout.text);
    assert.equal((await item(runtime, owner, ofScout.json.item.id)).state, 'answered');

    const noScope = await askOf(runtime, lead.token, { project: 'ops', title: 'x', body: 'y', asked_of: 'Ana' });
    assert.equal(noScope.status, 400, noScope.text);
    assert.equal(noScope.json.error, 'means-required', 'an ask of a person needs its scope line');

    // A record refused after its ask was posted: the ask stands and is answerable.
    const orphan = await askOf(runtime, lead.token, {
      project: 'nowhere', title: 'Ship it', body: 'b', asked_of: 'Ana', scope: 'I ship it',
    });
    assert.equal(orphan.status, 404, orphan.text);
    assert.equal(orphan.json.error, 'unknown-project');
    assert.ok(Number.isSafeInteger(orphan.json.message.id), 'the refusal names the ask it left');
    const answerOrphan = await post(runtime, '/api/annotated-messages', {
      text: 'no', annotation: { answers: [{ ask_id: orphan.json.message.id, choice: 'no' }] },
    }, owner);
    assert.equal(answerOrphan.status, 201, answerOrphan.text);
  } finally {
    await runtime.close();
  }
});
