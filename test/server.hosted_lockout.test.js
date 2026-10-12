'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');

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

test('hosted mode: three wrong setup codes end the process', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-lock-'));
  const runtime = await startInterlockServer({ port, dataDir, hostedOrigin: HOSTED });
  try {
    const realCode = runtime.setupCode;
    assert.equal(typeof realCode, 'string', 'ARRANGEMENT: a setup code is open');
    let settled = false;
    const ended = runtime.failure.then(error => { settled = true; return error; });
    for (let i = 0; i < 3; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, `ARRANGEMENT: still running before wrong code ${i + 1}`);
      const wrong = await post(runtime, '/api/bootstrap/redeem',
        { name: 'Mallory', password: 'correct horse battery staple', setup_code: 'BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BB' });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.error, 'setup-code-invalid');
    }
    const error = await ended;
    assert.equal(error.code, 'setup-code-exhausted');
    assert.equal(runtime.setupCode, null, 'the exhausted code is withdrawn');
    const late = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: 'correct horse battery staple', setup_code: realCode });
    assert.equal(late.status, 403, 'even the right code is refused once the window closed: ' + late.text);
  } finally {
    await runtime.close().catch(() => undefined);
  }
});
