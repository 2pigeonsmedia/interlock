'use strict';

// Revising a decision in place: its asker rewrites the question under the same
// id. No earlier answer carries over to the new revision, and the kill question
// and its reply move onto the trail, so the slot is open again.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');

const owner = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const lead = Object.freeze({ subject_id: 's-1', name: 'Lead', kind: 'seat', owner: false });
const reviewer = Object.freeze({ subject_id: 's-3', name: 'Reviewer', kind: 'seat', owner: false });

const uuid = () => crypto.randomUUID();
const ref = actor => ({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null });

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-decision-revise-'));
  let now = 1_700_000_000_000;
  const store = openWorkStore({ dataDir });
  return { dataDir, store, work: createWorkService({ store, clock: () => (now += 1000) }) };
}

function code(fn, expected) {
  assert.throws(fn, error => {
    assert.equal(error && error.code, expected, error && error.message);
    return true;
  });
}

// The lead asks the owner; the reviewer kills the pick; the lead agrees it is killed.
function killedDecision(work) {
  const created = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers from the OEM?',
    body: 'The OEM part fits without changes.', proposal: 'Buy OEM rollers', rationale: 'Fit', scope: 'OEM rollers',
    asked_of: ref(owner),
  }).item;
  const attacked = work.killAsk(reviewer, { operation_id: uuid(), id: created.id, expected_revision: created.revision,
    question: 'The OEM part is out of stock until March?' }).item;
  const killed = work.killReply(lead, { operation_id: uuid(), id: created.id, expected_revision: attacked.revision,
    words: 'Yes, March. Killed.', outcome: 'killed' }).item;
  assert.equal(killed.kill_state, 'killed', 'ARRANGEMENT: the pick is killed');
  assert.equal(killed.state, 'awaiting', 'ARRANGEMENT: killed withdraws nothing');
  return killed;
}

function revise(work, actor, item, extra) {
  return work.revise(actor, Object.assign({ operation_id: uuid(), id: item.id, expected_revision: item.revision,
    reason: 'the OEM part is out of stock' }, extra));
}

test('the asker revises a killed decision in place: same id, new words, the kill on the trail, the slot open', () => {
  const { work } = fresh();
  const killed = killedDecision(work);
  assert.equal(killed.question_revision, 1, 'a decision starts at question revision 1');
  const result = revise(work, lead, killed, { proposal: 'Buy third-party rollers', scope: 'third-party rollers' });
  assert.equal(result.ok, true);
  const item = result.item;
  assert.equal(item.id, killed.id, 'the id never changes');
  assert.equal(item.question_revision, 2);
  assert.deepEqual([item.proposal, item.scope, item.title], ['Buy third-party rollers', 'third-party rollers', killed.title]);
  assert.equal(item.kill, null);
  assert.equal(item.kill_state, 'unattacked', 'the new revision can be attacked again');
  const history = work.get(owner, { id: killed.id }).history;
  const event = history.filter(row => row.kind === 'revised').slice(-1)[0];
  assert.ok(event, 'a revised event is on the trail');
  assert.equal(event.reason, 'the OEM part is out of stock');
  assert.equal(event.question_revision, 2);
  assert.deepEqual(event.before, { proposal: 'Buy OEM rollers', scope: 'OEM rollers' });
  assert.deepEqual(event.after, { proposal: 'Buy third-party rollers', scope: 'third-party rollers' });
  assert.equal(event.kill_cleared.question, 'The OEM part is out of stock until March?');
  assert.equal(event.kill_cleared.reply.outcome, 'killed');
  const again = work.killAsk(reviewer, { operation_id: uuid(), id: item.id, expected_revision: item.revision,
    question: 'Do third-party rollers void the warranty?' });
  assert.equal(again.item.kill_state, 'attacked', 'one kill question per revision');
});

test('a reported answer never carries over to a new revision; it stays on the trail', () => {
  const { work } = fresh();
  const killed = killedDecision(work);
  const reported = work.reportAnswer(reviewer, { operation_id: uuid(), id: killed.id, expected_revision: killed.revision,
    text: 'Ana said yes on the phone', source: 'phone call' }).item;
  assert.equal(reported.state, 'reported', 'ARRANGEMENT: an answer was reported');
  const item = revise(work, lead, reported, { scope: 'third-party rollers' }).item;
  assert.equal(item.answer, null);
  assert.equal(item.state, 'awaiting');
  const event = work.get(owner, { id: item.id }).history.filter(row => row.kind === 'revised').slice(-1)[0];
  assert.equal(event.answer_superseded.text, 'Ana said yes on the phone');
});

