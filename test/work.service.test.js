'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService, stripIds } = require('../src/work/service.js');

const owner = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const lead = Object.freeze({ subject_id: 's-1', name: 'Lead', kind: 'seat', owner: false });
const builder = Object.freeze({ subject_id: 's-2', name: 'Builder', kind: 'seat', owner: false });
const reviewer = Object.freeze({ subject_id: 's-3', name: 'Reviewer', kind: 'seat', owner: false });
const sameName = Object.freeze({ subject_id: 's-9', name: 'Builder', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: actor.session ?? null };
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

// A decision bound to its room ask, as an earlier build's "Ask a decision"
// stored it; filing a decision binds one the same way (bindAsk).
function boundByEarlierBuild(store, id, askMessageId) {
  return store.commit(draft => {
    const item = draft.items.find(row => row.id === id);
    item.ask_message_id = askMessageId;
    item.ask_revision = 1;
    item.revision += 1;
    return Object.assign({}, item);
  });
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
    done_account: 'Merged the candidate.', no_evidence: true, note: 'finished',
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

test('replay returns the stored result for a known operation and raw digest, and refuses a different one', () => {
  const { work } = fresh();
  const operationId = uuid();
  const first = work.createItem(lead, {
    operation_id: operationId, kind: 'work', project: 'ops', title: 'Once', body: 'Only once.', raw_digest: 'a',
  });
  assert.deepEqual(work.replay(lead, operationId, 'a'), Object.assign({}, first, { replayed: true }));
  assert.deepEqual(work.replay(lead, operationId.toUpperCase(), 'a'), Object.assign({}, first, { replayed: true }));
  code(() => work.replay(lead, operationId, 'b'), 'operation-conflict');
  assert.equal(work.replay(lead, uuid(), 'a'), null);
  const unmarked = uuid();
  work.createItem(lead, { operation_id: unmarked, kind: 'work', project: 'ops', title: 'Older', body: 'No raw digest.' });
  assert.equal(work.replay(lead, unmarked, 'a'), null, 'an entry without a raw digest is left to the resolved-digest check');
  assert.equal(work.list(lead, {}).items.length, 2);
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

test('list and brief rows carry the parent link', () => {
  const { work } = fresh();
  const parent = newWork(work, lead);
  const decision = newDecision(work, builder, owner, { parent: parent.id });
  const finding = work.createItem(lead, {
    operation_id: uuid(), kind: 'finding', project: 'ops', title: 'Dates drift', body: 'Seen in March.', parent: parent.id,
  }).item;
  const rows = new Map(work.list(owner, {}).items.map(row => [row.id, row]));
  assert.equal(rows.get(parent.id).parent, null);
  assert.equal(rows.get(decision.id).parent, parent.id);
  assert.equal(rows.get(finding.id).parent, parent.id);
  assert.equal(work.brief(owner).decisions.find(row => row.id === decision.id).parent, parent.id);
});

test('list and brief rows carry who created the record, with ids stripped on the way out', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { next_to: ref(owner), next_action: 'Approve the import.' });
  const decision = newDecision(work, builder, owner);
  const rows = new Map(work.list(owner, {}).items.map(row => [row.id, row]));
  assert.deepEqual(rows.get(item.id).created_by, ref(lead));
  assert.deepEqual(rows.get(decision.id).created_by, ref(builder));
  const brief = work.brief(owner);
  assert.deepEqual(brief.needs_me.find(row => row.id === item.id).created_by, ref(lead));
  assert.deepEqual(brief.open.find(row => row.id === item.id).created_by, ref(lead));
  assert.deepEqual(brief.decisions.find(row => row.id === decision.id).created_by, ref(builder));
  const stripped = stripIds(work.list(owner, { needs_me: true })).items;
  assert.deepEqual(stripped.find(row => row.id === item.id).created_by, { name: 'Lead', kind: 'seat', session: null });
  assert.equal(JSON.stringify(stripIds(brief)).includes('subject_id'), false);
});

test('work rows carry the block reason; decision rows carry none', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked',
    block_reason: 'Waiting on the bank.', note: 'stuck' });
  const decision = newDecision(work, builder, owner);
  const rows = new Map(work.list(owner, {}).items.map(row => [row.id, row]));
  assert.equal(rows.get(item.id).block_reason, 'Waiting on the bank.');
  assert.equal(work.brief(owner).open.find(row => row.id === item.id).block_reason, 'Waiting on the bank.');
  assert.equal(Object.hasOwn(rows.get(decision.id), 'block_reason'), false);
});

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

function reportedDecision(work) {
  const decision = newDecision(work, builder, owner);
  work.reportAnswer(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No guessing.', source: 'terminal' });
  return decision;
}

test('a share outcome is an append that records purpose, outcome and the message id', () => {
  const { work } = fresh();
  const decision = reportedDecision(work);
  const before = work.get(lead, { id: decision.id }).item.revision;
  const shared = work.share(lead, {
    operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57,
  });
  assert.equal(shared.ok, true);
  assert.equal(shared.event.kind, 'shared');
  assert.deepEqual(shared.event.by, ref(lead));
  const detail = work.get(lead, { id: decision.id });
  const last = detail.history.at(-1);
  assert.equal(last.kind, 'shared');
  assert.equal(last.purpose, 'exposure');
  assert.equal(last.outcome, 'sent');
  assert.equal(last.to, 'Ana');
  assert.equal(last.message_id, 57);
  assert.equal(last.detail, '');
  assert.equal(detail.item.revision, before);
  const declined = work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'declined', to: 'Ana' });
  assert.equal(declined.event.message_id, null);
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'broadcast', outcome: 'declined', to: 'Ana' }), 'invalid-purpose');
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'delivered', to: 'Ana' }), 'invalid-outcome');
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'declined', to: ' ' }), 'invalid-to');
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'declined', to: 'Ana', expected_revision: 2 }), 'invalid-input');
});

