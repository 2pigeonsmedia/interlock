'use strict';

// A20 (an addition; the owner's yes at the GO): a webhook seat whose last
// delivery did not fail is kept through a quiet day; once its webhook is
// unreachable idle release applies again; its pass expiry ends it either way.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { releaseIdleSeats, IDLE_MS } = require('../src/idle.js');
const { webhookIdleExempt } = require('../src/server.js');
const { openWebhookStore } = require('../src/webhooks/store.js');

const NOW = 1_800_000_000_000;
const DAY_AGO = NOW - IDLE_MS - 60_000;

// The idle pass with the real rule's inputs; the store answers which seats
// were last heard over a day ago (all of them) and records what was released.
function idlePass(roster, exempt) {
  const released = [];
  const house = {
    listParticipants: () => roster,
    releaseIdleSeats: ({ subject_ids }) => { released.push(...subject_ids); return subject_ids.length; },
  };
  const store = {
    coordinateIdleRelease: ({ seats, now, idleMs, commit }) => {
      const idle = seats.filter(seat => seat.created_at + idleMs <= now).map(seat => seat.subject_id);
      return idle.length ? commit(idle) : 0;
    },
  };
  return Promise.resolve(releaseIdleSeats({ house, store, now: NOW, exempt })).then(() => released);
}

const seat = (subject_id, kind) => ({ subject_id, name: subject_id, kind: 'seat', created_at: DAY_AGO,
  presence_kind: kind ? { kind, since: DAY_AGO, next: null } : null });

test('a quiet day: a webhook seat that has not failed is kept; a seat without one is released', async () => {
  const roster = [seat('hooked', 'listening'), seat('plain', 'away')];
  const kept = webhookIdleExempt(roster, id => id === 'hooked');
  assert.deepEqual([...kept], ['hooked']);
  assert.deepEqual(await idlePass(roster, kept), ['plain']);
  // Arrangement control: with no exemption, both are a day idle and both go.
  assert.deepEqual((await idlePass(roster, new Set())).sort(), ['hooked', 'plain']);
});

test('once its webhook is unreachable, idle release applies again', async () => {
  const roster = [seat('hooked', 'unreachable')];
  const kept = webhookIdleExempt(roster, () => true);
  assert.equal(kept.size, 0);
  assert.deepEqual(await idlePass(roster, kept), ['hooked']);
});

test('a rung webhook seat is kept too (its last delivery succeeded)', async () => {
  const roster = [seat('hooked', 'rung')];
  assert.deepEqual(await idlePass(roster, webhookIdleExempt(roster, () => true)), []);
});

test('pass expiry still ends it: an expired seat is not in the roster, so it is not kept, and its webhook is erased as ended', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-webhook-idle-'));
  const store = openWebhookStore({ dataDir });
  store.register('expired-seat', { url: 'http://127.0.0.1:9/' });
  // The roster the room reads lists live, unexpired seats only.
  const roster = [];
  assert.equal(webhookIdleExempt(roster, id => store.has(id)).has('expired-seat'), false);
  // The identity record lists an expired seat among the ended ones.
  assert.equal(store.eraseEnded(new Set(['expired-seat'])), 1);
  assert.equal(store.has('expired-seat'), false);
});

test('the exemption never makes a delivered ring count as contact', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /delivered:\s*subjectId\s*=>\s*\{\s*chat\.touchParticipant/);
});
