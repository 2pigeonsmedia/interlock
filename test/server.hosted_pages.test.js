'use strict';

// Hosted mode: the room, setup and Help pages are served with the hosted
// wording already in the HTML, so a reader that does not run scripts (an AI's
// web fetch tool, for example) learns the room's address and the exact join
// command instead of being told the room is "on this computer".

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
const JOIN = `interlock join --url ${HOSTED}`;
const PASSWORD = 'correct horse battery staple';

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
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, text, json });
      });
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathName, body, session = {}) {
  const headers = { origin: HOSTED, 'sec-fetch-site': 'same-origin' };
  if (session.cookie) headers.cookie = session.cookie;
  if (session.csrf) headers['x-csrf-token'] = session.csrf;
  return call(runtime, { path: pathName, method: 'POST', body, headers });
}

// What a script-less reader sees: the page text with tags removed.
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function assertPageHeaders(page, label) {
  assert.equal(page.status, 200, label + ': ' + page.text.slice(0, 200));
  assert.match(page.headers['content-type'], /^text\/html; charset=utf-8$/, label);
  assert.equal(Number(page.headers['content-length']), page.raw.length, label + ': content-length matches the rendered body');
  assert.equal(page.headers['cache-control'], 'no-store', label);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/, label);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/, label);
  assert.doesNotMatch(page.text, /<script[^>]*>\s*[^<]/, label + ': no inline script');
}

function assertNoLoopbackWording(text, label) {
  for (const phrase of ['only on this computer', 'on this computer', 'Local:']) {
    assert.ok(!text.includes(phrase), `${label} must not say "${phrase}"`);
  }
}

// Headers a proxy or a client could send. None may reach a page.
const FOREIGN_HEADERS = Object.freeze({
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'http',
  forwarded: 'host=evil.example;proto=http',
  origin: 'https://evil.example',
  referer: 'https://evil.example/',
});

test('hosted mode serves the setup, room, Help, History and Source pages with hosted wording in the HTML', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-hosted-pages-'));
  const runtime = await startInterlockServer({ port, dataDir, hostedOrigin: HOSTED });
  try {
    assert.equal(runtime.url, HOSTED, 'ARRANGEMENT: the runtime is hosted');

    // Setup page, before any owner exists.
    const setup = await call(runtime);
    assertPageHeaders(setup, 'setup page');
    assert.match(setup.text, /Set up your room/, 'ARRANGEMENT: GET / is the setup page');
    const setupText = visibleText(setup.text);
    assertNoLoopbackWording(setupText, 'the hosted setup page');
    assert.ok(setupText.includes(`This room is reachable at ${HOSTED}; keep the setup code private.`), setupText);
    assert.ok(setupText.includes('A hosted room has no owner recovery yet: keep your password and a backup of the data directory.'), setupText);
    const setupSource = await call(runtime, { path: '/source' });
    assertPageHeaders(setupSource, 'setup-time source page');
    assertNoLoopbackWording(visibleText(setupSource.text), 'the setup-time source page');
    assert.match(setupSource.text, />Hosted: checking…</);

    // First-owner setup through the front.
    const redeemed = await post(runtime, '/api/bootstrap/redeem',
      { name: 'Ana', password: PASSWORD, setup_code: runtime.setupCode });
    assert.equal(redeemed.status, 200, redeemed.text);
    const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
    const device = createDevice({ origin: HOSTED, rpId: HOST });
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

    // Room page, signed out: what an AI's web fetch reads.
    const room = await call(runtime);
    assertPageHeaders(room, 'room page');
    assert.match(room.text, /Open your room/, 'ARRANGEMENT: GET / is the room page');
    const roomText = visibleText(room.text);
    assertNoLoopbackWording(roomText, 'the hosted room page');
    assert.ok(roomText.includes(`Do not sign in here. Run ${JOIN} in a terminal on any machine with Interlock installed.`), roomText);
    assert.ok(roomText.includes(`This room is reachable at ${HOSTED}.`), roomText);
    assert.ok(roomText.includes(`Run ${JOIN} , choose a name and join the chatroom.`), roomText);
    assert.ok(roomText.includes('The AI runs that in a terminal on any machine with Interlock installed, then knocks here'), roomText);
    assert.ok(roomText.includes('A hosted room has no owner recovery yet: keep your password and a backup of the data directory.'), roomText);
    assert.match(room.text, /<a href="\/help">Help<\/a> covers installing it\./);
    assert.match(room.text, />Hosted: checking…</);
    assert.equal(room.text.split(`<code data-interlock-join-command>${JOIN}</code>`).length, 3,
      'both join commands carry the full --url in the HTML');

    // HEAD answers with the same length.
    const head = await call(runtime, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), room.raw.length);

    // Help: a hosted note at the top, before the guide's own text.
    const help = await call(runtime, { path: '/help' });
    assertPageHeaders(help, 'Help page');
    assert.match(help.text, />Hosted: checking…</);
    assert.ok(!help.text.includes('Local: checking'), 'the Help badge is hosted');
    const helpText = visibleText(help.text);
    const note = helpText.indexOf(`This room is hosted at ${HOSTED}.`);
    assert.ok(note !== -1, helpText.slice(0, 2000));
    assert.ok(helpText.includes(JOIN), 'the Help page gives the exact join command');
    assert.ok(note < helpText.indexOf('The Interlock Guide'), 'the hosted note comes before the guide');
    assert.ok(helpText.slice(note, helpText.indexOf('The Interlock Guide')).includes('http://localhost:8788'),
      'the note tells the reader to use this address instead of the localhost examples');

    // History, signed in.
    const signedIn = await post(runtime, '/api/login', { name: 'Ana', password: PASSWORD });
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = signedIn.headers['set-cookie'][0].split(';', 1)[0];
    const history = await call(runtime, { path: '/history', headers: { cookie } });
    assertPageHeaders(history, 'History page');
    assertNoLoopbackWording(visibleText(history.text), 'the hosted History page');
    const source = await call(runtime, { path: '/source' });
    assertPageHeaders(source, 'Source page');
    assertNoLoopbackWording(visibleText(source.text), 'the hosted Source page');

    // No request header reaches a page: foreign forwarding and origin headers
    // change nothing, byte for byte.
    for (const [pathName, plain, extra] of [
      ['/', room, {}], ['/help', help, {}], ['/source', source, {}], ['/history', history, { cookie }],
    ]) {
      const probed = await call(runtime, { path: pathName, headers: Object.assign({}, FOREIGN_HEADERS, extra) });
      assert.equal(probed.status, 200, pathName);
      assert.ok(probed.raw.equals(plain.raw), pathName + ' is the same with foreign request headers');
      assert.ok(!probed.text.includes('evil.example'), pathName + ' never reflects a request header');
    }
    // A different Host is refused before any page is served.
    const otherHost = await call(runtime, { headers: { host: 'evil.example' } });
    assert.equal(otherHost.status, 421);
    assert.ok(!otherHost.text.includes('evil.example'));
  } finally {
    await runtime.close();
  }
});
