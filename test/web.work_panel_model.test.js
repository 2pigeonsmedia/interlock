'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const model = require('../src/web/work_panel_model.js');

const {
  who, waitingLabel, stateLabel, killWord, killLines, createAnswerTracker, changedSince, needsYou, reportedToYou, projectSummaries, projectTree, doneLine,
  reportedLabel, historyLines, messagePrefill, exposureText, notifyText, shareLine,
  errorWords, sourceLine, evidenceSourceLine, answerLines, projectRowLine, actionsByPerson, projectSections, drawerLines,
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
  updated_at: NOW - 3 * HOUR, created_by: LEAD,
});
const WORK_ROW = Object.freeze({
  id: 'W-1', kind: 'work', project: 'ops', title: 'Rotate the keys', state: 'active',
  responsible: BUILDER_2, next_to: ANA, next_action: 'Approve the rotation window',
  target: 'keys v2', updated_at: NOW - 2 * DAY, evidence_attached: false, awaiting: null, created_by: LEAD,
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
  assert.equal(rows.find(row => row.id === 'W-1').by, 'asked by Lead · responsible: Builder (session 2)');
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
      ask: 'Approve the rotation window', by: 'asked by Lead · responsible: Builder (session 2)', waiting: 'waiting 2d', action: 'Open work' },
    { id: 'W-3', kind: 'decision', projectName: 'Finance', title: 'Pick the bank',
      ask: 'Use the credit union', by: 'asked by Lead', waiting: 'waiting 3h', action: 'Answer' },
  ]);
  const bare = needsYou(Object.assign({}, BRIEF, {
    needs_me: [Object.assign({}, DECISION_ROW, { proposal: '' }), Object.assign({}, WORK_ROW, { responsible: null })],
  }), NOW);
  assert.equal(bare.rows.find(row => row.id === 'W-3').ask, 'Pick the bank');
  assert.equal(bare.rows.find(row => row.id === 'W-1').by, 'asked by Lead');
  // In the addressee's own queue the row names who asked; a decision still names its asker, not its creator.
  const relayed = needsYou(Object.assign({}, BRIEF, {
    needs_me: [Object.assign({}, WORK_ROW, { created_by: BUILDER_1 }), Object.assign({}, DECISION_ROW, { created_by: BUILDER_1 })],
  }), NOW);
  assert.equal(relayed.rows.find(row => row.id === 'W-1').by, 'asked by Builder (session 1) · responsible: Builder (session 2)');
  assert.equal(relayed.rows.find(row => row.id === 'W-3').by, 'asked by Lead');
  for (const row of relayed.rows) assert.doesNotMatch(row.by, /unassigned/);
});

test('needs you lists each open ask addressed to the viewer as its own row, by age with the work', () => {
  const asks = [
    { ask_id: 41, asked_at: NOW - 5 * HOUR, by: 'Lead', of: 'Ana', of_kind: 'person', means: 'I merge\nthe candidate',
      deliver: 'now', state: 'open', kept_open: false, carried_from: null, answers: [] },
    { ask_id: 7, asked_at: NOW - 3 * DAY, by: 'Builder', of: 'Ana', of_kind: 'person', means: 'I rotate the keys tonight',
      deliver: 'now', state: 'open', kept_open: false, carried_from: 'transcript-x', answers: [] },
    { ask_id: 42, asked_at: NOW - 5 * HOUR, by: 'Lead', of: 'Ana', of_kind: 'person', means: null,
      deliver: 'now', state: 'open', kept_open: false, carried_from: null, answers: [] },
  ];
  const result = needsYou(BRIEF, NOW, asks);
  assert.equal(result.count, needsYou(BRIEF, NOW).count + 3, 'one ask, one row');
  assert.deepEqual(result.rows.map(row => row.id), ['ask-7', 'W-1', 'ask-41', 'ask-42', 'W-3'],
    'asks and work interleave oldest first');
  assert.deepEqual(result.rows.find(row => row.id === 'ask-41'), {
    id: 'ask-41', kind: 'ask', askId: 41, projectName: 'Ask', title: 'A yes means: I merge ⏎ the candidate',
    ask: 'Message #41', by: 'asked by Lead', waiting: 'waiting 5h', action: 'Show ask',
  });
  assert.equal(result.rows.find(row => row.id === 'ask-7').ask, 'Asked before the transcript was cleared');
  assert.equal(result.rows.find(row => row.id === 'ask-42').title, 'Ask in message #42');
  assert.deepEqual(needsYou(BRIEF, NOW, []).rows, needsYou(BRIEF, NOW).rows, 'no asks, the work rows unchanged');
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
  assert.deepEqual(tree.map(node => node.row.id), ['W-2', 'W-9', 'W-11']);
  // The title stands alone; the open question it waits on is in the row's facts line only.
  assert.equal(tree[0].label, 'Parent');
  assert.equal(projectRowLine(tree[0].row), 'awaiting W-7');
  assert.equal(tree[1].label, 'Orphan');
  assert.equal(tree[2].label, 'Loose decision');
  assert.deepEqual(tree[0].children.map(row => row.id), ['W-3', 'W-7', 'W-10']);
  assert.deepEqual(tree[1].children, []);
  assert.deepEqual(tree[2].children, []);
});

function treeIds(tree) {
  return tree.flatMap(node => [node.row.id, ...node.children.map(row => row.id)]).sort();
}

test('the project tree keeps a decision whose parent is not in the rows at top level', () => {
  const rows = [
    { id: 'W-1', kind: 'work', title: 'Work', parent: null, awaiting: null },
    { id: 'D-2', kind: 'decision', title: 'Orphaned ask', parent: 'W-40' },
  ];
  const tree = projectTree(rows);
  assert.deepEqual(tree.map(node => node.row.id), ['W-1', 'D-2']);
  assert.equal(tree[1].label, 'Orphaned ask');
  assert.deepEqual(treeIds(tree), rows.map(row => row.id).sort());
});

