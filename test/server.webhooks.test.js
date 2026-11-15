'use strict';

// Webhook delivery through a real room: an owner registers a seat's webhook
// in Settings, a ring to that seat calls it, and the secret is never seen
// again anywhere but in the receiver's own verification.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');

// Short retries, read when the room starts.
process.env.INTERLOCK_TEST_MODE = '1';
process.env.INTERLOCK_WEBHOOK_RETRY_SCHEDULE_MS = '10,10,10';
process.env.INTERLOCK_WEBHOOK_TIMEOUT_MS = '2000';

const room = require('./helpers/room_server.js');
const Ring = require('../src/rings.js');

const receivers = new Set();
test.afterEach(async () => {
  for (const server of [...receivers]) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
  receivers.clear();
});

async function receiver(status = 200) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), url: request.url });
      response.writeHead(typeof status === 'function' ? status(seen.length) : status, { 'content-type': 'text/plain' });
      response.end('RECEIVER-BODY-MARKER');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  receivers.add(server);
  return { seen, port: server.address().port };
}

async function eventually(check, what, bound = 10_000) {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`never: ${what}`);
}

function verifies(secret, call) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(call.body, 'utf8').digest('hex');
  const given = String(call.headers['x-interlock-signature'] || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function kindOf(runtime, owner, name) {
  const read = await room.get(runtime, '/api/participants', owner);
  assert.equal(read.status, 200, read.text);
  const row = read.json.participants.find(entry => entry.name === name);
  return row && row.presence_kind ? row.presence_kind.kind : null;
}

// Identity is one per process, so this file runs one room; each test admits
// its own seats.
let shared = null;
let seatCount = 0;
test.after(async () => { if (shared) await shared.runtime.close(); });

async function setUp() {
  if (!shared) {
    const { runtime, dataDir } = await room.startRoom('interlock-webhooks-');
    const device = await room.bootstrap(runtime);
    shared = { runtime, dataDir, device };
  }
  const { runtime, dataDir, device } = shared;
  seatCount += 1;
  const names = { scout: `Scout${seatCount}`, other: `Other${seatCount}` };
  let owner = await room.elevate(runtime, await room.login(runtime), device);
  const scout = await room.admitSeat(runtime, owner, names.scout);
  owner = await room.elevate(runtime, owner, device);
  const other = await room.admitSeat(runtime, owner, names.other);
  owner = await room.login(runtime);
  return { runtime, dataDir, device, owner, scout, other, names };
}

test('an owner registers a webhook; an @mention calls it, signed; a plain post does not', async () => {
  const { runtime, owner, names } = await setUp();
  const S = names.scout;
  const O = names.other;
  try {
    const target = await receiver();
    const set = await room.post(runtime, '/api/settings/webhooks/set',
      { name: S, url: `http://127.0.0.1:${target.port}/routine/TOKEN-IN-PATH?k=QUERY-SECRET` }, owner);
    assert.equal(set.status, 200, set.text);
    const secret = set.json.secret;
    assert.match(secret, /^ilwh_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Object.keys(set.json.webhook).sort(), ['created_at', 'excerpt', 'target', 'updated_at']);
    assert.equal(set.json.webhook.target, `http://127.0.0.1:${target.port}`, 'the path and query are not shown');

    const listed = await room.get(runtime, '/api/settings/webhooks', owner);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.json.seats.find(row => row.name === S).webhook.target, `http://127.0.0.1:${target.port}`);
    assert.equal(listed.json.seats.find(row => row.name === O).webhook, null);
    assert.equal(listed.text.includes(secret), false);
    assert.equal(listed.text.includes('TOKEN-IN-PATH'), false);
    assert.equal(await kindOf(runtime, owner, S), 'listening', 'a registered webhook seat reads listening');

    // Not addressed: no call.
    assert.equal((await room.post(runtime, '/api/messages', { text: 'general news, no one named' }, owner)).status, 201);
    assert.equal((await room.post(runtime, '/api/messages', { text: `@${O} this one is for Other` }, owner)).status, 201);
    const mention = await room.post(runtime, '/api/messages', { text: `@${S} please check the import` }, owner);
    assert.equal(mention.status, 201, mention.text);
    await eventually(() => target.seen.length >= 1, 'the webhook was called');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(target.seen.length, 1, 'only the post that rings Scout calls Scout\'s webhook');
    const [call] = target.seen;
    assert.equal(call.url, '/routine/TOKEN-IN-PATH?k=QUERY-SECRET');
    assert.equal(verifies(secret, call), true);
    const body = JSON.parse(call.body);
    assert.equal(body.message_id, mention.json.message.id);
    assert.equal(body.from, 'Ana');
    assert.equal(Ring.validRing(body), true, 'the body is the one ring shape (C4), nothing more');
    assert.equal(body.kind, 'mention');
    assert.equal(body.room_time, Ring.NOT_SET, 'Ana set no time zone');
    assert.equal(body.read, `interlock history --connection ${S} --through ${mention.json.message.id}`);
    assert.equal(body.excerpt, undefined);
    assert.equal(await eventually(async () => (await kindOf(runtime, owner, S)) === 'rung' && 'rung', 'rung'), 'rung');
  } finally {
    // The room is shared by this file's tests.
  }
});