test('a sent share requires a message id and a declined or failed one refuses it', () => {
  const { work } = fresh();
  const decision = reportedDecision(work);
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'sent', to: 'Ana' }), 'invalid-message-id');
  for (const bad of [0, -3, 1.5, '57', Number.MAX_SAFE_INTEGER + 1, null]) {
    code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: bad }), 'invalid-message-id');
  }
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'declined', to: 'Ana', message_id: 57 }), 'invalid-message-id');
  code(() => work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'failed', to: 'Ana', message_id: 57 }), 'invalid-message-id');
  assert.equal(work.get(lead, { id: decision.id }).history.at(-1).kind, 'answer-reported', 'a refused share appends nothing');
});

test('a failed exposure leaves the reported answer standing', () => {
  const { work } = fresh();
  const decision = reportedDecision(work);
  work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'failed', to: 'Ana', detail: 'The room was unreachable.' });
  const detail = work.get(owner, { id: decision.id });
  assert.equal(detail.item.answer.kind, 'reported');
  assert.equal(detail.item.state, 'reported');
  assert.equal(detail.history.at(-1).detail, 'The room was unreachable.');
});

test('markdown export renders a share outcome with its message id', () => {
  const { work } = fresh();
  const decision = reportedDecision(work);
  work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 });
  work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'declined', to: 'Ana' });
  work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'exposure', outcome: 'failed', to: 'Ana', detail: 'The room was unreachable.' });
  work.share(lead, { operation_id: uuid(), id: decision.id, purpose: 'notify', outcome: 'failed', to: 'Reviewer' });
  const body = work.exportRecords(owner, { format: 'md' }).body;
  assert.match(body, /· Lead · shared · exposure · sent as #57 to Ana · a send receipt is not proof of reading\n/);
  assert.match(body, /· Lead · shared · notify · declined · to Ana\n/);
  assert.match(body, /· Lead · shared · exposure · failed · to Ana · The room was unreachable\.\n/);
  assert.match(body, /· Lead · shared · notify · failed · to Reviewer\n/);
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

test('an unrelated participant cannot reopen or re-address another person\'s question', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, owner);
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  code(() => work.reopen(builder, { operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'New facts.' }),
    'not-asker');
  code(() => work.reopen(builder, { operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'Mine to make.', asked_of: ref(builder) }),
    'not-asker');
  assert.equal(work.get(owner, { id: decision.id }).item.state, 'answered');
});

test('the asker may reopen and re-address to a third party; the event keeps the previous recipient', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, owner);
  code(() => work.reopen(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'still open' }),
    'invalid-state');
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  const reopened = work.reopen(lead, {
    operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'Reviewer decides.', asked_of: ref(reviewer),
  });
  assert.equal(reopened.item.state, 'awaiting');
  assert.deepEqual(reopened.item.asked_of, ref(reviewer));
  assert.equal(reopened.item.answer, null);
  assert.deepEqual(work.list(reviewer, { needs_me: true }).items.map(row => row.id), [decision.id]);
  const event = work.get(owner, { id: decision.id }).history.find(e => e.kind === 'reopened');
  assert.deepEqual(event.previous_asked_of, ref(owner));
  assert.deepEqual(event.asked_of, ref(reviewer));
  assert.match(work.exportRecords(owner, { format: 'md' }).body, /asked of Reviewer · previously asked of Ana/);
});

test('the owner may reopen any decision', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, builder);
  work.answer(builder, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'Dates first.' });
  const reopened = work.reopen(owner, { operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'New facts.' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.item.state, 'awaiting');
  assert.deepEqual(reopened.item.asked_of, ref(builder));
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
  work.updateWork(builder, { operation_id: uuid(), id: item.id, expected_revision: 1, target: 'sha-b', note: 'repaired' });
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

test('brief counts each project\'s done work and findings, never its decisions', () => {
  const { work } = fresh();
  work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Finance' });
  const counts = () => new Map(work.brief(owner).projects.map(project => [project.id, project.done_count]));
  assert.deepEqual([...counts()], [['ops', 0], ['finance', 0]]);
  const done = newWork(work, lead);
  work.updateWork(lead, { operation_id: uuid(), id: done.id, expected_revision: 1, state: 'done',
    done_account: 'Imported.', no_evidence: true, note: 'closing' });
  const finding = work.createItem(lead, { operation_id: uuid(), kind: 'finding', project: 'finance', title: 'Gap',
    body: 'Seen.' }).item;
  work.updateWork(lead, { operation_id: uuid(), id: finding.id, expected_revision: 1, state: 'done',
    done_account: 'Closed.', no_evidence: true, note: 'closing' });
  newWork(work, lead);
  const decision = newDecision(work, builder, owner);
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  assert.deepEqual([...counts()], [['ops', 1], ['finance', 1]]);
  assert.equal(work.brief(owner, { project: 'finance' }).projects[0].done_count, 1);
});

test('brief counts each project\'s withdrawn decisions, so the tile can still reach them', () => {
  const { work } = fresh();
  const withdrawn = () => work.brief(owner).projects.map(project => [project.id, project.withdrawn_count]);
  const decision = newDecision(work, builder, owner);
  newDecision(work, builder, owner);
  assert.deepEqual(withdrawn(), [['ops', 0]], 'ARRANGEMENT: open decisions are not counted');
  work.withdraw(builder, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'not needed' });
  assert.deepEqual(withdrawn(), [['ops', 1]]);
  assert.equal(work.brief(owner).decisions.some(row => row.id === decision.id), false,
    'the brief still leaves a withdrawn decision out of its open list');
  work.reopen(builder, { operation_id: uuid(), id: decision.id, expected_revision: 2, reason: 'needed after all' });
  assert.deepEqual(withdrawn(), [['ops', 0]], 'a reopened decision is no longer counted');
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

// ── review fixes ──────────────────────────────────────────────────────────────

test('an ordinary edit to a blocked item keeps its unblocker in the queue', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked', block_reason: 'Needs the scope.',
    next_to: ref(reviewer), next_action: 'Name the scope you will check.', note: 'asked the reviewer',
  });
  const edited = work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 2, title: 'Import rows (typo fixed)', note: 'typo',
  });
  assert.deepEqual(edited.item.next_to, ref(reviewer));
  assert.deepEqual(work.list(reviewer, { needs_me: true }).items.map(row => row.id), [item.id]);
});

