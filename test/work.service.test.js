'use strict';

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
const builder = Object.freeze({ subject_id: 's-2', name: 'Builder', kind: 'seat', owner: false });
const reviewer = Object.freeze({ subject_id: 's-3', name: 'Reviewer', kind: 'seat', owner: false });
const sameName = Object.freeze({ subject_id: 's-9', name: 'Builder', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind };
}

function uuid() {
  return crypto.randomUUID();
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-service-'));
  let now = 1_700_000_000_000;
  const store = openWorkStore({ dataDir });
  const work = createWorkService({ store, clock: () => (now += 1000) });
  return { dataDir, store, work };
}

function newWork(work, actor, extra = {}) {
  return work.createItem(actor, Object.assign({
    operation_id: uuid(), kind: 'work', project: 'ops',
    title: 'Import statement rows without guessing dates',
    body: 'Accept unambiguous dates and make unresolved rows visible.',
  }, extra)).item;
}

function code(fn, expected) {
  assert.throws(fn, error => {
    assert.equal(error && error.code, expected, error && error.message);
    return true;
  });
}

// ── projects and items ────────────────────────────────────────────────────────

test('a seat creates a work item and the record carries the trusted actor, never a body field', () => {
  const { work } = fresh();
  const created = work.createItem(lead, {
    operation_id: uuid(), kind: 'work', project: 'ops', title: 'First', body: 'Why it matters',
  });
  assert.equal(created.ok, true);
  assert.equal(created.item.id, 'W-1');
  assert.equal(created.item.state, 'open');
  assert.equal(created.item.revision, 1);
  assert.deepEqual(created.item.created_by, ref(lead));
  const detail = work.get(lead, { id: 'W-1' });
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].kind, 'created');
  assert.deepEqual(detail.history[0].by, ref(lead));
  code(() => work.createItem(lead, {
    operation_id: uuid(), kind: 'work', project: 'ops', title: 'x', body: 'y', by: 'Somebody Else',
  }), 'invalid-input');
});

test('only the owner creates or retires a project, slugs are checked, and creation in a retired project is refused', () => {
  const { work } = fresh();
  code(() => work.createProject(lead, { operation_id: uuid(), id: 'finance', display_name: 'Finance' }), 'owner-only');
  code(() => work.createProject(owner, { operation_id: uuid(), id: 'Finance!', display_name: 'Finance' }), 'invalid-project-id');
  const created = work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Finance' });
  assert.equal(created.project.id, 'finance');
  assert.equal(created.project.revision, 1);
  code(() => work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Again' }), 'project-exists');
  code(() => newWork(work, lead, { project: 'nowhere' }), 'unknown-project');
  code(() => work.retireProject(lead, { operation_id: uuid(), id: 'finance' }), 'owner-only');
  work.retireProject(owner, { operation_id: uuid(), id: 'finance' });
  code(() => newWork(work, lead, { project: 'finance' }), 'project-retired');
});

test('any writer updates a project narrative, attributed and revisioned', () => {
  const { work } = fresh();
  const updated = work.updateProject(lead, {
    operation_id: uuid(), id: 'ops', expected_revision: 1,
    objective: 'Keep the room useful.', today: 'Record open questions.',
  });
  assert.equal(updated.project.revision, 2);
  assert.deepEqual(updated.project.updated_by, ref(lead));
  code(() => work.updateProject(builder, { operation_id: uuid(), id: 'ops', expected_revision: 1, today: 'stale' }),
    'stale-revision');
});

// ── the personal queue ────────────────────────────────────────────────────────

test('a work item enters the queue of the participant its next action is addressed to, keyed on subject id', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { next_to: ref(builder), next_action: 'Prepare a candidate.' });
  assert.deepEqual(work.list(builder, { needs_me: true }).items.map(row => row.id), [item.id]);
  assert.deepEqual(work.list(sameName, { needs_me: true }).items, []);
  assert.deepEqual(work.list(lead, { needs_me: true }).items, []);
});

