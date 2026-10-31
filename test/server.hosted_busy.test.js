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

// One /48 can have at most 16 password checks in flight; a parallel burst past
// that is refused for capacity, and the host is told how many, so an operator
// can tell a capacity flood from wrong passwords.
test('hosted mode: sign-ins refused because every check is busy are reported to the host', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-busy-'));
  const reported = [];
  const runtime = await startInterlockServer({
    port, dataDir, hostedOrigin: HOSTED, onSignInBusy: count => { reported.push(count); },
  });
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
    assert.deepEqual(reported, [], 'ARRANGEMENT: nothing reported before the burst');

    const burst = [];
    for (let i = 0; i < 40; i += 1) {
      burst.push(post(runtime, '/api/login', { name: `burst-${i}`, password: 'wrong-password' }, {},
        { 'cf-connecting-ip': `2001:db8:1:${i.toString(16)}::1` }));
    }
    const answers = await Promise.all(burst);
    assert.ok(answers.every(answer => answer.status === 401), answers.map(answer => answer.status).join(','));
    assert.ok(reported.length > 0, 'ARRANGEMENT: the burst passed the block cap and the host heard of it');
    assert.ok(reported.every((count, i) => i === 0 || count > reported[i - 1]), 'each report carries a larger count');
    assert.ok(reported[reported.length - 1] >= 40 - 16,
      `at least the attempts past the cap were counted (${reported[reported.length - 1]})`);
  } finally {
    await runtime.close();
  }
});