test('a ref keeps the session discriminator of the participant it names, through export', () => {
  const { work } = fresh();
  const second = { subject_id: 's-9', name: 'Builder', kind: 'seat', session: 2 };
  const item = newWork(work, lead, { next_to: second, next_action: 'Prepare.' });
  assert.deepEqual(item.next_to, second);
  const json = JSON.parse(work.exportRecords(owner, { format: 'json' }).body);
  assert.deepEqual(json.items[0].next_to, { name: 'Builder', kind: 'seat', session: 2 });
  assert.deepEqual(json.items[0].created_by, { name: 'Lead', kind: 'seat', session: null });
  assert.ok(work.exportRecords(owner, { format: 'md' }).body.includes('Builder (session 2)'));
});

test('a changed participant exports as name and session, never as its opaque id', () => {
  const { work } = fresh();
  const second = { subject_id: 's-9', name: 'Builder', kind: 'seat', session: 2 };
  const item = newWork(work, lead, { next_to: ref(lead), next_action: 'Prepare.' });
  work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 1, next_to: second, note: 'handing over' });
  const markdown = work.exportRecords(owner, { format: 'md' }).body;
  assert.doesNotMatch(markdown, /subject_id/);
  const updated = markdown.split('\n').filter(line => line.includes(' · updated · '));
  assert.equal(updated.length, 1);
  assert.ok(updated[0].endsWith(' · handing over · next_to: Lead → Builder (session 2)'), updated[0]);
});

// ── second review (Codex) ─────────────────────────────────────────────────────

test('history keeps the values a change replaced, and creation records the initial fields', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { body: 'Original requirement.' });
  work.updateWork(builder, { operation_id: uuid(), id: item.id, expected_revision: 1, body: 'Rewritten.', note: 'rewrote' });
  const history = work.get(lead, { id: item.id }).history;
  assert.equal(history[0].kind, 'created');
  assert.equal(history[0].body, 'Original requirement.');
  assert.deepEqual(history[1].before, { body: 'Original requirement.' });
  assert.deepEqual(history[1].after, { body: 'Rewritten.' });
  assert.ok(work.exportRecords(owner, { format: 'md' }).body.includes('Original requirement.'));
});

test('a project filter never hides what needs me or what was reported to me', () => {
  const { work } = fresh();
  work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Finance' });
  const decision = newDecision(work, builder, owner, { project: 'finance' });
  const reported = newDecision(work, builder, owner, { project: 'finance', title: 'Second' });
  work.reportAnswer(lead, { operation_id: uuid(), id: reported.id, expected_revision: 1, text: 'No.', source: 'terminal' });
  const brief = work.brief(owner, { project: 'ops' });
  assert.deepEqual(brief.projects.map(p => p.id), ['ops']);
  assert.deepEqual(brief.needs_me.map(row => row.id), [decision.id]);
  assert.deepEqual(brief.reported_to_me.map(row => row.id), [reported.id]);
  assert.deepEqual(brief.decisions, []);
});

test('markdown export renders evidence attached to a decision in full', () => {
  const { work } = fresh();
  const decision = newDecision(work, builder, owner);
  work.attachEvidence(reviewer, {
    operation_id: uuid(), id: decision.id, target: 'sample run 4', observed: 'Dates stayed unresolved.',
    reference: 'run log 4', limits: 'Sample file only.',
  });
  const body = work.exportRecords(owner, { format: 'md' }).body;
  for (const expected of ['sample run 4', 'run log 4', 'Sample file only.']) {
    assert.ok(body.includes(expected), 'decision evidence is missing: ' + expected);
  }
});

test('done needs an explicit evidence reference or an explicit no-evidence declaration', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  code(() => work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'done', done_account: 'Merged.', note: 'done',
  }), 'invalid-done-evidence');
  const bare = work.updateWork(lead, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'done', done_account: 'Merged.',
    no_evidence: true, note: 'done',
  });
  assert.equal(bare.item.done_evidence, null);
  assert.equal(bare.item.done_without_evidence, true);
  assert.ok(work.exportRecords(owner, { format: 'md' }).body.includes('no evidence attached'));
  const second = newWork(work, lead, { title: 'Second' });
  const evidence = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: second.id, target: 'sha-a', observed: 'Green.', reference: 'run 1', limits: 'Unit only.',
  });
  code(() => work.updateWork(lead, {
    operation_id: uuid(), id: second.id, expected_revision: 1, state: 'done', done_account: 'Merged.',
    done_evidence: 999, note: 'done',
  }), 'invalid-done-evidence');
  const cited = work.updateWork(lead, {
    operation_id: uuid(), id: second.id, expected_revision: 1, state: 'done', done_account: 'Merged.',
    done_evidence: evidence.event.seq, note: 'done',
  });
  assert.equal(cited.item.done_evidence, evidence.event.seq);
  assert.equal(cited.item.done_without_evidence, false);
});