test('ready requires a recipient', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  code(() => work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'ready', note: 'candidate up',
  }), 'invalid-ready');
  const ready = work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'ready',
    next_to: ref(reviewer), next_action: 'Check the candidate.', note: 'candidate up',
  });
  assert.equal(ready.item.state, 'ready');
  assert.deepEqual(work.list(reviewer, { needs_me: true }).items.map(row => row.id), [item.id]);
});

test('blocked requires a reason and clears the next actor unless the unblocking act is named', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { next_to: ref(builder), next_action: 'Prepare a candidate.' });
  code(() => work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked', note: 'waiting',
  }), 'invalid-blocked');
  const waiting = work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked',
    block_reason: 'Waiting for the reviewer.', note: 'waiting',
  });
  assert.equal(waiting.item.next_to, null);
  assert.deepEqual(work.list(builder, { needs_me: true }).items, []);
  const named = work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 2, state: 'blocked',
    block_reason: 'Needs the candidate scope.', next_to: ref(reviewer),
    next_action: 'Name the scope you will check.', note: 'asked the reviewer',
  });
  assert.deepEqual(named.item.next_to, ref(reviewer));
  assert.deepEqual(work.list(reviewer, { needs_me: true }).items.map(row => row.id), [item.id]);
});

test('done requires a completion account, clears the next actor, and reports whether evidence is attached', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { next_to: ref(builder), next_action: 'Prepare a candidate.' });
  code(() => work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'done', note: 'finished',
  }), 'invalid-done');
  const done = work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'done',
    done_account: 'Merged the candidate.', note: 'finished',
  });
  assert.equal(done.item.state, 'done');
  assert.equal(done.item.next_to, null);
  assert.deepEqual(work.list(builder, { needs_me: true }).items, []);
  assert.equal(work.list(lead, {}).items[0].evidence_attached, false);
  work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'Suite green.',
    reference: 'run 12', limits: 'Unit tests only.',
  });
  assert.equal(work.list(lead, {}).items[0].evidence_attached, true);
});

// ── evidence, targets, notes ──────────────────────────────────────────────────

test('a changed target pins earlier evidence to the target it examined', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { target: 'sha-a' });
  work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'Suite green at a.',
    reference: 'run 12', limits: 'Unit tests only.',
  });
  work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, target: 'sha-b', note: 'repaired',
  });
  let detail = work.get(lead, { id: item.id });
  assert.equal(detail.item.target, 'sha-b');
  assert.deepEqual(detail.evidence.map(row => [row.target, row.target_matches]), [['sha-a', false]]);
  assert.deepEqual(detail.history.filter(e => e.kind === 'target-changed').map(e => [e.from, e.to]),
    [['sha-a', 'sha-b']]);
  work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-b', observed: 'Suite green at b.',
    reference: 'run 13', limits: 'Unit tests only.',
  });
  detail = work.get(lead, { id: item.id });
  assert.deepEqual(detail.evidence.map(row => [row.target, row.target_matches]),
    [['sha-a', false], ['sha-b', true]]);
});

test('evidence needs all four fields and may relate to an earlier evidence entry on the same item', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { target: 'sha-a' });
  code(() => work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', reference: 'y', limits: '',
  }), 'invalid-limits');
  const first = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', reference: 'y', limits: 'z',
  });
  code(() => work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', reference: 'y', limits: 'z',
    relates_to: 999,
  }), 'invalid-relates-to');
  const second = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'correction', reference: 'y2', limits: 'z',
    relates_to: first.event.seq,
  });
  assert.equal(second.event.relates_to, first.event.seq);
});

test('a note on any item is appended with the actor and time and needs no revision', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  const noted = work.addNote(builder, { operation_id: uuid(), id: item.id, text: 'Reading room.css first.' });
  assert.equal(noted.event.kind, 'note');
  assert.deepEqual(noted.event.by, ref(builder));
  assert.equal(work.get(lead, { id: item.id }).item.revision, 1);
});

