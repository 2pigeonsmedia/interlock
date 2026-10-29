'use strict';

// A seat may say at join which project it is joining for and which model its
// client runs. The Allow card shows the project as typed; once allowed, the
// room's People rows and Settings carry the model, the project and who set
// it, and the presence line, each null when unset.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const crypto = require('node:crypto');
const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port, path: options.path || '/',
      method: options.method || 'GET', headers,
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
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: {
      origin: runtime.url, 'sec-fetch-site': 'same-origin',
      cookie: session.cookie, 'x-csrf-token': session.csrf,
    },
  });
}

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

const NONE = { cookie: '', csrf: '' };

async function bootstrap(runtime, device) {
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' }, NONE);
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = sessionFrom(redeemed);
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
}

async function login(runtime, name, password) {
  const signedIn = await post(runtime, '/api/login', { name, password }, NONE);
  assert.equal(signedIn.status, 200, signedIn.text);
  return sessionFrom(signedIn);
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return sessionFrom(finished);
}

async function roles(runtime, session) {
  const response = await call(runtime, { path: '/api/session', headers: { cookie: session.cookie } });
  assert.equal(response.status, 200, response.text);
  return response.json.user.roles;
}


async function admitSeat(runtime, owner, name, extra = {}) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest, ...extra,
  };
  const waiting = call(runtime, { path: '/api/ai/admissions', method: 'POST', body });
  for (let attempt = 0; ; attempt += 1) {
    const pending = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
    if (pending.json && pending.json.pending.some(row => row.request_id === body.request_id && row.connected)) break;
    assert.ok(attempt < 50, 'ARRANGEMENT: the knock became visible');
    await new Promise(resolve => setImmediate(resolve));
  }
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal((await waiting).status, 200);
  return candidate.token;
}

