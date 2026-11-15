'use strict';

// presence_kind: why a participant is or isn't answering, computed by the
// room (owner's ruling on #938, 2026-11-15: "working" only on a declared
// pause; any other silence reads away within minutes).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PresenceKind = require('../src/chat/presence_kind.js');
const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_800_000_000_000;

function seat(overrides) {
  return PresenceKind.seatKind(Object.assign({
    now: T0, started_at: T0 - 10 * HOUR, created_at: T0 - 9 * HOUR,
    last_polled_at: null, last_posted_at: null, pause: null, resumed_at: null, webhook: null,
  }, overrides));
}

test('listening: a poll under two minutes ago', () => {
  const kind = seat({ last_polled_at: T0 - MINUTE });
  assert.deepEqual(kind, { kind: 'listening', since: T0 - MINUTE, next: null });
  assert.equal(seat({ last_polled_at: T0 - 2 * MINUTE }).kind, 'away', 'two minutes is the edge: away');
});

test('working only on a declared pause, never inferred from a gap (#938)', () => {
  // The Dunlin / Opus-Claude2 specimen: the doorbell's Monitor expired after
  // its last poll 40 minutes ago. 0.3.11 read that as "working" for 3 hours.
  const dead = seat({ last_polled_at: T0 - 40 * MINUTE });
  assert.equal(dead.kind, 'away');
  assert.equal(dead.since, T0 - 40 * MINUTE);
  assert.match(dead.next, /will not wake it/);
  const paused = seat({ last_polled_at: T0 - 40 * MINUTE, pause: { reason: 'turn', since: T0 - 39 * MINUTE, renewed_at: T0 - 39 * MINUTE } });
  assert.deepEqual(paused, { kind: 'working', since: T0 - 39 * MINUTE, next: 'picks up after its turn' });
});

test('a pause expires at three hours unless renewed; expired reads away since the pause', () => {
  const since = T0 - 3 * HOUR;
  assert.equal(seat({ pause: { reason: 'turn', since, renewed_at: since + 1 } }).kind, 'working', 'one ms inside');
  const expired = seat({ pause: { reason: 'turn', since, renewed_at: since } });
  assert.deepEqual([expired.kind, expired.since], ['away', since]);
  const renewed = seat({ pause: { reason: 'turn', since: T0 - 5 * HOUR, renewed_at: T0 - HOUR } });
  assert.deepEqual([renewed.kind, renewed.since], ['working', T0 - 5 * HOUR], 'a renewal keeps when the turn began');
});

test('unknown after a restart until the seat polls; a seat admitted since reads away', () => {
  const restarted = seat({ started_at: T0 - 5 * MINUTE, created_at: T0 - HOUR });
  assert.deepEqual(restarted, { kind: 'unknown', since: T0 - 5 * MINUTE, next: 'waits for its next poll' });
  const fresh = seat({ started_at: T0 - HOUR, created_at: T0 - 5 * MINUTE });
  assert.deepEqual([fresh.kind, fresh.since], ['away', T0 - 5 * MINUTE], 'admitted after the start, never polled');
  const resumed = seat({ started_at: T0 - HOUR, created_at: T0 - 2 * HOUR, resumed_at: T0 - 10 * MINUTE });
  assert.deepEqual([resumed.kind, resumed.since], ['away', T0 - 10 * MINUTE], 'a resume is a signal: not unknown');
});

test('webhook: rung until it answers, listening at rest, unreachable after one failed delivery', () => {
  const rungAt = T0 - 5 * MINUTE;
  const hook = last => ({ registered: true, last });
  assert.equal(seat({ webhook: hook({ ok: true, at: rungAt, error_class: null }) }).kind, 'rung');
  assert.equal(seat({ webhook: hook({ ok: true, at: rungAt, error_class: null }), last_posted_at: rungAt + 1 }).kind,
    'listening', 'it posted after the ring');
  // MED-2: no delivery since this server started: not known, never an all-clear.
  const rest = seat({ webhook: hook(null) });
  assert.deepEqual(rest, { kind: 'unknown', since: T0 - 10 * HOUR, next: 'waits for its next ring' });
  const delivered = seat({ webhook: hook({ ok: true, at: rungAt, error_class: null }), last_posted_at: rungAt + 1 });
  assert.deepEqual(delivered, { kind: 'listening', since: rungAt, next: 'the room rings it by webhook' },
    'a good delivery it answered: listening by webhook');
  const failed = seat({ webhook: hook({ ok: false, at: rungAt, error_class: 'timeout' }), last_polled_at: T0 - 1000 });
  assert.equal(failed.kind, 'unreachable', 'the alarm outranks a fresh poll');
  assert.match(failed.next, /\(timeout\).*Settings/);
});

test('ended seats: left (an act) names who has the work; ended (time) names the way back', () => {
  assert.deepEqual(PresenceKind.endedKind('left', T0, 'Boubou'), { kind: 'left', since: T0, next: 'its work went to Boubou' });
  assert.equal(PresenceKind.endedKind('removed', T0, null).kind, 'left');
  for (const how of ['released', 'expired', 'legacy']) assert.equal(PresenceKind.endedKind(how, T0, null).kind, 'ended', how);
});

