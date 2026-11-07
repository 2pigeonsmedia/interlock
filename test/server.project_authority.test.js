'use strict';

// Who may change a project's objective and today line, through the real
// routes: an administrator, the first owner, or that project's live lead.
// Nobody changes a retired project.

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

async function item(runtime, owner, id) {
  const read = await get(runtime, `/api/work/items/${id}`, owner);
  assert.equal(read.status, 200, read.text);
  return read.json.item;
}

test('a project narrative changes only by an admin, the first owner or its lead, and never once retired', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-project-authority-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await elevate(runtime, await login(runtime, password), device);
    const quill = await admitSeat(runtime, owner, 'Quill');
    owner = await elevate(runtime, owner, device);
    const lead = await admitSeat(runtime, owner, 'Lead');
    const grant = await post(runtime, '/api/grants/create',
      { holder_name: 'Lead', holder_kind: 'seat', project: 'ops', scope: 'leads ops', until: null },
      await elevate(runtime, await login(runtime, password), device));
    assert.equal(grant.status, 201, 'ARRANGEMENT: Lead leads ops: ' + grant.text);
    const books = await post(runtime, '/api/work/projects/create', { operation_id: uuid(), id: 'books', display_name: 'Books' },
      await elevate(runtime, await login(runtime, password), device));
    assert.equal(books.status, 201, 'ARRANGEMENT: books has no lead: ' + books.text);
    const ana = await login(runtime, password);
    const revision = async id => (await get(runtime, `/api/work/brief?project=${id}`, ana)).json.projects.find(p => p.id === id).revision;
    const asAi = async (token, id, today) => aiPost(runtime, '/api/ai/work/projects/update',
      { operation_id: uuid(), id, expected_revision: await revision(id), today }, token);

    const stranger = await asAi(quill.token, 'ops', 'an AI with no grant');
    assert.equal(stranger.status, 403, stranger.text);
    assert.equal(stranger.json.error, 'not-lead');
    const elsewhere = await asAi(lead.token, 'books', 'not my project');
    assert.equal(elsewhere.status, 403, elsewhere.text);
    assert.equal(elsewhere.json.error, 'not-lead');
    const mine = await asAi(lead.token, 'ops', 'the lead says so');
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.json.project.today, 'the lead says so');
    const byOwner = await post(runtime, '/api/work/projects/update',
      { operation_id: uuid(), id: 'books', expected_revision: await revision('books'), today: 'the owner says so' }, ana);
    assert.equal(byOwner.status, 200, byOwner.text);

    const retired = await post(runtime, '/api/work/projects/retire', { operation_id: uuid(), id: 'books' },
      await elevate(runtime, await login(runtime, password), device));
    assert.equal(retired.status, 200, 'ARRANGEMENT: books is retired: ' + retired.text);
    const late = await post(runtime, '/api/work/projects/update',
      { operation_id: uuid(), id: 'books', expected_revision: await revision('books'), today: 'after retire' }, ana);
    assert.equal(late.status, 409, late.text);
    assert.equal(late.json.error, 'project-retired');
    assert.equal((await get(runtime, '/api/work/brief', ana)).json.projects.find(p => p.id === 'ops').today, 'the lead says so',
      'only the allowed writes landed');
  } finally {
    await runtime.close();
  }
});
