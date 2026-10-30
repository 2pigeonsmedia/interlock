'use strict';

// The story of an ask: whose turn, discussion, revision, agreement and the
// done receipt, in both directions, and the one turn rule shared with the page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChatService } = require('../src/chat/service.js');
const { openStore } = require('../src/chat/store.js');
const { turnOf } = require('../src/web/ask_turn.js');

const ANA = '11111111-1111-4111-8111-111111111111';
const SCOUT = '22222222-2222-4222-8222-222222222222';
const BEA = '33333333-3333-4333-8333-333333333333';
const ROSTER = [
  { subject_id: ANA, name: 'Ana', kind: 'person', created_at: Date.now() },
  { subject_id: SCOUT, name: 'Scout', kind: 'seat', created_at: Date.now() },
  { subject_id: BEA, name: 'Bea', kind: 'person', created_at: Date.now() },
];
const person = (subject_id, name) => ({ subject_id, name, kind: 'person', product: null, product_provenance: null, client_message_id: null });
const ANA_ACTOR = person(ANA, 'Ana');
const BEA_ACTOR = person(BEA, 'Bea');
let n = 0;
const scout = () => ({ subject_id: SCOUT, name: 'Scout', kind: 'seat', product: 'Codex CLI',
  product_provenance: 'client-reported', client_message_id: `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, '0')}` });

function room() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-ask-turn-'));
  return createChatService({ store: openStore({ dataDir: dir }), participants: () => ROSTER });
}

async function story(chat, askId, viewer) {
  const open = await chat.openAsks(viewer.subject_id, viewer.name);
  const ask = open.addressed.concat(open.asked).find(row => row.ask_id === askId);
  return ask ? ask.turn : null;
}

test('the shared rule: whose turn, from the facts alone', () => {
  const base = { state: 'open', done: false, asker: 'Scout', addressee: 'Ana', addressee_kind: 'person', last_choice: null };
  assert.deepEqual(turnOf(Object.assign({}, base, { latest_party: 'asker' })), { phase: 'waiting', waiting_on: 'Ana', acting: null });
  assert.deepEqual(turnOf(Object.assign({}, base, { latest_party: 'addressee' })), { phase: 'waiting', waiting_on: 'Scout', acting: null });
  assert.deepEqual(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'yes', latest_party: 'addressee' })),
    { phase: 'agreed', waiting_on: null, acting: 'Scout' }, 'a person said yes to what the asker will do');
  assert.equal(turnOf(Object.assign({}, base, { addressee: 'Scout', asker: 'Ana', addressee_kind: 'seat', state: 'answered', last_choice: 'yes' })).acting,
    'Scout', 'an AI said yes to a request: the AI is on it');
  assert.equal(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'no' })).phase, 'declined');
  assert.equal(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'yes', done: true })).phase, 'done');
  assert.equal(turnOf(Object.assign({}, base, { state: 'withdrawn' })).phase, 'withdrawn');
});

test('the printer story, an AI asking a person: discuss, revise, agree, done', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order new printer rollers?' }, scout(),
    { ask: { of: 'Ana', means: 'I order the OEM rollers, $64' } });
  assert.equal((await story(chat, ask.id, ANA_ACTOR)).waiting_on, 'Ana');
  // She asks about an alternative instead of answering.
  await chat.appendAnnotated({ text: 're #1 @Scout what about the third-party ones?' }, ANA_ACTOR, { discusses: ask.id });
  let open = (await chat.openAsks(ANA, 'Ana')).addressed;
  assert.equal(open[0].turn.waiting_on, 'Scout', 'her reply passes the turn to Scout');
  assert.deepEqual([open[0].state, open[0].latest.kind, open[0].latest.party], ['open', 'discussion', 'addressee']);
  // Scout revises the ask in place.
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', ask.id, 'I order the third-party rollers, $21');
  open = (await chat.openAsks(ANA, 'Ana')).addressed;
  assert.equal(open[0].turn.waiting_on, 'Ana');
  assert.equal(open[0].means, 'I order the third-party rollers, $21');
  assert.deepEqual(open[0].revisions, [{ means: 'I order the OEM rollers, $64', revision: 1 }], 'the old scope, kept to show struck');
  // Her yes, then his done receipt.
  const yes = await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  let mine = (await chat.openAsks(SCOUT, 'Scout')).asked;
  assert.deepEqual(mine.map(row => [row.ask_id, row.turn.phase, row.turn.acting]), [[ask.id, 'agreed', 'Scout']],
    'agreed: Scout is on it, and it stays on his list');
  assert.deepEqual((await chat.openAsks(ANA, 'Ana')).addressed, [], 'and off hers');
  const rows = (await chat.readAnnotations({ after: 0, limit: 20 })).rows;
  assert.equal(rows.find(row => row.kind === 'post' && row.answers.length).answers[0].revision, 2, 'her yes is to revision 2');
  await chat.appendAnnotated({ text: 're #1 Ordered, arriving Friday' }, scout(), { discusses: ask.id, status: 'done', read_through: yes.id });
  const done = (await chat.readAnnotations({ after: 0, limit: 20 })).rows.slice(-1)[0];
  assert.deepEqual(done.discusses, { ask_id: ask.id, party: 'asker' });
  assert.deepEqual((await chat.openAsks(SCOUT, 'Scout')).asked, [], 'the receipt closes it');
});