test('entering blocked keeps a next actor only when this request names both the unblocker and the act', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { next_to: ref(builder), next_action: 'Wait for review.' });
  const entered = work.updateWork(builder, {
    operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked', block_reason: 'Needs the scope.',
    next_to: ref(reviewer), note: 'blocked, recipient named but no act',
  });
  assert.equal(entered.item.next_to, null, 'an old waiting action is not an unblocking act');
  assert.deepEqual(work.list(reviewer, { needs_me: true }).items, []);
});

test('parents are one level deep: no self-parenting, no chains, no cycles', () => {
  const { work } = fresh();
  const top = newWork(work, lead, { title: 'Top' });
  const middle = newWork(work, lead, { title: 'Middle', parent: top.id });
  code(() => work.updateWork(lead, { operation_id: uuid(), id: top.id, expected_revision: 1, parent: top.id, note: 'self' }), 'invalid-parent');
  code(() => newWork(work, lead, { title: 'Deep', parent: middle.id }), 'invalid-parent');
  code(() => work.updateWork(lead, { operation_id: uuid(), id: top.id, expected_revision: 1, parent: middle.id, note: 'cycle' }), 'invalid-parent');
});

test('a captured source is stored, derives the source text, and survives in get and export', () => {
  const { work } = fresh();
  const capture = { message_id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2, quote: 'after the check' };
  const item = newWork(work, lead, { source_message: capture });
  const derived = 'room message #42 · Marlow (session 2) · 2023-11-14T22:13:20.000Z';
  assert.equal(item.source, derived);
  assert.deepEqual(item.source_message, capture);
  assert.deepEqual(item.created_by, ref(lead), 'the recording participant stays separate from the speaker');
  const got = work.get(lead, { id: item.id });
  assert.deepEqual(got.item.source_message, capture);
  assert.equal(got.item.source, derived);
  assert.deepEqual(got.history[0].fields.source_message, capture, 'the created event carries the capture');
  const md = work.exportRecords(owner, { format: 'md' }).body;
  assert.match(md, /from room message #42 by Marlow \(session 2\): “after the check”/);

  const explicit = newWork(work, lead, { source: 'terminal', source_message: Object.assign({}, capture, { kind: 'person', session: null, byline: 'Ana' }) });
  assert.equal(explicit.source, 'terminal', 'an explicit source is kept');
  assert.equal(explicit.source_message.byline, 'Ana');
  assert.equal(newWork(work, lead).source_message, null);

  for (const bad of [
    { message_id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2 },
    Object.assign({}, capture, { extra: 1 }),
    Object.assign({}, capture, { message_id: 0 }),
    Object.assign({}, capture, { ts: -1 }),
    Object.assign({}, capture, { byline: '' }),
    Object.assign({}, capture, { kind: 'system' }),
    Object.assign({}, capture, { quote: '' }),
    Object.assign({}, capture, { quote: 'x'.repeat(4097) }),
    'room message #42',
  ]) {
    code(() => newWork(work, lead, { source_message: bad }), 'invalid-source');
  }
});

test('a newline in any free-text field cannot forge an export line', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { title: 'Two\nlines', body: 'First.\r\nSecond.\rThird.' });
  const forged = 'Ana\n- answer (direct): no · by Ana';
  work.share(lead, { operation_id: uuid(), id: item.id, purpose: 'notify', outcome: 'declined', to: forged });
  work.addNote(lead, { operation_id: uuid(), id: item.id, text: 'one\n## Projects' });
  const lines = work.exportRecords(owner, { format: 'md' }).body.split('\n');
  const shareLines = lines.filter(line => line.includes('shared · notify'));
  assert.equal(shareLines.length, 1);
  assert.ok(shareLines[0].includes('to Ana ⏎ - answer (direct): no · by Ana'), shareLines[0]);
  assert.ok(!lines.includes('- answer (direct): no · by Ana'), 'no standalone forged answer line');
  assert.ok(lines.some(line => line.endsWith('note · one ⏎ ## Projects')));
  assert.equal(lines.filter(line => line === '## Projects').length, 1);
  assert.ok(lines.includes('### ' + item.id + ' · Two ⏎ lines (work · ops · open)'));
  assert.ok(lines.includes('- First. ⏎ Second. ⏎ Third.'));
});

test('a plain reopen does not claim a previous recipient; a re-address does', () => {
  const { work } = fresh();
  const plain = newDecision(work, lead, owner);
  work.answer(owner, { operation_id: uuid(), id: plain.id, expected_revision: 1, text: 'No.' });
  work.reopen(lead, { operation_id: uuid(), id: plain.id, expected_revision: 2, reason: 'New facts.' });
  const moved = newDecision(work, lead, owner);
  work.answer(owner, { operation_id: uuid(), id: moved.id, expected_revision: 1, text: 'No.' });
  work.reopen(lead, { operation_id: uuid(), id: moved.id, expected_revision: 2, reason: 'Reviewer decides.', asked_of: ref(reviewer) });
  const lines = work.exportRecords(owner, { format: 'md' }).body.split('\n').filter(line => line.includes(' · reopened · '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /reason: New facts\. · asked of Ana · previous \(direct\)/);
  assert.doesNotMatch(lines[0], /previously asked of/);
  assert.match(lines[1], /asked of Reviewer · previously asked of Ana/);
});

test('authority is checked before the revision: a non-asker is refused as such, even on a stale revision', () => {
  const { work } = fresh();
  const decision = newDecision(work, lead, owner);
  work.answer(owner, { operation_id: uuid(), id: decision.id, expected_revision: 1, text: 'No.' });
  code(() => work.reopen(builder, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'x' }), 'not-asker');
  const open = newDecision(work, lead, owner);
  code(() => work.withdraw(builder, { operation_id: uuid(), id: open.id, expected_revision: 9, reason: 'x' }), 'not-asker');
  code(() => work.reopen(lead, { operation_id: uuid(), id: decision.id, expected_revision: 1, reason: 'x' }), 'stale-revision');
  code(() => work.withdraw(lead, { operation_id: uuid(), id: open.id, expected_revision: 9, reason: 'x' }), 'stale-revision');
});

