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
  const base = { state: 'open', done: false, approval: true, asker: 'Scout', addressee: 'Ana', addressee_kind: 'person', last_choice: null };
  assert.deepEqual(turnOf(Object.assign({}, base, { latest_party: 'asker' })), { phase: 'waiting', waiting_on: 'Ana', acting: null });
  assert.deepEqual(turnOf(Object.assign({}, base, { latest_party: 'addressee' })), { phase: 'waiting', waiting_on: 'Scout', acting: null });
  assert.deepEqual(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'yes', latest_party: 'addressee' })),
    { phase: 'agreed', waiting_on: null, acting: 'Scout' }, 'approved: the asker does the work');
  assert.equal(turnOf(Object.assign({}, base, { addressee: 'Scout', asker: 'Ana', addressee_kind: 'seat', state: 'answered', last_choice: 'yes' })).acting,
    'Ana', 'approved by an AI: still the asker who does the work');
  assert.deepEqual(turnOf(Object.assign({}, base, { approval: false, state: 'answered', last_choice: 'yes' })),
    { phase: 'answered', waiting_on: null, acting: null }, 'a plain ask answered yes is answered: a question is just a question');
  assert.equal(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'no' })).phase, 'declined');
  assert.equal(turnOf(Object.assign({}, base, { state: 'answered', last_choice: 'yes', done: true })).phase, 'done');
  assert.equal(turnOf(Object.assign({}, base, { state: 'withdrawn' })).phase, 'withdrawn');
});

test('the printer story, an AI asking a person: discuss, revise, agree, done', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order new printer rollers?' }, scout(),
    { ask: { of: 'Ana', means: 'I order the OEM rollers, $64' } });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id);
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
  const yes = await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 2 }] });
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
  await chat.appendAnnotated({ text: 'yes, running' }, scout(), { answers: [{ ask_id: ask.id, choice: 'yes', revision: 2 }] });
  // A plain ask: his yes answers it, and it leaves both lists. Nobody is "on it".
  assert.deepEqual((await chat.openAsks(SCOUT, 'Scout')).addressed, [], 'off his list');
  assert.deepEqual((await chat.openAsks(ANA, 'Ana')).asked, [], 'off hers');
  const answered = (await chat.readAnnotations({ after: 0, limit: 20 })).rows.find(row => row.kind === 'post' && row.answers.length);
  assert.deepEqual(answered.answers.map(answer => [answer.choice, answer.closes]), [['yes', true]]);
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

test('a yes binds only to the revision its author saw: an answer to an earlier one is refused', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order the OEM rollers' } });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id);
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', ask.id, 'I order the third-party rollers from eBay');
  assert.equal((await chat.openAsks(ANA, 'Ana')).addressed[0].revision, 2, 'the arrangement: revision 2 is current');
  // Her screen still showed revision 1 when she tapped Yes.
  await assert.rejects(chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 1 }] }),
    error => error.code === 'ask-revised');
  // A client that names no revision answers the first, so it is refused too.
  await assert.rejects(chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes' }] }),
    error => error.code === 'ask-revised');
  await assert.rejects(chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 3 }] }),
    error => error.code === 'ask-revised', 'nor a revision that does not exist yet');
  const open = (await chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.deepEqual([open.state, open.answers.length, open.turn.phase], ['open', 0, 'waiting'], 'nothing was recorded');
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes', revision: 2 }] });
  const agreed = (await chat.openAsks(SCOUT, 'Scout')).asked[0];
  assert.deepEqual([agreed.turn.phase, agreed.answers[0].revision], ['agreed', 2]);
});

test('a first-revision ask still takes an answer that names no revision', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order them' } });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id);
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.equal((await chat.openAsks(SCOUT, 'Scout')).asked[0].turn.phase, 'agreed');
});

