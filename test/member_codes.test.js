'use strict';

// The member-code store's own rules (#821): off by default, three unused per
// member, fifteen minutes, one knock each (a re-knock with the same request id
// reads the same issuer), a cancelled code is no one's, and only digests on
// disk, in files of their own.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createMemberCodes, CODE_TTL_MS, MAX_UNUSED_PER_MEMBER, CODES_FILE, SETTINGS_FILE } = require('../src/member_codes.js');

const BEA = { subject_id: 'bea-1', name: 'Bea' };

function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-member-codes-'));
  const clock = { now: 1_800_000_000_000 };
  const codes = createMemberCodes({ dataDir, clock: () => clock.now });
  return { dataDir, clock, codes };
}

test('off until the first owner turns it on; absent settings read OFF', () => {
  const { codes } = rig();
  assert.equal(codes.enabled(), false);
  assert.deepEqual(codes.issue(BEA), { ok: false, reason: 'member-codes-off' });
  codes.setEnabled(true);
  assert.equal(codes.issue(BEA).ok, true);
});

test('three unused codes per member; a used or cancelled one frees a place', () => {
  const { codes } = rig();
  codes.setEnabled(true);
  const made = [];
  for (let i = 0; i < MAX_UNUSED_PER_MEMBER; i += 1) made.push(codes.issue(BEA));
  assert.deepEqual(codes.issue(BEA), { ok: false, reason: 'code-cap' });
  assert.equal(codes.issue({ subject_id: 'cal-1', name: 'Cal' }).ok, true, 'another member is not capped by Bea');
  assert.equal(codes.cancel(made[0].id, BEA.subject_id).ok, true);
  assert.equal(codes.issue(BEA).ok, true);
});

test('one knock per code; the same request id reads back the same issuer; a cancelled code is no one\'s', () => {
  const { codes } = rig();
  codes.setEnabled(true);
  const made = codes.issue(BEA);
  const requestId = crypto.randomUUID();
  const first = codes.reserve(made.code, requestId);
  assert.deepEqual([first.ok, first.fresh, first.issuer.name], [true, true, 'Bea']);
  const again = codes.reserve(made.code, requestId);
  assert.deepEqual([again.ok, again.fresh], [true, false], 'a re-knock keeps it');
  assert.deepEqual(codes.reserve(made.code, crypto.randomUUID()), { ok: false, reason: 'invalid-join-code' });
  assert.deepEqual(codes.issuerOf(requestId), { subject_id: 'bea-1', name: 'Bea' });
  const other = codes.issue(BEA);
  const otherId = crypto.randomUUID();
  assert.equal(codes.reserve(other.code, otherId).ok, true);
  assert.equal(codes.release(otherId), true);
  assert.equal(codes.issuerOf(otherId), null, 'released: not bound');
  assert.equal(codes.reserve(other.code, otherId).ok, true, 'and usable again');
});

test('a code expires after fifteen minutes', () => {
  const { codes, clock } = rig();
  codes.setEnabled(true);
  const made = codes.issue(BEA);
  clock.now += CODE_TTL_MS;
  assert.deepEqual(codes.reserve(made.code, crypto.randomUUID()), { ok: false, reason: 'invalid-join-code' });
  assert.equal(codes.list()[0].state, 'expired');
});

test('turned off again: no new code, and no knock can use an old one', () => {
  const { codes } = rig();
  codes.setEnabled(true);
  const made = codes.issue(BEA);
  codes.setEnabled(false);
  assert.deepEqual(codes.reserve(made.code, crypto.randomUUID()), { ok: false, reason: 'invalid-join-code' });
});

test('on disk: only digests, in files of their own', () => {
  const { codes, dataDir } = rig();
  codes.setEnabled(true);
  const made = codes.issue(BEA);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), [CODES_FILE, SETTINGS_FILE].sort());
  const raw = fs.readFileSync(path.join(dataDir, CODES_FILE), 'utf8');
  assert.equal(raw.includes(made.code.replace('-', '')), false, 'the code itself is never written');
  assert.equal(raw.includes(made.code), false);
});
