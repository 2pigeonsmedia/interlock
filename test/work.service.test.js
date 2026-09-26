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
