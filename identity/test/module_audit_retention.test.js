'use strict';

// The telemetry audit streams rotated at MAX_BYTES but never pruned, so an
// installation's audit directory grew to several gigabytes (one spinning
// browser tab was enough). Rotation now keeps at most MAX_SEGMENTS older
// segments per stream, removing the oldest first. Mutation rows are not
// telemetry and are untouched by this.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const F = require('./fixture.js');

function segmentsOf(dir, stream) {
  return fs.readdirSync(dir).filter(name => name.startsWith(stream + '.log.')).sort();
}

function ordinalOf(name, stream) {
  const start = (stream + '.log.').length;
  return Number(name.slice(start, start + 12));
}

test('rotating a full authz log keeps at most MAX_SEGMENTS older segments, oldest removed first', async () => {
  const fx = await F.fixture('identity-audit-retention-');
  const { audit, dir } = fx;
  assert.equal(typeof audit.MAX_SEGMENTS, 'number', 'the retention cap must be a published constant');
  const cap = audit.MAX_SEGMENTS;
  assert.ok(Number.isSafeInteger(cap) && cap >= 2 && cap <= 64, 'cap in a sane range: ' + cap);

  // ARRANGEMENT: cap + 2 older rotated segments already on disk, ordinals 1..cap+2,
  // plus one authn segment that authz rotation must never touch.
  for (let i = 1; i <= cap + 2; i += 1) {
    fs.writeFileSync(path.join(dir, `authz.log.${String(i).padStart(12, '0')}-${1000 + i}-seg`),
      '{"planted":true}\n');
  }
  // Decoys: MORE than the cap in each other stream, so a rogue prune of
  // either stream at the cap would remove some and the assertion would fire.
  const decoys = {};
  for (const stream of ['authn', 'mutation']) {
    decoys[stream] = [];
    for (let i = 1; i <= cap + 2; i += 1) {
      const name = `${stream}.log.${String(i).padStart(12, '0')}-${1000 + i}-seg`;
      fs.writeFileSync(path.join(dir, name), '{"planted":true}\n');
      decoys[stream].push(name);
    }
    assert.equal(segmentsOf(dir, stream).length, cap + 2, `ARRANGEMENT: ${stream} decoys exceed the cap`);
  }
  // ARRANGEMENT: the live authz.log sits exactly at MAX_BYTES, so the next append rotates.
  const live = path.join(dir, 'authz.log');
  fs.writeFileSync(live, '');
  fs.truncateSync(live, audit.MAX_BYTES);
  assert.equal(fs.statSync(live).size, audit.MAX_BYTES, 'ARRANGEMENT: live log at the rotation threshold');
  assert.equal(segmentsOf(dir, 'authz').length, cap + 2, 'ARRANGEMENT: more segments than the cap on disk');

  // ACT: one real authorization decision through the real audit path.
  const decision = fx.can(fx.person.id, 'read', 'room:main', F.context());
  assert.equal(typeof decision.allow, 'boolean', 'a decision was audited');
  await audit.drain();

  // OUTCOME: rotation produced ordinal cap+3; pruning removed ordinals 1..3.
  const kept = segmentsOf(dir, 'authz');
  assert.equal(kept.length, cap, 'exactly MAX_SEGMENTS remain after the rotation');
  assert.deepEqual(kept.map(name => ordinalOf(name, 'authz')),
    Array.from({ length: cap }, (_, k) => 4 + k),
    'the oldest ordinals are the ones removed; the just-rotated segment is kept');
  const size = fs.statSync(live).size;
  assert.ok(size > 0 && size < audit.MAX_BYTES, 'the live log holds only the new row');
  assert.deepEqual(segmentsOf(dir, 'authn'), decoys.authn,
    'another telemetry stream\'s segments are untouched (all cap+2 survive)');
  assert.deepEqual(segmentsOf(dir, 'mutation'), decoys.mutation,
    'the mutation record is never pruned by telemetry rotation (all cap+2 survive)');
});
