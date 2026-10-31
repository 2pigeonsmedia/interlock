'use strict';

// A reply on a withdrawn ask, read by its asker through the CLI against a real
// room. Its own file: one server per process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
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
    request.once('error', error => {
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

function get(runtime, pathname, session) {
  return call(runtime, { path: pathname, headers: { cookie: session.cookie } });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
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
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return { cookie: finished.headers['set-cookie'][0].split(';', 1)[0], csrf: finished.json.csrf_token };
}

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

// The owner session must hold a fresh step-up when this is called.
async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  const joined = await waiting;
  assert.equal(joined.status, 200, joined.text);
  return { token: candidate.token, name };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: bearer(token) });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: bearer(token) });
}

function uuid() {
  return crypto.randomUUID();
}

function messageQuery(after) {
  return `/api/ai/messages?after=${after}&limit=100&wait=0`;
}


// A connection the CLI loads by name. The cursor moves like the real profile's.
function connection(runtime, seat) {
  const profile = {
    schema: 2, name: seat.name, product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: runtime.url, request_id: crypto.randomUUID(), token: seat.token,
    selector: 'selectorselectorselecto', digest: 'a'.repeat(64), state: 'admitted',
    created_at: 1, admitted_at: 2, subject_id: 'unused', expires_at: Number.MAX_SAFE_INTEGER, cursor: 0,
  };
  const files = new Map();
  return {
    profile,
    files,
    dependencies: {
      config: { resolveConnectionDir: () => '/unused' },
      profiles: {
        validName: value => value === seat.name,
        openProfiles: () => ({
          load: () => Object.freeze(Object.assign({}, profile)),
          updateCursor(name, requestId, cursor) { profile.cursor = Math.max(profile.cursor, cursor); },
          acquireReadLease: () => ({ release() {} }),
        }),
      },
      readFile: file => {
        if (!files.has(file)) throw new Error('no such file: ' + file);
        return files.get(file);
      },
      // The CLI's requests reach the real server through the same loopback
      // client the route tests use.
      fetch: async (url, init = {}) => {
        const target = new URL(url);
        const response = await call(runtime, {
          path: target.pathname + target.search,
          method: init.method || 'GET',
          body: init.body === undefined ? undefined : JSON.parse(init.body),
          headers: { authorization: init.headers.authorization },
        });
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.json,
        };
      },
    },
  };
}

async function cli(seat, argv) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv.concat(['--connection', seat.profile.name]), {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, seat.dependencies);
  return { code, stdout, stderr };
}

function sentId(result) {
  const match = /Sent as \w+ \(message (\d+)\)\./.exec(result.stdout);
  assert.ok(match, 'ARRANGEMENT: the CLI reports the posted message: ' + result.stdout + result.stderr);
  return Number(match[1]);
}

// A reply on a withdrawn ask still reaches its asker, and the asker reads that
// the ask had been withdrawn when the reply came; a reply on an open ask reads
// as a plain discussion.
test('a reply on a withdrawn ask rings its asker and reads as withdrawn; a reply on an open ask does not', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-withdrawn-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    let owner = await login(runtime, password);
    owner = await elevate(runtime, owner, device);
    const lead = connection(runtime, await admitSeat(runtime, owner, 'Lead'));
    lead.files.set('q.md', 'Carry the old questions over?\n');
    lead.files.set('scope.txt', 'I carry the open questions into the new list\n');

    const gone = sentId(await cli(lead, ['say', '--file', 'q.md', '--asks-of', 'Ana', '--means-file', 'scope.txt']));
    const live = sentId(await cli(lead, ['say', '--file', 'q.md', '--asks-of', 'Ana', '--means-file', 'scope.txt']));
    const withdrawn = await cli(lead, ['ask', 'withdraw', String(gone)]);
    assert.equal(withdrawn.code, EXIT_OK, 'ARRANGEMENT: the first ask is withdrawn: ' + withdrawn.stderr);
    // More than a page of side-car rows after the withdraw, so the history
    // read has to look back past them to find it.
    for (let index = 0; index < 120; index += 1) {
      const filler = await aiPost(runtime, '/api/ai/annotated-messages',
        { text: `note ${index}`, client_message_id: uuid(), annotation: { discusses: live } }, lead.profile.token);
      assert.equal(filler.status, 201, filler.text);
    }

    const late = await post(runtime, '/api/messages', { text: `re #${gone} @Lead start fresh` }, owner);
    assert.equal(late.status, 201, late.text);
    const onTime = await post(runtime, '/api/messages', { text: `re #${live} @Lead fine by me` }, owner);
    assert.equal(onTime.status, 201, onTime.text);

    // Both replies are discussions of their asks, by the prefix rule, and the
    // one on the withdrawn ask still rang its asker.
    const rows = [];
    for (let after = 0, page = null; page === null || page.json.rows.length > 0; after = page.json.cursor) {
      page = await aiGet(runtime, `/api/ai/annotations?after=${after}&limit=100`, lead.profile.token);
      assert.equal(page.status, 200, page.text);
      rows.push(...page.json.rows);
    }
    const rowOf = id => rows.find(row => row.kind === 'post' && row.message_id === id);
    assert.deepEqual(rowOf(late.json.message.id).discusses, { ask_id: gone, party: 'addressee' },
      'ARRANGEMENT: the late reply discusses the withdrawn ask');
    assert.deepEqual(rowOf(onTime.json.message.id).discusses, { ask_id: live, party: 'addressee' },
      'ARRANGEMENT: the reply on the open ask discusses it');
    assert.ok(late.json.message.delivery.some(entry => entry.name === 'Lead'), 'the asker is rung: ' + late.text);
    // Withdrawn after its reply: that reply was not on a withdrawn ask.
    const after = await cli(lead, ['ask', 'withdraw', String(live)]);
    assert.equal(after.code, EXIT_OK, 'ARRANGEMENT: the second ask is withdrawn after its reply: ' + after.stderr);

    const read = await cli(lead, ['history', '--drain']);
    assert.equal(read.code, EXIT_OK, read.stderr);
    assert.match(read.stdout, new RegExp(`\\[${late.json.message.id}\\] Ana[^\\n]*\\nre #${gone} @Lead start fresh\\n+` +
      `  ↳ discusses ask ${gone} \\(withdrawn before this reply\\)\\n`));
    assert.match(read.stdout, new RegExp(`\\[${onTime.json.message.id}\\] Ana[^\\n]*\\nre #${live} @Lead fine by me\\n+` +
      `  ↳ discusses ask ${live}\\n`));
    assert.doesNotMatch(read.stdout, new RegExp(`discusses ask ${live} \\(withdrawn`),
      'a reply written before its ask was withdrawn is not called a reply on a withdrawn ask');
  } finally {
    await runtime.close();
  }
});
