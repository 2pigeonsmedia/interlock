'use strict';

// A real room for a server test: start it, set up its owner, sign in, step
// up, admit an AI seat and invite a member. The same steps the server tests
// each write out; gathered here for the webhook and doorbell tests.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const identity = require('identity');
const { createDevice } = require('../../identity/test/step_up_fixture.js');
const { startInterlockServer } = require('../../src/server.js');
const { reserveTestPort } = require('./reserve_port.js');

const PASSWORD = 'correct horse battery staple';

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
    request.once('error', reject);
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

function get(runtime, pathname, session = {}) {
  return call(runtime, { path: pathname, headers: session.cookie ? { cookie: session.cookie } : {} });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: { authorization: `Bearer ${token}` } });
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: { authorization: `Bearer ${token}` } });
}

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function bootstrap(runtime) {
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: PASSWORD });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = sessionFrom(redeemed);
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
  return device;
}

async function login(runtime, name = 'Ana', password = PASSWORD) {
  const response = await post(runtime, '/api/login', { name, password });
  assert.equal(response.status, 200, response.text);
  return sessionFrom(response);
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

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('the knock did not become visibly connected');
}

// The owner session must hold a fresh step-up.
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

// A member (no admin role). The owner session must hold a fresh step-up.
async function inviteMember(runtime, owner, name, password) {
  const invitation = await post(runtime, '/api/invitations', {}, owner);
  assert.equal(invitation.status, 200, invitation.text);
  const redeemed = await post(runtime, '/api/invitations/redeem',
    { secret: invitation.json.invite_code, name, password }, {});
  assert.equal(redeemed.status, 200, redeemed.text);
  return login(runtime, name, password);
}

async function startRoom(prefix = 'interlock-room-') {
  const port = await reserveTestPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = await startInterlockServer({ port, dataDir });
  return { runtime, dataDir };
}

module.exports = {
  PASSWORD, admitSeat, aiGet, aiPost, bootstrap, call, elevate, get, inviteMember, login, post, startRoom,
};
