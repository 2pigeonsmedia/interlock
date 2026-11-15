'use strict';

// The room's webhook delivery, against real local receivers: signing, the
// delivery id across retries, the failure classes, redirects, bodies never
// kept, hosted-mode address refusal, ordering and duplicates.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const Deliver = require('../src/webhooks/deliver.js');
const { openWebhookStore } = require('../src/webhooks/store.js');

const servers = new Set();
test.afterEach(async () => {
  for (const server of [...servers]) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
  servers.clear();
});

// A receiver that records each request and answers with `answer(n)`:
// { status, headers?, body?, hang? }.
async function receiver(answer, factory = http.createServer, options = undefined) {
  const seen = [];
  const handler = (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ headers: request.headers, body, url: request.url });
      const reply = answer(seen.length, seen[seen.length - 1]);
      if (reply.hang) return;
      response.writeHead(reply.status, reply.headers || { 'content-type': 'text/plain' });
      response.end(reply.body || '');
    });
  };
  const server = options ? factory(options, handler) : factory(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.add(server);
  return { seen, port: server.address().port, server };
}

function world() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-webhooks-'));
  return { dataDir, store: openWebhookStore({ dataDir }) };
}

function verify(secret, seen) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(seen.body, 'utf8').digest('hex');
  const given = String(seen.headers['x-interlock-signature'] || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const MESSAGE = Object.freeze({
  id: 41, ts: 1_794_700_000_000, byline: 'Ana', kind: 'person', text: '@Scout please look at the import\nsecond line',
  recipients: [{ subject_id: 'seat-scout', name: 'Scout' }],
});

function ringFor(message, recipient) {
  return { kind: 'mention', to: recipient.name, message_id: message.id, from: message.byline, at: message.ts,
    read: `interlock history --connection ${recipient.name} --through ${message.id}` };
}

function delivery(store, overrides = {}) {
  const notes = [];
  const engine = Deliver.createWebhookDelivery(Object.assign({
    store, ringFor, noteDelivery: (subjectId, outcome) => notes.push([subjectId, outcome]),
    retryDelaysMs: [5, 5, 5], timeoutMs: 2_000, version: '0.4.0-test',
  }, overrides));
  return { engine, notes };
}

test('a ring is POSTed once, signed with the seat\'s secret, and reported delivered', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 204 }));
  const { secret } = store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/hook/abc?k=1` });
  const { engine, notes } = delivery(store);
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.equal(target.seen.length, 1);
  const [call] = target.seen;
  assert.equal(call.url, '/hook/abc?k=1');
  assert.equal(verify(secret, call), true, 'the receiver can verify the signature with the secret');
  assert.match(call.headers['x-interlock-delivery'], /^[0-9a-f-]{36}$/);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(JSON.stringify(call).includes(secret), false, 'the secret itself never travels');
  const body = JSON.parse(call.body);
  assert.deepEqual(body, ringFor(MESSAGE, MESSAGE.recipients[0]), 'no excerpt unless the seat opts in');
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], 'seat-scout');
  assert.equal(notes[0][1].ok, true);
  engine.close();
});

test('a seat that opts in gets a one-line excerpt; a forged signature does not verify', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 200 }));
  const { secret } = store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/`, excerpt: true });
  const { engine } = delivery(store);
  engine.deliver(MESSAGE);
  await engine.settled();
  const body = JSON.parse(target.seen[0].body);
  assert.equal(body.excerpt, '@Scout please look at the import second line');
  assert.equal(verify('ilwh_' + 'x'.repeat(43), target.seen[0]), false, 'control: another secret fails');
  assert.equal(verify(secret, Object.assign({}, target.seen[0], { body: target.seen[0].body + ' ' })), false,
    'control: a changed body fails');
  engine.close();
});

test('a receiver answering 500 is tried 4 times with one delivery id, then reported 5xx', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 500, body: 'BODY-MARKER-500' }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store);
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.equal(target.seen.length, 4, 'the first attempt and three retries');
  assert.equal(new Set(target.seen.map(call => call.headers['x-interlock-delivery'])).size, 1);
  assert.deepEqual(notes.map(note => [note[1].ok, note[1].error_class]), [[false, '5xx']], 'one report per ring');
  engine.close();
});

