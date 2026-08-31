'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IDLE_MS, SETTINGS_ENDED_MS, releaseIdleSeats } = require('../src/idle.js');
const { readRoomSettings, writeRoomSettings } = require('../src/room_settings.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fakeStore(activity) {
  return {
    coordinateIdleRelease({ seats, now, idleMs, commit }) {
      const subject_ids = seats.filter(row => {
        const lastHeard = activity.get(row.subject_id);
        const contact = Number.isSafeInteger(lastHeard) ? lastHeard : row.created_at;
        return contact + idleMs <= now;
      }).map(row => row.subject_id);
      if (subject_ids.length === 0) return 0;
      return commit(subject_ids);
    },
  };
}

test('24 hours of no listen/history/say contact releases the seat', async () => {
  const created = 1_000;
  const heard = created + 60_000;
  const released = [];
  const house = {
    listParticipants() {
      return [{
        subject_id: 'seat-1', name: 'Marlow', kind: 'seat', created_at: created,
      }];
    },
    releaseIdleSeats(meta) {
      released.push(meta);
      return meta.subject_ids.length;
    },
  };
  const activity = new Map([['seat-1', heard]]);
  const store = fakeStore(activity);
  assert.equal(await releaseIdleSeats({ house, store, now: heard + IDLE_MS - 1 }), 0);
  assert.equal(released.length, 0);
  assert.equal(await releaseIdleSeats({ house, store, now: heard + IDLE_MS }), 1);
  assert.deepEqual(released[0], { now: heard + IDLE_MS, subject_ids: ['seat-1'] });
});

test('a quiet listener is not idle because last_heard is recent', async () => {
  const now = Date.now();
  const house = {
    listParticipants() {
      return [{ subject_id: 'seat-1', name: 'Marlow', kind: 'seat', created_at: now - IDLE_MS }];
    },
    releaseIdleSeats() { throw new Error('must not release'); },
  };
  const store = fakeStore(new Map([['seat-1', now - 60_000]]));
  assert.equal(await releaseIdleSeats({ house, store, now }), 0);
});

test('never-heard seats measure idle from created_at', async () => {
  const created = 5_000;
  const house = {
    listParticipants() {
      return [{ subject_id: 'seat-1', name: 'Marlow', kind: 'seat', created_at: created }];
    },
    releaseIdleSeats(meta) { return meta.subject_ids.length; },
  };
  const store = fakeStore(new Map());
  assert.equal(await releaseIdleSeats({ house, store, now: created + IDLE_MS }), 1);
});

test('contact after a stale idle snapshot is not released', async () => {
  const created = 0;
  const released = [];
  const house = {
    listParticipants() {
      return [{ subject_id: 'seat-1', name: 'Marlow', kind: 'seat', created_at: created }];
    },
    releaseIdleSeats(meta) {
      released.push(meta.subject_ids.slice());
      return meta.subject_ids.length;
    },
  };
  const activity = new Map([['seat-1', created]]);
  const store = {
    coordinateIdleRelease({ seats, now, idleMs, commit }) {
      activity.set('seat-1', now);
      const subject_ids = seats.filter(row => {
        const lastHeard = activity.get(row.subject_id);
        const contact = Number.isSafeInteger(lastHeard) ? lastHeard : row.created_at;
        return contact + idleMs <= now;
      }).map(row => row.subject_id);
      return commit(subject_ids);
    },
  };
  assert.equal(await releaseIdleSeats({ house, store, now: created + IDLE_MS }), 0);
  assert.deepEqual(released, [[]]);
});

test('room settings default to allowing ended-name reuse and persist a refusal', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-room-settings-'));
  assert.equal(readRoomSettings(dataDir).allow_ended_reuse, true);
  assert.equal(writeRoomSettings(dataDir, { allow_ended_reuse: false }).allow_ended_reuse, false);
  assert.equal(readRoomSettings(dataDir).allow_ended_reuse, false);
  assert.equal(SETTINGS_ENDED_MS, 7 * 24 * 60 * 60 * 1000);
});

test('existing malformed room settings fail closed instead of defaulting to allow', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-room-settings-bad-'));
  fs.writeFileSync(path.join(dataDir, 'room-settings.json'), '{"extra":true,"allow_ended_reuse":false}\n');
  assert.throws(() => readRoomSettings(dataDir), /invalid-settings/);
  fs.writeFileSync(path.join(dataDir, 'room-settings.json'), '{not json');
  assert.throws(() => readRoomSettings(dataDir), /invalid-settings/);
  fs.writeFileSync(path.join(dataDir, 'room-settings.json'), '{"allow_ended_reuse":"no"}\n');
  assert.throws(() => readRoomSettings(dataDir), /invalid-settings/);
});
