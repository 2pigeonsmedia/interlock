'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../src/web/work_panel_model.js');

const {
  who, waitingLabel, stateLabel, needsYou, reportedToYou, projectSummaries, projectTree, doneLine,
  reportedLabel, historyLines, recentChanges, messagePrefill, exposureText, notifyText, shareLine,
  errorWords, sourceLine,
} = model;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

const ANA = Object.freeze({ subject_id: 'u-ana', name: 'Ana', kind: 'person', session: null });
const LEAD = Object.freeze({ subject_id: 'u-lead', name: 'Lead', kind: 'seat', session: null });
const BUILDER_1 = Object.freeze({ subject_id: 'u-b1', name: 'Builder', kind: 'seat', session: 1 });
const BUILDER_2 = Object.freeze({ subject_id: 'u-b2', name: 'Builder', kind: 'seat', session: 2 });

const DECISION_ROW = Object.freeze({
  id: 'W-3', kind: 'decision', project: 'finance', title: 'Pick the bank', state: 'awaiting',
  asked_of: ANA, asked_by: LEAD, proposal: 'Use the credit union', answer_summary: null,
  updated_at: NOW - 3 * HOUR,
});
const WORK_ROW = Object.freeze({
  id: 'W-1', kind: 'work', project: 'ops', title: 'Rotate the keys', state: 'active',
  responsible: BUILDER_2, next_to: ANA, next_action: 'Approve the rotation window',
  target: 'keys v2', updated_at: NOW - 2 * DAY, evidence_attached: false, awaiting: null,
});
const REPORTED_ROW = Object.freeze({
  id: 'W-4', kind: 'decision', project: 'finance', title: 'Budget cap', state: 'reported',
  asked_of: ANA, asked_by: BUILDER_1, proposal: '',
  answer_summary: { kind: 'reported', by: BUILDER_1, attributed_to: ANA, at: NOW - HOUR },
  updated_at: NOW - HOUR,
});

const PROJECTS = Object.freeze([
  Object.freeze({ id: 'ops', display_name: 'Operations', objective: 'Keep it running', today: 'Keys',
    revision: 2, updated_by: BUILDER_1, updated_at: NOW - DAY, created_at: NOW - 5 * DAY, retired_at: null }),
  Object.freeze({ id: 'finance', display_name: 'Finance', objective: 'Close the books', today: '',
    revision: 1, updated_by: ANA, updated_at: NOW - 2 * DAY, created_at: NOW - 5 * DAY, retired_at: null }),
]);

const BRIEF = Object.freeze({
  ok: true, cursor: 12, projects: PROJECTS,
  needs_me: [WORK_ROW, DECISION_ROW],
  reported_to_me: [REPORTED_ROW],
  open: [
    WORK_ROW,
    { id: 'W-2', kind: 'work', project: 'ops', title: 'Patch', state: 'blocked', responsible: BUILDER_1,
      next_to: null, next_action: '', target: '', updated_at: NOW, evidence_attached: false, awaiting: null },
    { id: 'W-5', kind: 'finding', project: 'finance', title: 'Gap', state: 'ready', responsible: null,
      next_to: null, next_action: '', target: '', updated_at: NOW, evidence_attached: false, awaiting: 'W-3' },
  ],
  decisions: [DECISION_ROW, REPORTED_ROW],
});

test('who renders a session only when one is present, and nobody for none', () => {
  assert.equal(who(ANA), 'Ana');
  assert.equal(who(BUILDER_2), 'Builder (session 2)');
  assert.equal(who(null), 'nobody');
  assert.equal(who(undefined), 'nobody');
});

test('same-named seats render with their session everywhere', () => {
  const rows = needsYou(BRIEF, NOW).rows;
  assert.equal(rows.find(row => row.id === 'W-1').askedBy, 'Builder (session 2)');
  assert.equal(who({ name: 'Builder', kind: 'seat', session: null }), 'Builder');
  assert.deepEqual(reportedToYou(BRIEF).map(row => row.reportedBy), ['Builder (session 1)']);
});