test('only an explicit yes is agreement: a typed answer with no choice is answered, nobody is on it', async () => {
  const base = { state: 'answered', done: false, asker: 'Scout', addressee: 'Ana', addressee_kind: 'person', latest_party: 'addressee' };
  assert.deepEqual(turnOf(Object.assign({}, base, { last_choice: null })), { phase: 'answered', waiting_on: null, acting: null });
  assert.deepEqual(turnOf(Object.assign({}, base, { addressee_kind: 'seat', last_choice: null })),
    { phase: 'answered', waiting_on: null, acting: null }, 'the same when an AI was asked');
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Delete the staging bucket?' }, scout(), { ask: { of: 'Ana', means: 'I delete the staging bucket' } });
  await chat.appendAnnotated({ text: 'No. Absolutely not.' }, ANA_ACTOR, { answers: [{ ask_id: ask.id }] });
  assert.deepEqual((await chat.openAsks(SCOUT, 'Scout')).asked, [], 'not on Scout\'s list as his to carry out');
  const row = (await chat.readAnnotations({ after: 0, limit: 10 })).rows.find(entry => entry.answers && entry.answers.length);
  assert.equal(row.answers[0].choice, null, 'the arrangement: the answer carried no choice');
});

test('a done receipt lands only on an agreed ask: after a no, or a typed answer, it is a reply', async () => {
  const chat = room();
  const declined = await chat.appendAnnotated({ text: 'Restart the router?' }, scout(), { ask: { of: 'Ana', means: 'I restart the router' } });
  const no = await chat.appendAnnotated({ text: 'no' }, ANA_ACTOR, { answers: [{ ask_id: declined.id, choice: 'no' }] });
  await chat.appendAnnotated({ text: 're #1 Router restarted' }, scout(), { discusses: declined.id, status: 'done', read_through: no.id });
  const typed = await chat.appendAnnotated({ text: 'Wipe the disk?' }, scout(), { ask: { of: 'Ana', means: 'I wipe the disk' } });
  const words = await chat.appendAnnotated({ text: 'hmm, not sure' }, ANA_ACTOR, { answers: [{ ask_id: typed.id }] });
  await chat.appendAnnotated({ text: 're #4 Wiped' }, scout(), { discusses: typed.id, status: 'done', read_through: words.id });
  // A revise is refused only once an ask is done; here both still take one.
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', declined.id, 'I restart the router tonight');
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', typed.id, 'I wipe the old disk only');
  const open = (await chat.openAsks(ANA, 'Ana')).addressed;
  assert.deepEqual(open.map(ask => [ask.ask_id, ask.done, ask.turn.phase]), [[declined.id, null, 'waiting'], [typed.id, null, 'waiting']]);
});

test('the page lists exactly what the server lists, for every party, by the one shared rule', async () => {
  const Asks = require('../src/web/asks_model.js');
  const chat = room();
  const ofAna = means => chat.appendAnnotated({ text: means }, scout(), { ask: { of: 'Ana', means } });
  const agreed = await ofAna('I order rollers');
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', agreed.id);
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: agreed.id, choice: 'yes' }] });
  const declined = await ofAna('I restart the router');
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', declined.id);
  await chat.appendAnnotated({ text: 'no' }, ANA_ACTOR, { answers: [{ ask_id: declined.id, choice: 'no' }] });
  const typed = await ofAna('I wipe the disk');
  await chat.appendAnnotated({ text: 'hmm' }, ANA_ACTOR, { answers: [{ ask_id: typed.id }] });
  const waiting = await ofAna('I buy grit');
  const ofScout = await chat.appendAnnotated({ text: 'Rerun?' }, ANA_ACTOR, { ask: { of: 'Scout' } });
  await chat.appendAnnotated({ text: 'yes' }, scout(), { answers: [{ ask_id: ofScout.id, choice: 'yes' }] });
  const page = Asks.createAsksState();
  page.apply((await chat.readAnnotations({ after: 0, limit: 50 })).rows);
  const view = list => list.map(ask => [ask.ask_id, ask.turn.phase]);
  const server = {
    Ana: await chat.openAsks(ANA, 'Ana'), Scout: await chat.openAsks(SCOUT, 'Scout'), Bea: await chat.openAsks(BEA, 'Bea'),
  };
  assert.deepEqual(view(server.Ana.addressed), [[waiting.id, 'waiting']],
    'the arrangement: her agreed ask is Scout\'s to carry out, not hers');
  assert.deepEqual(view(server.Scout.asked), [[agreed.id, 'agreed'], [waiting.id, 'waiting']]);
  assert.deepEqual(view(server.Scout.addressed), [], 'a plain ask he answered is off his list');
  for (const name of ['Ana', 'Scout', 'Bea']) {
    const mine = page.openFor(name);
    assert.deepEqual([view(mine.addressed), view(mine.asked)], [view(server[name].addressed), view(server[name].asked)], name);
  }
  assert.ok(declined && typed, 'declined and answered asks are on nobody\'s list, on either side');
});

