'use strict';

// Settings lists every live participant and every seat ended in the last
// week. The chat store reads at most 64 participants per call, and a room
// with a few people and nineteen seats a day passes that on its fourth day,
// so the list must not depend on fitting in one call.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createFirstOwnerHandler } = require('../src/first_owner.js');

const ORIGIN = 'http://localhost:4100';

function stubs(names) {
  return Object.fromEntries(names.map(name => [name, () => { throw new Error(`unexpected call: ${name}`); }]));
}

function roomWith(liveSeats, endedSeats) {
  const calls = [];
  const person = { subject_id: 'person-1', name: 'Ana', kind: 'person' };
  const seat = (prefix, index) => ({ subject_id: `${prefix}-${index}`, name: `${prefix}${index}`, kind: 'seat',
    session: null, product: 'Codex CLI', product_provenance: 'client-reported' });
  const live = Array.from({ length: liveSeats }, (_, index) => seat('Live', index + 1));
  const ended = Array.from({ length: endedSeats }, (_, index) => Object.assign(seat('Ended', index + 1),
    { ended_at: 1_000 + index }));
  const house = Object.assign(stubs([
    'authorizeWrite', 'authorizeSeatBearer', 'aiSessionDiscriminator', 'resolveSession',
    'listParticipants', 'releaseIdleSeats', 'listAiSeatHistory', 'invite',
    'redeem', 'revokeParticipant', 'grantAdministrator', 'revokeAdministrator',
    'issuePasskeyCode', 'endOwnSeat', 'changePassword', 'signOutOtherSessions', 'confirmTranscriptClear',
  ]), {
    authorizeRead: () => ({ allow: true, subject_id: 'person-1' }),
    whoami: () => ({ subject_id: 'person-1', kind: 'person', name: 'Ana', roles: [{ slug: 'administrator' }] }),
    listRecentEndedSeats: () => ended,
    administrators: () => ({ ok: true, manage: true, people: [{ name: 'Ana', admin: true, first_owner: true, passkey: true }] }),
    firstOwner: { status: () => ({ completed: true, in_progress: false }) },
    authenticators: {},
    sessions: {},
    login: {},
  });
  const chat = Object.assign(stubs([
    'append', 'read', 'readForSeat', 'wait', 'waitForSeat', 'waitForSeatRings', 'acknowledge', 'touchParticipant',
    'readDeliveryChanges', 'transcriptCleared', 'peekBefore', 'peekFind',
    // Later releases add these; stubbing them keeps the test valid on either line.
    'annotate', 'appendAnnotated', 'openAsks', 'readAnnotations',
  ]), {
    listParticipants: async () => [person, ...live],
    // The store's own bound: more than 64 ids in one call is refused.
    participantState: async ids => {
      calls.push(ids.length);
      if (ids.length > 64) throw Object.assign(new Error('invalid-activity'), { code: 'invalid-activity' });
      return ids.map(id => ({ subject_id: id, last_heard: 5, outstanding: 0, fetched_without_post_at: null }));
    },
  });
  const handler = createFirstOwnerHandler({
    house, chat,
    admission: stubs(['knock', 'list', 'allow', 'decline']),
    archive: stubs(['exportTranscript', 'clearTranscript', 'listArchives', 'readArtifact']),
    origin: ORIGIN,
    assets: { setup: {}, room: {} },
    releaseIdle: async () => undefined,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-settings-many-')),
  });
  return { handler, calls };
}

async function settings(handler, query = '') {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, headersSent: false, statusCode: 200, body: '',
    setHeader() {},
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; },
  });
  const request = Object.assign(Readable.from([]), {
    method: 'GET', url: '/api/settings/participants' + query,
    headers: { host: 'localhost:4100', cookie: 'session=x' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  await handler(request, response);
  return { status: response.statusCode, json: JSON.parse(response.body) };
}

test('Settings lists a room with more than 64 participants in its window', async () => {
  const small = roomWith(3, 60);
  const fits = await settings(small.handler, '?ended=all');
  assert.equal(fits.status, 200, 'ARRANGEMENT: 64 participants fit one call');
  assert.equal(fits.json.participants.length, 64);

  const busy = roomWith(19, 57);
  const answered = await settings(busy.handler, '?ended=all');
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.equal(answered.json.participants.length, 77, 'one person, 19 live seats and 57 ended seats');
  assert.equal(answered.json.ended_more, 0);
  assert.ok(busy.calls.every(count => count <= 64), `every store call stays within its bound: ${busy.calls}`);
  const seatRows = answered.json.participants.filter(row => row.kind === 'seat');
  assert.ok(seatRows.every(row => row.last_heard === 5), 'every seat, in every batch, carries its state');
});

test('Settings lists the 50 newest ended seats and counts the rest', async () => {
  const busy = roomWith(19, 57);
  const page = await settings(busy.handler);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  const ended = page.json.participants.filter(row => row.live === false);
  assert.equal(ended.length, 50);
  assert.equal(page.json.ended_more, 7);
  assert.equal(page.json.participants.filter(row => row.live === true).length, 20, 'live participants are never paged');
  assert.ok(ended.every(row => row.ended_at >= 1_000 + 7), 'the newest ended seats are the ones listed');
  const refused = await settings(busy.handler, '?ended=some');
  assert.equal(refused.status, 400);
});
