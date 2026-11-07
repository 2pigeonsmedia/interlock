'use strict';

// A work or finding item that is no longer wanted is withdrawn, with a
// reason, by the person or AI that filed it, its project's live lead, the
// first owner or an administrator. Withdrawn is not done: the record says
// the work was dropped, never that it was finished. An item that was linked
// to it says its blocker was withdrawn instead of quietly reading as clear.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const { createWorkRoutes } = require('../src/work/routes.js');

const admin = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const first = Object.freeze({ subject_id: 'p-2', name: 'Bea', kind: 'person', owner: false, first_owner: true });
const filer = Object.freeze({ subject_id: 's-1', name: 'Filer', kind: 'seat', owner: false });
const holder = Object.freeze({ subject_id: 's-2', name: 'Holder', kind: 'seat', owner: false });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const other = Object.freeze({ subject_id: 's-4', name: 'Other', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function uuid() {
  return crypto.randomUUID();
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-withdraw-'));
  let now = 1_700_000_000_000;
  const store = openWorkStore({ dataDir });
  const work = createWorkService({ store, clock: () => (now += 1000), leadOf: project => (project === 'ops' ? ref(lead) : null) });
  return { store, work };
}

function newWork(work, actor, extra = {}) {
  return work.createItem(actor, Object.assign({
    operation_id: uuid(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'Match the statement.',
  }, extra)).item;
}

function code(fn, expected) {
  assert.throws(fn, error => {
    assert.equal(error && error.code, expected, error && error.message);
    return true;
  });
}

function withdraw(work, actor, item, extra = {}) {
  return work.withdrawItem(actor, Object.assign({
    operation_id: uuid(), id: item.id, expected_revision: item.revision, reason: 'Not needed after the March close.',
  }, extra));
}

test('the filer withdraws a work item: it is withdrawn, not done, with the reason on the record', () => {
  const { work } = fresh();
  const item = newWork(work, filer, { responsible: ref(holder), next_to: ref(holder), next_action: 'Pull the statement' });
  assert.equal(item.state, 'open', 'ARRANGEMENT: an open item with someone next');
  const result = withdraw(work, filer, item);
  assert.equal(result.ok, true);
  assert.equal(result.item.state, 'withdrawn');
  assert.equal(result.item.revision, item.revision + 1);
  assert.equal(result.item.next_to, null, 'nobody is next on withdrawn work');
  assert.equal(result.item.done_without_evidence, false, 'withdrawn is never recorded as done');
  const history = work.get(filer, { id: item.id }).history;
  const last = history[history.length - 1];
  assert.equal(last.kind, 'withdrawn');
  assert.equal(last.reason, 'Not needed after the March close.');
  assert.deepEqual(last.by, ref(filer));
});

test('a finding is withdrawable the same way', () => {
  const { work } = fresh();
  const finding = newWork(work, filer, { kind: 'finding' });
  assert.equal(withdraw(work, filer, finding).item.state, 'withdrawn');
});

test('who may withdraw: filer, live lead, first owner, administrator; not the holder, not anyone else', () => {
  const { work } = fresh();
  const make = () => newWork(work, filer, { responsible: ref(holder) });
  const held = make();
  code(() => withdraw(work, holder, held), 'not-withdrawer');
  code(() => withdraw(work, other, held), 'not-withdrawer');
  assert.equal(work.get(filer, { id: held.id }).item.state, 'open', 'a refused withdraw changes nothing');
  assert.equal(withdraw(work, lead, make()).item.state, 'withdrawn', 'the project\'s live lead');
  assert.equal(withdraw(work, first, make()).item.state, 'withdrawn', 'the first owner');
  assert.equal(withdraw(work, admin, make()).item.state, 'withdrawn', 'an administrator');
  // The lead of ops is not the lead of another project.
  work.createProject(admin, { operation_id: uuid(), id: 'books', display_name: 'Books' });
  const books = newWork(work, filer, { project: 'books' });
  code(() => withdraw(work, lead, books), 'not-withdrawer');
});

test('get says whether the reader may withdraw, so a page offers Withdraw only to them', () => {
  const { work } = fresh();
  const item = newWork(work, filer, { responsible: ref(holder) });
  assert.equal(work.get(filer, { id: item.id }).may_withdraw, true);
  assert.equal(work.get(lead, { id: item.id }).may_withdraw, true);
  assert.equal(work.get(holder, { id: item.id }).may_withdraw, false);
  assert.equal(work.get(other, { id: item.id }).may_withdraw, false);
  withdraw(work, filer, item);
  assert.equal(work.get(filer, { id: item.id }).may_withdraw, false, 'already withdrawn');
});

test('a reason is required; done work, requests for approval, decisions and withdrawn work are refused', () => {
  const { work } = fresh();
  const item = newWork(work, filer);
  code(() => withdraw(work, filer, item, { reason: '   ' }), 'invalid-reason');
  code(() => withdraw(work, filer, item, { reason: undefined }), 'invalid-reason');
  const done = work.updateWork(filer, {
    operation_id: uuid(), id: item.id, expected_revision: 1, note: 'closed', state: 'done', done_account: 'Matched.', no_evidence: true,
  }).item;
  assert.equal(done.state, 'done', 'ARRANGEMENT: a done item');
  code(() => withdraw(work, filer, done), 'invalid-state');
  const decision = work.createItem(filer, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Use the March cutoff?', body: 'b', asked_of: ref(admin),
  }).item;
  code(() => withdraw(work, filer, decision), 'invalid-kind');
  const gone = withdraw(work, filer, newWork(work, filer)).item;
  code(() => withdraw(work, filer, gone), 'invalid-state');
  code(() => withdraw(work, filer, newWork(work, filer), { expected_revision: 9 }), 'stale-revision');
});

test('a request for approval is refused: it closes by its own path', (t) => {
  const { store, work } = fresh();
  const item = newWork(work, filer);
  // A request for approval as the approvals path stores it.
  store.commit(draft => {
    const row = draft.items.find(entry => entry.id === item.id);
    row.approval = { state: 'awaiting', approver: ref(admin), by: ref(filer), scope: 'ship it' };
    return null;
  });
  const current = work.get(filer, { id: item.id }).item;
  assert.ok(current.approval, 'ARRANGEMENT: the item is a request for approval');
  code(() => withdraw(work, filer, current), 'invalid-kind');
});

test('update cannot set withdrawn; state open with a note undoes it', () => {
  const { work } = fresh();
  const item = newWork(work, filer);
  code(() => work.updateWork(filer, { operation_id: uuid(), id: item.id, expected_revision: 1, note: 'x', state: 'withdrawn' }),
    'invalid-state');
  const gone = withdraw(work, filer, item).item;
  const back = work.updateWork(filer, { operation_id: uuid(), id: gone.id, expected_revision: gone.revision, note: 'Needed after all.', state: 'open' });
  assert.equal(back.item.state, 'open');
  const history = work.get(filer, { id: item.id }).history;
  assert.equal(history[history.length - 1].kind, 'state-changed');
  assert.equal(history[history.length - 1].from, 'withdrawn');
});

test('withdrawn work leaves Needs you, Open work and what a decision holds up, and is counted with the withdrawn', () => {
  const { work } = fresh();
  const item = newWork(work, filer, { responsible: ref(holder) });
  const decision = work.createItem(filer, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Cutoff?', body: 'b', asked_of: ref(admin), links: [item.id],
  }).item;
  const before = work.brief(holder);
  assert.ok(before.needs_me.some(row => row.id === item.id), 'ARRANGEMENT: in the holder\'s Needs you');
  assert.ok(before.open.some(row => row.id === item.id), 'ARRANGEMENT: in Open work');
  assert.deepEqual(work.brief(admin).needs_me.find(row => row.id === decision.id).blocks, [item.id], 'ARRANGEMENT: the decision holds it up');
  assert.equal(before.projects.find(row => row.id === 'ops').withdrawn_count, 0);
  withdraw(work, filer, item);
  const after = work.brief(holder);
  assert.equal(after.needs_me.some(row => row.id === item.id), false);
  assert.equal(after.open.some(row => row.id === item.id), false);
  assert.deepEqual(work.brief(admin).needs_me.find(row => row.id === decision.id).blocks, []);
  assert.equal(after.projects.find(row => row.id === 'ops').withdrawn_count, 1);
  assert.equal(after.projects.find(row => row.id === 'ops').done_count, 0, 'not counted as done');
  assert.equal(work.list(filer, { needs_me: true }).items.some(row => row.id === item.id), false);
});

test('an item linked to withdrawn work says its blocker was withdrawn, and the withdraw names it', () => {
  const { work } = fresh();
  const blocker = newWork(work, filer, { title: 'Get the March statement' });
  const waiting = newWork(work, holder, { title: 'Reconcile March', responsible: ref(holder), links: [blocker.id] });
  const child = newWork(work, holder, { title: 'Check fees', responsible: ref(other), parent: blocker.id });
  const finished = newWork(work, holder, { links: [blocker.id] });
  work.updateWork(holder, { operation_id: uuid(), id: finished.id, expected_revision: 1, note: 'x', state: 'done', done_account: 'd', no_evidence: true });
  const unrelated = newWork(work, holder);
  const row = id => work.brief(admin).open.find(entry => entry.id === id);
  assert.deepEqual(row(waiting.id).blocker_withdrawn, [], 'ARRANGEMENT: nothing withdrawn yet');
  const result = withdraw(work, filer, blocker);
  assert.deepEqual(result.left_waiting.map(entry => entry.id), [waiting.id, child.id],
    'the live items linked to it, by id order; done work is not left waiting');
  assert.deepEqual(row(waiting.id).blocker_withdrawn, [blocker.id]);
  assert.deepEqual(row(child.id).blocker_withdrawn, [blocker.id], 'a child of withdrawn work');
  assert.deepEqual(row(unrelated.id).blocker_withdrawn, []);
  assert.deepEqual(work.get(holder, { id: waiting.id }).blocker_withdrawn, [blocker.id], 'the detail read says it too');
  // The holder clears it by unlinking; it is derived, never typed.
  const current = work.get(holder, { id: waiting.id }).item;
  work.updateWork(holder, { operation_id: uuid(), id: waiting.id, expected_revision: current.revision, note: 'not needed', links: [] });
  assert.deepEqual(row(waiting.id).blocker_withdrawn, []);
});

test('a retried withdraw replays its result and changes nothing more', () => {
  const { work } = fresh();
  const item = newWork(work, filer);
  const body = { operation_id: uuid(), id: item.id, expected_revision: 1, reason: 'dropped' };
  const once = work.withdrawItem(filer, body);
  const again = work.withdrawItem(filer, body);
  assert.equal(again.replayed, true);
  assert.equal(again.item.revision, once.item.revision);
  assert.equal(work.get(filer, { id: item.id }).history.filter(event => event.kind === 'withdrawn').length, 1);
});

test('the route items/withdraw answers 200, and 403 not-withdrawer for the holder', async () => {
  const { work } = fresh();
  const roster = [admin, filer, holder, lead, other].map(actor => ({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null }));
  const routes = createWorkRoutes({ work, participants: () => roster });
  const item = newWork(work, filer, { responsible: ref(holder) });
  const refused = await routes.mutate('items/withdraw', holder, { operation_id: uuid(), id: item.id, expected_revision: 1, reason: 'mine now' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'not-withdrawer');
  const done = await routes.mutate('items/withdraw', filer, { operation_id: uuid(), id: item.id, expected_revision: 1, reason: 'dropped' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.item.state, 'withdrawn');
  assert.equal(JSON.stringify(done.body).includes('subject_id'), false, 'no opaque ids leave the route');
});

test('the markdown export shows withdrawn work as withdrawn, never as done', () => {
  const { work } = fresh();
  const item = newWork(work, filer, { title: 'Reconcile March' });
  withdraw(work, filer, item);
  const text = work.exportRecords(admin, { format: 'md' }).body;
  assert.match(text, /### W-1 · Reconcile March \(work · ops · withdrawn\)/);
  assert.match(text, /Filer · withdrawn · reason: Not needed after the March close\./, 'the reason is in the event lines');
  assert.doesNotMatch(text, /no evidence attached/);
});

test('undoing a withdraw follows the same rule: filer, lead, first owner or administrator; never the holder', () => {
  const { work } = fresh();
  const item = newWork(work, filer, { responsible: ref(holder) });
  const gone = withdraw(work, filer, item).item;
  const reopen = (actor, current) => work.updateWork(actor, {
    operation_id: uuid(), id: current.id, expected_revision: current.revision, note: 'back', state: 'open',
  });
  code(() => reopen(holder, gone), 'not-withdrawer');
  code(() => reopen(other, gone), 'not-withdrawer');
  assert.equal(work.get(filer, { id: item.id }).item.state, 'withdrawn', 'a refused undo changes nothing');
  // A withdrawn item still takes an edit that leaves it withdrawn, as done work does.
  const edited = work.updateWork(holder, { operation_id: uuid(), id: gone.id, expected_revision: gone.revision, note: 'typo', title: 'Reconcile March (dropped)' });
  assert.equal(edited.item.state, 'withdrawn');
  assert.equal(reopen(lead, edited.item).item.state, 'open', 'the project\'s live lead');
  for (const actor of [filer, first, admin]) {
    const again = withdraw(work, filer, work.get(filer, { id: item.id }).item).item;
    assert.equal(reopen(actor, again).item.state, 'open', actor.name);
  }
});