test('every kind the module can produce passes its own validator', () => {
  const all = [
    seat({ last_polled_at: T0 }), seat({ pause: { reason: 'turn', since: T0, renewed_at: T0 } }),
    seat({ webhook: { registered: true, last: { ok: true, at: T0 - 1, error_class: null } } }),
    seat({ webhook: { registered: true, last: { ok: false, at: T0 - 1, error_class: 'tls' } } }),
    seat({}), seat({ started_at: T0, created_at: T0 - 1 }),
    PresenceKind.endedKind('left', T0, 'X'), PresenceKind.endedKind('expired', T0, null),
    PresenceKind.pendingKind(T0, 'K7Q2X'), PresenceKind.personKind(T0, T0), PresenceKind.personKind(null, T0),
  ];
  assert.deepEqual([...new Set(all.map(kind => kind.kind))].sort(),
    ['away', 'ended', 'here', 'left', 'listening', 'pending', 'rung', 'unknown', 'unreachable', 'working']);
  for (const kind of all) assert.ok(PresenceKind.validPresenceKind(kind), JSON.stringify(kind));
  assert.equal(PresenceKind.validPresenceKind({ kind: 'busy', since: null, next: null }), false, 'control: unknown word');
  assert.equal(PresenceKind.validPresenceKind({ kind: 'away', since: null, next: null, extra: 1 }), false, 'control: extra key');
});

const ANA = '11111111-1111-4111-8111-111111111111';
const CUE = '22222222-2222-4222-8222-222222222222';

function service(createdAt, hooked = new Set()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-presence-kind-'));
  return createChatService({
    store: openStore({ dataDir: dir }),
    hasWebhook: subjectId => hooked.has(subjectId),
    participants: () => [
      { subject_id: ANA, name: 'Ana', kind: 'person', created_at: createdAt },
      { subject_id: CUE, name: 'Cue', kind: 'seat', created_at: createdAt },
    ],
  });
}

async function kindOf(chat, name) {
  return (await chat.listParticipants()).find(row => row.name === name).presence_kind;
}

test('service: pause → working; a poll clears it → listening; resume clears it → away', async () => {
  const chat = service(Date.now() + 1000); // admitted after the service started
  assert.equal((await kindOf(chat, 'Cue')).kind, 'away', 'arrangement: admitted after start, never polled');
  const pause = chat.notePause(CUE, { reason: 'turn' });
  assert.equal(pause.reason, 'turn');
  assert.equal(pause.expires_at - pause.since, PresenceKind.PAUSE_MS);
  assert.equal((await kindOf(chat, 'Cue')).kind, 'working');
  chat.notePoll(CUE, Date.now());
  assert.equal((await kindOf(chat, 'Cue')).kind, 'listening', 'any poll ends the pause');
  chat.notePause(CUE, {});
  assert.equal((await kindOf(chat, 'Cue')).kind, 'working', 'reason defaults to turn');
  assert.equal(chat.notePause(CUE, null), null);
  const after = await kindOf(chat, 'Cue');
  assert.equal(after.kind, 'listening', 'resumed, and its poll is still under two minutes old');
  assert.throws(() => chat.notePause(CUE, { reason: 'lunch' }), { code: 'invalid-pause' });
  assert.throws(() => chat.notePause(CUE, { reason: 'turn', extra: 1 }), { code: 'invalid-pause' });
  await chat.close();
});

test('service: hasWebhook and noteWebhookDelivery drive rung, listening and unreachable', async () => {
  const hooked = new Set();
  const chat = service(Date.now() + 1000, hooked);
  chat.noteWebhookDelivery(CUE, { ok: false, at: Date.now(), error_class: '5xx' });
  assert.equal((await kindOf(chat, 'Cue')).kind, 'away', 'control: no registration, so a delivery says nothing');
  hooked.add(CUE);
  assert.equal((await kindOf(chat, 'Cue')).kind, 'unreachable', 'registered: one failed delivery is enough (A6)');
  chat.noteWebhookDelivery(CUE, { ok: true, at: Date.now() });
  assert.equal((await kindOf(chat, 'Cue')).kind, 'rung', 'the next 2xx clears it');
  chat.notePoll(CUE, Date.now());
  assert.equal((await kindOf(chat, 'Cue')).kind, 'listening', 'answered (a poll; a post is covered above)');
  assert.equal((await kindOf(chat, 'Cue')).kind, 'listening', 'idle and registered: listening, never away (A8)');
  hooked.delete(CUE);
  assert.equal((await kindOf(chat, 'Cue')).next, null, 'deleted: listening by its own poll now, not by webhook');
  assert.throws(() => chat.noteWebhookDelivery(CUE, { ok: false, at: Date.now() }), { code: 'invalid-delivery' },
    'a failure names its class');
  assert.throws(() => chat.noteWebhookDelivery(CUE, { ok: false, at: Date.now(), error_class: 'https://x/secret' }),
    { code: 'invalid-delivery' }, 'never a URL: only the class');
  await chat.close();
});

test('service: a person is here when heard in five minutes, away after', async () => {
  const chat = service(Date.now() + 1000); // admitted after the service started
  assert.equal((await kindOf(chat, 'Ana')).kind, 'away', 'never heard');
  await chat.touchParticipant(ANA, Date.now());
  assert.equal((await kindOf(chat, 'Ana')).kind, 'here');
  await chat.close();
});

test('service: a seat admitted before this server started reads unknown until its next poll', async () => {
  const chat = service(Date.now() - HOUR);
  assert.equal((await kindOf(chat, 'Cue')).kind, 'unknown');
  chat.notePoll(CUE, Date.now());
  assert.equal((await kindOf(chat, 'Cue')).kind, 'listening');
  await chat.close();
});

test('the page knows exactly the kinds the room can send', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
  const listed = /const PRESENCE_KINDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(page);
  assert.ok(listed, 'arrangement: room.js declares PRESENCE_KINDS');
  const kinds = [...listed[1].matchAll(/'([a-z]+)'/g)].map(match => match[1]);
  assert.deepEqual(kinds, [...PresenceKind.KINDS]);
});