test('an answer or a reply to an ask rings the AI that asked it, @ or not', async () => {
  const chat = room();
  const rung = message => message.recipients.map(recipient => recipient.name);
  const ofAna = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order them' } });
  const reply = await chat.appendAnnotated({ text: 'which ones?' }, ANA_ACTOR, { discusses: ofAna.id });
  assert.deepEqual(rung(reply), ['Scout'], 'her reply passes the turn to Scout, and rings him');
  const yes = await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ofAna.id, choice: 'yes' }] });
  assert.deepEqual(rung(yes), ['Scout'], 'her yes, with no @, rings the AI who is now on it');
  const bystander = await chat.appendAnnotated({ text: 'I would wait' }, BEA_ACTOR, { discusses: ofAna.id });
  assert.deepEqual(rung(bystander), ['Scout'], 'anyone\'s reply on his ask reaches him');
  const plain = await chat.append({ text: 'nice weather' }, ANA_ACTOR);
  assert.deepEqual(rung(plain), [], 'the control: a plain message rings nobody');
  // The other way: a person asks an AI. People are not rung; the AI's answer
  // turns her Needs-you card instead, and rings nobody.
  const ofScout = await chat.appendAnnotated({ text: 'Rerun?' }, ANA_ACTOR, { ask: { of: 'Scout' } });
  const back = await chat.appendAnnotated({ text: 'which head?' }, scout(), { discusses: ofScout.id });
  assert.deepEqual(rung(back), [], 'a person who asked is told by her list, not rung');
  assert.equal((await story(chat, ofScout.id, ANA_ACTOR)).waiting_on, 'Ana', 'her turn, on her list');
  const his = await chat.appendAnnotated({ text: 'yes' }, scout(), { answers: [{ ask_id: ofScout.id, choice: 'yes' }] });
  assert.deepEqual(rung(his), []);
});

