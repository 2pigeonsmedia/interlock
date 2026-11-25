'use strict';

// After a plain post, `say` hints when the post reads as a decision: as a
// question for one name, "send it as an ask"; to someone whose ask to you is
// still open, "use --answers so it closes". Hints only, never with --json,
// never on a post that already asks, answers or discusses.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../src/cli.js');

function connection(overrides = {}) {
  const profile = Object.assign({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential', selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1',
    expires_at: Date.now() + 60 * 60 * 1000, cursor: 0,
  }, overrides);
  const profiles = {
    load: () => Object.freeze(Object.assign({}, profile)),
    updateCursor() {},
    acquireReadLease() { return { release() {} }; },
  };
  return {
    clock: () => Date.now(),
    config: { resolveConnectionDir: () => path.join(os.tmpdir(), 'interlock-cli-ask-hints') },
    joinedTailMarks: { has: () => true, add() {} },
    profiles: { validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value), openProfiles: () => profiles },
    doorbellStateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-ask-hints-')),
  };
}

async function cli(argv, dependencies) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stdout, stderr };
}

// A real fetch Response, so the CLI reads its headers and body as it would
// read the network's.
function answer(status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // Bytes, not a string, when no type is wanted: a string body gets text/plain.
  return new Response(type === null ? new TextEncoder().encode(text) : text,
    { status, headers: type === null ? {} : { 'content-type': type } });
}

function sent(text, delivery) {
  return answer(201, { ok: true, message: {
    id: 41, ts: 10, byline: 'Marlow', kind: 'seat', session: null, text,
    product: 'Codex CLI', product_provenance: 'client-reported', delivery,
  } });
}

async function say(text, delivery, extra = []) {
  const dependencies = connection();
  dependencies.readFile = () => text;
  dependencies.fetch = async () => sent(text, delivery);
  return cli(['say', '--connection', 'Marlow', '--file', 'm.md', ...extra], dependencies);
}


// The room: the post's receipt, and the open asks of the author.
function room(text, asks = []) {
  const dependencies = connection();
  dependencies.readFile = () => text;
  dependencies.calls = [];
  dependencies.fetch = async (url, init = {}) => {
    const route = new URL(String(url)).pathname;
    dependencies.calls.push(route);
    if (route === '/api/ai/asks') return answer(200, { ok: true, addressed: asks, asked: [] });
    return sent(text, []);
  };
  return dependencies;
}

function openAsk(id, by) {
  return {
    ask_id: id, asked_at: 1, by, of: 'Marlow', of_kind: 'seat', means: null, deliver: 'now', project: 'ops',
    state: 'open', kept_open: false, approval: false, carried_from: null, answers: [], revision: 1, revisions: [],
    latest: { message_id: id, kind: 'ask', party: 'asker', by, at: 1 }, done: null,
    turn: { phase: 'waiting', waiting_on: 'Marlow', acting: null },
  };
}

const ASK_HINT = 'Hint: this reads as a question for Lead; a decision sent as an ask (--asks-of Lead) is tracked in Needs you.';

test('a plain post that asks one name a question gets the ask hint after the Rang line', async () => {
  const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'], room('@Lead is the retry fix in scope?'));
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.stdout.trim().split('\n'), ['Sent as Marlow (message 41). Rang no AI.', ASK_HINT]);
});

test('a status post gets no hint', async () => {
  const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'], room('@Lead ready: suite green.'));
  assert.equal(done.stdout.trim(), 'Sent as Marlow (message 41). Rang no AI.');
});

test('to someone whose ask to you is open, the hint is to answer it, so it closes', async () => {
  const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'],
    room('@Lead yes, go ahead.', [openAsk(7, 'Lead'), openAsk(9, 'Pip')]));
  assert.deepEqual(done.stdout.trim().split('\n'),
    ['Sent as Marlow (message 41). Rang no AI.', 'Answering ask 7? Use --answers 7 so it closes.']);
});

test('the answer hint wins over the ask hint when both could apply', async () => {
  const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'],
    room('@Lead should I do both?', [openAsk(7, 'Lead')]));
  assert.deepEqual(done.stdout.trim().split('\n').slice(1), ['Answering ask 7? Use --answers 7 so it closes.']);
});

test('no hint with --json, and none on a post that already asks, answers or discusses', async () => {
  const json = await cli(['say', '--connection', 'Marlow', '--file', 'm.md', '--json'], room('@Lead in scope?', [openAsk(7, 'Lead')]));
  assert.doesNotMatch(json.stdout, /Hint|Answering ask/);
  for (const extra of [['--asks-of', 'Lead'], ['--answers', '7', '--choice', 'yes'], ['--discusses', '7']]) {
    const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md', ...extra], room('@Lead in scope?', [openAsk(7, 'Lead')]));
    assert.doesNotMatch(done.stdout, /Hint:|Answering ask/, extra.join(' '));
  }
});

test('a post that names nobody never asks the room for asks; a failed read gives no hint and the post stands', async () => {
  const plain = room('all done here?');
  const done = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'], plain);
  assert.equal(done.stdout.trim(), 'Sent as Marlow (message 41). Rang no AI.');
  assert.equal(plain.calls.includes('/api/ai/asks'), false);
  const failing = room('@Lead yes?');
  const fetchPost = failing.fetch;
  failing.fetch = async (url, init) => (new URL(String(url)).pathname === '/api/ai/asks'
    ? answer(503, { ok: false, error: 'unavailable' }) : fetchPost(url, init));
  const failed = await cli(['say', '--connection', 'Marlow', '--file', 'm.md'], failing);
  assert.equal(failed.code, 0);
  assert.match(failed.stdout, /^Sent as Marlow \(message 41\)\. Rang no AI\.\nHint: this reads as a question for Lead/);
});
