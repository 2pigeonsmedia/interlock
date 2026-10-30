'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Asks = require('../src/web/asks_model.js');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.html'), 'utf8');

function post(seq, messageId, by, extra = {}) {
  return Object.assign({
    seq, ts: 1_000 * seq, kind: 'post', by, message_id: messageId,
    ask: null, answers: [], status: null, read_through: null, discusses: null,
  }, extra);
}

function ask(of, means = null, deliver = 'now') {
  return { of, of_kind: of === 'Ana' ? 'person' : 'seat', means, deliver, project: null };
}

// The server's stored facts: was the answerer the one asked, did it close it.
function answer(askId, choice = null, crossedBy = null, byAddressee = false, closes = false) {
  return { ask_id: askId, choice, crossed_by: crossedBy, by_addressee: byAddressee, closes, revision: 1 };
}

test('rows replay the way the server does: only the addressee closes; keep-open and withdraw belong to the asker', () => {
  const state = Asks.createAsksState();
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'I merge') }),
    post(2, 11, 'Scout', { answers: [answer(10, 'yes')] }),
  ]);
  assert.equal(state.ask(10).state, 'open', 'a bystander answer closes nothing');
  state.apply([post(3, 12, 'Ana', { answers: [answer(10, 'no', null, true, true)] })]);
  assert.equal(state.ask(10).state, 'answered');
  assert.equal(Asks.chosen(state.ask(10)), 'no', 'the addressee\'s own last choice is held');
  state.apply([{ seq: 4, ts: 4_000, kind: 'keep_open', by: 'Lead', ask_id: 10 }]);
  state.apply([post(5, 13, 'Ana', { answers: [answer(10, 'yes', null, true, false)] })]);
  assert.equal(state.ask(10).state, 'open', 'a kept-open ask stays open through answers');
  assert.equal(Asks.chosen(state.ask(10)), 'yes');
  state.apply([post(5.5, 14, 'Scout', { answers: [answer(10, 'no')] })]);
  assert.equal(Asks.chosen(state.ask(10)), 'yes', 'a bystander after her does not move her choice');
  state.apply([{ seq: 6, ts: 6_000, kind: 'withdraw', by: 'Lead', ask_id: 10 }]);
  assert.equal(state.ask(10).state, 'withdrawn');
  assert.deepEqual(state.openFor('Ana'), { addressed: [], asked: [] });
});

test('open asks for the viewer: addressed and asked, carried asks included, in id order', () => {
  const state = Asks.createAsksState();
  state.apply([
    { seq: 1, ts: 9, kind: 'carry', by: 'Lead', ask_id: 4, archive_id: 'transcript-x',
      asked_at: 5, ask: ask('Ana', 'old scope'), kept_open: false },
    post(2, 20, 'Ana', { ask: ask('Scout') }),
    post(3, 21, 'Scout', { ask: ask('Ana', 'new scope') }),
  ]);
  const open = state.openFor('Ana');
  assert.deepEqual(open.addressed.map(row => [row.ask_id, row.by, row.carried_from]),
    [[4, 'Lead', 'transcript-x'], [21, 'Scout', null]]);
  assert.deepEqual(open.asked.map(row => row.ask_id), [20]);
  assert.deepEqual(Object.keys(open.addressed[0]).sort(), ['answers', 'ask_id', 'asked_at', 'by',
    'carried_from', 'deliver', 'kept_open', 'means', 'of', 'of_kind', 'project', 'state'],
  'the event carries the same ask shape GET /api/ai/asks returns');
});

test('a bare yes, no or go answers the one open ask with no tap; anything else takes a tap', () => {
  const one = [{ ask_id: 7 }];
  assert.equal(Asks.bindAnswers(one, new Set(), 'sounds good, will do'), null, 'ordinary talk never closes an ask');
  assert.equal(Asks.bindAnswers(one, new Set(), 'yes, but'), null, 'only the exact word');
  assert.deepEqual(Asks.bindAnswers(one, new Set(), ' YES '), [{ ask_id: 7, choice: 'yes' }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set(), 'Go'), [{ ask_id: 7, choice: 'yes' }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set(), 'no'), [{ ask_id: 7, choice: 'no' }]);
  assert.equal(Asks.bindAnswers([{ ask_id: 7 }, { ask_id: 9 }], new Set(), 'yes'), null,
    'two open asks: a bare yes takes a tap');
  assert.deepEqual(Asks.bindAnswers(one, new Set([7]), 'merge it'), [{ ask_id: 7, choice: null }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set([7]), 'no'), [{ ask_id: 7, choice: 'no' }],
    'a tapped bare word keeps its choice');
  const two = [{ ask_id: 7 }, { ask_id: 9 }];
  assert.deepEqual(Asks.bindAnswers(two, new Set([9, 7, 99])),
    [{ ask_id: 7, choice: null }, { ask_id: 9, choice: null }], 'a stale pick is ignored');
});

