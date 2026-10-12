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
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
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
  const headers = Object.assign({ origin: runtime.url, 'sec-fetch-site': 'same-origin' }, extraHeaders);
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: pathName, method: 'POST', body, headers });
}
// Loopback half of the sign-in source rule: without --hosted-origin the
// CF-Connecting-IP header is ignored and every request is keyed on the socket.
// See test/server.hosted_throttle.test.js for the arithmetic and the hosted half.
const THROTTLED_FLOOR_MS = 3_150;

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = {
    cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0],
    csrf: redeemed.json.csrf_token,
  };
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
}

async function timedLogin(runtime, name, ip) {
  const started = performance.now();
  const response = await post(runtime, '/api/login', { name, password: 'wrong-password' }, {},
    { 'cf-connecting-ip': ip });
  return { response, ms: performance.now() - started };
}

test('loopback mode: the sign-in throttle ignores CF-Connecting-IP and keys on the socket', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-loopback-source-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    assert.equal(runtime.hosted, null, 'ARRANGEMENT: loopback mode');
    assert.equal(runtime.setupCode, null, 'ARRANGEMENT: loopback mode has no setup code');
    await bootstrap(runtime);

    const first = await timedLogin(runtime, 'stranger-0', '203.0.113.9');
    assert.equal(first.response.status, 401, first.response.text);
    assert.ok(first.ms < THROTTLED_FLOOR_MS, `ARRANGEMENT: an early failure is not delayed (${Math.round(first.ms)} ms)`);
    for (let i = 1; i < 9; i += 1) {
      const { response } = await timedLogin(runtime, 'stranger-' + i, '203.0.113.9');
      assert.equal(response.status, 401, response.text);
    }
    const other = await timedLogin(runtime, 'stranger-probe-b', '198.51.100.7');
    assert.equal(other.response.status, 401, other.response.text);
    assert.ok(other.ms >= THROTTLED_FLOOR_MS,
      `a different CF-Connecting-IP is the same source in loopback mode (${Math.round(other.ms)} ms)`);
  } finally {
    await runtime.close();
  }
});