test('an AI\'s answer rings the AI that asked it', async () => {
  const LEAD = '44444444-4444-4444-8444-444444444444';
  const roster = ROSTER.concat([{ subject_id: LEAD, name: 'Lead', kind: 'seat', created_at: Date.now() }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-ask-turn-'));
  const chat = createChatService({ store: openStore({ dataDir: dir }), participants: () => roster });
  const lead = { subject_id: LEAD, name: 'Lead', kind: 'seat', product: 'Codex CLI', product_provenance: 'client-reported',
    client_message_id: 'eeeeeeee-eeee-4eee-8eee-000000000001' };
  const ask = await chat.appendAnnotated({ text: 'Rerun the suite?' }, lead, { ask: { of: 'Scout' } });
  const yes = await chat.appendAnnotated({ text: 'yes, running' }, scout(), { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.deepEqual(yes.recipients.map(recipient => recipient.name), ['Lead']);
  const own = await chat.appendAnnotated({ text: 're: also the docs' },
    Object.assign({}, lead, { client_message_id: 'eeeeeeee-eeee-4eee-8eee-000000000002' }), { discusses: ask.id });
  assert.equal(own.recipients.some(recipient => recipient.name === 'Lead'), false, 'an asker\'s own reply never rings itself');
});

test('a request for approval: words never approve, and an ask already answered can never become one', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Order rollers?' }, scout(), { ask: { of: 'Ana', means: 'I order two rollers' } });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id);
  await assert.rejects(chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id), error => error.code === 'ask-not-open', 'once');
  await assert.rejects(chat.annotate({ subject_id: ANA, name: 'Ana' }, 'approval', ask.id), error => error.code === 'not-asker');
  await chat.appendAnnotated({ text: 'sounds fine' }, ANA_ACTOR, { answers: [{ ask_id: ask.id }] });
  let open = (await chat.openAsks(ANA, 'Ana')).addressed[0];
  assert.deepEqual([open.state, open.approval, open.turn.phase], ['open', true, 'waiting'], 'her words did not approve it');
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'yes' }] });
  assert.deepEqual((await chat.openAsks(SCOUT, 'Scout')).asked.map(row => row.turn.phase), ['agreed'], 'her explicit yes did');
  // A plain question she already answered yes to can never be turned into an approval afterwards.
  const plain = await chat.appendAnnotated({ text: 'Grit?' }, scout(), { ask: { of: 'Ana', means: 'I buy grit' } });
  await chat.appendAnnotated({ text: 'yes' }, ANA_ACTOR, { answers: [{ ask_id: plain.id, choice: 'yes' }] });
  await assert.rejects(chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', plain.id), error => error.code === 'ask-not-open');
  open = (await chat.readAnnotations({ after: 0, limit: 50 })).rows.filter(row => row.kind === 'approval');
  assert.deepEqual(open.map(row => row.ask_id), [ask.id]);
});

test('right after a clear, a live write cannot re-mark a carried answered ask as an approval', async () => {
  const { createAskIndex, parseRow } = require('../src/chat/annotations.js');
  const index = createAskIndex(10);
  const carried = parseRow({
    v: 1, seq: 1, ts: 5, kind: 'carry', subject_id: SCOUT, name: 'Scout', ask_id: 3,
    archive_id: 'transcript-20261030T000000000Z-11111111-1111-4111-8111-111111111111', asked_at: 1,
    ask: { of_subject_id: ANA, of_name: 'Ana', of_kind: 'person', means: 'm', deliver: 'now', project: 'ops' },
    era_first_id: 10, kept_open: false,
  }, 1);
  assert.equal(index.replay(carried, undefined), true);
  index.asks.get(3).answers.push({ choice: 'yes', by_addressee: true, revision: 1 });
  index.asks.get(3).state = 'answered';
  assert.equal(index.checkLifecycle('approval', 3, SCOUT, false), null, 'the arrangement: a replayed carry block may re-mark it');
  assert.equal(index.checkLifecycle('approval', 3, SCOUT, true), 'ask-not-open', 'a live write may not');
});

test('a declined request for approval stays declined: no revise reopens it', async () => {
  const chat = room();
  const ask = await chat.appendAnnotated({ text: 'Approve?' }, scout(), { ask: { of: 'Ana', means: 'I wipe the archive' } });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'approval', ask.id);
  await chat.appendAnnotated({ text: 'no' }, ANA_ACTOR, { answers: [{ ask_id: ask.id, choice: 'no' }] });
  await assert.rejects(chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', ask.id, 'I wipe half the archive'),
    error => error.code === 'ask-not-open');
  const plain = await chat.appendAnnotated({ text: 'Which?' }, scout(), { ask: { of: 'Ana', means: 'x' } });
  await chat.appendAnnotated({ text: 'no' }, ANA_ACTOR, { answers: [{ ask_id: plain.id, choice: 'no' }] });
  await chat.annotate({ subject_id: SCOUT, name: 'Scout' }, 'revise', plain.id, 'y');
  assert.equal((await chat.openAsks(ANA, 'Ana')).addressed[0].ask_id, plain.id, 'the control: a plain ask still reopens on a revise');
});
