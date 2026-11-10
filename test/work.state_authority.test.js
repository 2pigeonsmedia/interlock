'use strict';

// Who may change an item's STATE (ruling, 2026-11-10): changing the state of
// an item someone else holds or is next on takes the same people who may
// assign it: its filer, its holder, whoever is next, its project's live lead,
// the first owner and administrators. An item that is yours, or that nobody
// holds or is next on, stays free. Before this, any member could mark someone
// else's work done or blocked. The refusal is the assign refusal's 403, naming
// whom to ask, with `change: 'state'` so the words say what was refused.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');
const { createWorkService } = require('../src/work/service.js');
const { createWorkRoutes } = require('../src/work/routes.js');
const MODEL = require('../src/web/work_panel_model.js');
const { EXIT_RUNTIME, run } = require('../src/cli.js');

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
const admin = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const firstOwner = Object.freeze({ subject_id: 'p-2', name: 'Fo', kind: 'person', owner: false, first_owner: true });
const filer = Object.freeze({ subject_id: 's-1', name: 'Filer', kind: 'seat', owner: false });
const holder = Object.freeze({ subject_id: 's-2', name: 'Holder', kind: 'seat', owner: false });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const other = Object.freeze({ subject_id: 's-4', name: 'Other', kind: 'seat', owner: false });
const nextOne = Object.freeze({ subject_id: 's-5', name: 'Next', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-state-'));
  return createWorkService({ store: openWorkStore({ dataDir }), leadOf: project => (project === 'ops' ? ref(lead) : null) });
}

function code(fn, expected) {
  let caught = null;
  assert.throws(fn, error => { caught = error; assert.equal(error && error.code, expected, error && error.message); return true; });
  return caught;
}

function update(work, actor, item, fields) {
  const current = work.get(actor, { id: item.id }).item;
  return work.updateWork(actor, Object.assign({ operation_id: crypto.randomUUID(), id: item.id, expected_revision: current.revision, note: 'n' }, fields)).item;
}

function filed(work, extra = {}) {
  return work.createItem(filer, Object.assign({ operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b' }, extra)).item;
}

const MOVES = Object.freeze([
  ['active', {}],
  ['blocked', { block_reason: 'waiting on the bank' }],
  ['done', { done_account: 'reconciled', no_evidence: true }],
]);

test('a bystander cannot change the state of an item someone else holds, to anything; nothing changes', () => {
  const work = fresh();
  for (const [state, extra] of MOVES) {
    const item = filed(work, { responsible: ref(holder) });
    const refused = code(() => update(work, other, item, Object.assign({ state }, extra)), 'not-assigner');
    assert.deepEqual(refused.can_assign, ['Filer', 'Holder', 'Lead'], state);
    assert.equal(refused.change, 'state', state);
    const after = work.get(filer, { id: item.id }).item;
    assert.deepEqual([after.state, after.revision], ['open', 1], 'a refused ' + state + ' changes nothing');
  }
});

test('a bystander cannot change the state of an item someone else is next on (nobody holds it)', () => {
  const work = fresh();
  const item = filed(work, { next_to: ref(nextOne), next_action: 'check the totals' });
  code(() => update(work, other, item, { state: 'active' }), 'not-assigner');
  code(() => update(work, other, item, { state: 'ready' }), 'not-assigner');
  code(() => update(work, other, item, { state: 'done', done_account: 'x', no_evidence: true }), 'not-assigner');
  assert.equal(work.get(filer, { id: item.id }).item.state, 'open');
});

test('dropping someone else from next by Blocked or Done is the same refusal, once (folded, not doubled)', () => {
  const work = fresh();
  const item = filed(work, { next_to: ref(nextOne), next_action: 'look' });
  const refused = code(() => update(work, other, item, { state: 'blocked', block_reason: 'r' }), 'not-assigner');
  assert.equal(refused.change, 'state');
  assert.deepEqual(refused.can_assign, ['Filer', 'Next', 'Lead']);
});

test('the filer, holder, whoever is next, the live lead, the first owner and an administrator may change it', () => {
  const work = fresh();
  // A fresh item for each move: entering Blocked or Done drops whoever is
  // next, who is then no longer among the assigners of that item.
  const held = () => filed(work, { responsible: ref(holder), next_to: ref(nextOne), next_action: 'look' });
  for (const actor of [filer, holder, nextOne, lead, firstOwner, admin]) {
    assert.equal(update(work, actor, held(), { state: 'active' }).state, 'active', actor.name + ' to active');
    assert.equal(update(work, actor, held(), { state: 'blocked', block_reason: 'r' }).state, 'blocked', actor.name + ' to blocked');
    const done = update(work, actor, held(), { state: 'done', done_account: 'ok', no_evidence: true });
    assert.equal(done.state, 'done', actor.name + ' to done');
    if (actor !== nextOne) assert.equal(update(work, actor, done, { state: 'open' }).state, 'open', actor.name + ' reopens');
  }
  // Once Done dropped them, whoever was next is not an assigner of it any more.
  const dropped = update(work, nextOne, held(), { state: 'done', done_account: 'ok', no_evidence: true });
  code(() => update(work, nextOne, dropped, { state: 'open' }), 'not-assigner');
});

test('your own items, and items nobody holds or is next on, stay free', () => {
  const work = fresh();
  const loose = filed(work);
  assert.equal(update(work, other, loose, { state: 'active' }).state, 'active', 'an unheld item');
  assert.equal(update(work, other, loose, { state: 'done', done_account: 'ok', no_evidence: true }).state, 'done');
  const mine = work.createItem(other, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops', title: 't', body: 'b', responsible: ref(other) }).item;
  assert.equal(update(work, other, mine, { state: 'blocked', block_reason: 'r' }).state, 'blocked', 'my own');
  // A bystander's non-state edit is still not a state change.
  const held = filed(work, { responsible: ref(holder) });
  assert.equal(update(work, other, held, { title: 'Reconcile March (bank)' }).title, 'Reconcile March (bank)');
  // Nor is re-sending the state it already has.
  assert.equal(update(work, other, held, { state: 'open' }).state, 'open');
});

test('two steps do not get around it: claim-then-change needs an unheld item, which is already free', () => {
  const work = fresh();
  const held = filed(work, { responsible: ref(holder) });
  code(() => update(work, other, held, { responsible: ref(other), state: 'done', done_account: 'x', no_evidence: true }), 'not-assigner');
  code(() => update(work, other, held, { next_to: ref(other), next_action: 'me', state: 'active' }), 'not-assigner');
  // The holder stepping out first leaves an unheld item: then it is free, by the rule.
  update(work, holder, held, { responsible: null });
  assert.equal(update(work, other, held, { state: 'active' }).state, 'active');
});

test('the route answers 403 with can_assign and change; the CLI and the page say whom to ask to change its state', async () => {
  const work = fresh();
  const item = filed(work, { responsible: ref(holder) });
  const roster = [admin, filer, holder, lead, other, nextOne].map(actor => ref(actor));
  const routes = createWorkRoutes({ work, participants: () => roster });
  const refused = await routes.mutate('items/update', other,
    { operation_id: crypto.randomUUID(), id: item.id, expected_revision: 1, note: 'n', state: 'done', done_account: 'x', no_evidence: true });
  assert.deepEqual([refused.status, refused.body.error, refused.body.can_assign, refused.body.change],
    [403, 'not-assigner', ['Filer', 'Holder', 'Lead'], 'state']);
  // An assignment refusal stays as it was: no `change`.
  const assign = await routes.mutate('items/update', other,
    { operation_id: crypto.randomUUID(), id: item.id, expected_revision: 1, note: 'n', responsible: 'Next' });
  assert.equal(assign.body.change, undefined);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-state-')), 'body.json');
  fs.writeFileSync(file, JSON.stringify({ expected_revision: 1, note: 'n', state: 'done' }));
  let stderr = '';
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const exit = await run(['work', 'update', item.id, '--connection', 'Marlow', '--file', file], {
    stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
  }, {
    clock: () => 100,
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: { validName: () => true, openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }) },
    fetch: async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => refused.body, text: async () => '' }),
  });
  assert.equal(exit, EXIT_RUNTIME);
  assert.match(stderr, /refused the command: not-assigner\. Ask Filer, Holder or Lead \(or the first owner or an administrator\) to change its state; your own items, and items nobody holds or is next on, are yours to change\./);

  assert.equal(MODEL.assignerWords(['Filer', 'Holder', 'Lead'], 'state'),
    'Ask Filer, Holder or Lead (or the first owner or an administrator) to change its state.');
  assert.equal(MODEL.assignerWords(['Filer']), 'Ask Filer (or the first owner or an administrator) to assign it.');
  assert.ok(PANEL.includes("else if (code === 'not-assigner') where.textContent = model().assignerWords(error.canAssign, error.change);"));
});