test('a failing webhook reads unreachable; the next 2xx clears it', async () => {
  const { runtime, owner, names } = await setUp();
  const S = names.scout;
  const O = names.other;
  try {
    let healthy = false;
    const target = await receiver(() => (healthy ? 200 : 500));
    const set = await room.post(runtime, '/api/settings/webhooks/set',
      { name: S, url: `http://127.0.0.1:${target.port}/` }, owner);
    assert.equal(set.status, 200, set.text);
    await room.post(runtime, '/api/messages', { text: `@${S} one` }, owner);
    await eventually(async () => (await kindOf(runtime, owner, S)) === 'unreachable', 'unreachable after one failed ring');
    assert.equal(target.seen.length, 4, 'one ring: the first attempt and three retries');
    healthy = true;
    await room.post(runtime, '/api/messages', { text: `@${S} two` }, owner);
    await eventually(async () => (await kindOf(runtime, owner, S)) === 'rung', 'rung after a good delivery');
  } finally {
    // The room is shared by this file's tests.
  }
});

test('regenerate makes a new secret; excerpt is per seat; delete stops the calls', async () => {
  const { runtime, owner, names } = await setUp();
  const S = names.scout;
  const O = names.other;
  try {
    const target = await receiver();
    const first = (await room.post(runtime, '/api/settings/webhooks/set',
      { name: S, url: `http://127.0.0.1:${target.port}/` }, owner)).json.secret;
    const again = await room.post(runtime, '/api/settings/webhooks/regenerate', { name: S }, owner);
    assert.equal(again.status, 200, again.text);
    assert.notEqual(again.json.secret, first);
    const excerpt = await room.post(runtime, '/api/settings/webhooks/excerpt', { name: S, excerpt: true }, owner);
    assert.equal(excerpt.status, 200, excerpt.text);
    assert.equal(excerpt.json.webhook.excerpt, true);
    assert.equal(excerpt.json.secret, undefined, 'only set and regenerate answer with a secret');
    await room.post(runtime, '/api/messages', { text: `@${S} read the\nimport log` }, owner);
    await eventually(() => target.seen.length === 1, 'called');
    assert.equal(verifies(again.json.secret, target.seen[0]), true);
    assert.equal(verifies(first, target.seen[0]), false, 'the old secret no longer signs');
    assert.equal(JSON.parse(target.seen[0].body).excerpt, `@${S} read the import log`);

    const removed = await room.post(runtime, '/api/settings/webhooks/delete', { name: S }, owner);
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await room.post(runtime, '/api/settings/webhooks/delete', { name: S }, owner)).status, 404);
    await room.post(runtime, '/api/messages', { text: `@${S} after delete` }, owner);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(target.seen.length, 1, 'a deleted webhook is not called');
    assert.equal((await room.get(runtime, '/api/settings/webhooks', owner)).json.seats
      .find(row => row.name === S).webhook, null);
  } finally {
    // The room is shared by this file's tests.
  }
});