test('the same story reversed, a person asking an AI', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Can you rerun the suite?' }, ANA_ACTOR, { ask: { of: 'Scout' } });
  assert.equal((await story(chat, ask.id, ANA_ACTOR)).waiting_on, 'Scout');
  await chat.appendAnnotated({ text: 're #1 which head?' }, scout(), { discusses: ask.id });
  assert.equal((await story(chat, ask.id, ANA_ACTOR)).waiting_on, 'Ana', 'his question passes the turn back to her');
  await chat.annotate({ subject_id: ANA, name: 'Ana' }, 'revise', ask.id, 'rerun at 5075314');
  assert.equal((await story(chat, ask.id, ANA_ACTOR)).waiting_on, 'Scout');
  const yes = await chat.appendAnnotated({ text: 'yes, running' }, scout(), { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  const his = (await chat.openAsks(SCOUT, 'Scout')).addressed;
  assert.deepEqual(his.map(row => [row.turn.phase, row.turn.acting]), [['agreed', 'Scout']], 'Scout is on it');
  assert.deepEqual((await chat.openAsks(ANA, 'Ana')).asked, [], 'off her list');
  await chat.appendAnnotated({ text: 're #1 rerun green' }, scout(), { discusses: ask.id, status: 'done', read_through: yes.id });
  assert.deepEqual((await chat.openAsks(SCOUT, 'Scout')).addressed, [], 'his receipt closes it');
});

test('a bystander\'s reply is in the story but never moves the turn', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order them' } });
  await chat.appendAnnotated({ text: 're #1 I would wait' }, BEA_ACTOR, { discusses: ask.id });
  const open = (await chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.equal(open.turn.waiting_on, 'Ana');
  assert.equal(open.latest.kind, 'ask');
});

test('a revision after a yes reopens the ask; the yes stays a yes to the old scope', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order the OEM rollers' } });
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.deepEqual((await chat.openAsks(ANA, 'Ana')).addressed, [], 'the arrangement: agreed');
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', ask.id, 'I order the OEM rollers and a drum');
  const open = (await chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.equal(open.state, 'open', 'reopened: her yes was not to this');
  assert.equal(open.turn.waiting_on, 'Ana');
  assert.deepEqual(open.answers.map(answer => [answer.choice, answer.revision]), [['yes', 1]]);
});

test('only the asker revises; a person\'s ask keeps its scope line; a reply cannot also answer', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order them' } });
  await assert.rejects(chat.annotate({ subject_id: ANA, name: 'Ana' }, 'revise', ask.id, 'x'), error => error.code === 'not-asker');
  await assert.rejects(chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', ask.id, null), error => error.code === 'means-required');
  await assert.rejects(chat.appendAnnotated({ text: 'yes but' }, ANA_ACTOR,
    { discusses: ask.id, answers: [{ ask_id: ask.id }] }), error => error.code === 'invalid-annotation');
  await assert.rejects(chat.appendAnnotated({ text: 're #9' }, ANA_ACTOR, { discusses: 99 }), error => error.code === 'ask-not-found');
});