// ── revisions and idempotency ─────────────────────────────────────────────────

test('a stale revision conflicts and carries the current revision', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 1, state: 'active', note: 'taking it' });
  assert.throws(() => work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'active', note: 'me too',
  }), error => error.code === 'stale-revision' && error.revision === 2);
  code(() => work.updateWork(builder, { operation_id: uuid(), id: item.id, state: 'active', note: 'no revision' }),
    'invalid-revision');
});

test('an operation id replays its original result and refuses a different body', () => {
  const { work } = fresh();
  const operationId = uuid();
  const input = { operation_id: operationId, kind: 'work', project: 'ops', title: 'Once', body: 'Only once.' };
  const first = work.createItem(lead, input);
  const again = work.createItem(lead, input);
  assert.deepEqual(again, Object.assign({}, first, { replayed: true }));
  assert.equal(work.list(lead, {}).items.length, 1);
  code(() => work.createItem(lead, Object.assign({}, input, { title: 'Twice' })), 'operation-conflict');
  code(() => work.createItem(lead, Object.assign({}, input, { operation_id: 'not-a-uuid', title: 'x' })), 'invalid-operation');
});

// ── decisions ─────────────────────────────────────────────────────────────────

function newDecision(work, actor, askedOf, extra = {}) {
  return work.createItem(actor, Object.assign({
    operation_id: uuid(), kind: 'decision', project: 'ops',
    title: 'What should happen to ambiguous dates?',
    body: 'This choice governs the import flow.',
    asked_of: ref(askedOf),
    proposal: 'Keep the row unresolved and ask the person. Do not guess.',
    scope: 'The statement-import flow',
  }, extra)).item;
}

test('a decision asked of the owner enters her queue; a seat cannot answer it; an answer of no is answered', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  assert.equal(decision.state, 'awaiting');
  assert.deepEqual(work.list(owner, { needs_me: true }).items.map(row => row.id), [decision.id]);
  code(() => work.answer(builder, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'Yes.' }),
    'not-answerer');
  const answered = work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  assert.equal(answered.item.state, 'answered');
  assert.equal(answered.item.answer.kind, 'direct');
  assert.equal(answered.item.answer.text, 'No.');
  assert.deepEqual(answered.item.answer.by, ref(owner));
  assert.deepEqual(answered.item.answer.attributed_to, ref(owner));
  assert.deepEqual(work.list(owner, { needs_me: true }).items, []);
});

test('a reported answer leaves the queue, stays visibly reported, and drafts an exposure message to the person it is attributed to', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  const reported = work.reportAnswer(lead, {
    operation_id: uuid(), id: decision.id, expected_revision: 1,
    text: 'No automatic guessing. Keep ambiguous rows unresolved.',
    source: 'Terminal exchange with Ana, 14:02', conditions: 'For this import path only.',
  });
  assert.equal(reported.item.state, 'reported');
  assert.deepEqual(reported.item.answer.by, ref(lead));
  assert.deepEqual(reported.item.answer.attributed_to, ref(owner));
  assert.equal(reported.exposure.to, 'Ana');
  assert.match(reported.exposure.text, /reported by Lead, not confirmed here/);
  assert.match(reported.exposure.text, /No automatic guessing/);
  assert.match(reported.exposure.text, /For this import path only/);
  assert.deepEqual(work.list(owner, { needs_me: true }).items, []);
  const detail = work.get(owner, { id: decision.id });
  assert.deepEqual(detail.history.map(event => event.kind), ['created', 'answer-reported']);
  code(() => work.reportAnswer(owner, {
    operation_id: uuid(), id: decision.id, expected_revision: 2, text: 'me', source: 'me',
  }), 'not-a-relay');
});

