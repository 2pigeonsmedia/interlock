'use strict';

// Page half of withdrawing a work or finding item: the model words it, and
// the panel offers Withdraw only to a reader the room says may withdraw it.
// The panel half is a source contract; the withdraw itself is tested on the
// server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
const MODEL = require('../src/web/work_panel_model.js');

test('withdrawn work reads as Withdrawn, and its row line says withdrawn, never done or next', () => {
  assert.equal(MODEL.stateLabel({ kind: 'work', state: 'withdrawn' }), 'Withdrawn');
  const line = MODEL.projectRowLine({ id: 'W-5', kind: 'work', state: 'withdrawn', next_to: null, responsible: { name: 'Lead', kind: 'seat' },
    next_action: 'Pull it', evidence_attached: false, awaiting: null, target: '' });
  assert.equal(line, 'withdrawn');
});

test('a live row linked to withdrawn work says its blocker was withdrawn', () => {
  const line = MODEL.projectRowLine({ id: 'W-6', kind: 'work', state: 'active', next_to: null, responsible: null,
    next_action: '', evidence_attached: false, awaiting: null, target: '', blocker_withdrawn: ['W-5'] });
  assert.match(line, /blocker withdrawn: W-5/);
  const cards = MODEL.needsCards({ projects: [], needs_me: [{ id: 'W-6', kind: 'work', project: 'ops', title: 'Reconcile March', state: 'active',
    created_by: { name: 'Cue', kind: 'seat' }, next_action: '', updated_at: 1, blocker_withdrawn: ['W-5'] }] }, 1);
  assert.deepEqual(cards.cards.find(card => card.id === 'W-6').blockerWithdrawn, ['W-5']);
  assert.ok(PANEL.includes("if (card.blockerWithdrawn && card.blockerWithdrawn.length) facts.push('blocker withdrawn: ' + card.blockerWithdrawn.join(', '));"),
    'the Needs you card shows it');
});

test('a withdrawn follow-up is not an open one', () => {
  const line = MODEL.doneLine({ done_account: 'Matched.', done_without_evidence: true }, [], [
    { kind: 'work', state: 'withdrawn' }, { kind: 'work', state: 'open' },
  ], { name: 'Cue', kind: 'seat' });
  assert.match(line, /1 open follow-up$/);
});

test('a refused withdraw reads as words', () => {
  assert.equal(MODEL.errorWords('not-withdrawer'),
    'Only whoever filed it, its project\'s lead, the first owner or an administrator can withdraw it. A holder can hand it back instead.');
});

test('Withdraw is offered only to who may withdraw the record, and it sends items/withdraw with a reason at the record revision', () => {
  assert.ok(PANEL.includes("if (result.may_withdraw === true) actionButton(buttons, slot, 'Withdraw', item, () => withdrawWorkForm(item));"),
    'the action is offered only to a reader the room says may withdraw it');
  const form = PANEL.slice(PANEL.indexOf('function withdrawWorkForm('), PANEL.indexOf('function renderWorkActions('));
  assert.ok(form.includes("control('input', 'reason', 'Reason', { required: true })"), 'a reason is required');
  assert.ok(form.includes("write('items/withdraw', { id: item.id, expected_revision: item.revision, reason: reason.node.value }"),
    'the form withdraws this record at the revision it showed');
});