test('a failure then a 2xx is one delivered ring', async () => {
  const { store } = world();
  const target = await receiver(n => ({ status: n === 1 ? 503 : 200 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store);
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.equal(target.seen.length, 2);
  assert.deepEqual(notes.map(note => note[1].ok), [true]);
  engine.close();
});

test('each failure has its class: 4xx, redirect (never followed), timeout, network', async () => {
  const cases = [];
  const elsewhere = await receiver(() => ({ status: 200 }));
  cases.push(['4xx', await receiver(() => ({ status: 404 }))]);
  cases.push(['redirect', await receiver(() => ({ status: 302, headers: { location: `http://127.0.0.1:${elsewhere.port}/` } }))]);
  cases.push(['timeout', await receiver(() => ({ hang: true }))]);
  for (const [want, target] of cases) {
    const { store } = world();
    store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
    const { engine, notes } = delivery(store, { retryDelaysMs: [], timeoutMs: want === 'timeout' ? 200 : 2_000 });
    engine.deliver(MESSAGE);
    await engine.settled();
    assert.deepEqual(notes.map(note => note[1].error_class), [want], want);
    engine.close();
  }
  assert.equal(elsewhere.seen.length, 0, 'a redirect is not followed');
  // Nothing listens on a port just closed.
  const closed = await receiver(() => ({ status: 200 }));
  closed.server.close();
  servers.delete(closed.server);
  await once(closed.server, 'close');
  const { store } = world();
  store.register('seat-scout', { url: `http://127.0.0.1:${closed.port}/` });
  const { engine, notes } = delivery(store, { retryDelaysMs: [] });
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.deepEqual(notes.map(note => note[1].error_class), ['network']);
  engine.close();
});

test('a TLS failure is class tls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-webhook-tls-'));
  const made = childProcess.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { encoding: 'utf8' });
  if (made.error || made.status !== 0) { t.skip('openssl is not available'); return; }
  const target = await receiver(() => ({ status: 200 }), https.createServer, {
    key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')),
  });
  const { store } = world();
  store.register('seat-scout', { url: `https://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store, { retryDelaysMs: [] });
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.deepEqual(notes.map(note => note[1].error_class), ['tls'], 'a self-signed certificate is refused');
  assert.equal(target.seen.length, 0);
  engine.close();
  // Control: trusting that certificate, the same delivery succeeds.
  const trusted = delivery(store, { retryDelaysMs: [], tls: { ca: fs.readFileSync(path.join(dir, 'cert.pem')), servername: 'localhost' } });
  trusted.engine.deliver(Object.assign({}, MESSAGE, { id: 42 }));
  await trusted.engine.settled();
  assert.deepEqual(trusted.notes.map(note => note[1].ok), [true]);
  trusted.engine.close();
});

test('a hosted room refuses a private address, by name or by literal, at delivery', async () => {
  const target = await receiver(() => ({ status: 200 }));
  const { dataDir } = world();
  const store = openWebhookStore({ dataDir, hosted: true });
  assert.throws(() => store.register('seat-scout', { url: `http://example.com/` }), /invalid-url/,
    'a hosted room takes https only');
  // A name that resolves to loopback (the DNS answer an attacker controls).
  store.register('seat-scout', { url: `https://hooks.example.test:${target.port}/` });
  const lookups = [];
  const resolve = (hostname, options, callback) => {
    lookups.push(hostname);
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  };
  const { engine, notes } = delivery(store, { hosted: true, resolve, retryDelaysMs: [] });
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.deepEqual(lookups, ['hooks.example.test'], 'arrangement: the name was resolved at delivery');
  assert.deepEqual(notes.map(note => note[1].error_class), ['refused']);
  // A literal private address: refused when set in a hosted room, and refused
  // again at delivery for one written before (a room that was local, then
  // hosted on the same data).
  const local = openWebhookStore({ dataDir });
  for (const literal of ['127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.5']) {
    assert.throws(() => store.register('seat-scout', { url: `https://${literal}:${target.port}/` }), /invalid-url/);
    local.register('seat-scout', { url: `https://${literal}:${target.port}/` });
    const next = delivery(local, { hosted: true, resolve, retryDelaysMs: [] });
    next.engine.deliver(Object.assign({}, MESSAGE, { id: 100 + lookups.length }));
    await next.engine.settled();
    assert.deepEqual(next.notes.map(note => note[1].error_class), ['refused'], literal);
    next.engine.close();
  }
  assert.equal(target.seen.length, 0, 'nothing reached the private receiver');
  engine.close();
});