test('confirming a reported answer creates a direct answer and keeps the reported event', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  work.reportAnswer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No guessing.', source: 'terminal' });
  code(() => work.confirmReported(builder, { operation_id: uuid(), id: decision.id, expected_revision: 2 }), 'not-answerer');
  const confirmed = work.confirmReported(owner, { operation_id: uuid(), id: decision.id, expected_revision: 2 });
  assert.equal(confirmed.item.state, 'answered');
  assert.equal(confirmed.item.answer.kind, 'direct');
  assert.equal(confirmed.item.answer.text, 'No guessing.');
  assert.deepEqual(confirmed.item.answer.by, ref(owner));
  assert.deepEqual(work.get(owner, { id: decision.id }).history.map(event => event.kind),
    ['created', 'answer-reported', 'confirmed']);
});

test('correcting a reported answer requires a reason, replaces it, and keeps the earlier wording', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  work.reportAnswer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'GO on everything.', source: 'terminal' });
  code(() => work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 2, text: 'GO on the sample only.' }),
    'invalid-reason');
  const corrected = work.answer(owner, {
    operation_id: uuid(), id: decision.id, expected_revision: 2,
    text: 'GO on the sample only.', reason: 'The relay dropped my scope.',
  });
  assert.equal(corrected.item.answer.text, 'GO on the sample only.');
  const replaced = work.get(owner, { id: decision.id }).history.find(event => event.kind === 'answer-replaced');
  assert.equal(replaced.previous.kind, 'reported');
  assert.equal(replaced.previous.text, 'GO on everything.');
  assert.equal(replaced.reason, 'The relay dropped my scope.');
  assert.equal(corrected.exposure.to, 'Lead');
});

test('a report against a recorded answer is attached as a conflict and changes nothing', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  const conflict = work.reportAnswer(lead, {
    operation_id: uuid(), id: decision.id, expected_revision: 2, text: 'She said yes.', source: 'hallway',
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.item.answer.text, 'No.');
  assert.equal(conflict.item.answer.kind, 'direct');
  assert.equal(work.get(owner, { id: decision.id }).history.at(-1).kind, 'reported-conflict');
});

test('withdrawal is the asker’s act or the owner’s, and an answered question is not withdrawable', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  code(() => work.withdraw(reviewer, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'noise' }),
    'not-asker');
  const withdrawn = work.withdraw(builder, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'Answered in W-1.' });
  assert.equal(withdrawn.item.state, 'withdrawn');
  assert.deepEqual(work.list(owner, { needs_me: true }).items, []);
  const second = newDecision(work, builder, owner);
  work.answer(owner, { operation_id: uuid(), id: second.id, expected_revision: 1, text: 'No.' });
  code(() => work.withdraw(owner, { operation_id: uuid(), id: second.id, expected_revision: 2, reason: 'late' }),
    'answer-recorded');
});

test('reopen restores the question to its answerer or to a new one, with the owner rule for third parties', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  code(() => work.reopen(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'still open' }),
    'invalid-state');
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  const reopened = work.reopen(lead, { operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'New facts.' });
  assert.equal(reopened.item.state, 'awaiting');
  assert.deepEqual(reopened.item.asked_of, ref(owner));
  assert.equal(reopened.item.answer, null);
  assert.deepEqual(work.list(owner, { needs_me: true }).items.map(row => row.id), [decision.id]);
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 3, text: 'Still no.', reason: 'asked again' });
  const toSelf = work.reopen(lead, { operation_id: uuid(), id: decision.id, expected_revision: 4, reason: 'Mine to make.', asked_of: ref(lead) });
  assert.deepEqual(toSelf.item.asked_of, ref(lead));
  work.answer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 5, text: 'Unresolved rows stay.' });
  code(() => work.reopen(builder, { operation_id: uuid(), id: decision.id, expected_revision: 6, reason: 'x', asked_of: ref(reviewer) }),
    'owner-only');
  const byOwner = work.reopen(owner, { operation_id: uuid(), id: decision.id, expected_revision: 6, reason: 'Reviewer decides.', asked_of: ref(reviewer) });
  assert.deepEqual(byOwner.item.asked_of, ref(reviewer));
  const history = work.get(owner, { id: decision.id }).history.filter(event => event.kind === 'reopened');
  assert.deepEqual(history.map(event => event.asked_of.name), ['Ana', 'Lead', 'Reviewer']);
});

