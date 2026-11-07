'use strict';

// Follow-ups to the v0.3.5 cold read of the work line:
// M1: a state change that drops someone else from next is an assignment
//     too, so Blocked or Done cannot clear the way to a claim.
// L1: undoing a withdraw goes back to open, never straight to done.
// L2: "blocker withdrawn" marks only the items that depend on the withdrawn
//     one (their own links or parent), as waiting-on does.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');

const filer = Object.freeze({ subject_id: 's-1', name: 'Filer', kind: 'seat', owner: false });
const next = Object.freeze({ subject_id: 's-2', name: 'Next', kind: 'seat', owner: false });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const other = Object.freeze({ subject_id: 's-4', name: 'Other', kind: 'seat', owner: false });
const holder = Object.freeze({ subject_id: 's-5', name: 'Holder', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-followups-'));
  return createWorkService({ store: openWorkStore({ dataDir }), leadOf: project => (project === 'ops' ? ref(lead) : null) });
}

function filed(work, extra = {}) {
  return work.createItem(filer, Object.assign({ operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'Item', body: 'b' }, extra)).item;
}

function update(work, actor, item, fields) {
  const current = work.get(actor, { id: item.id }).item;
  return work.updateWork(actor, Object.assign({ operation_id: crypto.randomUUID(), id: item.id, expected_revision: current.revision, note: 'n' }, fields)).item;
}

function refused(fn, code) {
  let caught = null;
  assert.throws(fn, error => { caught = error; assert.equal(error && error.code, code, error && error.message); return true; });
  return caught;
}

const BLOCK = { state: 'blocked', block_reason: 'Waiting on the bank.' };
const DONE = { state: 'done', done_account: 'Closed.', no_evidence: true };

test('M1: Blocked or Done that would drop someone else from next is an assignment', () => {
  const work = fresh();
  for (const change of [BLOCK, DONE]) {
    const item = filed(work, { next_to: ref(next), next_action: 'check it' });
    const error = refused(() => update(work, other, item, change), 'not-assigner');
    assert.deepEqual(error.can_assign, ['Filer', 'Next', 'Lead']);
    assert.equal(work.get(filer, { id: item.id }).item.next_to.name, 'Next', 'nobody was dropped');
    refused(() => update(work, other, item, { responsible: ref(other) }), 'not-assigner');
  }
});

test('M1: naming the same next person does not get around it; the outcome decides', () => {
  const work = fresh();
  const blocked = filed(work, { next_to: ref(next), next_action: 'check it' });
  refused(() => update(work, other, blocked, Object.assign({ next_to: ref(next), next_action: '' }, BLOCK)), 'not-assigner');
  const done = filed(work, { next_to: ref(next), next_action: 'check it' });
  refused(() => update(work, other, done, Object.assign({ next_to: ref(next), next_action: 'check it' }, DONE)), 'not-assigner');
  assert.equal(work.get(filer, { id: done.id }).item.next_to.name, 'Next', 'nobody was dropped');
});

test('M1: whoever is next may drop themselves, and an assigner may drop them', () => {
  const work = fresh();
  assert.equal(update(work, next, filed(work, { next_to: ref(next), next_action: 'x' }), BLOCK).next_to, null, 'its own next slot');
  assert.equal(update(work, filer, filed(work, { next_to: ref(next), next_action: 'x' }), DONE).next_to, null, 'the filer');
  assert.equal(update(work, lead, filed(work, { next_to: ref(next), next_action: 'x' }), BLOCK).next_to, null, 'the live lead');
  assert.equal(update(work, other, filed(work), BLOCK).state, 'blocked', 'with nobody next, nothing is dropped');
});

test('L1: a withdraw is undone back to open only', () => {
  const work = fresh();
  for (const change of [DONE, { state: 'ready', next_to: ref(next), next_action: 'x' }, BLOCK, { state: 'active' }]) {
    const item = filed(work);
    const gone = work.withdrawItem(filer, { operation_id: crypto.randomUUID(), id: item.id, expected_revision: 1, reason: 'dropped' }).item;
    refused(() => update(work, filer, gone, change), 'invalid-state');
    assert.equal(update(work, filer, gone, { state: 'open' }).state, 'open');
  }
});

test('L2: withdrawing an item marks only what depends on it, never what it depended on', () => {
  const work = fresh();
  const base = filed(work, { title: 'Get the statement', responsible: ref(holder) });
  const dependent = filed(work, { title: 'Reconcile', links: [base.id] });
  const result = work.withdrawItem(filer, { operation_id: crypto.randomUUID(), id: dependent.id, expected_revision: 1, reason: 'not needed' });
  assert.deepEqual(result.left_waiting, [], 'the item it depended on is not left waiting');
  assert.deepEqual(work.brief(filer).open.find(row => row.id === base.id).blocker_withdrawn, []);

  const parent = filed(work, { title: 'Close March' });
  const child = filed(work, { title: 'Check fees', parent: parent.id });
  const dropChild = work.withdrawItem(filer, { operation_id: crypto.randomUUID(), id: child.id, expected_revision: 1, reason: 'n/a' });
  assert.deepEqual(dropChild.left_waiting, [], 'a parent does not depend on its child');

  const second = filed(work, { title: 'Pay the fee', parent: parent.id });
  const linked = filed(work, { title: 'File it', links: [parent.id] });
  const dropParent = work.withdrawItem(filer, { operation_id: crypto.randomUUID(), id: parent.id, expected_revision: 1, reason: 'n/a' });
  assert.deepEqual(dropParent.left_waiting.map(row => row.id), [second.id, linked.id], 'its child and the item linked to it');
});