test('a row whose parent is itself a child attaches under the nearest top-level ancestor', () => {
  const rows = [
    { id: 'W-1', kind: 'work', title: 'Root', parent: null, awaiting: null },
    { id: 'W-2', kind: 'work', title: 'Middle', parent: 'W-1', awaiting: null },
    { id: 'W-3', kind: 'finding', title: 'Leaf', parent: 'W-2', awaiting: null },
    { id: 'D-4', kind: 'decision', title: 'Leaf ask', parent: 'W-3' },
    { id: 'W-5', kind: 'work', title: 'Loop a', parent: 'W-6', awaiting: null },
    { id: 'W-6', kind: 'work', title: 'Loop b', parent: 'W-5', awaiting: null },
  ];
  const tree = projectTree(rows);
  assert.equal(tree[0].row.id, 'W-1');
  assert.deepEqual(tree[0].children.map(row => row.id), ['W-2', 'W-3', 'D-4']);
  // Every row appears exactly once, even a parent cycle the service cannot produce.
  assert.deepEqual(treeIds(tree), rows.map(row => row.id).sort());
});

test('the project tree nests real service rows under their parent', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { openWorkStore } = require('../src/work/store.js');
  const { createWorkService } = require('../src/work/service.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-panel-tree-'));
  try {
    let clock = NOW;
    const work = createWorkService({ store: openWorkStore({ dataDir }), clock: () => (clock += 1000) });
    const owner = { subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true };
    const lead = { subject_id: 's-1', name: 'Lead', kind: 'seat', session: 1, owner: false };
    const op = () => crypto.randomUUID();
    const parent = work.createItem(lead, { operation_id: op(), kind: 'work', project: 'ops', title: 'Rotate', body: 'Why' }).item;
    const decision = work.createItem(lead, { operation_id: op(), kind: 'decision', project: 'ops', title: 'Pick',
      body: 'Which', asked_of: { subject_id: 'p-1', name: 'Ana', kind: 'person', session: null }, parent: parent.id }).item;
    const finding = work.createItem(lead, { operation_id: op(), kind: 'finding', project: 'ops', title: 'Drift',
      body: 'Seen', parent: parent.id }).item;
    const loose = work.createItem(lead, { operation_id: op(), kind: 'work', project: 'ops', title: 'Other', body: 'Why' }).item;

    const tree = projectTree(work.list(owner, { project: 'ops' }).items);
    assert.deepEqual(tree.map(node => node.row.id), [parent.id, loose.id]);
    assert.match(decision.id, /^D-/);
    assert.equal(tree[0].label, 'Rotate');
    assert.equal(projectRowLine(tree[0].row), 'awaiting ' + decision.id);
    assert.deepEqual(tree[0].children.map(row => row.id).sort(), [decision.id, finding.id].sort());
    assert.deepEqual(tree[1].children, []);
    assert.equal(tree[1].label, 'Other');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a project row line carries the work record\'s own facts', () => {
  assert.equal(projectRowLine(WORK_ROW),
    'next: Ana — Approve the rotation window · responsible: Builder (session 2) · target: keys v2');
  assert.equal(projectRowLine(BRIEF.open[1]), 'responsible: Builder (session 1)');
  assert.equal(projectRowLine(BRIEF.open[2]), 'awaiting W-3');
  const bare = { id: 'W-8', kind: 'work', state: 'open', responsible: null, next_to: null, next_action: '',
    target: '', evidence_attached: false, awaiting: null };
  assert.equal(projectRowLine(bare), '');
  // An action addressed to no one still shows the action, under the word Actions uses.
  assert.equal(projectRowLine(Object.assign({}, bare, { next_action: 'Pick an owner' })), 'next: unassigned — Pick an owner');
  // A whitespace-only action is no action.
  assert.equal(projectRowLine(Object.assign({}, bare, { next_action: ' \n ' })), '');
  assert.equal(projectRowLine(Object.assign({}, bare, { next_action: '  Pick an owner ' })), 'next: unassigned — Pick an owner');
  assert.equal(projectRowLine(Object.assign({}, bare, { next_to: LEAD })), 'next: Lead');
  assert.equal(projectRowLine(Object.assign({}, bare, { kind: 'finding', next_to: LEAD, next_action: 'complete 717',
    target: 'line\ntwo', evidence_attached: true, awaiting: 'D-4' })),
  'next: Lead — complete 717 · target: line ⏎ two · awaiting D-4 · evidence attached');
});

test('a blocked project row leads with its reason, then the next step only when it names someone', () => {
  const blocked = { id: 'W-4', kind: 'work', state: 'blocked', responsible: BUILDER_1, next_to: null,
    next_action: 'Chase the bank', block_reason: 'waiting on the bank', target: '', evidence_attached: false, awaiting: null };
  assert.equal(projectRowLine(blocked), 'blocked: waiting on the bank · responsible: Builder (session 1)');
  assert.equal(projectRowLine(Object.assign({}, blocked, { next_to: ANA })),
    'blocked: waiting on the bank · next: Ana — Chase the bank · responsible: Builder (session 1)');
  assert.equal(projectRowLine(Object.assign({}, blocked, { block_reason: 'two\nlines' })),
    'blocked: two ⏎ lines · responsible: Builder (session 1)');
  // A reason left over from an earlier block is not shown once the item moves on.
  assert.equal(projectRowLine(Object.assign({}, blocked, { state: 'active', next_to: ANA })),
    'next: Ana — Chase the bank · responsible: Builder (session 1)');
});

test('a project row line for a decision names who asked whom and how it was answered, never verified', () => {
  assert.equal(projectRowLine(DECISION_ROW), 'asked of Ana by Lead');
  assert.equal(projectRowLine(REPORTED_ROW), 'asked of Ana by Builder (session 1) · reported by Builder (session 1) · attributed to Ana');
  const answered = Object.assign({}, DECISION_ROW, { state: 'answered',
    answer_summary: { kind: 'direct', by: ANA, attributed_to: null, at: NOW } });
  assert.equal(projectRowLine(answered), 'asked of Ana by Lead · answered by Ana');
  for (const row of [DECISION_ROW, REPORTED_ROW, answered, WORK_ROW]) assert.doesNotMatch(projectRowLine(row), /verified/i);
});

