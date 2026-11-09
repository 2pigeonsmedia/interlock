'use strict';

// A report that matches the recorded answer is a no-op: it says the decision
// is already answered and writes nothing to the decision. Six were sent by
// mistake after the person's own room replies had already bound them, and
// each recorded a "conflicting report" with an exposure draft. A real
// conflict still records as before. A matching report never overwrites,
// re-attributes or re-times the recorded answer.

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
const relay = Object.freeze({ subject_id: 's-2', name: 'Relay', kind: 'seat', owner: false });
const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: actor.session ?? null };
}

function uuid() {
  return crypto.randomUUID();
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-report-matching-'));
  let now = 1_700_000_000_000;
  const store = openWorkStore({ dataDir });
  const work = createWorkService({ store, clock: () => (now += 1000) });
  return { store, work };
}

// A decision whose ask is room message 41, answered by Ana in the room as #51.
function answeredInRoom(choice, text) {
  const { store, work } = fresh();
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Merge?', body: 'b', asked_of: ref(owner),
    source_message: { message_id: 41, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Merge?' },
  }).item;
  store.commit(draft => {
    const item = draft.items.find(row => row.id === decision.id);
    item.ask_message_id = 41;
    item.ask_revision = 1;
    item.revision += 1;
    return null;
  });
  const said = work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 41, revision: 1, message_id: 51, text, choice, by_addressee: true, of: ANA_OF,
  });
  assert.equal(said.recorded, decision.id, 'ARRANGEMENT: the room answer is the record');
  return { store, work, id: decision.id };
}

function recorded(work, id) {
  const detail = work.get(owner, { id });
  return { item: detail.item, history: detail.history };
}

function report(work, id, text, extra = {}) {
  const revision = work.get(owner, { id }).item.revision;
  return work.reportAnswer(relay, Object.assign({
    operation_id: uuid(), id, expected_revision: revision, text, source: 'her reply in the room',
  }, extra));
}

test('a report matching a room answer is a no-op that names the room message', () => {
  const { work, id } = answeredInRoom('yes', 'yes');
  const before = recorded(work, id);
  for (const words of ['yes', 'Yes', 'Yes.', '  YES  ']) {
    const result = report(work, id, words);
    assert.equal(result.ok, true, words);
    assert.equal(result.conflict, false, words);
    assert.equal(result.exposure, undefined, words + ': no exposure draft');
    assert.deepEqual(result.already, { choice: 'yes', text: 'yes', room_message_id: 51 }, words);
    assert.deepEqual(recorded(work, id), before, words + ': nothing about the decision changed');
  }
});

test('the room\'s own words match too, and a matching report never re-attributes or re-times the answer', () => {
  const { work, id } = answeredInRoom('yes', 'Yes, merge it');
  const before = recorded(work, id);
  const result = report(work, id, 'yes, merge it.');
  assert.equal(result.conflict, false);
  assert.deepEqual(result.already, { choice: 'yes', text: 'Yes, merge it', room_message_id: 51 });
  const after = recorded(work, id);
  assert.deepEqual(after.item.answer.by, ref(Object.assign({}, owner, { session: null })));
  assert.equal(after.item.answer.at, before.item.answer.at);
  assert.equal(after.item.answer.source, 'answered in the room #51');
  assert.deepEqual(after, before);
  assert.deepEqual(report(work, id, 'Yes').already, { choice: 'yes', text: 'Yes, merge it', room_message_id: 51 },
    'a bare Yes matches a room Yes said in more words');
  assert.deepEqual(recorded(work, id), before);
});

test('a report matching an answer recorded here is a no-op without a room message', () => {
  const { work } = fresh();
  const id = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Dates?', body: 'b', asked_of: ref(owner),
  }).item.id;
  work.answer(owner, { operation_id: uuid(), id, expected_revision: 1, text: 'No.' });
  const before = recorded(work, id);
  const result = report(work, id, 'no');
  assert.equal(result.conflict, false);
  assert.deepEqual(result.already, { choice: null, text: 'No.', room_message_id: null });
  assert.deepEqual(recorded(work, id), before);
});

test('a report matching a reported answer is a no-op: the first reporter keeps the record', () => {
  const { work } = fresh();
  const id = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Dates?', body: 'b', asked_of: ref(owner),
  }).item.id;
  work.reportAnswer(lead, { operation_id: uuid(), id, expected_revision: 1, text: 'No guessing.', source: 'terminal' });
  const before = recorded(work, id);
  const result = report(work, id, 'no guessing');
  assert.equal(result.conflict, false);
  assert.equal(result.exposure, undefined);
  assert.deepEqual(result.already, { choice: null, text: 'No guessing.', room_message_id: null });
  assert.deepEqual(recorded(work, id), before);
  assert.deepEqual(recorded(work, id).item.answer.by, ref(lead));
});

test('a real conflict still records as before, with its exposure draft', () => {
  const cases = [
    ['the other choice', 'no', {}],
    ['other words', 'She said yes, but only for March', {}],
    ['the same word with conditions the answer did not have', 'yes', { conditions: 'March only' }],
  ];
  for (const [label, words, extra] of cases) {
    const { work, id } = answeredInRoom('yes', 'yes');
    const before = recorded(work, id);
    const result = report(work, id, words, extra);
    assert.equal(result.conflict, true, label);
    assert.equal(result.already, undefined, label);
    assert.equal(result.exposure.to, 'Ana', label);
    const after = recorded(work, id);
    assert.equal(after.history.at(-1).kind, 'reported-conflict', label);
    assert.equal(after.history.length, before.history.length + 1, label);
    assert.deepEqual(after.item.answer, before.item.answer, label + ': the recorded answer stands');
  }
});
