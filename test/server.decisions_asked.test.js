'use strict';

// "Ask a decision" is gone: Ask for approval replaced it. A decision an
// earlier build asked in the room keeps its bridge: the addressee's room
// answer is its answer, an answer on the record closes the room ask, a
// revision moves its scope, and its kill slot still works.

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

async function roomCount(runtime, owner) {
  return (await get(runtime, '/api/messages?after=0&limit=100&wait=0', owner)).json.messages.length;
}

test('"Ask a decision" posts nothing now; a decision an earlier build asked in the room keeps its bridge', async () => {
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

    // "Ask a decision" is not a request any more, for an AI or in the browser.
    const known = await aiPost(runtime, '/api/ai/work/items/create', {
      operation_id: uuid(), kind: 'work', project: 'ops', title: 'Known route', body: 'b',
    }, lead.token);
    assert.equal(known.status, 201, 'ARRANGEMENT: the work routes answer this seat: ' + known.text);
    const before = await roomCount(runtime, owner);
    const gone = { project: 'ops', title: 'Wipe the archive', body: 'b', asked_of: 'Scout', scope: 'I wipe the archive' };
    const byAi = await aiPost(runtime, '/api/ai/work/decisions/ask', Object.assign({ operation_id: uuid() }, gone), lead.token);
    assert.equal(byAi.status, 404, byAi.text);
    const inBrowser = await post(runtime, '/api/work/decisions/ask', Object.assign({ operation_id: uuid() }, gone), owner);
    assert.equal(inBrowser.status, 404, inBrowser.text);
    assert.equal(await roomCount(runtime, owner), before, 'nothing was posted or rung');
    assert.equal((await get(runtime, '/api/work/brief', owner)).json.decisions.length, 0, 'no decision was recorded');

    // What an earlier build left: a room ask of Ana and the decision bound to it.
    async function askedEarlier(title, means) {
      const asked = await aiPost(runtime, '/api/ai/annotated-messages', {
        text: `Decision: ${title}`, client_message_id: uuid(), annotation: { ask: { of: 'Ana', means, project: 'ops' } },
      }, lead.token);
      assert.equal(asked.status, 201, asked.text);
      const recorded = await aiPost(runtime, '/api/ai/work/items/create', {
        operation_id: uuid(), kind: 'decision', project: 'ops', title, body: 'b', asked_of: 'Ana', scope: means,
        source_message: { message_id: asked.json.message.id, quote: `Decision: ${title}` },
      }, lead.token);
      assert.equal(recorded.status, 201, recorded.text);
      return { askId: asked.json.message.id, id: recorded.json.item.id };
    }
    const merge = await askedEarlier('Merge the candidate', 'I merge the candidate to main and nothing else');
    const lanes = await askedEarlier('Order the lanes', 'I order the lanes');
    const rollers = await askedEarlier('Rollers', 'I order the OEM rollers');
    const loose = await askedEarlier('Delete the archive', 'I delete the archive');
    await runtime.close();
    const storeFile = path.join(dataDir, 'work', 'store.json');
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    for (const { id, askId } of [merge, lanes, rollers]) {
      const row = stored.items.find(entry => entry.id === id);
      row.ask_message_id = askId;
      row.ask_revision = 1;
      row.revision += 1;
    }
    fs.writeFileSync(storeFile, JSON.stringify(stored));
    runtime = await startInterlockServer({ port, dataDir });
    owner = await login(runtime, password);
    assert.equal((await item(runtime, owner, merge.id)).ask_message_id, merge.askId, 'ARRANGEMENT: the old binding opened');

    // A bystander's room answer records nothing; the addressee's is her answer.
    const bystander = await aiPost(runtime, '/api/ai/annotated-messages', {
      text: 'yes from me', client_message_id: uuid(),
      annotation: { answers: [{ ask_id: merge.askId, choice: 'yes' }] },
    }, scout.token);
    assert.equal(bystander.status, 201, bystander.text);
    assert.equal((await item(runtime, owner, merge.id)).state, 'awaiting');
    const yes = await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: merge.askId, choice: 'yes' }] },
    }, owner);
    assert.equal(yes.status, 201, yes.text);
    const answered = await item(runtime, owner, merge.id);
    assert.equal(answered.state, 'answered');
    assert.equal(answered.answer.kind, 'direct');
    assert.equal(answered.answer.by.name, 'Ana');
    assert.equal(answered.answer.source, `answered in the room #${yes.json.message.id}`);

    // A decision that only cites an ask was never bound, and her word does not answer it.
    await post(runtime, '/api/annotated-messages', {
      text: 'yes', annotation: { answers: [{ ask_id: loose.askId, choice: 'yes' }] },
    }, owner);
    assert.equal((await item(runtime, owner, loose.id)).state, 'awaiting', 'a citation alone never binds');

    // Answered on the record by the person asked: the room's ask closes too.
    const fresh = await item(runtime, owner, lanes.id);
    const recorded = await post(runtime, '/api/work/decisions/answer', {
      operation_id: uuid(), id: fresh.id, expected_revision: fresh.revision, text: 'yes, by priority', choice: 'yes',
    }, owner);
    assert.equal(recorded.status, 200, recorded.text);
    const echoed = (await get(runtime, '/api/annotations?after=0&limit=100', owner)).json.rows
      .filter(row => row.kind === 'post' && row.answers.some(entry => entry.ask_id === lanes.askId));
    assert.equal(echoed.length, 1, 'the room carries her answer');
    assert.deepEqual(echoed[0].answers.map(entry => [entry.by_addressee, entry.closes]), [[true, true]]);
    assert.equal((await item(runtime, owner, lanes.id)).answer.source, 'recorded here');

    // The asker revises the old ask: the decision's scope follows.
    const revised = await aiPost(runtime, '/api/ai/annotations', {
      kind: 'revise', ask_id: rollers.askId, means: 'I order the third-party rollers',
    }, lead.token);
    assert.equal(revised.status, 201, revised.text);
    assert.equal((await item(runtime, owner, rollers.id)).scope, 'I order the third-party rollers');

    // The kill slot on an old decision: anyone but the asker asks; only the asker replies.
    let current = await item(runtime, owner, rollers.id);
    const kill = (token, extra) => aiPost(runtime, '/api/ai/work/decisions/kill',
      Object.assign({ operation_id: uuid(), id: rollers.id }, extra), token);
    const own = await kill(lead.token, { expected_revision: current.revision, question: 'mine?' });
    assert.equal(own.json.error, 'kill-own-pick', own.text);
    const attacked = await kill(scout.token, { expected_revision: current.revision, question: 'Do the rollers fit?' });
    assert.equal(attacked.status, 201, attacked.text);
    current = attacked.json.item;
    const survived = await aiPost(runtime, '/api/ai/work/decisions/kill-reply', {
      operation_id: uuid(), id: rollers.id, expected_revision: current.revision, words: 'Measured: they fit.', outcome: 'survived',
    }, lead.token);
    assert.equal(survived.status, 200, survived.text);
    assert.equal(survived.json.item.kill_state, 'survived');
  } finally {
    await runtime.close();
  }
});
