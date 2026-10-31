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
  assert.deepEqual(Object.keys(open.addressed[0]).sort(), ['answers', 'approval', 'ask_id', 'asked_at', 'by',
    'carried_from', 'deliver', 'done', 'kept_open', 'latest', 'means', 'of', 'of_kind', 'project', 'revision',
    'revisions', 'state', 'turn'],
  'the event carries the same ask shape GET /api/ai/asks returns');
});

test('a bare yes, no or go answers the one open ask with no tap; anything else takes a tap', () => {
  const one = [{ ask_id: 7 }];
  assert.equal(Asks.bindAnswers(one, new Set(), 'sounds good, will do'), null, 'ordinary talk never closes an ask');
  assert.equal(Asks.bindAnswers(one, new Set(), 'yes, but'), null, 'only the exact word');
  assert.deepEqual(Asks.bindAnswers(one, new Set(), ' YES '), [{ ask_id: 7, choice: 'yes', revision: 1 }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set(), 'Go'), [{ ask_id: 7, choice: 'yes', revision: 1 }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set(), 'no'), [{ ask_id: 7, choice: 'no', revision: 1 }]);
  assert.equal(Asks.bindAnswers([{ ask_id: 7 }, { ask_id: 9 }], new Set(), 'yes'), null,
    'two open asks: a bare yes takes a tap');
  assert.deepEqual(Asks.bindAnswers(one, new Set([7]), 'merge it'), [{ ask_id: 7, choice: null, revision: 1 }]);
  assert.deepEqual(Asks.bindAnswers(one, new Set([7]), 'no'), [{ ask_id: 7, choice: 'no', revision: 1 }],
    'a tapped bare word keeps its choice');
  const two = [{ ask_id: 7 }, { ask_id: 9 }];
  assert.deepEqual(Asks.bindAnswers(two, new Set([9, 7, 99])),
    [{ ask_id: 7, choice: null, revision: 1 }, { ask_id: 9, choice: null, revision: 1 }], 'a stale pick is ignored');
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
    // `stamp` became a known kind in 0.3.1; a kind no release knows yet stands in.
    { seq: 2, ts: 2, kind: 'pin', by: 'Lead', message_id: 10, project: 'orchard' },
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
  assert.match(ROOM_JS, /addEventListener\('interlock:answer-ask'[\s\S]*answerAsk\(detail\.ask_id, detail\.choice, detail\.revision\)/);
  assert.match(ROOM_JS, /question: askQuestion\(ask\.ask_id\)/);
});

test('the work panel\'s Reply on an ask is the same composer act as the message\'s Reply', () => {
  assert.match(ROOM_JS, /addEventListener\('interlock:reply-ask'[\s\S]*seedReply\(detail\.ask_id\)/);
});

// The page replays the story the way the server does, so the chip, the card
// and the CLI read the same turn. Rows are the public side-car rows.
test('the page replays the printer story in both directions and reads the same turn as the server', () => {
  const { createAsksState } = require('../src/web/asks_model.js');
  const ask = (seq, message_id, by, of, of_kind, means) => ({ seq, ts: seq * 1000, kind: 'post', by, message_id,
    ask: { of, of_kind, means, deliver: 'now', project: 'ops' }, answers: [], status: null, read_through: null, discusses: null });
  const reply = (seq, message_id, by, ask_id, party, status = null) => ({ seq, ts: seq * 1000, kind: 'post', by, message_id,
    ask: null, answers: [], status, read_through: status ? 0 : null, discusses: { ask_id, party } });
  const answer = (seq, message_id, by, ask_id, choice, revision) => ({ seq, ts: seq * 1000, kind: 'post', by, message_id, ask: null,
    answers: [{ ask_id, choice, crossed_by: null, by_addressee: true, closes: true, revision }], status: null, read_through: null, discusses: null });
  const revise = (seq, by, ask_id, means) => ({ seq, ts: seq * 1000, kind: 'revise', by, ask_id, means });
  const approval = (seq, by, ask_id) => ({ seq, ts: seq * 1000, kind: 'approval', by, ask_id });

  // An AI asks a person for approval: the asker acts after a yes.
  const room = createAsksState();
  room.apply([ask(1, 6, 'Scout', 'Patti', 'person', 'I order one roller, up to $30'), approval(1.5, 'Scout', 6)]);
  assert.deepEqual(room.ask(6).turn, { phase: 'waiting', waiting_on: 'Patti', acting: null });
  room.apply([reply(2, 8, 'Patti', 6, 'addressee')]);
  assert.deepEqual(room.ask(6).turn, { phase: 'waiting', waiting_on: 'Scout', acting: null }, 'her reply passes the turn');
  assert.equal(room.ask(6).latest.kind, 'discussion');
  room.apply([revise(3, 'Scout', 6, 'I order one refurbished roller, up to $15')]);
  assert.equal(room.ask(6).means, 'I order one refurbished roller, up to $15');
  assert.deepEqual(room.ask(6).revisions, [{ means: 'I order one roller, up to $30', revision: 1 }], 'the old scope stays, struck');
  assert.deepEqual(room.ask(6).turn, { phase: 'waiting', waiting_on: 'Patti', acting: null }, 'the revision is hers to answer');
  room.apply([answer(4, 9, 'Patti', 6, 'yes', 2)]);
  assert.deepEqual(room.ask(6).turn, { phase: 'agreed', waiting_on: null, acting: 'Scout' });
  assert.deepEqual(room.openFor('Scout').asked.map(row => row.ask_id), [6], 'agreed stays on the acting asker\'s list');
  assert.deepEqual(room.openFor('Patti').addressed.map(row => row.ask_id), [], 'and off hers, as on the server');
  room.apply([reply(5, 10, 'Scout', 6, 'asker', 'done')]);
  assert.equal(room.ask(6).done.message_id, 10, 'the acting party\'s done reply is the receipt');
  assert.equal(room.ask(6).turn.phase, 'done');
  assert.deepEqual(room.openFor('Scout').asked, [], 'done leaves every list');

  // A revision after a yes reopens: no yes carries over to a scope she did not see.
  const again = createAsksState();
  again.apply([ask(1, 6, 'Scout', 'Patti', 'person', 'one roller'), approval(1.5, 'Scout', 6), answer(2, 7, 'Patti', 6, 'yes', 1), revise(3, 'Scout', 6, 'two rollers')]);
  assert.deepEqual(again.ask(6).turn, { phase: 'waiting', waiting_on: 'Patti', acting: null });

  // A person asks an AI a plain question: a bystander's reply moves nothing,
  // his yes answers it, and nobody is on anything.
  const reverse = createAsksState();
  reverse.apply([ask(1, 3, 'Patti', 'Scout', 'seat', 'You order one roller')]);
  reverse.apply([reply(2, 4, 'Lark', 3, 'other')]);
  assert.deepEqual(reverse.ask(3).turn, { phase: 'waiting', waiting_on: 'Scout', acting: null }, 'a bystander does not pass the turn');
  reverse.apply([answer(3, 5, 'Scout', 3, 'yes', 1)]);
  assert.deepEqual(reverse.ask(3).turn, { phase: 'answered', waiting_on: null, acting: null }, 'a question is just a question');
  reverse.apply([reply(4, 6, 'Scout', 3, 'addressee', 'done')]);
  assert.equal(reverse.ask(3).done, null, 'a plain ask takes no done receipt');
});

test('an answer names the revision it was given against; a stale one is refused on the page', () => {
  const Asks = require('../src/web/asks_model.js');
  assert.deepEqual(Asks.bindAnswers([{ ask_id: 7, revision: 3 }], new Set(), 'yes'), [{ ask_id: 7, choice: 'yes', revision: 3 }],
    'the composer binds the revision on screen');
  assert.deepEqual(Asks.bindAnswers([{ ask_id: 7, revision: 2 }, { ask_id: 9, revision: 1 }], new Set([7, 9]), 'no'),
    [{ ask_id: 7, choice: 'no', revision: 2 }, { ask_id: 9, choice: 'no', revision: 1 }]);
  assert.match(ROOM_JS, /answerAsk\(ask\.ask_id, choice, ask\.revision\)/, 'the chip sends the revision it shows');
  assert.match(ROOM_JS, /current\.revision !== revision\) \{\s*setRoomNotice\('This ask changed since it was shown/,
    'an answer given against a scope that changed is not sent');
  assert.match(ROOM_JS, /annotation: \{ answers: \[\{ ask_id: askId, choice, revision \}\] \}/);
});

test('a carried ask\'s story replays: its revision, its earlier scopes, and a yes not yet done', () => {
  const state = Asks.createAsksState();
  const carry = (seq, askId, means) => ({
    seq, ts: 5_000, kind: 'carry', by: 'Lead', ask_id: askId, archive_id: 'transcript-x', asked_at: 1_000,
    ask: ask('Ana', means), kept_open: false,
  });
  const story = (seq, askId, means, extra) => Object.assign(carry(seq, askId, means), { kind: 'carry_state' }, extra);
  const rows = [
    story(1, 10, 'two drums', { revision: 2, revisions: [{ means: 'one drum', revision: 1 }], agreed: null }),
    story(2, 11, 'mealworms', { revision: 1, revisions: [], agreed: { message_id: 7, by: 'Ana', revision: 1, at: 2_000 } }),
    carry(3, 12, 'grit'),
    { seq: 4, ts: 5_000, kind: 'approval', by: 'Lead', ask_id: 11 },
  ];
  assert.equal(Asks.validPage({ ok: true, rows, cursor: 3, first_id: 20 }), true);
  assert.equal(Asks.validPage({ ok: true, rows: [Object.assign({}, rows[0], { revisions: [] })], cursor: 1, first_id: 20 }), false,
    'revision n has n-1 earlier scopes');
  state.apply(rows);
  assert.deepEqual([state.ask(10).revision, state.ask(10).revisions, state.ask(10).turn.phase],
    [2, [{ means: 'one drum', revision: 1 }], 'waiting']);
  assert.deepEqual([state.ask(11).state, state.ask(11).turn.phase, state.ask(11).turn.acting], ['answered', 'agreed', 'Lead']);
  assert.deepEqual(state.openFor('Lead').asked.map(row => row.ask_id), [10, 11, 12], 'all still on his list');
  assert.deepEqual([state.ask(12).revision, state.ask(12).turn.phase], [1, 'waiting'], 'a plain carry reads as before');
});

test('on the page too, a done receipt lands only on an agreed ask', () => {
  const state = Asks.createAsksState();
  const done = (seq, id, askId) => post(seq, id, 'Lead', { discusses: { ask_id: askId, party: 'asker' }, status: 'done', read_through: id - 1 });
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'I restart the router') }),
    { seq: 1.5, ts: 1_500, kind: 'approval', by: 'Lead', ask_id: 10 },
    post(2, 11, 'Ana', { answers: [answer(10, 'no', null, true, true)] }),
    done(3, 12, 10),
    post(4, 13, 'Lead', { ask: ask('Ana', 'I wipe the disk') }),
    post(5, 14, 'Ana', { answers: [answer(13, null, null, true, true)] }),
    done(6, 15, 13),
  ]);
  assert.deepEqual([state.ask(10).done, state.ask(10).turn.phase], [null, 'declined']);
  assert.deepEqual([state.ask(13).done, state.ask(13).turn.phase], [null, 'answered']);
});