test('waiting labels round down to minutes, hours and days', () => {
  assert.equal(waitingLabel(NOW - 59_999, NOW), 'waiting <1m');
  assert.equal(waitingLabel(NOW, NOW), 'waiting <1m');
  assert.equal(waitingLabel(NOW - 12 * MINUTE, NOW), 'waiting 12m');
  assert.equal(waitingLabel(NOW - 59 * MINUTE - 59_000, NOW), 'waiting 59m');
  assert.equal(waitingLabel(NOW - 3 * HOUR - 5 * MINUTE, NOW), 'waiting 3h');
  assert.equal(waitingLabel(NOW - 2 * DAY - HOUR, NOW), 'waiting 2d');
});

test('state labels name work states and decision states in plain words', () => {
  const work = state => ({ kind: 'work', state });
  const decision = state => ({ kind: 'decision', state });
  assert.deepEqual(['open', 'active', 'blocked', 'ready', 'done'].map(state => stateLabel(work(state))),
    ['Open', 'Active', 'Blocked', 'Ready', 'Done']);
  assert.equal(stateLabel({ kind: 'finding', state: 'ready' }), 'Ready');
  assert.deepEqual(['awaiting', 'answered', 'reported', 'withdrawn'].map(state => stateLabel(decision(state))),
    ['Awaiting answer', 'Answered here', 'Answer reported', 'Withdrawn']);
});

test('needs you lists decisions to answer and work to open, oldest first', () => {
  const result = needsYou(BRIEF, NOW);
  assert.equal(result.count, 2);
  assert.deepEqual(result.rows, [
    { id: 'W-1', kind: 'work', projectName: 'Operations', title: 'Rotate the keys',
      ask: 'Approve the rotation window', askedBy: 'Builder (session 2)', waiting: 'waiting 2d', action: 'Open work' },
    { id: 'W-3', kind: 'decision', projectName: 'Finance', title: 'Pick the bank',
      ask: 'Use the credit union', askedBy: 'Lead', waiting: 'waiting 3h', action: 'Answer' },
  ]);
  const bare = needsYou(Object.assign({}, BRIEF, {
    needs_me: [Object.assign({}, DECISION_ROW, { proposal: '' }), Object.assign({}, WORK_ROW, { responsible: null })],
  }), NOW);
  assert.equal(bare.rows.find(row => row.id === 'W-3').ask, 'Pick the bank');
  assert.equal(bare.rows.find(row => row.id === 'W-1').askedBy, 'unassigned');
});

test('needs you is never narrowed by a project filter', () => {
  const filtered = Object.assign({}, BRIEF, { projects: [PROJECTS[1]] });
  const result = needsYou(filtered, NOW);
  assert.equal(result.count, 2);
  assert.equal(result.rows.length, filtered.needs_me.length);
  // A project outside the filter still has a readable name: its id.
  assert.equal(result.rows.find(row => row.id === 'W-1').projectName, 'ops');
});

test('reported to you names the reporter and the person it is attributed to', () => {
  assert.deepEqual(reportedToYou(BRIEF), [
    { id: 'W-4', title: 'Budget cap', reportedBy: 'Builder (session 1)', attributedTo: 'Ana', at: NOW - HOUR },
  ]);
});

test('project summaries count open, blocked, ready, awaiting and needs-you per project', () => {
  assert.deepEqual(projectSummaries(BRIEF), [
    { id: 'ops', display_name: 'Operations', objective: 'Keep it running', today: 'Keys',
      updatedBy: 'Builder (session 1)', updated_at: NOW - DAY, open: 2, blocked: 1, ready: 0, awaiting: 0, needsYou: 1 },
    { id: 'finance', display_name: 'Finance', objective: 'Close the books', today: '',
      updatedBy: 'Ana', updated_at: NOW - 2 * DAY, open: 1, blocked: 0, ready: 1, awaiting: 1, needsYou: 1 },
  ]);
});

test('the project tree nests children under their parent in id order', () => {
  const rows = [
    { id: 'W-10', kind: 'work', title: 'Child late', parent: 'W-2', awaiting: null },
    { id: 'W-2', kind: 'work', title: 'Parent', parent: null, awaiting: 'W-7' },
    { id: 'W-7', kind: 'decision', title: 'Ask', parent: 'W-2' },
    { id: 'W-3', kind: 'work', title: 'Child early', parent: 'W-2', awaiting: null },
    { id: 'W-9', kind: 'finding', title: 'Orphan', parent: 'W-1', awaiting: null },
    { id: 'W-11', kind: 'decision', title: 'Loose decision', parent: null },
  ];
  const tree = projectTree(rows);
  assert.deepEqual(tree.map(node => node.row.id), ['W-2', 'W-9']);
  assert.equal(tree[0].label, 'Parent · awaiting W-7');
  assert.equal(tree[1].label, 'Orphan');
  assert.deepEqual(tree[0].children.map(row => row.id), ['W-3', 'W-7', 'W-10']);
  assert.deepEqual(tree[1].children, []);
});

