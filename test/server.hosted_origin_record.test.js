'use strict';

// A hosted data directory records its origin. This file sets up its own room
// (one identity binding per process), so what a restart finds does not depend
// on any other test having finished its setup.

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

// A start that must be refused. If it starts anyway, the runtime is closed
// before the failure is reported, so a failing check ends the run as a
// failure instead of leaving a listener that keeps the process alive.
async function assertStartRefused(options, expected, message) {
  let started = null;
  try {
    await assert.rejects(async () => { started = await startInterlockServer(options); }, expected, message);
  } finally {
    if (started !== null) await started.close();
  }
}

// A hosted room with its first owner set up, closed again; returns its directory.
async function setUpHostedRoom() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-origin-'));
  const runtime = await startInterlockServer({ port: await reservePort(), dataDir, hostedOrigin: HOSTED });
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
    assert.equal(done.status, 200, 'ARRANGEMENT: setup complete: ' + done.text);
    assert.equal(runtime.setupCode, null, 'ARRANGEMENT: the room has its owner');
  } finally {
    await runtime.close();
  }
  return dataDir;
}

test('hosted mode: the data directory remembers its origin; a loopback or other-origin start is refused', async () => {
  const hostedDataDir = await setUpHostedRoom();
  const recordPath = path.join(hostedDataDir, 'origin.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')).origin, HOSTED,
    'ARRANGEMENT: the first hosted start recorded the hosted origin');
  if (process.platform !== 'win32') assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600, 'the record is private');

  const again = await startInterlockServer({ port: await reservePort(), dataDir: hostedDataDir, hostedOrigin: HOSTED });
  try {
    assert.equal(again.url, HOSTED, 'a restart at the same origin is allowed');
    assert.equal(again.setupCode, null, 'and finds the owner it already has');
  } finally {
    await again.close();
  }

  const recorded = fs.readFileSync(recordPath, 'utf8');
  for (const other of [{}, { hostedOrigin: 'https://other.example.test' }]) {
    await assertStartRefused(Object.assign({ port: await reservePort(), dataDir: hostedDataDir }, other),
      error => {
        assert.equal(error.code, 'origin-mismatch', error.message);
        assert.ok(error.message.includes(HOSTED), error.message);
        assert.ok(error.message.includes(other.hostedOrigin || 'http://localhost:'), error.message);
        assert.ok(error.message.includes('UPGRADE.md'), error.message);
        return true;
      }, JSON.stringify(other));
  }
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recorded, 'refused starts leave the record alone');
});