test('a typed or bound answer is sent against the revision shown when she began writing, never one that landed after', () => {
  const state = Asks.createAsksState();
  state.apply([post(1, 3, 'Lead', { ask: ask('Ana', 'scope one') })]);
  const shown = new Map();
  Asks.noteShown(shown, state.openFor('Ana').addressed, false);
  assert.equal(shown.get(3), 1, 'the arrangement: shown at revision 1, composer empty');
  // She types "yes"; the revise lands and the page redraws while she writes.
  state.apply([{ seq: 2, ts: 2_000, kind: 'revise', by: 'Lead', ask_id: 3, means: 'scope two' }]);
  Asks.noteShown(shown, state.openFor('Ana').addressed, true);
  assert.equal(state.ask(3).revision, 2, 'the arrangement: the model is at revision 2');
  assert.deepEqual(Asks.bindAnswers(state.openFor('Ana').addressed, new Set(), 'yes', null, shown),
    [{ ask_id: 3, choice: 'yes', revision: 1 }], 'sent against what she saw, so the room refuses it');
  // With the composer empty again, the page follows the ask.
  Asks.noteShown(shown, state.openFor('Ana').addressed, false);
  assert.deepEqual(Asks.bindAnswers(state.openFor('Ana').addressed, new Set(), 'yes', null, shown),
    [{ ask_id: 3, choice: 'yes', revision: 2 }]);
  // An ask that leaves the list leaves the map.
  state.apply([{ seq: 3, ts: 3_000, kind: 'withdraw', by: 'Lead', ask_id: 3 }]);
  Asks.noteShown(shown, state.openFor('Ana').addressed, true);
  assert.equal(shown.has(3), false);
});