test('the done line names the closer, the disposition, the evidence or its absence, and open follow-ups', () => {
  const withEvidence = { kind: 'work', state: 'done', done_account: 'Keys rotated', done_evidence: 14,
    done_without_evidence: false };
  const children = [
    { id: 'W-3', kind: 'work', state: 'done' },
    { id: 'W-4', kind: 'work', state: 'open' },
    { id: 'W-5', kind: 'decision', state: 'awaiting' },
    { id: 'W-6', kind: 'decision', state: 'answered' },
  ];
  assert.equal(doneLine(withEvidence, [], children, BUILDER_2),
    'Builder (session 2) · Keys rotated · evidence entry 14 · 2 open follow-ups');
  assert.equal(doneLine(withEvidence, [], children.slice(0, 2), BUILDER_2),
    'Builder (session 2) · Keys rotated · evidence entry 14 · 1 open follow-up');
  const without = { kind: 'work', state: 'done', done_account: 'Dropped', done_evidence: null,
    done_without_evidence: true };
  assert.equal(doneLine(without, [], [], ANA), 'Ana · Dropped · no evidence attached · no open follow-ups');
  assert.equal(doneLine(without, [], [], null), 'nobody · Dropped · no evidence attached · no open follow-ups');
});

test('a reported answer is labelled reported, attributed and not confirmed', () => {
  assert.equal(reportedLabel({ kind: 'reported', text: 'Yes', by: BUILDER_1, attributed_to: ANA, at: NOW }),
    'Reported by Builder (session 1) · attributed to Ana · not confirmed here');
});

const STAMP = '2026-09-26T12:00:00.000Z';
const EVENTS = Object.freeze([
  { seq: 5, at: NOW, by: BUILDER_2, item: 'W-1', project: 'ops', kind: 'state-changed', from: 'active', to: 'done',
    note: 'rotated', changed: ['state', 'done_account'],
    before: { state: 'active', done_account: '' }, after: { state: 'done', done_account: 'Keys rotated' } },
  { seq: 6, at: NOW, by: BUILDER_1, item: 'W-4', project: 'finance', kind: 'answer-reported', text: 'Yes',
    source: 'call on Monday', attributed_to: ANA },
  { seq: 7, at: NOW, by: LEAD, item: 'W-1', project: 'ops', kind: 'shared', purpose: 'exposure', outcome: 'sent',
    to: 'Ana', message_id: 57, detail: '' },
  { seq: 8, at: NOW, by: LEAD, item: 'W-1', project: 'ops', kind: 'shared', purpose: 'notify', outcome: 'declined',
    to: 'Ana', message_id: null, detail: '' },
  { seq: 9, at: NOW, by: LEAD, item: 'W-1', project: 'ops', kind: 'shared', purpose: 'notify', outcome: 'failed',
    to: 'Ana', message_id: null, detail: 'room closed' },
  { seq: 10, at: NOW, by: LEAD, item: 'W-3', project: 'finance', kind: 'reopened', reason: 'new facts',
    asked_of: ANA, previous_asked_of: BUILDER_1,
    previous: { kind: 'reported', by: BUILDER_1, text: 'Yes' } },
]);

test('history lines match the export event rules', () => {
  assert.deepEqual(historyLines(EVENTS), [
    `${STAMP} · Builder (session 2) · state-changed · active → done · rotated · state: "active" → "done" · done_account: "" → "Keys rotated"`,
    `${STAMP} · Builder (session 1) · answer-reported · Yes · source: call on Monday · attributed to Ana · reported by Builder (session 1), not confirmed here`,
    `${STAMP} · Lead · shared · exposure · sent as #57 to Ana · a send receipt is not proof of reading`,
    `${STAMP} · Lead · shared · notify · declined · to Ana`,
    `${STAMP} · Lead · shared · notify · failed · to Ana · room closed`,
    `${STAMP} · Lead · reopened · reason: new facts · asked of Ana · previously asked of Builder (session 1) · previous (reported, reported by Builder (session 1)): Yes`,
  ]);
});

