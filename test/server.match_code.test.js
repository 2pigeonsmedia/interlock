'use strict';

// A knock's match code lets the person tell their own AI's request apart from
// a stranger's. The joining CLI prints the code beside its waiting line and the
// Allow card shows the same code; both are derived from the knock's credential
// selector, which only the joining client and the room know.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');
const { EXIT_OK, runJoin } = require('../src/cli.js');
const { MATCH_CODE_ALPHABET, MATCH_CODE_LENGTH, matchCode } = require('../src/admission/match_code.js');
const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

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
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port,
      path: options.path || '/', method: options.method || 'GET', headers,
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

function post(runtime, pathname, body, session = null) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: session ? {
      origin: runtime.url, 'sec-fetch-site': 'same-origin',
      cookie: session.cookie, 'x-csrf-token': session.csrf,
    } : {},
  });
}

const cookieOf = response => response.headers['set-cookie'][0].split(';', 1)[0];

async function ownerSession(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Dana', password },
    { cookie: '', csrf: '' });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: cookieOf(redeemed), csrf: redeemed.json.csrf_token };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  const signedIn = await post(runtime, '/api/login', { name: 'Dana', password }, { cookie: '', csrf: '' });
  assert.equal(signedIn.status, 200, signedIn.text);
  return { cookie: cookieOf(signedIn), csrf: signedIn.json.csrf_token };
}

async function pendingRows(runtime, owner) {
  const listed = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: owner.cookie } });
  assert.equal(listed.status, 200, listed.text);
  return listed.json.pending;
}

test('a match code is five characters a person can read aloud, fixed by the selector', () => {
  assert.equal(MATCH_CODE_LENGTH, 5);
  assert.equal(MATCH_CODE_ALPHABET.length, 32);
  for (const confusable of ['0', 'O', '1', 'I']) {
    assert.equal(MATCH_CODE_ALPHABET.includes(confusable), false, `the alphabet leaves out ${confusable}`);
  }
  const selector = identity.newAiCredential().selector;
  assert.equal(matchCode(selector), matchCode(selector), 'the same selector always gives the same code');
  const seen = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const code = matchCode(identity.newAiCredential().selector);
    assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
    seen.add(code);
  }
  // 32^5 codes: 2,000 random selectors collide only rarely (expected about 0.06 pairs).
  assert.ok(seen.size >= 1995, `codes spread across the space (${seen.size} distinct of 2000)`);
  assert.equal(matchCode('not a selector'), null, 'a malformed selector has no code');
});

test('the code the joining CLI prints is the code on its Allow card, and only on its card', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-match-code-'));
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-match-code-client-'));
  const runtime = await startInterlockServer({ port: await reservePort(), dataDir });
  let owner = null;
  let joining = null;
  let strangerWait = null;
  try {
    owner = await ownerSession(runtime);

    // A stranger's knock waits beside the real one.
    const stranger = identity.newAiCredential();
    const strangerBody = {
      request_id: '6f1c2a4e-2b7d-4c1a-9e3f-1a2b3c4d5e6f', name: 'Atlas', product: 'Codex CLI',
      product_provenance: 'client-reported', selector: stranger.selector, digest: stranger.digest,
    };
    strangerWait = post(runtime, '/api/ai/admissions', strangerBody);

    let stdout = '';
    let stderr = '';
    joining = runJoin(['--product', 'Codex CLI', '--name', 'Scout', '--url', runtime.url], {
      stdout: { write: value => { stdout += String(value); } },
      stderr: { write: value => { stderr += String(value); } },
    }, {
      config: { resolveConnectionDir: () => connectionDir },
      ask: async () => { throw new Error('explicit test facts must not prompt'); },
    });

    let rows = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rows = await pendingRows(runtime, owner);
      if (rows.length === 2 && rows.every(row => row.connected)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // The first knock is held open for up to 20 s before the CLI reports it is
    // waiting, so the code is printed as the request is made.
    const printed = /Requesting admission as Scout\. Match code: ([A-Z0-9]+)/.exec(stdout);
    assert.ok(printed, `the request line carries the code: ${JSON.stringify(stdout)}`);
    const scout = rows.find(row => row.name === 'Scout');
    const atlas = rows.find(row => row.name === 'Atlas');
    assert.ok(scout && atlas, 'ARRANGEMENT: both knocks are waiting');

    const saved = JSON.parse(fs.readFileSync(path.join(connectionDir, 'scout.json'), 'utf8'));
    assert.equal(printed[1], matchCode(saved.selector), 'the CLI prints the code of its own selector');
    assert.equal(scout.match_code, printed[1], 'the card shows the code the AI printed');
    assert.equal(atlas.match_code, matchCode(stranger.selector), "the stranger's card shows the stranger's code");
    assert.notEqual(atlas.match_code, scout.match_code, 'ARRANGEMENT: the two codes differ');

  } finally {
    // Decline whatever is still waiting, pass or fail, so the joining CLI and
    // the stranger's held request end instead of outliving the room.
    if (owner !== null) {
      for (const row of await pendingRows(runtime, owner)) {
        await post(runtime, `/api/ai/admissions/${row.request_id}/decline`, {}, owner);
      }
    }
    if (strangerWait !== null) await strangerWait;
    const joined = joining === null ? null : await joining;
    await runtime.close();
    assert.notEqual(joined, EXIT_OK, 'a declined join does not connect');
  }
});

test('the Allow card shows the match code and warns that the name and product are not verified', () => {
  const validator = ROOM_JS.slice(ROOM_JS.indexOf('function validPendingAi('), ROOM_JS.indexOf('function pendingStatus('));
  assert.ok(validator.includes("'match_code'"), 'the page accepts the match code field');
  assert.ok(validator.includes('/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(value.match_code)'),
    'and only in the match code form');
  const render = ROOM_JS.slice(ROOM_JS.indexOf('function renderPendingAis('), ROOM_JS.indexOf('async function loadPendingAis('));
  assert.ok(render.includes('`Match code: ${row.match_code}`'), 'the card shows the code of its own row');
  assert.ok(render.includes("'The name and product are reported by the AI and not verified. " +
    "Allow only an AI you just asked to join, and check its match code.'"), 'the card carries the warning');
  assert.ok(render.indexOf('facts.append(name, product);') !== -1 &&
    render.indexOf('facts.append(code, warning);') > render.indexOf('facts.append(name, product);'),
  'and both are on the card, after the name, product and any declared project');
});
