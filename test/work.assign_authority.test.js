'use strict';

// Who may put someone else in an item's holder or next slot (ruling,
// 2026-11-07): its filer, its current holder, whoever is next, its project's
// live lead, the first owner and administrators. Anyone may claim a slot
// nobody holds or step out of one. A refusal names who can assign, so a
// blocked hand-off knows whom to ask. Before this, any member could make
// another participant read "waiting on X" by assigning them a linked item.

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
const ROOM = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const admin = Object.freeze({ subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true });
const filer = Object.freeze({ subject_id: 's-1', name: 'Filer', kind: 'seat', owner: false });
const holder = Object.freeze({ subject_id: 's-2', name: 'Holder', kind: 'seat', owner: false });
const lead = Object.freeze({ subject_id: 's-3', name: 'Lead', kind: 'seat', owner: false });
const other = Object.freeze({ subject_id: 's-4', name: 'Other', kind: 'seat', owner: false });
const target = Object.freeze({ subject_id: 's-5', name: 'Target', kind: 'seat', owner: false });

function ref(actor) {
  return { subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: null };
}

function fresh() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-assign-'));
  const work = createWorkService({ store: openWorkStore({ dataDir }), leadOf: project => (project === 'ops' ? ref(lead) : null) });
  return work;
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

test('a bystander cannot put someone else in either slot; the refusal names who can', () => {
  const work = fresh();
  const item = filed(work, { responsible: ref(holder) });
  const refused = code(() => update(work, other, item, { responsible: ref(target) }), 'not-assigner');
  assert.deepEqual(refused.can_assign, ['Filer', 'Holder', 'Lead']);
  code(() => update(work, other, item, { next_to: ref(target), next_action: 'check it' }), 'not-assigner');
  code(() => update(work, other, item, { responsible: null }), 'not-assigner');
  assert.deepEqual(work.get(filer, { id: item.id }).item.responsible, ref(holder), 'a refused assignment changes nothing');
});

test('the filer, holder, whoever is next, the live lead and an administrator may assign', () => {
  const work = fresh();
  const item = filed(work, { responsible: ref(holder), next_to: ref(other), next_action: 'look' });
  assert.equal(update(work, filer, item, { responsible: ref(target) }).responsible.name, 'Target', 'the filer');
  assert.equal(update(work, other, item, { next_to: ref(holder), next_action: 'yours' }).next_to.name, 'Holder', 'whoever is next');
  assert.equal(update(work, holder, item, { responsible: ref(holder) }).responsible.name, 'Holder', 'whoever is next takes it back');
  assert.equal(update(work, holder, item, { responsible: ref(target) }).responsible.name, 'Target', 'the holder hands it on');
  assert.equal(update(work, lead, item, { responsible: ref(other) }).responsible.name, 'Other', 'the live lead');
  assert.equal(update(work, admin, item, { responsible: ref(holder) }).responsible.name, 'Holder', 'an administrator');
});

test('anyone may claim a slot nobody holds, or step out of one', () => {
  const work = fresh();
  const item = filed(work);
  assert.equal(update(work, other, item, { responsible: ref(other) }).responsible.name, 'Other', 'a claim of an unheld item');
  assert.equal(update(work, other, item, { responsible: null }).responsible, null, 'stepping out');
  const held = filed(work, { responsible: ref(holder) });
  code(() => update(work, other, held, { responsible: ref(other) }), 'not-assigner');
  const taken = update(work, other, filed(work), { responsible: ref(other), next_to: ref(target), next_action: 'check the totals' });
  assert.deepEqual([taken.responsible.name, taken.next_to.name], ['Other', 'Target'], 'taking an unheld item and naming who is next, in one request');
  code(() => update(work, other, filed(work), { next_to: ref(target), next_action: 'check' }), 'not-assigner');
  const unrelated = update(work, other, held, { title: 'Reconcile March (bank)' });
  assert.equal(unrelated.title, 'Reconcile March (bank)', 'an edit that names nobody is not an assignment');
});

test('the route answers 403 with can_assign; the CLI and the page say whom to ask', async () => {
  const work = fresh();
  const item = filed(work, { responsible: ref(holder) });
  const roster = [admin, filer, holder, lead, other, target].map(actor => Object.assign(ref(actor)));
  const routes = createWorkRoutes({ work, participants: () => roster });
  const refused = await routes.mutate('items/update', other,
    { operation_id: crypto.randomUUID(), id: item.id, expected_revision: 1, note: 'n', responsible: 'Target' });
  assert.deepEqual([refused.status, refused.body.error, refused.body.can_assign], [403, 'not-assigner', ['Filer', 'Holder', 'Lead']]);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-assign-')), 'body.json');
  fs.writeFileSync(file, JSON.stringify({ expected_revision: 1, note: 'n', responsible: 'Target' }));
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
  assert.match(stderr, /refused the command: not-assigner\. Ask Filer, Holder or Lead \(or the first owner or an administrator\) to assign it; you may take an item nobody holds, or step out of a slot yourself\./);

  assert.equal(MODEL.assignerWords(['Filer', 'Holder', 'Lead']),
    'Ask Filer, Holder or Lead (or the first owner or an administrator) to assign it.');
  assert.ok(PANEL.includes("else if (code === 'not-assigner') where.textContent = model().assignerWords(error.canAssign);"));
  assert.ok(ROOM.includes('if (result && Array.isArray(result.can_assign)) error.canAssign = result.can_assign.filter(name => typeof name === \'string\');'));
});