test('the owner answering a question asked of someone else needs a reason and is recorded on whose behalf', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, lead);
  code(() => work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'Start with dates.' }),
    'invalid-reason');
  const answered = work.answer(owner, {
    operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'Start with dates.', reason: 'Lead is offline.',
  });
  assert.deepEqual(answered.item.asked_of, ref(lead));
  assert.deepEqual(answered.item.answer.by, ref(owner));
  const event = work.get(owner, { id: decision.id }).history.find(e => e.kind === 'answered');
  assert.equal(event.on_behalf, true);
  assert.deepEqual(event.asked_of, ref(lead));
});

test('a lead records its own choice as a decision asked of itself, and the owner never sees it as hers', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, lead, { title: 'Which check runs first?' });
  assert.deepEqual(work.list(owner, { needs_me: true }).items, []);
  assert.deepEqual(work.list(lead, { needs_me: true }).items.map(row => row.id), [decision.id]);
  const answered = work.answer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'Dates first.' });
  assert.equal(answered.item.state, 'answered');
  assert.deepEqual(answered.item.answer.by, ref(lead));
  assert.equal(work.get(owner, { id: decision.id }).history.find(e => e.kind === 'answered').on_behalf, false);
});

test('name reuse does not inherit a pending question', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, builder);
  assert.deepEqual(work.list(sameName, { needs_me: true }).items, []);
  code(() => work.answer(sameName, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'mine?' }),
    'not-answerer');
  assert.deepEqual(work.list(builder, { needs_me: true }).items.map(row => row.id), [decision.id]);
});

// ── brief, changes, pagination, export ────────────────────────────────────────

test('brief returns projects, what needs me, what was reported to me, open work and decisions, with the cursor changes continue from', () => {
  const { work } = fresh();
  work.updateProject(lead, { operation_id: uuid(), id: 'ops', expected_revision: 1, objective: 'Keep the room useful.', today: 'Open questions.' });
  const item = newWork(work, lead, { next_to: ref(builder), next_action: 'Prepare a candidate.' });
  const reported = newDecision(work, builder, owner);
  work.reportAnswer(lead, { operation_id: uuid(), id: reported.id, expected_revision: 1, text: 'No guessing.', source: 'terminal' });
  const pending = newDecision(work, lead, owner, { title: 'Retain the open question?' });
  const brief = work.brief(owner, {});
  assert.deepEqual(brief.projects.map(p => [p.id, p.objective, p.today]), [['ops', 'Keep the room useful.', 'Open questions.']]);
  assert.deepEqual(brief.needs_me.map(row => row.id), [pending.id]);
  assert.deepEqual(brief.reported_to_me.map(row => row.id), [reported.id]);
  assert.deepEqual(brief.open.map(row => row.id), [item.id]);
  assert.deepEqual(brief.decisions.map(row => [row.id, row.state]), [[reported.id, 'reported'], [pending.id, 'awaiting']]);
  assert.deepEqual(work.changes(owner, { after: brief.cursor }).events, []);
  work.addNote(builder, { operation_id: uuid(), id: item.id, text: 'Starting.' });
  const since = work.changes(owner, { after: brief.cursor });
  assert.deepEqual(since.events.map(event => event.kind), ['note']);
  assert.equal(since.cursor, brief.cursor + 1);
  assert.deepEqual(work.brief(builder, {}).needs_me.map(row => row.id), [item.id]);
});