test('evidence from a room message keeps the capture, credits the speaker in the reference, and exports both', () => {
  const { work } = fresh();
  const item = newWork(work, lead, { target: 'sha-a' });
  const capture = { message_id: 42, ts: 1700000000000, byline: 'Marlow', kind: 'seat', session: 2, quote: 'the import passed' };
  const attached = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'the import passed', limits: 'one run only',
    source_message: capture,
  });
  assert.deepEqual(attached.event.source_message, capture);
  assert.equal(attached.event.reference, 'room message #42 · Marlow (session 2)');
  assert.deepEqual(attached.event.by, ref(reviewer), 'the recorder stays separate from the speaker');
  const got = work.get(owner, { id: item.id });
  assert.deepEqual(got.evidence[0].source_message, capture);
  const md = work.exportRecords(owner, { format: 'md' }).body;
  assert.match(md, /reference: room message #42 · Marlow \(session 2\) · limits: one run only · from room message #42 by Marlow \(session 2\): “the import passed”/);

  const explicit = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', reference: 'CI run 7', limits: 'z', source_message: capture,
  });
  assert.equal(explicit.event.reference, 'CI run 7', 'an explicit reference is kept');
  const plain = work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', reference: 'y', limits: 'z',
  });
  assert.equal(plain.event.source_message, null);
  code(() => work.attachEvidence(reviewer, {
    operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', limits: 'z',
  }), 'invalid-reference');
  for (const bad of [Object.assign({}, capture, { extra: 1 }), { message_id: 42, quote: 'the import passed' }, 'room message #42']) {
    code(() => work.attachEvidence(reviewer, {
      operation_id: uuid(), id: item.id, target: 'sha-a', observed: 'x', limits: 'z', source_message: bad,
    }), 'invalid-source');
  }
});

test('an export names a block reason only while the item is blocked', () => {
  const { work } = fresh();
  const item = newWork(work, lead);
  work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 1, state: 'blocked', block_reason: 'Waiting on the bank.', note: 'stuck' });
  const itemLine = () => work.exportRecords(owner, { format: 'md' }).body.split('\n').find(line => line.startsWith('- responsible: '));
  assert.match(itemLine(), / · blocked: Waiting on the bank\./);
  work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 2, state: 'done', done_account: 'Imported.',
    no_evidence: true, note: 'finished' });
  assert.doesNotMatch(itemLine(), /blocked:/);
  assert.match(itemLine(), / · done: Imported\./);
  code(() => work.updateWork(lead, { operation_id: uuid(), id: item.id, expected_revision: 3, title: 'x' }), 'invalid-note');
});

test('Operations, the default project, cannot be retired; another project can', () => {
  const { work } = fresh();
  work.createProject(owner, { operation_id: uuid(), id: 'finance', display_name: 'Finance' });
  assert.equal(work.retireProject(owner, { operation_id: uuid(), id: 'finance' }).project.retired_at !== null, true,
    'ARRANGEMENT: the owner can retire a project');
  code(() => work.retireProject(owner, { operation_id: uuid(), id: 'ops' }), 'default-project');
  assert.ok(work.brief(owner).projects.some(project => project.id === 'ops'), 'Operations stays live');
});

test('a room answer reaches only the decision bound to its ask, from its addressee, and the latest one is the record', () => {
  const { work, store } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Merge?', body: 'b',
    asked_of: ref(owner), source_message: { message_id: 41, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Merge?' },
  }).item;
  const asOwner = Object.assign({}, owner, { session: null });
  const say = (message_id, choice, extra = {}) => work.answerFromRoom(asOwner, Object.assign({
    ask_id: 41, revision: 1, message_id, text: choice || 'ok', choice, by_addressee: true, of: ANA_OF,
  }, extra));
  assert.equal(say(49, 'yes').recorded, null, 'before the bind, nothing records');
  boundByEarlierBuild(store, decision.id, 41);
  assert.equal(say(50, 'yes', { by_addressee: false }).recorded, null, 'the room says a bystander: nothing records');
  assert.equal(say(51, 'yes').recorded, decision.id);
  assert.equal(say(51, 'yes').replayed, true);
  assert.equal(say(52, 'no').recorded, decision.id, 'her later answer is the record');
  let after = work.get(owner, { id: decision.id });
  assert.equal(after.item.answer.choice, 'no');
  assert.equal(after.item.answer.source, 'answered in the room #52');
  assert.deepEqual(after.history.filter(event => event.kind === 'answered' || event.kind === 'answer-replaced')
    .map(event => event.choice), ['yes', 'no'], 'earlier answers stay on the trail');
  // Reopened to the same person: a replay of an old message records nothing.
  work.reopen(owner, { operation_id: uuid(), id: decision.id, expected_revision: after.item.revision, reason: 'again' });
  assert.equal(say(51, 'yes').replayed, true, 'a message is recorded once in the decision\'s life');
  assert.equal(work.get(owner, { id: decision.id }).item.state, 'awaiting');
  // Re-addressed: the decision lets go of the ask; nobody's room answer records.
  after = work.get(owner, { id: decision.id });
  work.withdraw(owner, { operation_id: uuid(), id: decision.id, expected_revision: after.item.revision, reason: 'r' });
  after = work.get(owner, { id: decision.id });
  work.reopen(owner, { operation_id: uuid(), id: decision.id, expected_revision: after.item.revision, reason: 'to Builder', asked_of: ref(builder) });
  after = work.get(owner, { id: decision.id });
  assert.equal(after.item.ask_message_id, null);
  assert.equal(after.history.filter(event => event.kind === 'reopened').slice(-1)[0].unbound_ask, 41);
  assert.equal(work.answerFromRoom(Object.assign({}, builder, { session: null }), {
    ask_id: 41, revision: 1, message_id: 60, text: 'yes', choice: 'yes', by_addressee: false,
    of: ANA_OF,
  }).recorded, null);
  assert.equal(say(61, 'yes').recorded, null, 'her answer to the ask put to her no longer reaches it either');
});

