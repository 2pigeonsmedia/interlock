'use strict';

// Step-up refusals over HTTP: what the page is told for each one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDevice } = require('../identity/test/step_up_fixture.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

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

function post(runtime, pathname, body, session) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: {
      origin: runtime.url, 'sec-fetch-site': 'same-origin',
      cookie: session.cookie, 'x-csrf-token': session.csrf,
    },
  });
}

function sessionFrom(response) {
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

const NONE = { cookie: '', csrf: '' };

async function bootstrap(runtime, device) {
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password: 'correct horse battery staple' }, NONE);
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = sessionFrom(redeemed);
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
}

async function login(runtime, name, password) {
  const signedIn = await post(runtime, '/api/login', { name, password }, NONE);
  assert.equal(signedIn.status, 200, signedIn.text);
  return sessionFrom(signedIn);
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return sessionFrom(finished);
}


const { STEP_UP_REFUSALS } = require('../identity/administration.js');
const { STEP_UP_PAGE, stepUpPageRefusal } = require('../src/first_owner.js');

// A step-up refusal reaches the page through ONE table. Only a missing or stale
// step-up asks the page for another passkey confirmation, and no refusal comes
// back as not-authorized (the page reads that as "this tab is out of date").

test('every identity step-up reason has its own page code, and only one asks for a passkey', () => {
  for (const reason of STEP_UP_REFUSALS) {
    assert.ok(Object.prototype.hasOwnProperty.call(STEP_UP_PAGE, reason), `${reason} is mapped by name`);
  }
  for (const reason of [...STEP_UP_REFUSALS, 'not-authorized', 'something-new', undefined, null]) {
    const [status, code] = stepUpPageRefusal(reason === undefined ? undefined : { ok: false, reason });
    assert.notEqual(code, 'not-authorized', `${reason} must not reach the page as not-authorized`);
    assert.equal(code === 'fresh-step-up-required', reason === 'fresh-step-up-required',
      `${reason} -> ${code}: only a missing or stale step-up asks for another`);
    assert.ok(Number.isSafeInteger(status) && status >= 400 && status < 500, `${reason} -> ${status}`);
  }
});

test('the host names the step-up word in one place only', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'first_owner.js'), 'utf8');
  const lines = host.split('\n').filter(line => line.includes("'fresh-step-up-required'"));
  assert.equal(lines.length, 1, 'every step-up route goes through the one table: ' + lines.join(' | '));
  assert.match(lines[0], /^\s*'fresh-step-up-required': Object\.freeze\(\[403, 'fresh-step-up-required'\]\),$/);
});

test('a spent step-up that removes nobody says so instead of asking for another passkey', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-step-up-refusals-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const ownerDevice = createDevice({ origin: runtime.url, rpId: 'localhost' });
    await bootstrap(runtime, ownerDevice);

    const plain = await login(runtime, 'Ana', 'correct horse battery staple');
    const unconfirmed = await post(runtime, '/api/participants/revoke', { name: 'Nobody' }, plain);
    assert.equal(unconfirmed.status, 403, unconfirmed.text);
    assert.equal(unconfirmed.json.error, 'fresh-step-up-required', 'no step-up yet: ask for one');

    const elevated = await elevate(runtime, await login(runtime, 'Ana', 'correct horse battery staple'), ownerDevice);
    const spent = await post(runtime, '/api/participants/revoke', { name: 'Nobody' }, elevated);
    assert.equal(spent.status, 403, spent.text);
    assert.equal(spent.json.error, 'refused-after-step-up',
      'the step-up was spent and nobody was removed; another passkey would not help');

    const cleared = await post(runtime, '/api/transcript/clear', {}, elevated);
    assert.equal(cleared.status, 403, cleared.text);
    assert.equal(cleared.json.error, 'fresh-step-up-required', 'ARRANGEMENT: that step-up is used up');
  } finally {
    await runtime.close();
  }
});