test('a real service row addressed to Lead reads next: Lead — the action', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { openWorkStore } = require('../src/work/store.js');
  const { createWorkService, stripIds } = require('../src/work/service.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-panel-rowline-'));
  try {
    let clock = NOW;
    const work = createWorkService({ store: openWorkStore({ dataDir }), clock: () => (clock += 1000) });
    const owner = { subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true };
    const lead = { subject_id: 's-1', name: 'Lead', kind: 'seat', session: null };
    const item = work.createItem(owner, { operation_id: crypto.randomUUID(), kind: 'work', project: 'ops',
      title: 'Item 717 is ready for the last step.', body: 'Why', next_to: lead, next_action: 'complete 717' }).item;
    const rows = stripIds(work.list(owner, { project: 'ops' })).items;
    const [node] = projectTree(rows);
    assert.equal(node.row.id, item.id);
    assert.equal(projectRowLine(node.row), 'next: Lead — complete 717');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const BO = Object.freeze({ subject_id: 'u-bo', name: 'Bo', kind: 'person', session: null });

function workRow(id, fields) {
  return Object.assign({ id, kind: 'work', project: 'ops', title: 'Title ' + id, state: 'open', responsible: null,
    next_to: null, next_action: '', target: '', updated_at: NOW - HOUR, evidence_attached: false, awaiting: null,
    created_by: LEAD }, fields);
}

// A blocked item that names its recipient is still that person's action.
const BLOCKED_FOR_ANA = workRow('W-14', { state: 'blocked', next_to: ANA, next_action: 'Send the keys', updated_at: NOW - 4 * HOUR });

const ZOE = Object.freeze({ subject_id: 'u-zoe', name: 'Zoe', kind: 'person', session: null });

const ACTIONS_BRIEF = Object.freeze(Object.assign({}, BRIEF, {
  needs_me: [WORK_ROW, DECISION_ROW, BLOCKED_FOR_ANA],
  open: [
    WORK_ROW,
    BLOCKED_FOR_ANA,
    workRow('W-6', { next_to: BO, next_action: 'Sign the form', updated_at: NOW - 5 * HOUR }),
    workRow('W-7', { state: 'blocked', next_to: BUILDER_2, next_action: 'Wait for keys' }),
    workRow('W-8', { state: 'blocked', next_to: null, next_action: 'Waiting on the vendor' }),
    workRow('W-9', { kind: 'finding', project: 'finance', state: 'ready', next_action: 'Pick an owner' }),
    workRow('W-11', { state: 'done', next_to: ANA, next_action: 'Nothing' }),
    workRow('W-12', { state: 'active', next_to: BUILDER_1, next_action: 'Review\nthe patch' }),
    workRow('W-13', { next_to: null, next_action: '' }),
    workRow('W-15', { next_to: null, next_action: '   ' }),
    workRow('W-16', { next_to: ZOE, next_action: 'File the return' }),
  ],
  decisions: [
    DECISION_ROW,
    REPORTED_ROW,
    Object.assign({}, DECISION_ROW, { id: 'W-10', asked_of: BUILDER_2, asked_by: ANA, proposal: '', title: 'Which region' }),
  ],
}));

test('actions group every open action by the person or seat it is addressed to, unassigned last', () => {
  const actions = actionsByPerson(ACTIONS_BRIEF);
  assert.deepEqual(actions.groups.map(group => [group.who, group.rows.map(row => row.id)]), [
    ['Ana', ['W-1', 'W-14', 'W-3']],
    ['Bo', ['W-6']],
    ['Builder (session 1)', ['W-12']],
    ['Builder (session 2)', ['W-10', 'W-7']],
    // Unassigned is last even after a name that sorts after it.
    ['Zoe', ['W-16']],
    ['unassigned', ['W-9']],
  ]);
  assert.equal(actions.count, 9);
  const rows = new Map(actions.groups.flatMap(group => group.rows).map(row => [row.id, row]));
  assert.deepEqual(rows.get('W-1'), { id: 'W-1', kind: 'work', projectName: 'Operations', title: 'Rotate the keys',
    state: 'active', ask: 'Approve the rotation window',
    line: 'next: Ana — Approve the rotation window · Operations · Active' });
  assert.equal(rows.get('W-3').line, 'asked of Ana by Lead · Finance · Awaiting answer');
  assert.equal(rows.get('W-3').ask, 'Use the credit union');
  assert.equal(rows.get('W-10').line, 'asked of Builder (session 2) by Ana · Finance · Awaiting answer');
  assert.equal(rows.get('W-10').ask, 'Which region');
  assert.equal(rows.get('W-7').line, 'next: Builder (session 2) — Wait for keys · Operations · Blocked');
  assert.equal(rows.get('W-9').line, 'next: unassigned — Pick an owner · Finance · Ready');
  assert.equal(rows.get('W-12').line, 'next: Builder (session 1) — Review ⏎ the patch · Operations · Active');
  // A blocked wait with no recipient is nobody's action; done, reported and action-less rows are not actions.
  // A whitespace-only next action is no action.
  for (const id of ['W-8', 'W-11', 'W-4', 'W-2', 'W-5', 'W-13', 'W-15']) assert.equal(rows.has(id), false, id);
});

test('the actions count is distinct records, and an empty brief has no groups', () => {
  const doubled = Object.assign({}, ACTIONS_BRIEF, { open: [WORK_ROW, ...ACTIONS_BRIEF.open] });
  const actions = actionsByPerson(doubled);
  assert.equal(actions.count, 9);
  assert.deepEqual(actions.groups[0].rows.map(row => row.id), ['W-1', 'W-14', 'W-3']);
  assert.deepEqual(actionsByPerson(Object.assign({}, BRIEF, { open: [], decisions: [] })), { count: 0, groups: [] });
});

function viewerGroup(brief, name) {
  const group = actionsByPerson(brief).groups.find(entry => entry.who === name);
  return group ? group.rows.map(row => [row.id, row.ask]) : [];
}

test('a viewer\'s Needs you equals their group in Actions for the same brief', () => {
  assert.deepEqual(needsYou(BRIEF, NOW).rows.map(row => [row.id, row.ask]), viewerGroup(BRIEF, 'Ana'));
  assert.equal(needsYou(ACTIONS_BRIEF, NOW).count, 3);
  assert.deepEqual(needsYou(ACTIONS_BRIEF, NOW).rows.map(row => [row.id, row.ask]), viewerGroup(ACTIONS_BRIEF, 'Ana'));
});

test('on real service briefs, every viewer\'s Needs you equals their Actions group, and Actions reads the same for all', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { openWorkStore } = require('../src/work/store.js');
  const { createWorkService, stripIds } = require('../src/work/service.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-panel-actions-'));
  try {
    let clock = NOW;
    const work = createWorkService({ store: openWorkStore({ dataDir }), clock: () => (clock += 1000) });
    const ana = { subject_id: 'p-1', name: 'Ana', kind: 'person', owner: true };
    const lead = { subject_id: 's-1', name: 'Lead', kind: 'seat', session: null, owner: false };
    const builder = { subject_id: 's-2', name: 'Builder', kind: 'seat', session: 2, owner: false };
    const refOf = actor => ({ subject_id: actor.subject_id, name: actor.name, kind: actor.kind, session: actor.session ?? null });
    const op = () => crypto.randomUUID();
    work.createItem(ana, { operation_id: op(), kind: 'work', project: 'ops', title: 'Item 717', body: 'Why',
      next_to: refOf(lead), next_action: 'complete 717' });
    work.createItem(lead, { operation_id: op(), kind: 'decision', project: 'ops', title: 'Pick', body: 'Which',
      asked_of: refOf(ana) });
    work.createItem(ana, { operation_id: op(), kind: 'work', project: 'ops', title: 'Patch', body: 'Why',
      next_to: refOf(builder), next_action: 'Patch it' });
    work.createItem(ana, { operation_id: op(), kind: 'finding', project: 'ops', title: 'Drift', body: 'Seen',
      next_action: 'Find an owner' });
    const briefs = new Map([ana, lead, builder].map(actor => [actor, stripIds(work.brief(actor))]));
    const views = [];
    for (const [actor, brief] of briefs) {
      const name = actor.session ? actor.name + ' (session ' + actor.session + ')' : actor.name;
      assert.equal(needsYou(brief, clock).count, 1, name);
      assert.deepEqual(needsYou(brief, clock).rows.map(row => [row.id, row.ask]), viewerGroup(brief, name), name);
      views.push(actionsByPerson(brief));
    }
    assert.deepEqual(views[1], views[0]);
    assert.deepEqual(views[2], views[0]);
    assert.equal(views[0].count, 4);
    assert.deepEqual(views[0].groups.map(group => group.who), ['Ana', 'Builder (session 2)', 'Lead', 'unassigned']);
    assert.equal(views[0].groups[2].rows[0].line, 'next: Lead — complete 717 · Operations · Open');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a done row\'s facts line says done and whether evidence is attached, never a next step', () => {
  const done = { id: 'W-1', kind: 'work', state: 'done', responsible: BUILDER_1, next_to: null,
    next_action: 'complete 717', block_reason: 'old wait', target: 'v2', evidence_attached: true, awaiting: null };
  assert.equal(projectRowLine(done), 'done · evidence attached');
  assert.equal(projectRowLine(Object.assign({}, done, { evidence_attached: false })), 'done · no evidence attached');
  assert.equal(projectRowLine(Object.assign({}, done, { next_to: LEAD, awaiting: 'D-4' })), 'done · evidence attached · awaiting D-4');
  assert.doesNotMatch(projectRowLine(Object.assign({}, done, { next_to: LEAD })), /next:/);
});

test('project sections list each project\'s open work and decisions in place, nested one level, with its done count', () => {
  const brief = {
    projects: [
      Object.assign({}, PROJECTS[0], { done_count: 2 }),
      Object.assign({}, PROJECTS[1], { done_count: 0 }),
    ],
    open: [
      workRow('W-12', { parent: null, next_to: LEAD, next_action: 'complete 717' }),
      workRow('W-14', { parent: 'W-12', kind: 'finding', state: 'blocked', block_reason: 'waiting on the bank' }),
      // Its parent W-2 is done, so it is not in the brief: this row lists at top level.
      workRow('W-15', { parent: 'W-2', next_action: 'Follow up' }),
      workRow('W-20', { project: 'finance', parent: null }),
    ],
    decisions: [
      Object.assign({}, DECISION_ROW, { id: 'D-13', project: 'ops', parent: 'W-12' }),
      Object.assign({}, REPORTED_ROW, { id: 'D-3', project: 'finance', parent: null }),
    ],
  };
  const sections = projectSections(brief);
  assert.deepEqual(sections.map(section => [section.id, section.display_name, section.doneCount]),
    [['ops', 'Operations', 2], ['finance', 'Finance', 0]]);
  const [ops, finance] = sections;
  assert.equal(ops.objective, 'Keep it running');
  assert.equal(ops.today, 'Keys');
  assert.equal(ops.revision, 2);
  assert.equal(ops.updatedBy, 'Builder (session 1)');
  assert.equal(ops.updated_at, NOW - DAY);
  assert.deepEqual(ops.rows.map(node => [node.row.id, node.children.map(child => child.row.id)]),
    [['W-12', ['D-13', 'W-14']], ['W-15', []]]);
  assert.equal(ops.rows[0].facts, 'next: Lead — complete 717');
  assert.equal(ops.rows[0].children[1].facts, 'blocked: waiting on the bank');
  assert.equal(ops.rows[0].children[0].facts, 'asked of Ana by Lead');
  assert.equal(ops.rows[1].facts, 'next: unassigned — Follow up');
  assert.deepEqual(finance.rows.map(node => node.row.id), ['D-3', 'W-20']);
  assert.equal(finance.rows[0].facts, 'asked of Ana by Builder (session 1) · reported by Builder (session 1) · attributed to Ana');
  // A brief from before done_count counts nothing rather than failing.
  assert.equal(projectSections(Object.assign({}, brief, { projects: [PROJECTS[0]] }))[0].doneCount, 0);
  assert.equal(ops.withdrawnCount, 0);
  const withdrawn = projectSections(Object.assign({}, brief, {
    projects: [Object.assign({}, PROJECTS[0], { done_count: 2, withdrawn_count: 3 })],
  }));
  assert.deepEqual([withdrawn[0].doneCount, withdrawn[0].withdrawnCount], [2, 3]);
});

test('the item dialog shows every field of a work item or finding, and a block reason only while blocked', () => {
  const finding = { id: 'W-14', kind: 'finding', state: 'blocked', responsible: BUILDER_1, next_to: null,
    next_action: 'Chase the bank', target: 'statement v2', block_reason: 'waiting on the bank',
    consequence: 'Dates import wrong', severity: 'blocking', parent: 'W-12', links: ['D-13', 'W-3'],
    body: 'Rows from March drift.\nSeen twice.' };
  assert.deepEqual(drawerLines(finding, []), [
    'Responsible: Builder (session 1)',
    'Next: unassigned — Chase the bank',
    'Target: statement v2',
    'Blocked: waiting on the bank',
    'Consequence: Dates import wrong',
    'Severity: blocking',
    'Follow-up of W-12',
    'Linked: D-13, W-3',
    'Details: Rows from March drift.\nSeen twice.',
  ]);
  const moved = Object.assign({}, finding, { kind: 'work', state: 'active', next_to: LEAD, consequence: '', severity: null,
    parent: null, links: [], target: '', responsible: null, body: 'Why' });
  assert.deepEqual(drawerLines(moved, []), ['Responsible: unassigned', 'Next: Lead — Chase the bank', 'Details: Why']);
  assert.deepEqual(drawerLines(Object.assign({}, moved, { next_to: null, next_action: '  ' }), []),
    ['Responsible: unassigned', 'Details: Why']);
});

test('the item dialog shows every field of a decision, with its answer\'s conditions and source', () => {
  const asked = { id: 'D-13', kind: 'decision', state: 'awaiting', asked_of: ANA, asked_by: LEAD, proposal: 'Use the credit union',
    rationale: 'Lower fees', scope: 'Checking only', conditions: '', answer: null, parent: 'W-12', links: [], body: 'Which bank?' };
  assert.deepEqual(drawerLines(asked, []), [
    'Asked of Ana by Lead', 'Proposal: Use the credit union', 'Rationale: Lower fees', 'Scope: Checking only',
    'Follow-up of W-12', 'Details: Which bank?',
  ]);
  const reported = Object.assign({}, asked, { state: 'reported', rationale: '', scope: '', parent: null,
    answer: { kind: 'reported', text: 'Yes', conditions: 'after Friday', source: 'phone call', by: BUILDER_1,
      attributed_to: ANA, at: NOW, reason: '' } });
  assert.deepEqual(drawerLines(reported, []), [
    'Asked of Ana by Lead', 'Reported by Builder (session 1) · attributed to Ana · not confirmed here',
    'Proposal: Use the credit union', 'Answer: Yes', 'Answer conditions: after Friday', 'Answer source: phone call',
    'Details: Which bank?',
  ]);
  const limited = Object.assign({}, asked, { conditions: 'Only under 500' });
  assert.deepEqual(drawerLines(limited, []), [
    'Asked of Ana by Lead', 'Proposal: Use the credit union', 'Rationale: Lower fees', 'Scope: Checking only',
    'Asked with conditions: Only under 500', 'Follow-up of W-12', 'Details: Which bank?',
  ], 'the asker\'s own conditions show before an answer exists');
  const direct = Object.assign({}, reported, { state: 'answered',
    answer: { kind: 'direct', text: 'No', conditions: '', source: 'recorded here', by: ANA, attributed_to: ANA, at: NOW, reason: '' } });
  assert.deepEqual(drawerLines(direct, []), [
    'Asked of Ana by Lead', 'Answered here by Ana', 'Proposal: Use the credit union', 'Answer: No', 'Details: Which bank?',
  ]);
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
    `${STAMP} · Builder (session 2) · state-changed · active → done · rotated · state: active → done · done_account:  → Keys rotated`,
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
    work.addNote(builder, { operation_id: op(), id: item.id, text: 'two\nlines\r\n- answer (direct): no' });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'exposure', outcome: 'sent', to: 'Ana', message_id: 57 });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'notify', outcome: 'declined', to: 'Ana' });
    work.share(lead, { operation_id: op(), id: item.id, purpose: 'notify', outcome: 'failed', to: 'Ana', detail: 'offline' });
    work.updateWork(builder, { operation_id: op(), id: item.id, expected_revision: 2, responsible: refOf(builder),
      next_to: refOf(lead), next_action: 'Review it', note: 'handing over' });
    work.updateWork(builder, { operation_id: op(), id: item.id, expected_revision: 3, state: 'done',
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
    assert.ok(exported.some(line => line.endsWith(' · responsible: null → Builder (session 2) · next_to: Builder (session 2) → Lead (session 1) · ' +
      'next_action: Do it → Review it')), 'a changed participant reads as name and session');
    assert.equal(exported.join('\n').includes('subject_id'), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a history line keeps every free-text field on one line', () => {
  const lines = historyLines([
    { seq: 1, at: NOW, by: LEAD, kind: 'shared', purpose: 'notify', outcome: 'failed', to: 'Ana\n- forged', message_id: null,
      detail: 'a\r\nb' },
    { seq: 2, at: NOW, by: LEAD, kind: 'note', text: 'one\rtwo' },
    { seq: 3, at: NOW, by: LEAD, kind: 'target-changed', from: 'v1\nx', to: 'v2' },
  ]);
  assert.deepEqual(lines, [
    `${STAMP} · Lead · shared · notify · failed · to Ana ⏎ - forged · a ⏎ b`,
    `${STAMP} · Lead · note · one ⏎ two`,
    `${STAMP} · Lead · target-changed · v1 ⏎ x → v2`,
  ]);
});

test('a plain reopen names no previous recipient; a re-address does', () => {
  const reopened = extra => Object.assign({ seq: 11, at: NOW, by: LEAD, kind: 'reopened', reason: 'again', asked_of: BUILDER_1,
    previous: null }, extra);
  assert.equal(historyLines([reopened({ previous_asked_of: BUILDER_1 })])[0],
    `${STAMP} · Lead · reopened · reason: again · asked of Builder (session 1)`);
  assert.equal(historyLines([reopened({ previous_asked_of: BUILDER_2 })])[0],
    `${STAMP} · Lead · reopened · reason: again · asked of Builder (session 1) · previously asked of Builder (session 2)`);
});

const MESSAGE = Object.freeze({
  id: 42, ts: NOW, byline: 'Marlow', kind: 'seat', session: 2,
  text: 'We should rotate the keys before Friday.\nThe old ones leak.', product: 'claude-code',
  product_provenance: 'declared', delivery: null,
});

test('a message prefill keeps the speaker words and the message id', () => {
  assert.deepEqual(messagePrefill(MESSAGE, 'work'), {
    kind: 'work', title: 'We should rotate the keys before Friday.', body: MESSAGE.text,
    source_message: { message_id: 42, quote: MESSAGE.text }, quote_truncated: false,
  });
  assert.equal(messagePrefill(MESSAGE, 'decision').kind, 'decision');
  assert.deepEqual(messagePrefill(MESSAGE, 'evidence'), {
    kind: 'evidence', target: '', observed: MESSAGE.text,
    source_message: { message_id: 42, quote: MESSAGE.text }, quote_truncated: false,
  });
  const longEvidence = messagePrefill(Object.assign({}, MESSAGE, { text: 'z'.repeat(5000) }), 'evidence');
  assert.equal(longEvidence.observed, 'z'.repeat(4096), 'what was observed is the verified quote');
  assert.equal(longEvidence.source_message.quote, longEvidence.observed);
  assert.equal(longEvidence.quote_truncated, true);
  const long = messagePrefill(Object.assign({}, MESSAGE, { text: 'x'.repeat(200) }), 'work');
  assert.equal(Array.from(long.title).length, 120);
  assert.ok(long.title.endsWith('…'));
  assert.equal(long.body, 'x'.repeat(200));
  const exact = messagePrefill(Object.assign({}, MESSAGE, { text: 'y'.repeat(120) }), 'work');
  assert.equal(exact.title, 'y'.repeat(120));
});

const bytes = text => Buffer.byteLength(text, 'utf8');
const noLoneSurrogate = text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

test('a long message is quoted to the server limits: a prefix, cut on a code point, and flagged', () => {
  const text = 'Start. ' + 'x'.repeat(4993);
  assert.equal(bytes(text), 5000);
  const prefill = messagePrefill(Object.assign({}, MESSAGE, { text }), 'work');
  assert.equal(bytes(prefill.source_message.quote), 4096);
  assert.ok(text.startsWith(prefill.source_message.quote), 'the quote is a prefix, so the room check passes');
  assert.equal(prefill.quote_truncated, true);
  assert.equal(prefill.body, text, 'a 5000-byte body is within the details limit');
  const huge = 'y'.repeat(20000);
  const big = messagePrefill(Object.assign({}, MESSAGE, { text: huge }), 'decision');
  assert.equal(bytes(big.body), 16384);
  assert.ok(huge.startsWith(big.body));
  assert.ok(bytes(big.title) <= 256);
});

test('the prefill title is the first non-blank line, within 256 bytes even in CJK', () => {
  const cjk = '鍵'.repeat(100);
  assert.equal(bytes(cjk), 300);
  const prefill = messagePrefill(Object.assign({}, MESSAGE, { text: cjk + '\nmore' }), 'work');
  assert.ok(bytes(prefill.title) <= 256, String(bytes(prefill.title)));
  assert.ok(prefill.title.endsWith('…'));
  assert.ok(cjk.startsWith(prefill.title.slice(0, -1)));
  assert.equal(prefill.quote_truncated, false);
  const blankFirst = messagePrefill(Object.assign({}, MESSAGE, { text: '\r\n   \r\nReal title\r\nbody' }), 'work');
  assert.equal(blankFirst.title, 'Real title');
});

test('an emoji at the quote cut is dropped whole, never split into half a pair', () => {
  const text = 'a'.repeat(4094) + '😀' + 'tail';
  const prefill = messagePrefill(Object.assign({}, MESSAGE, { text }), 'work');
  assert.equal(prefill.source_message.quote, 'a'.repeat(4094));
  assert.ok(noLoneSurrogate(prefill.source_message.quote));
  assert.equal(prefill.quote_truncated, true);
  const fits = 'a'.repeat(4092) + '😀' + 'tail';
  assert.equal(messagePrefill(Object.assign({}, MESSAGE, { text: fits }), 'work').source_message.quote, 'a'.repeat(4092) + '😀');
});

test('an exposure to an AI is prefixed with its handle; to a person it is not', () => {
  assert.equal(exposureText({ to: 'Marlow', text: 'W-1 · Rotate the keys' }, ['Marlow']), '@Marlow W-1 · Rotate the keys');
  assert.equal(exposureText({ to: 'Ana', text: 'W-1 · Rotate the keys' }, ['Marlow']), 'W-1 · Rotate the keys');
  assert.equal(exposureText({ to: 'marlow', text: 'W-1 · Rotate the keys' }, ['Marlow']), '@Marlow W-1 · Rotate the keys');
  assert.equal(notifyText({ id: 'W-1', kind: 'work', title: 'Rotate', next_action: 'Go',
    next_to: { name: 'MARLOW', kind: 'seat', session: null } }, ['Marlow']), '@Marlow W-1 · Rotate — Go');
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

test('an evidence row names the room message and its speaker, apart from the recorder', () => {
  assert.equal(evidenceSourceLine({ by: ANA, source_message: null }), null);
  assert.equal(evidenceSourceLine({ by: ANA }), null);
  assert.equal(evidenceSourceLine({ by: ANA, source_message: {
    message_id: 42, ts: NOW, byline: 'Marlow', kind: 'seat', session: 2, quote: 'passed' } }),
  'from room message #42 by Marlow (session 2)');
  assert.equal(evidenceSourceLine({ by: BUILDER_1, source_message: {
    message_id: 7, ts: NOW, byline: 'Ana', kind: 'person', session: null, quote: 'yes' } }),
  'from room message #7 by Ana');
});

test('an answer reads who gave it, and an owner answering for someone names both and the reason', () => {
  assert.deepEqual(answerLines({ answer: null }, []), []);
  const reported = { kind: 'reported', text: 'Yes', by: BUILDER_1, attributed_to: ANA, at: NOW, reason: '' };
  assert.deepEqual(answerLines({ answer: reported, asked_of: ANA }, []), [reportedLabel(reported)]);
  const direct = { kind: 'direct', text: 'No', by: ANA, attributed_to: ANA, at: NOW, reason: '' };
  const answered = { seq: 3, at: NOW, by: ANA, kind: 'answered', text: 'No', on_behalf: false, asked_of: ANA };
  assert.deepEqual(answerLines({ answer: direct, asked_of: ANA }, [answered]), ['Answered here by Ana']);
  const forLead = Object.assign({}, direct, { reason: 'Lead is offline.' });
  const onBehalf = Object.assign({}, answered, { on_behalf: true, asked_of: LEAD, reason: 'Lead is offline.' });
  assert.deepEqual(answerLines({ answer: forLead, asked_of: LEAD }, [onBehalf]),
    ['Answered by Ana · asked of Lead', 'Reason: Lead is offline.']);
  // A later answer event decides: after a reopen and a direct answer, the old on-behalf flag no longer applies.
  const later = [onBehalf, { seq: 4, at: NOW, by: ANA, kind: 'reopened', reason: 'x', asked_of: LEAD },
    { seq: 5, at: NOW, by: LEAD, kind: 'answered', text: 'Yes', on_behalf: false, asked_of: LEAD }];
  assert.deepEqual(answerLines({ answer: Object.assign({}, direct, { by: LEAD }), asked_of: LEAD }, later), ['Answered here by Lead']);
});

test('the contract is frozen and carries only the panel functions', () => {
  assert.ok(Object.isFrozen(model));
  assert.deepEqual(Object.keys(model).sort(), ['actionsByPerson', 'answerLines', 'changedSince', 'createAnswerTracker', 'doneLine', 'drawerLines', 'errorWords', 'evidenceSourceLine', 'exposureText', 'historyLines', 'killLines', 'killWord', 'messagePrefill',
    'needsYou', 'notifyText', 'projectRowLine', 'projectSections', 'projectSummaries', 'projectTree', 'reportedLabel', 'reportedToYou',
    'shareLine', 'sourceLine', 'stateLabel', 'waitingLabel', 'who']);
});

test('the kill slot reads in words on the decision and its Needs you row; an older record shows none', () => {
  assert.deepEqual(['unattacked', 'attacked', 'survived', 'killed'].map(state => killWord({ kill_state: state })),
    ['unattacked', 'attacked', 'attacked, survived', 'killed']);
  assert.equal(killWord({}), null);
  assert.equal(killWord({ kill_state: 'sunk' }), null);
  const lead = { name: 'Lead', kind: 'seat', session: null };
  const marlow = { name: 'Marlow', kind: 'seat', session: 1 };
  assert.deepEqual(killLines({ kill_state: 'killed', kill: { question: 'Would the bank\nrefuse?', by: marlow, at: 1,
    reply: { words: 'It would.', outcome: 'killed', by: lead, at: 2 } } }), [
    'Kill slot: killed',
    'Kill question from Marlow (session 1): Would the bank ⏎ refuse?',
    'Reply from Lead (killed): It would.',
  ]);
  assert.deepEqual(killLines({ kill_state: 'unattacked', kill: null }), ['Kill slot: unattacked']);
  assert.deepEqual(killLines({}), []);
  const brief = Object.assign({}, BRIEF, { needs_me: BRIEF.needs_me.map(row => row.kind === 'decision'
    ? Object.assign({}, row, { kill_state: 'attacked' }) : row) });
  const rows = needsYou(brief, NOW).rows;
  assert.equal(rows.find(row => row.kind === 'decision').kill, 'attacked');
  assert.equal(Object.hasOwn(rows.find(row => row.kind === 'work'), 'kill'), false);
});

test('an ask that a decision cites as its message is drawn once, as the decision', () => {
  const decision = BRIEF.needs_me.find(row => row.kind === 'decision');
  const brief = Object.assign({}, BRIEF, { needs_me: BRIEF.needs_me.map(row => row === decision
    ? Object.assign({}, row, { ask_message_id: 41 }) : row) });
  const ask = id => ({ ask_id: id, asked_at: NOW - HOUR, by: 'Lead', of: 'Ana', of_kind: 'person', means: 'I pick it',
    deliver: 'now', state: 'open', kept_open: false, carried_from: null, answers: [] });
  const result = needsYou(brief, NOW, [ask(41), ask(42)]);
  assert.deepEqual(result.rows.map(row => row.id).sort(), ['W-1', 'W-3', 'ask-42'],
    'the cited ask is the decision row; the uncited ask keeps its own');
  assert.equal(result.count, 3);
  const viaDecisions = needsYou(Object.assign({}, BRIEF, { decisions: [{ kind: 'decision', id: 'D-9',
    ask_message_id: 42 }] }), NOW, [ask(42)]);
  assert.equal(viaDecisions.rows.some(row => row.id === 'ask-42'), false,
    'a decision in the brief\'s decision list also claims its ask');
  assert.equal(needsYou(BRIEF, NOW, [ask(41)]).rows.some(row => row.id === 'ask-41'), true,
    'ARRANGEMENT: without the citation the ask has its own row');
});

test('an awaiting decision whose ask the person asked answered in the room says so, until the record has it', () => {
  const decision = BRIEF.needs_me.find(row => row.kind === 'decision');
  assert.equal(decision.state, 'awaiting', 'ARRANGEMENT: the fixture decision is awaiting');
  const cites = Object.assign({}, decision, { ask_message_id: 41 });
  const brief = Object.assign({}, BRIEF, { needs_me: BRIEF.needs_me.map(row => row === decision ? cites : row) });
  const row = id => needsYou(brief, NOW, [], new Set(id)).rows.find(r => r.id === decision.id);
  assert.equal(row([41]).note, 'Answered in the room, not recorded here');
  assert.equal(Object.hasOwn(row([40]), 'note'), false, 'another ask answered says nothing');
  assert.equal(Object.hasOwn(row([]), 'note'), false);
  assert.equal(Object.hasOwn(needsYou(BRIEF, NOW, [], new Set([41])).rows.find(r => r.id === decision.id), 'note'), false,
    'a decision that cites no message says nothing');
  const citesOnly = Object.assign({}, decision, { source_message_id: 41, ask_message_id: null });
  assert.equal(Object.hasOwn(needsYou(Object.assign({}, BRIEF, { needs_me: BRIEF.needs_me.map(row => row === decision ? citesOnly : row) }),
    NOW, [], new Set([41])).rows.find(r => r.id === decision.id), 'note'), false,
  'a decision that only cites a message, with no ask bound to it, says nothing');
  const item = { kind: 'decision', state: 'awaiting', asked_of: { name: 'Ana' }, asked_by: { name: 'Lead' },
    answer: null, ask_message_id: 41, source_message: { message_id: 41, byline: 'Lead', session: null, quote: 'Decision: Pick' } };
  assert.ok(drawerLines(item, [], new Set([41])).includes('Answered in the room, not recorded here (message #41).'));
  assert.ok(!drawerLines(Object.assign({}, item, { state: 'answered' }), [], new Set([41]))
    .some(line => line.startsWith('Answered in the room')), 'once recorded, the line goes');
  assert.ok(!drawerLines(item, []).some(line => line.startsWith('Answered in the room')));
  assert.ok(!drawerLines(Object.assign({}, item, { ask_message_id: null }), [], new Set([41]))
    .some(line => line.startsWith('Answered in the room')), 'citing alone binds nothing');
});

test('a room answer is settled only by a brief read that began after it arrived', () => {
  const answers = createAnswerTracker();
  assert.equal(answers.observe([5]), true, 'a first answer is new');
  assert.deepEqual([...answers.settled()], [], 'unsettled until a brief is read');
  // The answer that arrives while a read is in flight is not settled by it.
  const inFlight = answers.beginRead();
  assert.equal(answers.observe([5, 7]), true);
  answers.settle(inFlight);
  assert.deepEqual([...answers.settled()], [5], 'the read settles 5, which it began after; 7 arrived mid-read');
  const next = answers.beginRead();
  answers.settle(next);
  assert.deepEqual([...answers.settled()].sort(), [5, 7]);
  assert.equal(answers.observe([5, 7]), false, 'the same ids again are nothing new');
  assert.equal(answers.observe([7]), false, 'an id leaving (era reset) is not new');
  assert.deepEqual([...answers.settled()], [7]);
  assert.equal(answers.observe([7, 0, -1, 1.5, '9']), false, 'malformed ids are ignored');
});

test('a decision the room answered reads as answered in the room, from the record or its row', () => {
  const room = { kind: 'direct', source: 'answered in the room #5' };
  assert.equal(stateLabel({ kind: 'decision', state: 'answered', answer: room }), 'Answered in the room');
  assert.equal(stateLabel({ kind: 'decision', state: 'answered', answer_summary: room }), 'Answered in the room');
  assert.equal(stateLabel({ kind: 'decision', state: 'answered', answer: { kind: 'direct', source: '' } }), 'Answered here');
  assert.equal(stateLabel({ kind: 'decision', state: 'answered', answer: { kind: 'direct', source: 'answered in the room #5 and more' } }),
    'Answered here', 'only the room\'s exact words count');
  assert.equal(stateLabel({ kind: 'decision', state: 'answered', answer_summary: { kind: 'direct' } }), 'Answered here',
    'a row without the answer\'s source keeps the old label');
  assert.equal(stateLabel({ kind: 'decision', state: 'reported', answer: room }), 'Answer reported');
});

test('the open dialog knows when its record changed in a newer brief', () => {
  const brief = { needs_me: [{ id: 'D-2', updated_at: 200 }], open: [{ id: 'W-1', updated_at: 50 }], decisions: [{ id: 'D-2', updated_at: 200 }] };
  assert.equal(changedSince(brief, 'D-2', 100), true);
  assert.equal(changedSince(brief, 'D-2', 200), false);
  assert.equal(changedSince(brief, 'W-1', 50), false);
  assert.equal(changedSince(brief, 'W-9', 1), false, 'a record the brief does not list is left alone');
  assert.equal(changedSince({ needs_me: [], open: [] }, 'D-2', 100), false);
});

test('the dialog says a room answer was given in the room, naming the message', () => {
  const by = { name: 'Scout', kind: 'seat', session: null };
  assert.deepEqual(answerLines({ answer: { kind: 'direct', by, source: 'answered in the room #7' } }, []),
    ['Answered in the room by Scout (message #7)']);
  assert.deepEqual(answerLines({ answer: { kind: 'direct', by, source: '' } }, []), ['Answered here by Scout']);
});