test('only an owner or admin, from the page, may set or read webhooks', async () => {
  const { runtime, device, scout, names } = await setUp();
  let owner = null;
  const S = names.scout;
  const O = names.other;
  try {
    const url = 'http://127.0.0.1:9/';
    const elevated = await room.elevate(runtime, await room.login(runtime), device);
    const member = await room.inviteMember(runtime, elevated, `Mo${S}`, 'mo has a long password');
    // A live owner session for every probe below; the control at the end
    // proves it would have been accepted.
    owner = await room.login(runtime);
    const tries = [
      ['no session', await room.post(runtime, '/api/settings/webhooks/set', { name: S, url }, {})],
      ['no csrf', await room.post(runtime, '/api/settings/webhooks/set', { name: S, url }, { cookie: owner.cookie })],
      ['wrong origin', await room.post(runtime, '/api/settings/webhooks/set', { name: S, url }, owner,
        { origin: 'https://evil.example' })],
      ['a member', await room.post(runtime, '/api/settings/webhooks/set', { name: S, url }, member)],
      ['the AI itself', await room.aiPost(runtime, '/api/settings/webhooks/set', { name: S, url }, scout.token)],
      ['a member read', await room.get(runtime, '/api/settings/webhooks', member)],
      ['the AI read', await room.aiGet(runtime, '/api/settings/webhooks', scout.token)],
    ];
    for (const [who, response] of tries) {
      assert.ok(response.status === 401 || response.status === 403, `${who}: ${response.status} ${response.text}`);
      assert.equal(response.text.includes('ilwh_'), false, who);
    }
    // Control: the owner's own request, the same body, works.
    assert.equal((await room.post(runtime, '/api/settings/webhooks/set', { name: S, url }, owner)).status, 200);
    // Bad input is refused, not stored.
    for (const body of [
      { name: S, url: 'ftp://127.0.0.1/' }, { name: S, url: 'http://user:pass@127.0.0.1/' },
      { name: S, url: 'http://127.0.0.1/#frag' }, { name: S }, { name: 'Nobody', url },
      { name: S, url, excerpt: 'yes' }, { name: S, url, extra: 1 },
    ]) {
      const refused = await room.post(runtime, '/api/settings/webhooks/set', body, owner);
      assert.ok(refused.status === 400 || refused.status === 404, `${JSON.stringify(body)}: ${refused.status}`);
    }
  } finally {
    // The room is shared by this file's tests.
  }
});

// Every file under a directory, recursively, as [path, bytes].
function filesUnder(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else if (entry.isFile()) found.push([full, fs.readFileSync(full)]);
  }
  return found;
}