test('on the record, a room answer from a seat that only shares the asked seat\'s name records nothing', () => {
  const { work, store } = fresh();
  const BUILDER_OF = { kind: 'seat', subject_id: builder.subject_id, name: 'Builder' };
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rerun?', body: 'b',
    asked_of: ref(builder), source_message: { message_id: 70, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Rerun?' },
  }).item;
  boundByEarlierBuild(store, decision.id, 70);
  // The room counts a rejoined Builder as the addressee (by name); the record does not.
  assert.equal(work.answerFromRoom(Object.assign({}, sameName, { session: null }), {
    ask_id: 70, revision: 1, message_id: 71, text: 'yes', choice: 'yes', by_addressee: true, of: BUILDER_OF,
  }).recorded, null);
  assert.equal(work.answerFromRoom(Object.assign({}, builder, { session: null }), {
    ask_id: 70, revision: 1, message_id: 72, text: 'yes', choice: 'yes', by_addressee: true, of: BUILDER_OF,
  }).recorded, decision.id);
});

test('the latest room answer is the one latest in the room, not the one that arrived last', () => {
  const { work, store } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Order?', body: 'b',
    asked_of: ref(owner), source_message: { message_id: 90, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Order?' },
  }).item;
  boundByEarlierBuild(store, decision.id, 90);
  const asOwner = Object.assign({}, owner, { session: null });
  const say = (message_id, choice) => work.answerFromRoom(asOwner, {
    ask_id: 90, revision: 1, message_id, text: choice, choice, by_addressee: true, of: ANA_OF,
  });
  assert.equal(say(95, 'no').recorded, decision.id);
  assert.equal(say(93, 'yes').recorded, null, 'an older message arriving later does not replace her newer answer');
  assert.equal(work.get(owner, { id: decision.id }).item.answer.choice, 'no');
  const row = work.list(owner, {}).items.find(entry => entry.id === decision.id);
  assert.equal(row.answer_summary.source, 'answered in the room #95', 'list rows can say where it was answered');
});

test('the first owner\'s recorded answer stands: no admin replaces or reopens it, no room answer replaces it', () => {
  const { work, store } = fresh();
  const first = Object.assign({}, owner, { first_owner: true });
  const admin = Object.freeze({ subject_id: 'p-2', name: 'Bea', kind: 'person', owner: true, first_owner: false });
  const decision = newDecision(work, lead, owner);
  const answered = work.answer(first, { operation_id: uuid(), id: decision.id, expected_revision: decision.revision, text: 'yes' }).item;
  assert.equal(answered.answer.first_owner_protected, true);
  assert.throws(() => work.answer(admin, { operation_id: uuid(), id: decision.id, expected_revision: answered.revision, text: 'no', reason: 'overruled' }),
    error => error.code === 'first-owner-answer');
  assert.throws(() => work.reopen(admin, { operation_id: uuid(), id: decision.id, expected_revision: answered.revision, reason: 'again' }),
    error => error.code === 'first-owner-answer');
  assert.equal(work.get(owner, { id: decision.id }).item.answer.text, 'yes', 'her answer stands');
  const reopened = work.reopen(first, { operation_id: uuid(), id: decision.id, expected_revision: answered.revision, reason: 'mine to reopen' }).item;
  assert.equal(reopened.state, 'awaiting', 'she may reopen her own');
  // Her answer on a seat's behalf is not replaced by that seat's room answer.
  const BUILDER_OF = { kind: 'seat', subject_id: builder.subject_id, name: 'Builder' };
  const ofSeat = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rerun?', body: 'b', asked_of: ref(builder),
    source_message: { message_id: 110, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Rerun?' },
  }).item;
  const bound = boundByEarlierBuild(store, ofSeat.id, 110);
  work.answer(first, { operation_id: uuid(), id: ofSeat.id, expected_revision: bound.revision, text: 'no', reason: 'on its behalf' });
  assert.equal(work.answerFromRoom(Object.assign({}, builder, { session: null, first_owner: false }), {
    ask_id: 110, revision: 1, message_id: 111, text: 'yes', choice: 'yes', by_addressee: true, of: BUILDER_OF,
  }).recorded, null);
  assert.equal(work.get(owner, { id: ofSeat.id }).item.answer.text, 'no');
  // An admin's own recorded answer is not protected from another admin.
  const other = newDecision(work, lead, builder);
  const byAdmin = work.answer(admin, { operation_id: uuid(), id: other.id, expected_revision: other.revision, text: 'go', reason: 'on behalf' }).item;
  assert.equal(work.reopen(Object.assign({}, admin, { subject_id: 'p-3', name: 'Cy' }),
    { operation_id: uuid(), id: other.id, expected_revision: byAdmin.revision, reason: 'r' }).item.state, 'awaiting');
});

