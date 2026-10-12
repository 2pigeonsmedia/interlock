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

// One identity binding per process: this file starts ONE hosted data directory.
// The throttle halves each live in their own file for the same reason.

test('hosted mode: refusals happen at construction, before any directory is created', async () => {
  const port = await reservePort();
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-refuse-')), 'data');
  assert.equal(fs.existsSync(dataDir), false, 'ARRANGEMENT: the data directory does not exist yet');
  for (const bad of ['http://app.example.test', 'https://app.example.test/', 'https://localhost', 42]) {
    await assert.rejects(startInterlockServer({ port, dataDir, hostedOrigin: bad }),
      /interlock: --hosted-origin/, String(bad));
  }
  await assert.rejects(startInterlockServer({ port, dataDir, onWrongSetupCode: () => undefined }),
    /onWrongSetupCode is accepted only with hostedOrigin/, 'loopback mode refuses the callback');
  await assert.rejects(startInterlockServer({ port, dataDir, hostedOrigin: HOSTED, onWrongSetupCode: 'print' }),
    /onWrongSetupCode must be a function/);
  assert.equal(fs.existsSync(dataDir), false, 'no data directory was created by a refused start');
});

test('hosted mode: Host is pinned to the hosted origin, the setup code gates first-owner setup, /health says nothing', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-'));
  const wrongCounts = [];
  const runtime = await startInterlockServer({
    port, dataDir, hostedOrigin: HOSTED, onWrongSetupCode: count => { wrongCounts.push(count); },
  });
  try {
    // ARRANGEMENT: the runtime reports hosted mode and a setup code.
    assert.deepEqual(runtime.hosted, { origin: HOSTED, host: HOST, hostname: HOST });
    assert.equal(runtime.url, HOSTED);
    assert.match(runtime.setupCode, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
    assert.equal(runtime.address, '127.0.0.1', 'still binds loopback');

    const wrongHost = await call(runtime, { path: '/health', headers: { host: `localhost:${port}` } });
    assert.equal(wrongHost.status, 421);
    assert.equal(wrongHost.json.canonical_url, HOSTED);

    const health = await call(runtime, { path: '/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, service: 'interlock', scope: 'process' },
      'no bootstrap state through the front');

    const status = await call(runtime, { path: '/api/bootstrap/status' });
    assert.equal(status.status, 200, 'the setup page still works through the front');
    assert.equal(status.json.state, 'empty');
    assert.equal(status.json.hosted, true, 'the setup page learns to ask for the setup code');

    // A forged POST without the setup code must not claim the room.
    const forged = await post(runtime, '/api/bootstrap/redeem', { name: 'Mallory', password: 'correct horse battery staple' });
    assert.equal(forged.status, 403, forged.text);
    assert.equal(forged.json.error, 'setup-code-required');
    assert.equal(forged.headers['set-cookie'], undefined);

    // A wrong code costs one second and never ends the process or closes the door.
    const WRONG = 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA';
    const wrongRedeem = () => post(runtime, '/api/bootstrap/redeem',
      { name: 'Mallory', password: 'correct horse battery staple', setup_code: WRONG });
    assert.deepEqual(wrongCounts, [], 'ARRANGEMENT: no wrong code yet');
    const sequentialStart = performance.now();
    for (let i = 0; i < 5; i += 1) {
      const wrongCode = await wrongRedeem();
      assert.equal(wrongCode.status, 403, wrongCode.text);
      assert.equal(wrongCode.json.error, 'setup-code-invalid');
      assert.equal(wrongCode.headers['set-cookie'], undefined);
    }
    const sequentialMs = performance.now() - sequentialStart;
    assert.ok(sequentialMs >= 5_000, `five wrong codes cost at least five seconds (${Math.round(sequentialMs)} ms)`);
    assert.deepEqual(wrongCounts, [1, 2, 3, 4, 5], 'the host sees each wrong code with its running count');

    const shortPassword = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'short', setup_code: runtime.setupCode });
    assert.equal(shortPassword.status, 400, shortPassword.text);
    assert.equal(shortPassword.json.error, 'password-too-short');

    // Twelve wrong codes in flight at once: ten take slots one second apart,
    // the rest would wait more than ten seconds and are answered at once as busy.
    // One burst covers both "the queue is bounded" and "the correct code is not
    // delayed by a busy queue": the correct code can redeem only once per room.
    const burstStart = performance.now();
    const burst = Array.from({ length: 12 }, () => wrongRedeem()
      .then(response => ({ response, ms: performance.now() - burstStart })));
    const waitStart = performance.now();
    while (wrongCounts.length < 17 && performance.now() - waitStart < 5_000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(wrongCounts.length, 17, 'ARRANGEMENT: all twelve wrong codes reached the server; the queue is busy');

    const stillServing = await call(runtime, { path: '/health' });
    assert.equal(stillServing.status, 200, 'wrong codes never stop the server');
    assert.equal(typeof runtime.setupCode, 'string', 'wrong codes never withdraw the setup code');

    const correctStart = performance.now();
    const redeemed = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'correct horse battery staple', setup_code: runtime.setupCode.toLowerCase() });
    const correctMs = performance.now() - correctStart;
    assert.equal(redeemed.status, 200, redeemed.text);
    assert.ok(correctMs < 1_000, `the correct code never waits behind wrong ones (${Math.round(correctMs)} ms)`);

    const answered = await Promise.all(burst);
    const busy = answered.filter(item => item.response.status === 429);
    const queued = answered.filter(item => item.response.status === 403);
    assert.equal(busy.length + queued.length, 12, answered.map(item => item.response.status).join(','));
    assert.ok(busy.length >= 1, 'beyond the cap a wrong code is answered as busy');
    for (const item of busy) {
      assert.equal(item.response.json.error, 'setup-code-busy');
      assert.match(item.response.headers['retry-after'], /^[1-9][0-9]*$/);
      assert.ok(item.ms < 1_000, `a busy answer comes at once (${Math.round(item.ms)} ms)`);
    }
    for (const item of queued) assert.equal(item.response.json.error, 'setup-code-invalid');
    const lastQueuedMs = Math.max(...queued.map(item => item.ms));
    assert.ok(lastQueuedMs >= (queued.length - 1) * 1_000,
      `queued wrong codes are answered one second apart (${queued.length} took ${Math.round(lastQueuedMs)} ms)`);
    assert.deepEqual(wrongCounts, Array.from({ length: 17 }, (_, i) => i + 1),
      'the running count increases by one for every wrong code, busy ones included');

    const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    assert.match(redeemed.headers['set-cookie'][0], /^__Host-/, 'the cookie is the __Host- cookie');

    // The resume path (setup in progress) signs in with name + password only.
    const inProgress = await call(runtime, { path: '/api/bootstrap/status' });
    assert.equal(inProgress.json.state, 'in-progress', 'ARRANGEMENT: setup is in progress');
    const resumed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' });
    assert.equal(resumed.status, 200, resumed.text);
    session.cookie = resumed.headers['set-cookie'][0].split(';', 1)[0];
    session.csrf = resumed.json.csrf_token;

    // Passkeys bind to the exact hostname.
    const device = createDevice({ origin: HOSTED, rpId: HOST });
    const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
    assert.equal(registration.status, 200, registration.text);
    assert.equal(registration.json.options.rp.id, HOST, 'rpId is the hosted hostname');
    const registered = await post(runtime, '/api/bootstrap/registration/finish', {
      ceremony_id: registration.json.ceremony_id,
      response: device.registration(registration.json.options.challenge),
    }, session);
    assert.equal(registered.status, 200, registered.text);
    const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
    assert.equal(elevation.status, 200, elevation.text);
    assert.notEqual(runtime.setupCode, null, 'ARRANGEMENT: the code is held until setup completes');
    const completed = await post(runtime, '/api/bootstrap/complete', {
      ceremony_id: elevation.json.ceremony_id,
      response: device.assertion(elevation.json.options.challenge),
    }, session);
    assert.equal(completed.status, 200, completed.text);

    assert.equal(runtime.setupCode, null, 'the runtime forgets the code once setup completes');
    const after = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Mallory', password: 'correct horse battery staple', setup_code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA' });
    assert.equal(after.status, 409, 'setup is complete; the code is spent');
    assert.equal(after.json.error, 'setup-complete');

    // Password changes through the front carry the same floor.
    const signedIn = await post(runtime, '/api/login', { name: 'Ana', password: 'correct horse battery staple' });
    assert.equal(signedIn.status, 200, signedIn.text);
    const owner = { cookie: signedIn.headers['set-cookie'][0].split(';', 1)[0], csrf: signedIn.json.csrf_token };
    const weakChange = await post(runtime, '/api/owner/password',
      { current_password: 'correct horse battery staple', new_password: 'short' }, owner);
    assert.equal(weakChange.status, 400, weakChange.text);
    assert.equal(weakChange.json.error, 'password-too-short');
  } finally {
    await runtime.close();
  }
});