test('changes returns events after a cursor in order, with the total remaining and the cursor reached', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  for (const text of ['one', 'two', 'three', 'four']) {
    work.addNote(lead, { operation_id: uuid(), id: item.id, text });
  }
  const all = work.changes(lead, { after: 0 });
  assert.deepEqual(all.events.map(event => event.seq), [1, 2, 3, 4, 5]);
  assert.equal(all.cursor, 5);
  assert.equal(all.total, 5);
  const page = work.changes(lead, { after: 1, limit: 2 });
  assert.deepEqual(page.events.map(event => event.kind), ['note', 'note']);
  assert.equal(page.cursor, 3);
  assert.equal(page.total, 4);
  code(() => work.changes(lead, { after: -1 }), 'invalid-query');
});

test('list paginates with a total and a continuation, never a silent cap', () => {
  const { work } = fresh();
  for (let i = 0; i < 5; i += 1) newWork(work, lead, { title: 'Item ' + i });
  const first = work.list(lead, { limit: 2 });
  assert.deepEqual(first.items.map(row => row.id), ['W-1', 'W-2']);
  assert.equal(first.total, 5);
  assert.equal(first.next, 2);
  const second = work.list(lead, { after: first.next, limit: 2 });
  assert.deepEqual(second.items.map(row => row.id), ['W-3', 'W-4']);
  assert.equal(second.next, 4);
  const last = work.list(lead, { after: second.next, limit: 2 });
  assert.deepEqual(last.items.map(row => row.id), ['W-5']);
  assert.equal(last.next, null);
});

test('export carries actors, states, conditions, limits and earlier answers in both formats, without opaque ids', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { target: 'sha-a' });
  work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'Suite green.', reference: 'run 12', limits: 'Unit tests only.',
  });
  const decision = newDecision(work, builder, owner);
  work.reportAnswer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'GO on everything.', source: 'terminal' });
  work.answer(owner, {
    operation_id: uuid(), id: decision.id, expected_revision: 2, text: 'GO on the sample only.',
    conditions: 'Sample file only.', reason: 'The relay dropped my scope.',
  });
  const json = work.exportRecords(owner, { format: 'json' });
  assert.equal(json.content_type, 'application/json; charset=utf-8');
  const parsed = JSON.parse(json.body);
  assert.deepEqual(Object.keys(parsed).sort(), ['events', 'exported_at', 'items', 'projects', 'schema']);
  assert.equal(parsed.items.find(row => row.id === decision.id).state, 'answered');
  assert.equal(json.body.includes('subject_id'), false);
  assert.equal(json.body.includes('operations'), false);
  const markdown = work.exportRecords(owner, { format: 'md' });
  assert.equal(markdown.content_type, 'text/markdown; charset=utf-8');
  for (const expected of ['GO on the sample only.', 'GO on everything.', 'Sample file only.', 'Unit tests only.',
    'The relay dropped my scope.', 'Reviewer', 'Ana', 'answered', 'reported by Lead', 'matches current target: no']) {
    assert.ok(markdown.body.includes(expected), 'markdown export is missing: ' + expected);
  }
  assert.equal(markdown.body.includes('subject_id'), false);
  code(() => work.exportRecords(owner, { format: 'xml' }), 'invalid-format');
});

test('retired projects drop out of the default list and brief but their records stay readable', () => {
  const { work } = fresh();
  work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Finance' });
  const item = newWork(work, lead, { project: 'finance', next_to: ref(builder), next_action: 'Prepare.' });
  work.retireProject(owner, { operation_id: uuid(), id: 'finance' });
  assert.deepEqual(work.list(lead, {}).items, []);
  assert.deepEqual(work.list(lead, { project: 'finance' }).items.map(row => row.id), [item.id]);
  assert.equal(work.get(lead, { id: item.id }).item.project, 'finance');
  assert.deepEqual(work.brief(builder, {}).projects.map(p => p.id), ['ops']);
  assert.deepEqual(work.brief(builder, { project: 'finance' }).projects.map(p => p.id), ['finance']);
});
