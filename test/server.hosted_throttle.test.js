'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const HOSTED = 'https://app.example.test';
const HOST = 'app.example.test';

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: HOST }, options.headers);
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
    const request = http.request({
      host: runtime.address, port: runtime.port, path: options.path || '/',
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

function post(runtime, pathName, body, session = {}, extraHeaders = {}) {
  const headers = Object.assign({ origin: HOSTED, 'sec-fetch-site': 'same-origin' }, extraHeaders);
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: pathName, method: 'POST', body, headers });
}

// The sign-in route answers every failure the same way (401 sign-in-failed),
// throttled or not: the identity module never says "throttled". What the
// throttle does is make the caller wait. The source dimension is isolated by
// giving every attempt its own account name, so the account dimension never
// reaches its threshold. With 5 free failures and a 200 ms base doubling per
// failure, the 10th attempt from one source waits 200 * 2^4 = 3200 ms.
const THROTTLED_FLOOR_MS = 3_150;

async function timedLogin(runtime, name, ip) {
  const started = performance.now();
  const response = await post(runtime, '/api/login', { name, password: 'wrong-password' }, {},
    { 'cf-connecting-ip': ip });
  return { response, ms: performance.now() - started };
}

test('hosted mode: the sign-in throttle keys on CF-Connecting-IP', async () => {
  // Both modes in ONE process is impossible (one identity binding per process), so this file
  // proves the hosted half; test/server.loopback_source.test.js proves the loopback half.
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-throttle-'));
  const runtime = await startInterlockServer({ port, dataDir, hostedOrigin: HOSTED });
  try {
    const setup = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'correct horse battery staple', setup_code: runtime.setupCode });
    assert.equal(setup.status, 200, setup.text);
    const session = { cookie: setup.headers['set-cookie'][0].split(';', 1)[0], csrf: setup.json.csrf_token };
    const device = createDevice({ origin: HOSTED, rpId: HOST });
    const reg = await post(runtime, '/api/bootstrap/registration/options', {}, session);
    await post(runtime, '/api/bootstrap/registration/finish',
      { ceremony_id: reg.json.ceremony_id, response: device.registration(reg.json.options.challenge) }, session);
    const elev = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
    const done = await post(runtime, '/api/bootstrap/complete',
      { ceremony_id: elev.json.ceremony_id, response: device.assertion(elev.json.options.challenge) }, session);
    assert.equal(done.status, 200, 'ARRANGEMENT: setup complete');

    for (let i = 0; i < 9; i += 1) {
      const { response } = await timedLogin(runtime, 'stranger-' + i, '203.0.113.9');
      assert.equal(response.status, 401, response.text);
    }
    const same = await timedLogin(runtime, 'stranger-probe-a', '203.0.113.9');
    assert.equal(same.response.status, 401, same.response.text);
    assert.ok(same.ms >= THROTTLED_FLOOR_MS,
      `ARRANGEMENT: the tenth failure from one client address waits (${Math.round(same.ms)} ms)`);

    const other = await timedLogin(runtime, 'stranger-probe-b', '198.51.100.7');
    assert.equal(other.response.status, 401, other.response.text);
    assert.ok(other.ms < THROTTLED_FLOOR_MS,
      `a different client address is not throttled by the first one (${Math.round(other.ms)} ms)`);
  } finally {
    await runtime.close();
  }
});
