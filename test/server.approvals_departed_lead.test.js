'use strict';

// A person who leads a project approves its requests only while they are in
// the room: once removed, their grant reads as ended and the request goes to
// the first owner, for a new request and for one already waiting.

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

test('a person lead who has left the room approves nothing: the request goes back to the first owner', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-approvals-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const invitation = await post(runtime, '/api/invitations', {}, owner);
    assert.equal(invitation.status, 200, invitation.text);
    const redeemed = await post(runtime, '/api/invitations/redeem',
      { secret: invitation.json.invite_code, name: 'Bea', password: 'a separate member password' });
    assert.equal(redeemed.status, 200, redeemed.text);
    owner = await elevate(runtime, owner, device);
    const scout = await admitSeat(runtime, owner, 'Scout');
    owner = await elevate(runtime, owner, device);
    const granted = await post(runtime, '/api/grants/create',
      { holder_name: 'Bea', holder_kind: 'person', project: 'ops', scope: 'leads operations', until: null }, owner);
    assert.equal(granted.status, 201, granted.text);
    const askFor = title => aiPost(runtime, '/api/ai/work/approvals/ask',
      { operation_id: uuid(), project: 'ops', title, scope: 'I order two rollers, up to $40' }, scout.token);
    const waiting = await askFor('Order rollers');
    assert.equal(waiting.status, 201, waiting.text);
    const toDecline = await askFor('Order a second printer');
    assert.equal(toDecline.json.item.approval.approver.name, 'Bea', 'the arrangement: filed with Bea as approver');
    assert.equal(waiting.json.item.approval.approver.name, 'Bea', 'the arrangement: Bea leads ops and approves its requests');
    const needsAna = async () => (await get(runtime, '/api/work/brief', owner)).json.needs_me;
    assert.equal((await needsAna()).some(row => row.id === waiting.json.item.id), false,
      'the arrangement: while Bea leads, it is in her Needs you, not Ana\'s');

    owner = await elevate(runtime, owner, device);
    const removed = await post(runtime, '/api/participants/revoke', { name: 'Bea' }, owner);
    assert.equal(removed.status, 200, removed.text);
    const grants = (await get(runtime, '/api/grants', owner)).json.grants;
    assert.equal(grants.find(row => row.holder_name === 'Bea').state, 'ended', 'the arrangement: the room shows her grant as ended');

    const moved = (await needsAna()).find(row => row.id === waiting.json.item.id);
    assert.ok(moved, 'the waiting request moves to the first owner\'s Needs you');
    assert.equal(moved.approval.approver.name, 'Ana');
    assert.equal((await item(runtime, owner, waiting.json.item.id)).approval.approver.name, 'Ana',
      'the item itself shows the live approver, as the lists do');
    const fresh = await askFor('Order toner');
    assert.equal(fresh.status, 201, fresh.text);
    assert.equal(fresh.json.item.approval.approver.name, 'Ana', 'a new request routes to the first owner');
    const yes = await post(runtime, '/api/annotated-messages',
      { text: '@Scout — yes', annotation: { answers: [{ ask_id: waiting.json.message.id, choice: 'yes' }] } }, owner);
    assert.equal(yes.status, 201, yes.text);
    assert.equal((await item(runtime, owner, waiting.json.item.id)).approval.state, 'approved');

    // A revise after the yes sends the request back to its live approver.
    const revised = await aiPost(runtime, '/api/ai/annotations',
      { kind: 'revise', ask_id: waiting.json.message.id, means: 'I order two rollers, up to $45' }, scout.token);
    assert.equal(revised.status, 201, revised.text);
    const back = await item(runtime, owner, waiting.json.item.id);
    assert.deepEqual([back.approval.state, back.next_to.name], ['awaiting', 'Ana'], 'back to Ana, not to Bea who left');

    // A decline's account names who declined.
    const no = await post(runtime, '/api/annotated-messages',
      { text: '@Scout — no', annotation: { answers: [{ ask_id: toDecline.json.message.id, choice: 'no' }] } }, owner);
    assert.equal(no.status, 201, no.text);
    assert.match((await item(runtime, owner, toDecline.json.item.id)).done_account, /^declined by Ana in the room #\d+$/);
  } finally {
    await runtime.close();
  }
});
