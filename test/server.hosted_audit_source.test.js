'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const audit = require('../identity/audit.js');
const { startInterlockServer } = require('../src/server.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const HOSTED = 'https://app.example.test';
const HOST = 'app.example.test';
const SPOOFED = Object.freeze({
  'x-forwarded-for': '6.6.6.6',
  'true-client-ip': '7.7.7.7',
  'x-real-ip': '8.8.8.8',
});

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

function allFileText(root) {
  const chunks = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) chunks.push(allFileText(full));
    else if (entry.isFile()) chunks.push(fs.readFileSync(full).toString('utf8'));
  }
  return chunks.join('\n');
}

test('hosted mode: deny rows record the CF-Connecting-IP source, never a forwarding header', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-audit-source-'));
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

    await audit.drain();
    const before = audit.read('authn_deny', { limit: 1000 }).length;

    const failed = await post(runtime, '/api/login', { name: 'Ana', password: 'wrong-password' }, {},
      Object.assign({ 'cf-connecting-ip': '198.51.100.23' }, SPOOFED));
    assert.equal(failed.status, 401, 'ARRANGEMENT: the sign-in fails');
    const junk = await call(runtime, {
      path: '/api/ai/session',
      headers: Object.assign({
        authorization: 'Bearer not-a-real-credential',
        'cf-connecting-ip': '2001:db8:aa:bb:1:2:3:4',
      }, SPOOFED),
    });
    assert.equal(junk.status, 401, 'ARRANGEMENT: the bearer is refused');

    await audit.drain();
    const rows = audit.read('authn_deny', { limit: 1000 }).slice(before);
    const password = rows.filter(row => row.scheme === 'password');
    const bearer = rows.filter(row => row.reason === 'credential-rejected');
    assert.equal(password.length, 1, 'ARRANGEMENT: one failed password row');
    assert.equal(bearer.length, 1, 'ARRANGEMENT: one rejected bearer row');
    assert.equal(password[0].source, '198.51.100.23');
    assert.equal(bearer[0].source, '2001:db8:aa:bb::/64', 'an IPv6 source is recorded by its /64');

    const stored = allFileText(path.join(dataDir, 'identity'));
    assert.ok(stored.includes('198.51.100.23'), 'the scan can see a recorded source (known positive for the checks below)');
    for (const spoof of Object.values(SPOOFED)) {
      assert.equal(stored.includes(spoof), false, `${spoof} is recorded nowhere`);
    }
  } finally {
    await runtime.close();
  }
});