test('the room page sends the shown revision from the composer and words the refusal', () => {
  assert.ok(ROOM_JS.includes('messageBody.value, null, shownRevisions)'), 'the composer binds with the shown revisions');
  assert.match(ROOM_JS, /noteShown\(shownRevisions, open\.addressed, messageBody\.value\.trim\(\) !== '', pickedAsks\)/,
    'they stop following the asks once she is writing');
  assert.match(ROOM_JS, /'ask-revised': 'This ask changed while you were writing\./);
});

test('the page words an answer that is not a yes, and a revise the decision record could not follow', () => {
  const { turnWords } = require('../src/web/ask_turn.js');
  assert.equal(turnWords({ phase: 'answered', waiting_on: null, acting: null }, 'Ana'), 'answered', 'a plain ask is answered; a request for approval is never closed by words');
  assert.match(ROOM_JS, /if \(result && result\.decision === 'stale'\) setRoomNotice\(STALE_DECISION_NOTICE\)/);
  assert.match(ROOM_JS, /the decision record did not follow/);
});

test('a tapped chip keeps the revision it showed, even with the composer empty', () => {
  const state = Asks.createAsksState();
  state.apply([post(1, 3, 'Lead', { ask: ask('Ana', 'scope one') })]);
  const shown = new Map();
  const picked = new Set();
  Asks.noteShown(shown, state.openFor('Ana').addressed, false, picked);
  picked.add(3);
  shown.set(3, 1);
  state.apply([{ seq: 2, ts: 2_000, kind: 'revise', by: 'Lead', ask_id: 3, means: 'scope two' }]);
  Asks.noteShown(shown, state.openFor('Ana').addressed, false, picked);
  assert.equal(state.ask(3).revision, 2, 'the arrangement: revised after the tap, composer empty');
  assert.deepEqual(Asks.bindAnswers(state.openFor('Ana').addressed, picked, 'yes', null, shown),
    [{ ask_id: 3, choice: 'yes', revision: 1 }], 'sent against the tapped scope, so the room refuses it');
  picked.delete(3);
  Asks.noteShown(shown, state.openFor('Ana').addressed, false, picked);
  assert.equal(shown.get(3), 2, 'the control: untapped, it follows the ask again');
});

test('a tapped Yes or No posts words addressed to the one who asked, and never copies the asker\'s scope text', () => {
  assert.equal(Asks.answerText({ by: 'Piha', means: 'I post one note' }, 'yes'), '@Piha — yes');
  assert.equal(Asks.answerText({ by: 'Ana', means: null }, 'no'), '@Ana — no');
  assert.equal(Asks.answerText({ by: 'Lead', means: 'I tidy up @Scout and @all' }, 'yes'), '@Lead — yes',
    'an @ in the scope never rides in her message');
  assert.ok(ROOM_JS.includes('text: InterlockAsks.answerText(current, choice)'), 'the chip and the card post it');
});

test('a request for approval reads Approve and Decline, and its tapped answer says approved or declined', () => {
  assert.equal(Asks.answerText({ by: 'Scout', means: 'x', approval: true }, 'yes'), '@Scout — approved');
  assert.equal(Asks.answerText({ by: 'Scout', means: 'x', approval: true }, 'no'), '@Scout — declined');
  assert.equal(Asks.answerText({ by: 'Scout', means: 'x', approval: false }, 'yes'), '@Scout — yes', 'a plain ask reads as before');
  assert.ok(ROOM_JS.includes("ask.approval ? (choice === 'yes' ? 'Approve' : 'Decline')"), 'the chip under the ask');
  const PANEL_JS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
  assert.ok(PANEL_JS.includes("cardButton(card.approval ? 'Approve' : 'Yes'"), 'the Needs-you card');
  assert.ok(PANEL_JS.includes("' waiting on you ↑'"), 'the project count line');
});

test('the composer offers "for approval" to members only, routes it, and sends title, project and scope', () => {
  assert.ok(ROOM_HTML.includes('id="ask-approval"') && ROOM_HTML.includes('id="ask-project"'));
  assert.ok(ROOM_JS.includes("askApprovalLabel.hidden = !currentUser || currentUser.first_owner === true;"), 'hidden for the first owner');
  assert.ok(ROOM_JS.includes("await ownerMutation('/api/work/approvals/ask', request);"), 'sent to the approval route, not as a plain ask');
  assert.ok(/if \(approvalMode\(\)\) \{\s+sendButton\.disabled = true;\s+try \{\s+await sendApprovalRequest\(\);/.test(ROOM_JS), 'the composer sends it instead of the message');
  assert.ok(ROOM_JS.includes('askOf.hidden = on;'), 'the room routes it: no one to pick');
});

test('a request for approval is answered from its chip by its live approver, a plain ask by the person asked', () => {
  const request = { ask_id: 7, of: 'Bea', state: 'open', approval: true };
  assert.equal(Asks.mayAnswer(request, 'Bea'), true, 'before the brief is read: the person it was asked of');
  assert.equal(Asks.mayAnswer(request, 'Cal'), false);
  assert.equal(Asks.mayAnswer(request, 'Cal', new Set([7])), true, 'a lead who took it over approves it');
  assert.equal(Asks.mayAnswer(request, 'Bea', new Set()), false, 'the one it was first asked of no longer does');
  assert.equal(Asks.mayAnswer(Object.assign({}, request, { state: 'answered' }), 'Cal', new Set([7])), false, 'only while open');
  assert.equal(Asks.mayAnswer(request, null, new Set([7])), false, 'nobody signed in');
  const plain = { ask_id: 8, of: 'Bea', state: 'open', approval: false };
  assert.equal(Asks.mayAnswer(plain, 'Bea', new Set()), true, 'a plain ask ignores Needs you');
  assert.equal(Asks.mayAnswer(plain, 'Cal', new Set([8])), false);
});

test('Mark done is offered to the one carrying out an approved request, and only then', () => {
  const agreed = { ask_id: 7, by: 'Bea', of: 'Ana', state: 'answered', approval: true, turn: { phase: 'agreed', waiting_on: null, acting: 'Bea' } };
  assert.equal(Asks.mayMarkDone(agreed, 'Bea'), true);
  assert.equal(Asks.mayMarkDone(agreed, 'Ana'), false, 'not the approver');
  assert.equal(Asks.mayMarkDone(agreed, null), false);
  assert.equal(Asks.mayMarkDone(Object.assign({}, agreed, { approval: false }), 'Bea'), false, 'a plain ask has no done receipt button');
  for (const phase of ['waiting', 'declined', 'done']) {
    assert.equal(Asks.mayMarkDone(Object.assign({}, agreed, { turn: { phase, waiting_on: null, acting: null } }), 'Bea'), false, phase);
  }
});

// A reply on a withdrawn ask is still sent, and still reaches its asker; the
// one writing it is told first. A reply on an open ask gets no note.
test('the composer warns a reply on a withdrawn ask, and only on a withdrawn ask', () => {
  const state = Asks.createAsksState();
  state.apply([
    post(1, 10, 'Lead', { ask: ask('Ana', 'I carry the questions over') }),
    post(2, 11, 'Lead', { ask: ask('Ana', 'I start a fresh list') }),
  ]);
  assert.equal(Asks.replyNote(state.ask(10)), null, 'an open ask gets no note');
  assert.equal(Asks.replyNote(null), null, 'a reference to no ask gets no note');
  state.apply([{ seq: 3, ts: 3_000, kind: 'withdraw', by: 'Lead', ask_id: 10 }]);
  assert.equal(state.ask(10).state, 'withdrawn', 'ARRANGEMENT: the first ask is withdrawn');
  assert.equal(Asks.replyNote(state.ask(10)),
    'Lead withdrew #10. Your reply still goes to Lead as discussion.');
  assert.equal(Asks.replyNote(state.ask(11)), null, 'the open ask beside it gets no note');
  state.apply([post(4, 12, 'Ana', { answers: [answer(11, 'yes', null, true, true)] })]);
  assert.equal(Asks.replyNote(state.ask(11)), null, 'an answered ask gets no note');

  // The page shows the note under the composer as she writes, from the ask
  // her reply names, and still sends the reply.
  assert.match(ROOM_HTML, /<p id="reply-note" class="mention-preview reply-note" aria-live="polite" hidden><\/p>/);
  const visibility = ROOM_JS.slice(ROOM_JS.indexOf('function updateBindVisibility'), ROOM_JS.indexOf('function askButton'));
  assert.match(visibility, /InterlockAsks\.replyNote\(/);
  assert.match(visibility, /replyNote\.hidden = /);
});