test('an answer written before protection was recorded counts as protected when a person gave it', () => {
  const { store, work } = fresh();
  const admin = Object.freeze({ subject_id: 'p-2', name: 'Bea', kind: 'person', owner: true, first_owner: false });
  const decision = newDecision(work, lead, owner);
  const answered = work.answer(Object.assign({}, owner, { first_owner: true }),
    { operation_id: uuid(), id: decision.id, expected_revision: decision.revision, text: 'yes' }).item;
  // Arrange the older shape: the same answer without the stored fact.
  store.commit(draft => { delete draft.items.find(row => row.id === decision.id).answer.first_owner_protected; });
  assert.equal(work.get(owner, { id: decision.id }).item.answer.first_owner_protected, undefined, 'the arrangement');
  assert.throws(() => work.reopen(admin, { operation_id: uuid(), id: decision.id, expected_revision: answered.revision, reason: 'r' }),
    error => error.code === 'first-owner-answer');
});

test('a work row names the room message it was made from', () => {
  const { work } = fresh();
  const made = work.createItem(lead, {
    operation_id: uuid(), kind: 'work', project: 'ops', title: 'Track it', body: 'b',
    source_message: { message_id: 12, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: x' },
  }).item;
  const plain = newWork(work, lead);
  const rows = work.list(owner, {}).items;
  assert.equal(rows.find(row => row.id === made.id).source_message_id, 12);
  assert.equal(rows.find(row => row.id === plain.id).source_message_id, null);
});

test('a revised ask moves its decision\'s scope and voids an answer given to the old scope', () => {
  const { work, store } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers?', body: 'b', asked_of: ref(owner), scope: 'OEM',
    source_message: { message_id: 120, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Rollers?' },
  }).item;
  boundByEarlierBuild(store, decision.id, 120);
  work.answerFromRoom(Object.assign({}, owner, { session: null }), {
    ask_id: 120, revision: 1, message_id: 121, text: 'yes', choice: 'yes', by_addressee: true, of: ANA_OF,
  });
  assert.equal(work.reviseScope(Object.assign({}, builder, { session: null }), { ask_id: 120, means: 'third-party', revision: 2 }).revised, null,
    'only the decision\'s asker');
  assert.equal(work.reviseScope(Object.assign({}, lead, { session: null }), { ask_id: 120, means: 'third-party', revision: 2 }).revised, decision.id);
  const after = work.get(owner, { id: decision.id });
  assert.equal(after.item.scope, 'third-party');
  assert.equal(after.item.state, 'awaiting', 'her yes to OEM does not stand for third-party');
  const event = after.history.filter(row => row.kind === 'scope-revised').slice(-1)[0];
  assert.deepEqual([event.before, event.after, event.answer_superseded.text], ['OEM', 'third-party', 'yes']);
});

test('a decision follows the room ask by revision number, and takes a room answer only for the revision its scope is', () => {
  const { work, store } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const decision = work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Rollers?', body: 'b', asked_of: ref(owner), scope: 'OEM',
    source_message: { message_id: 130, ts: 1, byline: 'Lead', kind: 'seat', session: null, quote: 'Decision: Rollers?' },
  }).item;
  const asLead = Object.assign({}, lead, { session: null });
  const asOwner = Object.assign({}, owner, { session: null });
  const bound = boundByEarlierBuild(store, decision.id, 130);
  assert.equal(bound.ask_revision, 1, 'bound at the first revision');
  const say = (message_id, revision) => work.answerFromRoom(asOwner, {
    ask_id: 130, message_id, text: 'yes', choice: 'yes', by_addressee: true, of: ANA_OF, revision,
  });
  assert.equal(work.reviseScope(asLead, { ask_id: 130, means: 'third-party', revision: 2 }).revised, decision.id);
  assert.equal(say(131, 1).recorded, null, 'her yes to revision 1 never stands for revision 2');
  assert.equal(work.get(owner, { id: decision.id }).item.answer, null);
  assert.equal(work.reviseScope(asLead, { ask_id: 130, means: 'eBay', revision: 3 }).revised, decision.id);
  assert.equal(work.reviseScope(asLead, { ask_id: 130, means: 'third-party', revision: 2 }).revised, null,
    'an older revision arriving late never replaces a newer one');
  let after = work.get(owner, { id: decision.id }).item;
  assert.deepEqual([after.scope, after.ask_revision], ['eBay', 3]);
  assert.equal(say(132, 2).recorded, null);
  assert.equal(say(133, 3).recorded, decision.id);
  after = work.get(owner, { id: decision.id }).item;
  assert.deepEqual([after.state, after.answer.ask_revision], ['answered', 3], 'the answer names the revision it is to');
  // The record could not follow revision 4: it takes no room answer until it has.
  assert.equal(say(134, 4).recorded, null);
  // A decision bound before revisions were counted reads as the first.
  store.commit(draft => { delete draft.items.find(row => row.id === decision.id).ask_revision; });
  assert.equal(work.get(owner, { id: decision.id }).item.ask_revision, undefined, 'the arrangement: the older shape');
  assert.equal(say(135, 1).recorded, decision.id);
  assert.throws(() => say(136, undefined), error => error.code === 'invalid-input', 'an answer names its revision');
});