test('only the asker revises, and never while a direct answer stands or after a withdraw', () => {
  const { work } = fresh();
  const killed = killedDecision(work);
  code(() => revise(work, owner, killed, { scope: 'x' }), 'not-asker');
  code(() => revise(work, reviewer, killed, { scope: 'x' }), 'not-asker');
  const answered = work.answer(owner, { operation_id: uuid(), id: killed.id, expected_revision: killed.revision,
    text: 'No', choice: 'no' }).item;
  assert.equal(answered.state, 'answered', 'ARRANGEMENT: the owner answered directly');
  code(() => revise(work, lead, answered, { scope: 'x' }), 'answer-recorded');
  const reopened = work.reopen(lead, { operation_id: uuid(), id: answered.id, expected_revision: answered.revision,
    reason: 'out of stock' }).item;
  assert.equal(revise(work, lead, reopened, { scope: 'third-party' }).ok, true, 'reopen first, then revise');
  const now = work.get(owner, { id: killed.id }).item;
  const withdrawn = work.withdraw(lead, { operation_id: uuid(), id: now.id, expected_revision: now.revision, reason: 'moot' }).item;
  code(() => revise(work, lead, withdrawn, { scope: 'y' }), 'invalid-state');
});

test('a revise needs a reason, a real change, and the current revision', () => {
  const { work } = fresh();
  const killed = killedDecision(work);
  code(() => revise(work, lead, killed, { reason: '', scope: 'x' }), 'invalid-reason');
  code(() => revise(work, lead, killed, {}), 'invalid-input');
  code(() => revise(work, lead, killed, { scope: killed.scope }), 'invalid-input');
  code(() => revise(work, lead, killed, { title: '   ' }), 'invalid-title');
  code(() => revise(work, lead, killed, { asked_of: ref(reviewer), scope: 'x' }), 'invalid-input');
  code(() => revise(work, lead, Object.assign({}, killed, { revision: killed.revision - 1 }), { scope: 'x' }), 'stale-revision');
  assert.equal(work.get(owner, { id: killed.id }).item.question_revision, 1, 'nothing was revised');
});

test('a retried revise replays; it does not revise twice', () => {
  const { work } = fresh();
  const killed = killedDecision(work);
  const input = { operation_id: uuid(), id: killed.id, expected_revision: killed.revision, reason: 'stock', scope: 'third-party' };
  const first = work.revise(lead, input);
  const second = work.revise(lead, input);
  assert.equal(second.replayed, true);
  assert.equal(second.item.question_revision, first.item.question_revision);
  assert.equal(work.get(owner, { id: killed.id }).history.filter(row => row.kind === 'revised').length, 1);
});

test('a decision stored before revise existed reads as question revision 1 and revises to 2', () => {
  const { work, store } = fresh();
  const killed = killedDecision(work);
  const stored = store.read().items.find(row => row.id === killed.id);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'question_revision'), false,
    'an unrevised record stores nothing new');
  assert.equal(revise(work, lead, killed, { scope: 'third-party' }).item.question_revision, 2);
});

test('a bound decision refuses a room answer to the old wording from the moment it is revised, before the room follows', () => {
  const { work, store } = fresh();
  const killed = killedDecision(work);
  const bound = store.commit(draft => {
    const row = draft.items.find(entry => entry.id === killed.id);
    row.ask_message_id = 140;
    row.ask_revision = 1;
    row.revision += 1;
    return Object.assign({}, row);
  });
  const item = revise(work, lead, bound, { scope: 'third-party rollers' }).item;
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const late = work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 140, revision: 1, message_id: 141, text: 'yes', choice: 'yes', by_addressee: true, of: ANA_OF,
  });
  assert.equal(work.get(owner, { id: killed.id }).item.answer, null,
    'a Yes to the old wording, arriving before the room revise, is not recorded');
  assert.equal(late.recorded, null);
  assert.equal(item.ask_revision, 2, 'the record moved to the revision the room revise will make');
  const asLead = Object.assign({}, lead, { session: null });
  assert.equal(work.followAsk(asLead, { ask_id: 140, revision: 2 }).ok, true, 'the room landed on the same number');
  code(() => work.followAsk(asLead, { ask_id: 140, revision: 1 }), 'invalid-input');
  const again = revise(work, lead, work.get(owner, { id: killed.id }).item, { scope: 'eBay rollers' }).item;
  assert.equal(again.ask_revision, 3, 'ARRANGEMENT: a second revise moves the record to 3');
  assert.equal(work.followAsk(asLead, { ask_id: 140, revision: 2 }).ok, false, 'a room behind the record is not followed');
  assert.equal(work.followAsk(Object.assign({}, owner, { session: null }), { ask_id: 140, revision: 3 }).ok, false,
    'only the asker');
});