test('history lines agree byte for byte with the service export', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { openWorkStore } = require('../src/work/store.js');
  const { createWorkService } = require('../src/work/service.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-panel-model-'));
  try {
    let clock = NOW;
    const work = createWorkService({ store: openWorkStore({ dataDir }), clock: () => (clock += 1000) });
    const owner = { subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true };
    const lead = { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 1, owner: false };
    const builder = { subject_id: 's-2', name: 'Builder', kind: 'seat', session: 2, owner: false };
    const refOf = actor => ({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: actor.session ?? null });
    const op = () => crypto.randomUUID();
    const item = work.createItem(lead, { operation_id: op(), kind: 'work', project: 'ops', title: 'Rotate',
      body: 'Why', next_to: refOf(builder), next_action: 'Do it' }).item;
    work.updateWork(builder, { operation_id: op(), id: item.id, expected_revision: 1, state: 'active', note: 'taking it' });
    work.addNote(builder, { operation_id: op(), id: item.id, text: 'halfway' });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'notify', outcome: 'declined', to: 'Ana' });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'notify', outcome: 'failed', to: 'Ana', detail: 'offline' });
    work.updateWork(builder, { operation_id: op(), id: item.id, expected_revision: 2, state: 'done',
      done_account: 'Rotated.', no_evidence: true, note: 'finished' });
    const decision = work.createItem(builder, { operation_id: op(), kind: 'decision', project: 'ops', title: 'Pick',
      body: 'Which bank', asked_of: refOf(owner), proposal: 'Credit union' }).item;
    work.reportAnswer(lead, { operation_id: op(), id: decision.id, expected_revision: 1, text: 'Yes.',
      source: 'call', conditions: 'this year' });
    work.reopen(builder, { operation_id: op(), id: decision.id, expected_revision: 2, reason: 'New facts.' });

    const exported = work.exportRecords(owner, { format: 'md' }).body.split('\n');
    for (const id of [item.id, decision.id]) {
      const history = work.get(owner, { id }).history;
      const start = exported.indexOf('### ' + exported.find(line => line.startsWith('### ' + id + ' · ')).slice(4));
      const heading = exported.indexOf('#### History', start);
      const expected = exported.slice(heading + 2, heading + 2 + history.length).map(line => line.replace(/^- /, ''));
      assert.ok(history.length >= 3);
      assert.deepEqual(historyLines(history), expected);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recent changes shows its total and whether more exist', () => {
  const some = recentChanges({ events: EVENTS, total: 40, cursor: 10 }, 3);
  assert.equal(some.lines.length, 3);
  assert.equal(some.lines[0], historyLines(EVENTS)[0]);
  assert.equal(some.total, 40);
  assert.equal(some.shown, 3);
  assert.equal(some.more, true);
  const all = recentChanges({ events: EVENTS.slice(0, 2), total: 2, cursor: 6 }, 20);
  assert.deepEqual(all, { lines: historyLines(EVENTS.slice(0, 2)), total: 2, shown: 2, more: false });
});

const MESSAGE = Object.freeze({
  id: 42, ts: NOW, byline: 'Marlow', kind: 'seat', session: 2,
  text: 'We should rotate the keys before Friday.\nThe old ones leak.', product: 'claude-code',
  product_provenance: 'declared', delivery: null,
});

test('a message prefill keeps the speaker words and the message id', () => {
  assert.deepEqual(messagePrefill(MESSAGE, 'work'), {
    kind: 'work', title: 'We should rotate the keys before Friday.', body: MESSAGE.text,
    source_message: { message_id: 42, quote: MESSAGE.text },
  });
  assert.equal(messagePrefill(MESSAGE, 'decision').kind, 'decision');
  assert.deepEqual(messagePrefill(MESSAGE, 'evidence'), {
    kind: 'evidence', target: '', observed: MESSAGE.text, reference: 'room message #42',
  });
  const long = messagePrefill(Object.assign({}, MESSAGE, { text: 'x'.repeat(200) }), 'work');
  assert.equal(Array.from(long.title).length, 120);
  assert.ok(long.title.endsWith('…'));
  assert.equal(long.body, 'x'.repeat(200));
  const exact = messagePrefill(Object.assign({}, MESSAGE, { text: 'y'.repeat(120) }), 'work');
  assert.equal(exact.title, 'y'.repeat(120));
});

