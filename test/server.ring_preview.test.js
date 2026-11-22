'use strict';

// POST /api/ring-preview over HTTP: a signed-in person asks whom a post would
// ring, and gets the room's own answer. It is view-only: nothing is posted.
// Its own file: one real server per process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
  // A passive read, like the People poll: the same-origin envelope guards it.
  const crossSite = await post(runtime, '/api/ring-preview', { text: 'x' }, ana, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403, crossSite.text);
  const noOrigin = await post(runtime, '/api/ring-preview', { text: 'x' }, ana, { origin: 'https://elsewhere.example' });
  assert.equal(noOrigin.status, 403, noOrigin.text);
  const asAi = await aiPost(runtime, '/api/ring-preview', { text: 'x' }, rowan.token);
  assert.notEqual(asAi.status, 200, 'the page route is for a signed-in person');
  const read = await call(runtime, { path: '/api/ring-preview', headers: { cookie: ana.cookie } });
  assert.ok([404, 405].includes(read.status), `a GET is not a preview (${read.status})`);
});

test('the preview refuses what a send refuses, with the send\'s own answer', async () => {
  const { runtime, ana } = await setUp();
  const cases = [
    ['empty text', { text: '' }, '/api/messages'],
    ['text over 32 KiB', { text: 'x'.repeat(33 * 1024) }, '/api/messages'],
    ['a NUL in the text', { text: 'hello\u0000there' }, '/api/messages'],
    ['annotation null', { text: 'hello', annotation: null }, '/api/annotated-messages'],
  ];
  const before = await head(runtime, ana);
  for (const [label, body, sendRoute] of cases) {
    const sent = await post(runtime, sendRoute, body, ana);
    assert.equal(sent.status, 400, `arrangement: the send refuses ${label} (${sent.text})`);
    const preview = await post(runtime, '/api/ring-preview', body, ana);
    assert.deepEqual([preview.status, preview.json && preview.json.error], [sent.status, sent.json.error], label);
  }
  assert.equal(await head(runtime, ana), before, 'nothing was posted');
  const fine = await post(runtime, '/api/ring-preview', { text: 'hello' }, ana);
  assert.equal(fine.status, 200, 'control: an ordinary draft still previews');
});

test('the protocol describes the preview as a passive, view-only read with a send\'s rules', () => {
  const protocol = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PROTOCOL.md'), 'utf8');
  assert.match(protocol, /`POST \/api\/ring-preview`[\s\S]{0,600}same recipient rules[\s\S]{0,300}view-only and a\s+passive read/);
});
