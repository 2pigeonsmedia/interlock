'use strict';

// POST /api/ring-preview over HTTP: a signed-in person asks whom a post would
// ring, and gets the room's own answer. It is view-only: nothing is posted.
// Its own file: one real server per process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { admitSeat, aiPost, bootstrap, call, elevate, get, login, post, startRoom } = require('./helpers/room_server.js');

let room = null;
test.after(async () => { if (room) await room.runtime.close(); });

async function setUp() {
  if (room) return room;
  const { runtime } = await startRoom('interlock-ring-preview-');
  const device = await bootstrap(runtime);
  const ana = await elevate(runtime, await login(runtime), device);
  const rowan = await admitSeat(runtime, ana, 'Rowan');
  room = { runtime, ana, rowan };
  return room;
}

async function head(runtime, session) {
  const page = await get(runtime, '/api/messages?after=0&limit=100&wait=0', session);
  assert.equal(page.status, 200, page.text);
  return page.json.messages.length;
}

test('a person previews an untagged reply and the room names the AI that addressed her, as the send then rings', async () => {
  const { runtime, ana, rowan } = await setUp();
  const asked = await aiPost(runtime, '/api/ai/messages',
    { text: '@Ana shall I rerun the suite?', client_message_id: crypto.randomUUID() }, rowan.token);
  assert.equal(asked.status, 201, asked.text);
  const before = await head(runtime, ana);
  const preview = await post(runtime, '/api/ring-preview', { text: 'yes please' }, ana);
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json, { ok: true, recipients: ['Rowan'] });
  assert.equal(await head(runtime, ana), before, 'the preview posted nothing');
  const sent = await post(runtime, '/api/messages', { text: 'yes please' }, ana);
  assert.equal(sent.status, 201, sent.text);
  assert.deepEqual(sent.json.message.delivery.map(row => row.name), ['Rowan'], 'the send rang whom the preview named');
});

test('a preview with an annotation runs the same rules: an ask rings the AI asked', async () => {
  const { runtime, ana } = await setUp();
  const preview = await post(runtime, '/api/ring-preview',
    { text: 'can you check the build?', annotation: { ask: { of: 'Rowan' } } }, ana);
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.recipients, ['Rowan']);
});

test('a preview refuses as the send would', async () => {
  const { runtime, ana } = await setUp();
  const unknown = await post(runtime, '/api/ring-preview', { text: 'x', annotation: { ask: { of: 'Nobody' } } }, ana);
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(unknown.json.error, 'ask-target-unknown');
  const shape = await post(runtime, '/api/ring-preview', { text: 'x', extra: 1 }, ana);
  assert.equal(shape.status, 400, shape.text);
});

test('a preview needs a signed-in person and the request envelope', async () => {
  const { runtime, ana, rowan } = await setUp();
  const signedOut = await post(runtime, '/api/ring-preview', { text: 'x' }, {});
  assert.equal(signedOut.status, 401, signedOut.text);
  const noCsrf = await post(runtime, '/api/ring-preview', { text: 'x' }, { cookie: ana.cookie });
  assert.notEqual(noCsrf.status, 200, 'no CSRF token, no preview');
  const asAi = await aiPost(runtime, '/api/ring-preview', { text: 'x' }, rowan.token);
  assert.notEqual(asAi.status, 200, 'the page route is for a signed-in person');
  const read = await call(runtime, { path: '/api/ring-preview', headers: { cookie: ana.cookie } });
  assert.ok([404, 405].includes(read.status), `a GET is not a preview (${read.status})`);
});