test('the ask line is words: open with an age, answered with the choice, withdrawn, hold', () => {
  const state = Asks.createAsksState();
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'm') }),
    post(2, 11, 'Lead', { ask: ask('Scout', null, 'later') }),
  ]);
  assert.equal(Asks.askLine(state.ask(10), 1_000 + 3 * 3_600_000), 'Ask of Ana · open 3 h');
  assert.equal(Asks.askLine(state.ask(11), 2_000), 'Hold for Scout · open just now');
  state.apply([post(3, 12, 'Ana', { answers: [answer(10, 'yes', null, true, true)] })]);
  assert.equal(Asks.askLine(state.ask(10), 0), 'Ask of Ana · answered "yes" · Ana · #12');
});

test('a page is refused whole when any row is malformed or out of order', () => {
  const good = { ok: true, rows: [post(1, 10, 'Lead')], cursor: 1, first_id: 1 };
  assert.equal(Asks.validPage(good), true);
  assert.equal(Asks.validPage(Object.assign({}, good, { rows: [post(1, 10, 'Lead', { extra: 1 })] })), false);
  assert.equal(Asks.validPage(Object.assign({}, good, { rows: [post(2, 10, 'L'), post(1, 11, 'L')] })), false);
  assert.equal(Asks.validPage(Object.assign({}, good, {
    rows: [post(1, 10, 'Lead', { ask: Object.assign(ask('Ana'), { subject_id: 'x' }) })],
  })), false);
});

test('the room page loads the model before room.js and posts asks through the annotated route', () => {
  assert.ok(ROOM_HTML.indexOf('/asks_model.js') < ROOM_HTML.indexOf('/room.js'));
  assert.match(ROOM_JS, /fetch\('\/api\/annotated-messages', request\)/);
  assert.match(ROOM_JS, /fetch\(`\/api\/annotations\?after=\$\{annotationCursor\}&limit=100`/);
  assert.match(ROOM_JS, /new CustomEvent\('interlock:asks'/);
  // Ask text and scope are written as text, never markup.
  const decorate = ROOM_JS.slice(ROOM_JS.indexOf('function decorateMessage'),
    ROOM_JS.indexOf('function renderBindChips'));
  assert.doesNotMatch(decorate, /innerHTML|insertAdjacentHTML/);
});

test('a page carrying a kind from a later release is used, and that row is passed over', () => {
  const page = { ok: true, first_id: 1, cursor: 2, rows: [
    post(1, 10, 'Lead', { ask: ask('Ana', 'm') }),
    { seq: 2, ts: 2, kind: 'stamp', by: 'Lead', message_id: 10, project: 'finance' },
  ] };
  assert.equal(Asks.validPage(page), true);
  const state = Asks.createAsksState();
  state.apply(page.rows);
  assert.deepEqual(state.openFor('Ana').addressed.map(row => row.ask_id), [10]);
});

test('the page reads what the server stored, never re-derives it from names', () => {
  const state = Asks.createAsksState();
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'I merge') }),
    // A participant named exactly like the one asked, whom the server did not count as her.
    post(2, 11, 'Ana', { answers: [answer(10, 'yes', null, false, false)] }),
  ]);
  assert.equal(state.ask(10).state, 'open');
  assert.equal(Asks.chosen(state.ask(10)), null);
});

test('answered lists every ask its addressee has answered, by the stored fact, open or not', () => {
  const state = Asks.createAsksState();
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'a') }),
    post(2, 11, 'Lead', { ask: ask('Ana', 'b') }),
    post(3, 12, 'Ana', { answers: [answer(10, 'yes', null, true, true)] }),
    post(4, 13, 'Ana', { answers: [answer(11, 'yes', null, false, false)] }),
  ]);
  assert.deepEqual(state.answeredIds(), [10]);
});

test('one Reply on an ask, and it is a discussion that names the asker and binds nothing', () => {
  const decorate = ROOM_JS.slice(ROOM_JS.indexOf('function decorateMessage'), ROOM_JS.indexOf('function renderBindChips'));
  assert.doesNotMatch(decorate, /askButton\('Reply'/, 'the ask chip has no Reply of its own');
  const seed = ROOM_JS.slice(ROOM_JS.indexOf('function seedReply'), ROOM_JS.indexOf('function renderMessage('));
  assert.match(seed, /@\$\{ask\.by\}/, 'a reply to an ask names the asker');
  assert.doesNotMatch(seed, /pickedAsks/, 'a discussion reply never binds an ask');
  assert.match(decorate, /Re: \$\{asked\.by\}'s ask #\$\{target\}/, 'the reference says whose ask');
});

test('a reply to an ask hides the answer chips and binds nothing; the panel answers through the room', () => {
  const compose = ROOM_JS.slice(ROOM_JS.indexOf('function composerAnnotation'), ROOM_JS.indexOf('const ASK_REFUSALS'));
  assert.match(compose, /composingDiscussion\(\) \? null/, 'a discussion reply carries no answers');
  assert.match(ROOM_JS, /askBind\.hidden = addressed\.length === 0 \|\| composingDiscussion\(\)/);
  assert.match(ROOM_JS, /addEventListener\('interlock:answer-ask'[\s\S]*answerAsk\(detail\.ask_id, detail\.choice\)/);
  assert.match(ROOM_JS, /question: askQuestion\(ask\.ask_id\)/);
});

test('the work panel\'s Reply on an ask is the same composer act as the message\'s Reply', () => {
  assert.match(ROOM_JS, /addEventListener\('interlock:reply-ask'[\s\S]*seedReply\(detail\.ask_id\)/);
});
