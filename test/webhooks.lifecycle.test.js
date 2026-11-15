'use strict';

// The cold read's fixes, at the delivery and store layers: a seat that is no
// longer in the room is never called again, a repeated hand-over keeps its
// delivery id, a dead receiver holds at most one ring in flight and the
// latest waiting, a ring the room could not build is reported, the socket
// check refuses on its own, and registrations end with their seat.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

const Deliver = require('../src/webhooks/deliver.js');
const { openWebhookStore } = require('../src/webhooks/store.js');

const servers = new Set();
test.afterEach(async () => {
  for (const server of [...servers]) { server.closeAllConnections(); server.close(); await once(server, 'close'); }
  servers.clear();
});

async function receiver(answer) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const reply = answer(seen.length);
      if (reply.hang) return;
      response.writeHead(reply.status);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.add(server);
  return { seen, port: server.address().port };
}

function world(hosted = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-webhook-life-'));
  return { dataDir, store: openWebhookStore({ dataDir, hosted }) };
}

const message = id => ({ id, ts: 1_794_700_000_000 + id, byline: 'Ana', kind: 'person', text: `@Scout ${id}`,
  recipients: [{ subject_id: 'seat-scout', name: 'Scout' }] });
const ringFor = (m, r) => ({ kind: 'mention', message_id: m.id, from: m.byline, at: m.ts,
  read: `interlock history --connection ${r.name} --through ${m.id}` });

function engine(store, overrides = {}) {
  const notes = [];
  const delivered = [];
  const e = Deliver.createWebhookDelivery(Object.assign({
    store, ringFor, noteDelivery: (id, outcome) => notes.push(outcome),
    retryDelaysMs: [10, 10, 10], timeoutMs: 1_000,
  }, overrides));
  return { e, notes, delivered };
}

test('a seat that leaves the room mid-retry is not called again, and nothing is reported for it', async () => {
  const { store } = world();
  let live = true;
  const target = await receiver(n => { if (n === 1) live = false; return { status: 500 }; });
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { e, notes } = engine(store, { isLive: () => live });
  e.deliver(message(1));
  await e.settled();
  assert.equal(target.seen.length, 1, 'no retry after the seat left');
  assert.equal(notes.length, 0);
  // Control: a live seat gets all four attempts.
  live = true;
  const again = await receiver(() => ({ status: 500 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${again.port}/` });
  const control = engine(store, { isLive: () => true });
  control.e.deliver(message(2));
  await control.e.settled();
  assert.equal(again.seen.length, 4);
  e.close(); control.e.close();
});

test('a seat already gone is never called', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 200 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { e } = engine(store, { isLive: () => false });
  e.deliver(message(3));
  await e.settled();
  assert.equal(target.seen.length, 0);
  e.close();
});

test('the delivery id is the same for every hand-over of one message to one seat', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 200 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  // Two engines: a restart, after which the same message is handed over again.
  for (let i = 0; i < 2; i += 1) {
    const { e } = engine(store);
    e.deliver(message(7));
    await e.settled();
    e.close();
  }
  assert.equal(target.seen.length, 2);
  assert.equal(target.seen[0].headers['x-interlock-delivery'], target.seen[1].headers['x-interlock-delivery']);
  assert.equal(target.seen[0].headers['x-interlock-delivery'], Deliver.deliveryIdFor(7, 'seat-scout'));
  assert.notEqual(Deliver.deliveryIdFor(7, 'seat-scout'), Deliver.deliveryIdFor(8, 'seat-scout'));
  assert.notEqual(Deliver.deliveryIdFor(7, 'seat-scout'), Deliver.deliveryIdFor(7, 'seat-other'));
});

test('20,000 rings to a dead receiver hold one in flight and one waiting; the next live ring is the latest', async () => {
  const { store } = world();
  let alive = false;
  const target = await receiver(() => (alive ? { status: 200 } : { hang: true }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { e, notes } = engine(store, { retryDelaysMs: [], timeoutMs: 200 });
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let id = 1; id <= 20_000; id += 1) {
    e.deliver(message(id));
    if (id % 5_000 === 0) assert.ok(e.backlog() <= 2, `backlog ${e.backlog()} at ${id}`);
  }
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(e.backlog() <= 2);
  assert.ok(grown < 16 * 1024 * 1024, `heap grew ${grown} bytes`);
  alive = true;
  await e.settled();
  const ids = target.seen.map(call => JSON.parse(call.body).message_id);
  assert.equal(ids[0], 1, 'the ring in flight when the receiver died');
  assert.equal(ids.at(-1), 20_000, 'what waited was the latest ring, not the oldest');
  assert.ok(ids.length <= 2, `at most two calls, not twenty thousand: ${ids.length}`);
  assert.equal(notes.at(-1).ok, true);
  e.close();
});

test('a ring the room cannot build is reported as a failed delivery, not dropped silently', async () => {
  const { store } = world();
  const target = await receiver(() => ({ status: 200 }));
  store.register('seat-scout', { url: `http://127.0.0.1:${target.port}/` });
  const { e, notes } = engine(store, { ringFor: () => { throw new Error('no clock'); } });
  e.deliver(message(9));
  await e.settled();
  assert.equal(target.seen.length, 0);
  assert.deepEqual(notes.map(n => [n.ok, n.error_class]), [[false, 'refused']]);
  e.close();
});

test('delivery has no hook for a 2xx, so a delivered ring can never become the seat\'s contact', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'webhooks', 'deliver.js'), 'utf8');
  assert.doesNotMatch(source, /options\.delivered/);
});

