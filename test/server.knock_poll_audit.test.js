'use strict';

// An AI waiting for the owner's Allow checks its candidate credential between
// knocks. Until the owner answers, that check is waiting, not a failed sign-in:
// it must not fill the deny stream that operators watch for stolen credentials.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const audit = require('../identity/audit.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

const POLLS = 6;

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

function post(runtime, pathname, body, session = null) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: session ? {
      origin: runtime.url, 'sec-fetch-site': 'same-origin',
      cookie: session.cookie, 'x-csrf-token': session.csrf,
    } : {},
  });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password },
    { cookie: '', csrf: '' });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = {
    cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token,
  };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
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
  const signedIn = await post(runtime, '/api/login', { name: 'Ana', password }, { cookie: '', csrf: '' });
  assert.equal(signedIn.status, 200, signedIn.text);
  return {
    device,
    owner: { cookie: signedIn.headers['set-cookie'][0].split(';', 1)[0], csrf: signedIn.json.csrf_token },
  };
}

async function waitForPending(runtime, owner, requestId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('ARRANGEMENT: the knock never became pending');
}

async function denyRowCount() {
  await audit.drain();
  return audit.read('authn_deny', { limit: 1000 }).length;
}

function session(runtime, token) {
  return call(runtime, { path: '/api/ai/session', headers: { authorization: `Bearer ${token}` } });
}

test('a pending knock checking its candidate credential writes no deny rows; strangers still do', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-knock-poll-audit-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { owner } = await bootstrap(runtime);
    const candidate = identity.newAiCredential();
    const body = {
      request_id: crypto.randomUUID(), name: 'Marlow', product: 'Claude Code',
      product_provenance: 'client-reported', selector: candidate.selector, digest: candidate.digest,
    };
    const knocking = post(runtime, '/api/ai/admissions', body);
    await waitForPending(runtime, owner, body.request_id);

    const beforePolls = await denyRowCount();
    for (let i = 0; i < POLLS; i += 1) {
      const polled = await session(runtime, candidate.token);
      assert.equal(polled.status, 401, 'the waiting candidate is still not connected');
      assert.deepEqual(polled.json, { ok: false, error: 'invalid-connection' },
        'and gets the same answer as before, so waiting clients behave the same');
    }
    const afterPolls = await denyRowCount();
    assert.ok(afterPolls - beforePolls <= 1,
      `${POLLS} polls by a waiting candidate wrote ${afterPolls - beforePolls} deny rows`);

    // Controls: only the holder of the pending candidate's secret is quiet.
    const wrongSecret = `${candidate.selector}.${crypto.randomBytes(32).toString('base64url')}`;
    for (const token of ['not-a-real-credential', wrongSecret, identity.newAiCredential().token]) {
      const before = await denyRowCount();
      const refused = await session(runtime, token);
      assert.equal(refused.status, 401);
      assert.equal(await denyRowCount() - before, 1, 'a bearer that is not a pending candidate is still a deny row');
    }

    const declined = await post(runtime, `/api/ai/admissions/${body.request_id}/decline`, {}, owner);
    assert.equal(declined.status, 200, declined.text);
    assert.equal((await knocking).json.state, 'declined', 'ARRANGEMENT: the knock is answered');
    const beforeLate = await denyRowCount();
    const late = await session(runtime, candidate.token);
    assert.equal(late.status, 401);
    assert.equal(await denyRowCount() - beforeLate, 1,
      'once the knock is answered, the same credential is an ordinary deny again');
  } finally {
    await runtime.close();
  }
});