test('an exposure to an AI is prefixed with its handle; to a person it is not', () => {
  assert.equal(exposureText({ to: 'Marlow', text: 'W-1 · Rotate the keys' }, ['Marlow']), '@Marlow W-1 · Rotate the keys');
  assert.equal(exposureText({ to: 'Ana', text: 'W-1 · Rotate the keys' }, ['Marlow']), 'W-1 · Rotate the keys');
});

test('a notify text addresses the next person or the asked person', () => {
  const work = { id: 'W-1', kind: 'work', title: 'Rotate the keys', next_action: 'Approve the window',
    next_to: { name: 'Marlow', kind: 'seat', session: 2 } };
  assert.equal(notifyText(work, ['Marlow']), '@Marlow W-1 · Rotate the keys — Approve the window');
  const decision = { id: 'W-3', kind: 'decision', title: 'Pick the bank', proposal: '', asked_of: ANA };
  assert.equal(notifyText(decision, ['Marlow']), 'W-3 · Pick the bank — Pick the bank');
  assert.equal(notifyText(Object.assign({}, decision, { proposal: 'Credit union' }), []),
    'W-3 · Pick the bank — Credit union');
});

test('share lines say what happened to the message, never that it was read', () => {
  const event = (purpose, outcome, extra) => Object.assign({ kind: 'shared', purpose, outcome, to: 'Ana',
    message_id: null, detail: '' }, extra);
  assert.equal(shareLine(event('exposure', 'sent', { message_id: 57 })),
    'Exposure sent as #57 to Ana (a send receipt is not proof of reading)');
  assert.equal(shareLine(event('exposure', 'declined')), 'Exposure declined');
  assert.equal(shareLine(event('exposure', 'failed', { detail: 'room closed' })), 'Exposure send failed: room closed');
  assert.equal(shareLine(event('notify', 'sent', { message_id: 58 })), 'Notified via #58');
  assert.equal(shareLine(event('notify', 'declined')), 'Notify declined');
  assert.equal(shareLine(event('notify', 'failed', { detail: 'offline' })), 'Notify failed: offline');
});

test('error words are plain and name every refusal the panel can meet', () => {
  const codes = ['not-authenticated', 'not-answerer', 'not-asker', 'owner-only', 'not-a-relay', 'stale-revision',
    'operation-conflict', 'answer-recorded', 'invalid-state', 'invalid-source', 'unknown-item', 'store-damaged',
    'fresh-step-up-required', 'unavailable'];
  const words = codes.map(errorWords);
  for (const [index, text] of words.entries()) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, new RegExp(codes[index]), `${codes[index]} is spelled out, not echoed`);
  }
  assert.equal(new Set(words).size, codes.length);
  assert.match(errorWords('something-new'), /something-new/);
});

test('a source line names the room message, its speaker and who recorded it', () => {
  assert.equal(sourceLine({ source_message: null }), null);
  assert.equal(sourceLine({}), null);
  const item = { created_by: ANA, source_message: {
    message_id: 42, ts: NOW, byline: 'Marlow', kind: 'seat', session: 2, quote: 'rotate the keys' } };
  assert.equal(sourceLine(item), 'From room message #42 by Marlow (session 2) · “rotate the keys” · recorded by Ana');
  const person = { created_by: BUILDER_1, source_message: {
    message_id: 7, ts: NOW, byline: 'Ana', kind: 'person', session: null, quote: 'yes' } };
  assert.equal(sourceLine(person), 'From room message #7 by Ana · “yes” · recorded by Builder (session 1)');
});

test('the contract is frozen and carries only the panel functions', () => {
  assert.ok(Object.isFrozen(model));
  assert.deepEqual(Object.keys(model).sort(), ['doneLine', 'errorWords', 'exposureText', 'historyLines', 'messagePrefill',
    'needsYou', 'notifyText', 'projectSummaries', 'projectTree', 'recentChanges', 'reportedLabel', 'reportedToYou',
    'shareLine', 'sourceLine', 'stateLabel', 'waitingLabel', 'who']);
});