test('a read that under-reports erases nothing: only seats named as ended lose their webhook', () => {
  const { store } = world();
  store.register('seat-a', { url: 'http://127.0.0.1:9/' });
  store.register('seat-b', { url: 'http://127.0.0.1:9/' });
  // Nothing named as ended (an empty or failed read): nothing erased.
  assert.equal(store.eraseEnded(new Set()), 0);
  // One seat short of a roster is no evidence either; only a named end is.
  assert.equal(store.eraseEnded(new Set(['seat-unknown'])), 0);
  assert.equal(store.has('seat-a') && store.has('seat-b'), true);
  assert.equal(store.eraseEnded(new Set(['seat-b'])), 1);
  assert.deepEqual([store.has('seat-a'), store.has('seat-b')], [true, false]);
  assert.throws(() => store.eraseEnded(null), /invalid-request/);
});

test('the server erases only on the identity record\'s ended list, and erases nothing when it cannot read it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /house\.listRecentEndedSeats\(\{ now: Date\.now\(\), since: 0 \}\)/);
  assert.match(server, /try \{ ended = endedSeats\(\); \} catch \(_\) \{[\s\S]*?return;/);
  assert.doesNotMatch(server, /eraseEnded\(liveSeats/);
});

test('the check on the connected socket refuses a private peer by itself', async () => {
  const target = await receiver(() => ({ status: 200 }));
  const { dataDir } = world();
  const store = openWebhookStore({ dataDir, hosted: true });
  store.register('seat-scout', { url: `https://hooks.example.test:${target.port}/` });
  // The resolver is bypassed: it hands back loopback, as a gap in it would.
  // Only the socket check stands between the room and that peer.
  const lookups = [];
  const unfiltered = (hostname, options, callback) => {
    lookups.push(hostname);
    if (options && options.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return callback(null, '127.0.0.1', 4);
  };
  const { e, notes } = engine(store, { hosted: true, unfilteredLookupForTests: unfiltered, retryDelaysMs: [] });
  e.deliver(message(12));
  await e.settled();
  assert.deepEqual(lookups, ['hooks.example.test'], 'arrangement: the unfiltered resolver was used');
  assert.deepEqual(notes.map(n => n.error_class), ['refused']);
  assert.equal(target.seen.length, 0);
  e.close();
});

test('a hosted room refuses a private literal at registration, and takes a public one', () => {
  const { dataDir } = world();
  const store = openWebhookStore({ dataDir, hosted: true });
  for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.5/', 'https://169.254.169.254/', 'https://[::ffff:7f00:1]/']) {
    assert.throws(() => store.register('seat-scout', { url }), /invalid-url/, url);
  }
  assert.equal(store.register('seat-scout', { url: 'https://8.8.8.8/' }).webhook.target, 'https://8.8.8.8');
  // A local room may call loopback (a bridge on the same computer).
  const local = openWebhookStore({ dataDir: world().dataDir });
  assert.equal(local.register('seat-scout', { url: 'http://127.0.0.1:9/' }).webhook.target, 'http://127.0.0.1:9');
});

test('registrations end with their seat; orphans are listed and deletable; every change has one audit line without a secret', () => {
  const { store, dataDir } = world();
  const a = store.register('seat-a', { url: 'http://127.0.0.1:9/path-token' }, 'owner-1').secret;
  const b = store.register('seat-b', { url: 'http://127.0.0.1:9/' }, 'owner-1').secret;
  store.regenerate('seat-b', 'admin-2');
  store.setExcerpt('seat-b', true, 'admin-2');
  assert.deepEqual(store.orphans(new Set(['seat-b'])).map(view => view.subject_id), ['seat-a']);
  // Erased on positive evidence only: seat-a is named as ended.
  assert.equal(store.eraseEnded(new Set(['seat-a'])), 1);
  assert.equal(store.has('seat-a'), false);
  const onDisk = fs.readFileSync(path.join(dataDir, 'webhooks.json'), 'utf8');
  assert.equal(onDisk.includes(a), false, 'the ended seat\'s secret is erased');
  assert.equal(store.remove('seat-b', 'owner-1'), true);
  const lines = fs.readFileSync(path.join(dataDir, 'webhooks-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => [line.act, line.seat, line.by]), [
    ['set', 'seat-a', 'owner-1'], ['set', 'seat-b', 'owner-1'], ['regenerate', 'seat-b', 'admin-2'],
    ['excerpt-on', 'seat-b', 'admin-2'], ['ended', 'seat-a', null], ['delete', 'seat-b', 'owner-1'],
  ]);
  assert.equal(lines[4].target, 'http://127.0.0.1:9', 'the ended line keeps where the webhook pointed');
  const raw = fs.readFileSync(path.join(dataDir, 'webhooks-audit.jsonl'), 'utf8');
  for (const secret of [a, b]) assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes('ilwh_'), false);
  assert.equal(raw.includes('path-token'), false);
  assert.equal(lines[0].target, 'http://127.0.0.1:9');
});

test('the test timing variables are ignored outside test mode', () => {
  const { webhookTiming } = require('../src/server.js');
  const env = { INTERLOCK_WEBHOOK_RETRY_SCHEDULE_MS: '999999,999999', INTERLOCK_WEBHOOK_TIMEOUT_MS: '999999' };
  assert.deepEqual(webhookTiming(env), {});
  assert.deepEqual(webhookTiming(Object.assign({ INTERLOCK_TEST_MODE: '1' }, env)),
    { retryDelaysMs: [999999, 999999], timeoutMs: 999999 });
});