test('the secret never appears in a log, a page, an API read or another file', async () => {
  // Everything the server process writes to its own output.
  const written = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return outWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return errWrite(chunk, ...rest); };
  const { runtime, owner, scout, dataDir, names } = await setUp();
  const S = names.scout;
  const O = names.other;
  let secret;
  let failingSecret;
  try {
    const target = await receiver();
    secret = (await room.post(runtime, '/api/settings/webhooks/set',
      { name: S, url: `http://127.0.0.1:${target.port}/path-token`, excerpt: true }, owner)).json.secret;
    const failing = await receiver(500);
    failingSecret = (await room.post(runtime, '/api/settings/webhooks/set',
      { name: O, url: `http://127.0.0.1:${failing.port}/` }, owner)).json.secret;
    await room.post(runtime, '/api/messages', { text: `@${S} @${O} hello both` }, owner);
    await eventually(() => target.seen.length === 1 && failing.seen.length === 4, 'both delivered or failed');
    await eventually(async () => (await kindOf(runtime, owner, O)) === 'unreachable', 'failure recorded');

    const reads = [
      await room.get(runtime, '/', owner),
      await room.get(runtime, '/api/participants', owner),
      await room.get(runtime, '/api/settings/participants', owner),
      await room.get(runtime, '/api/settings/webhooks', owner),
      await room.get(runtime, '/api/messages?after=0&limit=100', owner),
      await room.aiGet(runtime, '/api/ai/session', scout.token),
      await room.aiGet(runtime, '/api/ai/messages?after=0&limit=100&wait=0', scout.token),
      await room.aiGet(runtime, '/api/ai/rings?after=0&limit=100&wait=0', scout.token),
    ];
    for (const read of reads) assert.ok(read.status < 500, read.text);
    const surfaces = reads.map(read => read.text).concat(written);
    for (const value of [secret, failingSecret]) {
      for (const text of surfaces) assert.equal(text.includes(value), false, 'a read or a log line holds the secret');
    }
    assert.equal(surfaces.some(text => text.includes('RECEIVER-BODY-MARKER')), false, 'a receiver body was echoed');
    assert.equal(surfaces.some(text => text.includes('path-token')), false, 'the URL path was shown');
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  // On disk: only the registrations file holds a secret (control: it does),
  // and no file holds a receiver's answer.
  const files = filesUnder(dataDir);
  const holders = files.filter(([, bytes]) => bytes.includes(secret)).map(([file]) => path.relative(dataDir, file));
  assert.deepEqual(holders, ['webhooks.json'], 'control: the scan finds the one file that must hold it');
  assert.equal(files.some(([, bytes]) => bytes.includes(failingSecret) && !bytes.includes(secret)), false);
  assert.equal(files.some(([, bytes]) => bytes.includes('RECEIVER-BODY-MARKER')), false);
  const mode = fs.statSync(path.join(dataDir, 'webhooks.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('a seat removed while its ring is retried is not called again', async () => {
  const { runtime, owner, device, names } = await setUp();
  const S = names.scout;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const server = http.createServer(async (request, response) => {
    request.resume();
    seen.push(request.url);
    if (seen.length === 1) await gate;
    response.writeHead(500);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  receivers.add(server);
  const set = await room.post(runtime, '/api/settings/webhooks/set',
    { name: S, url: `http://127.0.0.1:${server.address().port}/` }, owner);
  assert.equal(set.status, 200, set.text);
  await room.post(runtime, '/api/messages', { text: `@${S} are you there` }, owner);
  await eventually(() => seen.length === 1, 'the first attempt is in flight');
  const elevated = await room.elevate(runtime, await room.login(runtime), device);
  const removed = await room.post(runtime, '/api/participants/revoke', { name: S }, elevated);
  assert.equal(removed.status, 200, removed.text);
  release();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(seen.length, 1, 'no retry reached a removed seat');
});

test('a seat that leaves takes its registration and secret with it; a leftover is listed and deletable', async () => {
  const { runtime, owner, scout, other, names, dataDir } = await setUp();
  const S = names.scout;
  const O = names.other;
  const target = await receiver();
  const first = (await room.post(runtime, '/api/settings/webhooks/set',
    { name: S, url: `http://127.0.0.1:${target.port}/` }, owner)).json.secret;
  const second = (await room.post(runtime, '/api/settings/webhooks/set',
    { name: O, url: `http://127.0.0.1:${target.port}/` }, owner)).json.secret;
  assert.equal((await room.aiPost(runtime, '/api/ai/leave', {}, scout.token)).status, 200);
  assert.equal((await room.aiPost(runtime, '/api/ai/leave', {}, other.token)).status, 200);
  // Until the room clears it, a leftover is listed with an id.
  const listed = await room.get(runtime, '/api/settings/webhooks', owner);
  assert.equal(listed.json.seats.some(row => row.name === S || row.name === O), false);
  assert.equal(listed.json.ended.length >= 2, true, JSON.stringify(listed.json.ended));
  assert.equal(listed.text.includes(first), false);
  const leftover = listed.json.ended[0];
  const deleted = await room.post(runtime, '/api/settings/webhooks/delete', { ended: leftover.id }, owner);
  assert.equal(deleted.status, 200, deleted.text);
  // Any change clears the rest (the room also does every minute).
  const fresh = await setUp();
  await room.post(runtime, '/api/settings/webhooks/set',
    { name: fresh.names.scout, url: `http://127.0.0.1:${target.port}/` }, fresh.owner);
  const after = await room.get(runtime, '/api/settings/webhooks', fresh.owner);
  assert.deepEqual(after.json.ended, []);
  const onDisk = fs.readFileSync(path.join(dataDir, 'webhooks.json'), 'utf8');
  assert.equal(onDisk.includes(first), false, 'the gone seat\'s secret is erased');
  assert.equal(onDisk.includes(second), false);
  // The audit file holds no secret.
  const audit = fs.readFileSync(path.join(dataDir, 'webhooks-audit.jsonl'), 'utf8');
  assert.equal(audit.includes('ilwh_'), false);
});

test('a webhook ring for an answer to the seat\'s ask carries kind reply, a string, never a Promise', async () => {
  const { runtime, owner, scout, names } = await setUp();
  const S = names.scout;
  const target = await receiver();
  const set = await room.post(runtime, '/api/settings/webhooks/set', { name: S, url: `http://127.0.0.1:${target.port}/hook` }, owner);
  assert.equal(set.status, 200, set.text);
  const asked = await room.aiPost(runtime, '/api/ai/annotated-messages', {
    text: 'may I merge?', client_message_id: crypto.randomUUID(),
    annotation: { ask: { of: 'Ana', means: 'I merge the candidate and nothing else' } },
  }, scout.token);
  assert.equal(asked.status, 201, asked.text);
  // Arrangement: the seat's own ask rings nobody's webhook.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(target.seen.length, 0, 'arrangement: no call before the answer');
  const answer = await room.post(runtime, '/api/annotated-messages',
    { text: 'yes', annotation: { answers: [{ ask_id: asked.json.message.id, choice: 'yes' }] } }, owner);
  assert.equal(answer.status, 201, answer.text);
  await eventually(() => target.seen.length >= 1, 'the answer called the webhook');
  const body = JSON.parse(target.seen[0].body);
  assert.equal(body.message_id, answer.json.message.id);
  assert.equal(typeof body.kind, 'string', 'kind is a string (an un-awaited Promise would serialize as {})');
  assert.equal(body.kind, 'reply', 'the webhook says reply for an answer, as stdout does (C4)');
  assert.equal(Ring.validRing(body), true);
});