test('the hosted resolver keeps only public answers, and refuses a name with none', async () => {
  const answer = list => (hostname, options, callback) => callback(null, list);
  const mixed = Deliver.publicLookup(answer([
    { address: '10.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 },
  ]));
  const all = await new Promise(resolve => mixed('h', { all: true }, (error, list) => resolve([error, list])));
  assert.equal(all[0], null);
  assert.deepEqual(all[1].map(entry => entry.address), ['93.184.216.34']);
  const one = await new Promise(resolve => mixed('h', {}, (error, address, family) => resolve([error, address, family])));
  assert.deepEqual(one, [null, '93.184.216.34', 4]);
  const privateOnly = Deliver.publicLookup(answer([{ address: '192.168.0.9', family: 4 }]));
  const refused = await new Promise(resolve => privateOnly('h', {}, error => resolve(error)));
  assert.equal(refused.code, 'EWEBHOOKREFUSED');
  assert.equal(Deliver.errorClass(refused), 'refused');
});

test('rings to one seat arrive in order; a message seen twice is delivered once', async () => {
  const { store } = world();
  const target = await receiver(n => ({ status: n === 1 ? 500 : 200 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store, { retryDelaysMs: [30] });
  engine.deliver(MESSAGE);
  engine.deliver(Object.assign({}, MESSAGE, { id: 42 }));
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.deepEqual(target.seen.map(call => JSON.parse(call.body).message_id), [41, 41, 42]);
  assert.equal(notes.length, 2);
  engine.close();
});

test('a seat without a webhook, or a recipient list without it, sends nothing', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 200 }));
  store.register('seat-other', { url: `http://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store);
  engine.deliver(MESSAGE);
  engine.deliver(Object.assign({}, MESSAGE, { id: 50, recipients: [] }));
  await engine.settled();
  assert.equal(target.seen.length, 0);
  assert.equal(notes.length, 0);
  engine.close();
});

test('a regenerated secret signs the next attempt; a deleted webhook stops its retries', async () => {
  const { store } = world();
  let regenerated = null;
  const target = await receiver(n => {
    if (n === 1) regenerated = store.regenerate('seat-scout').secret;
    return { status: n === 1 ? 500 : 200 };
  });
  const first = store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` }).secret;
  const { engine } = delivery(store, { retryDelaysMs: [20] });
  engine.deliver(MESSAGE);
  await engine.settled();
  assert.equal(verify(first, target.seen[0]), true);
  assert.equal(verify(regenerated, target.seen[1]), true, 'the retry is signed with the new secret');
  assert.equal(verify(first, target.seen[1]), false);
  engine.close();

  const gone = await receiver(n => { if (n === 1) store.remove('seat-scout'); return { status: 500 }; });
  store.register('seat-scout', { url: `http://127.0.0.1:${gone.port}/` });
  const second = delivery(store, { retryDelaysMs: [20, 20, 20] });
  second.engine.deliver(Object.assign({}, MESSAGE, { id: 60 }));
  await second.engine.settled();
  assert.equal(gone.seen.length, 1, 'no retry after the webhook was deleted');
  assert.equal(second.notes.length, 0);
  second.engine.close();
});

test('close() ends a delivery waiting to retry, and settles', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 500 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { engine, notes } = delivery(store, { retryDelaysMs: [60_000] });
  engine.deliver(MESSAGE);
  assert.ok(await (async () => {
    for (let i = 0; i < 200 && target.seen.length === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    return target.seen.length === 1;
  })());
  engine.close();
  await engine.settled();
  assert.equal(notes.length, 0);
});

test('public means public: the address table', () => {
  const table = {
    '8.8.8.8': true, '1.1.1.1': true, '172.32.0.1': true, '2606:4700::1111': true, '2a00:1450:4001::200e': true,
    '::ffff:8.8.8.8': true, '64:ff9b::808:808': true,
    '127.0.0.1': false, '10.1.2.3': false, '172.16.0.1': false, '192.168.1.1': false, '169.254.169.254': false,
    '0.0.0.0': false, '100.64.1.1': false, '224.0.0.1': false, '255.255.255.255': false, '192.0.2.1': false,
    '::1': false, '::': false, 'fd00::1': false, 'fe80::1': false, 'ff02::1': false, '100::1': false,
    '::ffff:127.0.0.1': false, '::ffff:7f00:1': false, '0:0:0:0:0:ffff:7f00:1': false, '::127.0.0.1': false,
    '64:ff9b::a9fe:a9fe': false, '64:ff9b:1::a00:1': false, '::ffff:0:a00:1': false, '2002:a00:1::1': false,
    '2001:0:4136:e378::1': false, '2001:db8::1': false, '3fff::1': false, '[::1]': false, 'garbage': false, '': false,
  };
  for (const [address, expected] of Object.entries(table)) {
    assert.equal(Deliver.publicAddress(address), expected, address);
  }
});

test('excerpts are one safe line, bounded', () => {
  assert.equal(Deliver.excerptOf('a\nb\tc\u0007d'), 'a b c d');
  assert.equal(Array.from(Deliver.excerptOf('x'.repeat(500))).length, 200);
  assert.equal(Deliver.excerptOf(null), '');
});
