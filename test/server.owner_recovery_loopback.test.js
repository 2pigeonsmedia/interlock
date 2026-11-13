'use strict';

// Hosted owner recovery exists only on a hosted room. A loopback room keeps
// today's `interlock recover`, and its normal server exposes no code route,
// page or link.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startInterlockServer } = require('../src/server.js');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { reserveTestPort } = require('./helpers/reserve_port.js');

function call(runtime, route, method = 'GET', body, session = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: `localhost:${runtime.port}` };
    if (session.cookie) headers.cookie = session.cookie;
    if (session.csrf) headers['x-csrf-token'] = session.csrf;
    if (payload) {
      Object.assign(headers, { origin: runtime.url, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'content-length': payload.length });
    }
    const request = http.request({ agent: false, host: runtime.address, port: runtime.port,
      path: route, method, headers }, response => {
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
    request.end(payload);
  });
}

test('a loopback room has no owner-recovery code route, page or link', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-loopback-no-code-'));
  const runtime = await startInterlockServer({ port: await reserveTestPort(), dataDir });
  try {
    // A completed room, so the room's own pages are the ones being served.
    const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
    const redeemed = await call(runtime, '/api/bootstrap/redeem', 'POST',
      { name: 'Ana', password: 'correct horse battery staple' });
    assert.equal(redeemed.status, 200, redeemed.text);
    const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    const reg = await call(runtime, '/api/bootstrap/registration/options', 'POST', {}, session);
    await call(runtime, '/api/bootstrap/registration/finish', 'POST', { ceremony_id: reg.json.ceremony_id,
      response: device.registration(reg.json.options.challenge) }, session);
    const elev = await call(runtime, '/api/bootstrap/elevation/options', 'POST', {}, session);
    const done = await call(runtime, '/api/bootstrap/complete', 'POST', { ceremony_id: elev.json.ceremony_id,
      response: device.assertion(elev.json.options.challenge) }, session);
    assert.equal(done.status, 200, 'ARRANGEMENT: setup complete ' + done.text);

    for (const route of ['/api/owner-recovery/options', '/api/owner-recovery/complete']) {
      const response = await call(runtime, route, 'POST', { code: 'x', new_password: 'y' });
      assert.equal(response.status, 404, route + ' ' + response.text);
    }
    const page = await call(runtime, '/recover-owner');
    assert.equal(page.status, 404, page.text);
    const signIn = await call(runtime, '/');
    assert.equal(signIn.status, 200, 'ARRANGEMENT: the sign-in page is served');
    assert.doesNotMatch(signIn.text, /recover-owner/);
  } finally {
    await runtime.close();
  }
});
