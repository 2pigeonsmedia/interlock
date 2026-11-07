'use strict';

// What People says a seat is doing, from the Work record (Patti, 2026-10-31:
// "Pitta says waiting on Fruiteater but he is working on something"): a seat
// is waiting on someone only when every open item it holds or is next on is
// blocked by someone else. Otherwise it is working on its unblocked item, and
// a block on its other items stays in the detail.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');

const pitta = Object.freeze({ subject_id: 's-1', name: 'Pitta', kind: 'seat', owner: false });
const fruit = Object.freeze({ subject_id: 's-2', name: 'Fruiteater', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-working-'));
  let now = 1_700_000_000_000;
  return createWorkService({ store: openWorkStore({ dataDir }), clock: () => (now += 1000) });
}

function make(work, actor, extra) {
  return work.createItem(actor, Object.assign({
    operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'Item', body: 'b', responsible: ref(actor),
  }, extra)).item;
}

function activate(work, actor, item) {
  return work.updateWork(actor, { operation_id: crypto.randomUUID(), id: item.id, expected_revision: item.revision, note: 'on it', state: 'active' }).item;
}

test('one blocked item and one free one: working on the free one, not waiting; the block stays in sight', () => {
  const work = fresh();
  const seal = make(work, fruit, { title: 'Seal the tests' });
  const build = make(work, pitta, { title: 'Build S1', links: [seal.id] });
  assert.deepEqual(work.waitingOf(pitta.subject_id) && work.waitingOf(pitta.subject_id).item, seal.id,
    'ARRANGEMENT: with only the blocked item, Pitta is waiting on Fruiteater');
  assert.equal(work.workingOf(pitta.subject_id), null, 'and working on nothing free');
  const docs = activate(work, pitta, make(work, pitta, { title: 'Write the import docs' }));
  assert.equal(work.waitingOf(pitta.subject_id), null, 'not waiting while something of theirs is free');
  assert.deepEqual(work.workingOf(pitta.subject_id), {
    item: docs.id, title: 'Write the import docs', blocked: { name: 'Fruiteater', item: seal.id },
  });
  assert.ok(build.id);
});

test('an active item is named ahead of an open one; with no block, blocked is null', () => {
  const work = fresh();
  make(work, pitta, { title: 'Open first' });
  const second = activate(work, pitta, make(work, pitta, { title: 'Active second' }));
  assert.deepEqual(work.workingOf(pitta.subject_id), { item: second.id, title: 'Active second', blocked: null });
  assert.equal(work.workingOf(fruit.subject_id), null, 'a seat with no open work is working on nothing');
});

test('done and withdrawn work is not what a seat is working on', () => {
  const work = fresh();
  const only = make(work, pitta, { title: 'Dropped' });
  work.withdrawItem(pitta, { operation_id: crypto.randomUUID(), id: only.id, expected_revision: 1, reason: 'not needed' });
  assert.equal(work.workingOf(pitta.subject_id), null);
  assert.equal(work.waitingOf(pitta.subject_id), null);
});