test('a request for approval: only its approver\'s explicit answer at the current revision counts; a revise reopens; only its asker closes it', () => {
  const { work } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const asLead = Object.assign({}, lead, { session: null });
  const asOwner = Object.assign({}, owner, { session: null });
  const filed = work.createApproval(asLead, { operation_id: uuid(), project: 'ops', title: 'Order rollers',
    scope: 'two rollers, up to $40', approver: ANA_OF, ask_message_id: 140 }).item;
  assert.deepEqual([filed.state, filed.approval.state, filed.next_to.name], ['open', 'awaiting', 'Ana']);
  const say = (who, message_id, choice, revision = 1, byAddressee = true, approverOk = true) => work.answerFromRoom(who, {
    ask_id: 140, message_id, text: String(choice), choice, by_addressee: byAddressee, of: ANA_OF, revision, approver_ok: approverOk });
  assert.equal(say(Object.assign({}, builder, { session: null }), 141, 'yes', 1, false, false).recorded, null, 'a bystander\'s yes');
  assert.equal(say(asOwner, 149, 'yes', 1, true, false).recorded, null, 'a yes the host did not find from the current approver');
  assert.equal(say(asOwner, 142, null).recorded, null, 'her words alone');
  assert.equal(say(asOwner, 143, 'yes', 2).recorded, null, 'a yes to a revision the record is not at');
  assert.equal(work.get(owner, { id: filed.id }).item.approval.state, 'awaiting');
  assert.equal(say(asOwner, 144, 'yes').recorded, filed.id);
  let now = work.get(owner, { id: filed.id }).item;
  assert.deepEqual([now.state, now.approval.state, now.responsible.name], ['active', 'approved', 'Lead']);
  // Revised after the approval: back to awaiting, the approval struck on the trail.
  assert.equal(work.reviseScope(asLead, { ask_id: 140, means: 'two rollers, up to $42', revision: 2 }).revised, filed.id);
  now = work.get(owner, { id: filed.id });
  assert.deepEqual([now.item.state, now.item.approval.state, now.item.responsible], ['open', 'awaiting', null]);
  assert.ok(now.history.some(event => event.kind === 'scope-revised' && event.approval_superseded), 'the old approval stays on the trail');
  assert.equal(work.closeApproval(asLead, { ask_id: 140, message_id: 145, text: 'done' }).closed, null, 'not approved: nothing to close');
  assert.equal(say(asOwner, 146, 'yes', 2).recorded, filed.id);
  assert.equal(work.closeApproval(asOwner, { ask_id: 140, message_id: 147, text: 'done' }).closed, null, 'only its asker closes it');
  assert.throws(() => work.updateWork(asLead, { operation_id: uuid(), id: filed.id, expected_revision: work.get(owner, { id: filed.id }).item.revision,
    note: 'n', state: 'done' }), error => error.code === 'invalid-kind', 'nobody moves it by update');
  assert.equal(work.closeApproval(asLead, { ask_id: 140, message_id: 148, text: 'Ordered, arriving Friday' }).closed, filed.id);
  assert.equal(work.get(owner, { id: filed.id }).item.state, 'done');
});

test('a waiting request is in its current approver\'s Needs you, and moves with the lead', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-service-'));
  let now = 1_700_000_000_000;
  let current = { subject_id: 'p-bea', name: 'Bea' };
  const approverFor = () => ({ approver: current, owner: { subject_id: owner.subject_id, name: 'Ana' } });
  const work = createWorkService({ store: openWorkStore({ dataDir }), clock: () => (now += 1000), approverFor });
  const bea = Object.freeze({ subject_id: 'p-bea', name: 'Bea', kind: 'person', owner: false });
  const cara = Object.freeze({ subject_id: 'p-cara', name: 'Cara', kind: 'person', owner: false });
  const filed = work.createApproval(Object.assign({}, lead, { session: null }), { operation_id: uuid(), project: 'ops', title: 'Order rollers',
    scope: 'two rollers', approver: { subject_id: 'p-bea', name: 'Bea', kind: 'person' }, ask_message_id: 150 }).item;
  const waiting = who => work.brief(who, {}).needs_me.map(row => row.id);
  assert.deepEqual(waiting(bea), [filed.id], 'the arrangement: it waits on Bea, the lead it was filed with');
  current = { subject_id: 'p-cara', name: 'Cara' };
  assert.deepEqual(waiting(cara), [filed.id], 'the lead changed: it waits on Cara now');
  assert.deepEqual(waiting(bea), [], 'and no longer on Bea');
  assert.equal(work.brief(cara, {}).needs_me[0].approval.approver.name, 'Cara', 'the row names the current approver');
});

test('a filed decision binds only the ask its host just posted for it; a cited message is never the ask', () => {
  const { work } = fresh();
  const ANA_OF = { kind: 'person', subject_id: owner.subject_id, name: 'Ana' };
  const file = (source) => work.createItem(lead, {
    operation_id: uuid(), kind: 'decision', project: 'ops', title: 'Which cut-off?', body: 'b',
    asked_of: ref(owner), source_message: { message_id: source, ts: 1, byline: 'Ana', kind: 'person', session: null, quote: 'March' },
  }).item;
  const cites = file(50);
  code(() => work.bindAsk(lead, { id: cites.id, ask_message_id: 49, of: ANA_OF, cites_other: true }), 'not-authorized');
  code(() => work.bindAsk(lead, { id: cites.id, ask_message_id: 50, of: ANA_OF, cites_other: true }), 'not-authorized');
  code(() => work.bindAsk(builder, { id: cites.id, ask_message_id: 51, of: ANA_OF, cites_other: true }), 'not-authorized');
  code(() => work.bindAsk(lead, { id: cites.id, ask_message_id: 51, of: ANA_OF, cites_other: false }), 'invalid-input');
  const bound = work.bindAsk(lead, { id: cites.id, ask_message_id: 51, of: ANA_OF, cites_other: true });
  assert.deepEqual([bound.item.ask_message_id, bound.item.source_message.message_id], [51, 50],
    'bound to the newer ask its host posted; the citation stays');
  const plain = file(60);
  code(() => work.bindAsk(lead, { id: plain.id, ask_message_id: 61, of: ANA_OF }), 'not-authorized');
  assert.equal(work.bindAsk(lead, { id: plain.id, ask_message_id: 60, of: ANA_OF }).item.ask_message_id, 60,
    'without a citation of its own, the ask is what it cites');
});