test('a seat\'s declared project and model reach the Allow card, People and Settings', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-people-facts-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);
    let owner = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);

    const candidate = identity.newAiCredential();
    const knock = { request_id: crypto.randomUUID(), name: 'Scout', product: 'Claude Code', product_provenance: 'client-reported',
      selector: candidate.selector, digest: candidate.digest, project: 'ops', model: 'Opus 5.5' };
    const waiting = call(runtime, { path: '/api/ai/admissions', method: 'POST', body: knock });
    let card;
    for (let attempt = 0; !card; attempt += 1) {
      const pending = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
      card = pending.json.pending.find(row => row.request_id === knock.request_id && row.connected);
      assert.ok(card || attempt < 50, 'ARRANGEMENT: the knock became visible');
      if (!card) await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(Object.keys(card).length, 13, JSON.stringify(card));
    assert.equal(card.declared_project, 'ops', 'the Allow card shows the declared project as typed');
    const allowed = await post(runtime, `/api/ai/admissions/${knock.request_id}/allow`, {}, owner);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await waiting).status, 200);
    owner = await elevate(runtime, owner, ownerDevice);
    const plain = await admitSeat(runtime, owner, 'Wren');
    assert.equal(typeof plain, 'string', 'ARRANGEMENT: a seat that declares nothing joins as before');

    const people = await call(runtime, { path: '/api/participants', headers: { cookie: owner.cookie } });
    assert.equal(people.status, 200, people.text);
    const row = name => people.json.participants.find(item => item.name === name);
    assert.equal(Object.keys(row('Scout')).length, 14);
    assert.deepEqual([row('Scout').model, row('Scout').project, row('Scout').assigned.how, row('Scout').presence],
      ['Opus 5.5', 'ops', 'join', null]);
    assert.deepEqual([row('Wren').model, row('Wren').project, row('Wren').assigned], [null, null, null]);
    assert.deepEqual([row('Ana').model, row('Ana').project], [null, null], 'a person has no model or seat project');

    owner = await login(runtime, 'Ana', 'correct horse battery staple');
    const settings = await call(runtime, { path: '/api/settings/participants', headers: { cookie: owner.cookie } });
    assert.equal(settings.status, 200, settings.text);
    const scout = settings.json.participants.find(item => item.name === 'Scout');
    assert.equal(Object.keys(scout).length, 15);
    assert.deepEqual([scout.model, scout.project, scout.assigned.how], ['Opus 5.5', 'ops', 'join']);

    // Presence, own project, a lead assigning, the owner assigning, a post clearing.
    const scoutAuth = { authorization: `Bearer ${candidate.token}` };
    const wren = { authorization: `Bearer ${plain}` };
    const aiPost = (pathname, body, headers) => call(runtime, { path: pathname, method: 'POST', body, headers });
    const rows = async () => (await call(runtime, { path: '/api/participants', headers: { cookie: owner.cookie } }))
      .json.participants;
    const of = (list, name) => list.find(item => item.name === name);
    const set = await aiPost('/api/ai/presence', { middle: 'building the import', waiting_on: 'Ana', need: null }, scoutAuth);
    assert.equal(set.status, 200, set.text);
    assert.deepEqual([of(await rows(), 'Scout').presence.middle, of(await rows(), 'Scout').presence.waiting_on],
      ['building the import', 'Ana']);
    const notLead = await aiPost('/api/ai/project', { seat_name: 'Wren', project: 'ops' }, scoutAuth);
    assert.deepEqual([notLead.status, notLead.json.error], [403, 'not-authorized'], 'a seat without a grant cannot assign another');
    const own = await aiPost('/api/ai/project', { project: null }, wren);
    assert.equal(own.status, 200, own.text);
    assert.equal(of(await rows(), 'Wren').assigned.how, 'self');
    owner = await elevate(runtime, owner, ownerDevice);
    const granted = await post(runtime, '/api/grants/create',
      { holder_name: 'Scout', holder_kind: 'seat', project: 'ops', scope: 'leads ops', until: null }, owner);
    assert.equal(granted.status, 201, granted.text);
    const byLead = await aiPost('/api/ai/project', { seat_name: 'Wren', project: 'ops' }, scoutAuth);
    assert.equal(byLead.status, 200, 'the lead assigns into its own project: ' + byLead.text);
    assert.deepEqual([of(await rows(), 'Wren').project, of(await rows(), 'Wren').assigned.how,
      of(await rows(), 'Wren').assigned.by_name], ['ops', 'assigned', 'Scout']);
    const byOwner = await post(runtime, '/api/people/assign', { seat_name: 'Wren', project: null }, owner);
    assert.equal(byOwner.status, 200, byOwner.text);
    assert.deepEqual([of(await rows(), 'Wren').project, of(await rows(), 'Wren').assigned.by_name], [null, 'Ana']);
    const said = await aiPost('/api/ai/messages', { text: 'done with the import', client_message_id: crypto.randomUUID() }, scoutAuth);
    assert.equal(said.status, 201, said.text);
    assert.equal(of(await rows(), 'Scout').presence, null, 'a message clears its author\'s presence line');
    const profile = await post(runtime, '/api/profile', { line: 'BLUF, bullets' }, owner);
    assert.equal(profile.status, 200, profile.text);
    const grantState = async () => (await call(runtime, { path: '/api/grants', headers: { cookie: owner.cookie } }))
      .json.grants.find(item => item.holder_name === 'Scout').state;
    assert.equal(await grantState(), 'active', 'ARRANGEMENT: Scout holds an active grant');
    const left = await aiPost('/api/ai/leave', {}, scoutAuth);
    assert.equal(left.status, 200, left.text);
    assert.equal(await grantState(), 'ended', 'a grant ends when its holder leaves the room');

    const bad = await call(runtime, { path: '/api/ai/admissions', method: 'POST',
      body: Object.assign({}, knock, { request_id: crypto.randomUUID(), name: 'Bad', model: 'a\nb' }) });
    assert.deepEqual([bad.status, bad.json.error], [400, 'invalid-request'], 'a model with a line break is refused');
  } finally {
    await runtime.close();
  }
});
