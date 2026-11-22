'use strict';

// What the command line says when the room answers: whom a post rang, why a
// command was refused (and whether the room or something in front of it
// answered), what a work refusal needs, and why a connection stopped.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, EXIT_UNREACHABLE, run, workFileHelp } = require('../src/cli.js');

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
    config: { resolveConnectionDir: () => path.join(os.tmpdir(), 'interlock-cli-refusal-words') },
    joinedTailMarks: { has: () => true, add() {} },
    profiles: { validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value), openProfiles: () => profiles },
    doorbellStateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-refusal-words-')),
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

const ring = (name, session = null) => ({ name, session, acknowledged_at: null });

test('say names whom the post rang, from the room\'s own delivery list', async () => {
  const nobody = await say('a note to the room', []);
  assert.equal(nobody.code, EXIT_OK, nobody.stderr);
  assert.equal(nobody.stdout, 'Sent as Marlow (message 41). Rang no AI.\n');

  const two = await say('@Ana @Bea look', [ring('Ana'), ring('Bea', 2)]);
  assert.equal(two.stdout, 'Sent as Marlow (message 41). Rang: Ana, Bea (Session 2).\n');

  // A post that names only a person rings no AI; the person is still notified.
  const person = await say('@Rowan have a look', []);
  assert.equal(person.stdout, 'Sent as Marlow (message 41). Rang no AI.\n');

  // A reply rings the AI that addressed the author, untagged: the line says
  // so, because it reads the room's list, not the text.
  const reply = await say('thanks, done', [ring('Ana')]);
  assert.match(reply.stdout, /^Sent as Marlow \(message 41\)\. Rang: Ana\.$/m);
});

test('say with the all-seats tag says how many it rang', async () => {
  const all = await say('@all stand up', [ring('Ana'), ring('Bea'), ring('Cy')]);
  assert.equal(all.stdout, 'Sent as Marlow (message 41). Rang 3 (all-seats tag): Ana, Bea, Cy.\n');
  // The line never carries the tag itself, so pasting it cannot broadcast.
  assert.doesNotMatch(all.stdout, /@all/);
  // An address that merely contains "all" is not the tag.
  const mail = await say('see me@all.example', [ring('Ana')]);
  assert.match(mail.stdout, /^Sent as Marlow \(message 41\)\. Rang: Ana\.$/m);
});

test('say --json is the room\'s receipt, unchanged', async () => {
  const json = await say('@Ana look', [ring('Ana')], ['--json']);
  assert.equal(json.code, EXIT_OK, json.stderr);
  const lines = json.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, json.stdout);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['ok', 'message']);
});

async function doorbell(fetch, serverUrl = 'https://app.example.test') {
  const dependencies = connection({ server_url: serverUrl });
  dependencies.fetch = fetch;
  return cli(['doorbell', '--connection', 'Marlow', '--json'], dependencies);
}

test('a refusal by the room gives its HTTP status and error code', async () => {
  const refused = await doorbell(async () => answer(400, { ok: false, error: 'invalid-ring-query' }));
  assert.equal(refused.code, EXIT_RUNTIME);
  assert.equal(refused.stderr,
    'interlock: the Interlock room at https://app.example.test refused the command (HTTP 400 invalid-ring-query).\n');
  assert.deepEqual(JSON.parse(refused.stdout), {
    ok: false, error: 'refused', status: 400, code: 'invalid-ring-query',
    content_type: 'application/json', body_snippet: null,
  });
});

test('an answer that is not the room\'s says so, with its type and first bytes', async () => {
  const page = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>' + 'x'.repeat(400) + '</body></html>';
  const edge = await doorbell(async () => answer(200, page, 'text/html; charset=UTF-8'));
  assert.equal(edge.code, EXIT_RUNTIME);
  assert.match(edge.stderr, /^interlock: the room's address \(https:\/\/app\.example\.test\) answered with a non-Interlock page \(HTTP 200, content-type text\/html; charset=UTF-8\); the room itself may be fine\. It began: "<!DOCTYPE html><html><head><title>Just a moment\.\.\.<\/title>/);
  assert.doesNotMatch(edge.stderr, /refused the command/);
  const facts = JSON.parse(edge.stdout);
  assert.deepEqual([facts.ok, facts.error, facts.status, facts.code, facts.content_type],
    [false, 'not-interlock', 200, null, 'text/html; charset=UTF-8']);
  assert.equal(Buffer.byteLength(facts.body_snippet), 120, 'the first 120 bytes, no more');
  assert.equal(page.startsWith(facts.body_snippet), true);

  const forbidden = await doorbell(async () => answer(403, 'error code: 1020', 'text/plain'));
  assert.match(forbidden.stderr, /non-Interlock page \(HTTP 403, content-type text\/plain\); the room itself may be fine\. It began: "error code: 1020"\./);

  const bare = await doorbell(async () => answer(200, '', null));
  assert.match(bare.stderr, /non-Interlock page \(HTTP 200, no content-type\); the room itself may be fine\.\n$/);
  assert.equal(JSON.parse(bare.stdout).body_snippet, '');
});

function lookupFailure(code) {
  const cause = Object.assign(new Error(`getaddrinfo ${code} app.example.test`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

test('a failed name lookup is this computer\'s DNS, not the room', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    const failed = await doorbell(async () => { throw lookupFailure(code); });
    assert.equal(failed.code, EXIT_UNREACHABLE, code);
    // The same line the doorbell's give-up reads (doorbell.give_up.test.js).
    assert.equal(failed.stderr,
      'interlock: this computer could not look up app.example.test; the room may be fine. Check this computer\'s DNS.\n', code);
    assert.equal(JSON.parse(failed.stdout).error, 'lookup-failed', code);
  }
});

test('an unreachable hosted room is not blamed on this computer; a local one still is', async () => {
  const hosted = await doorbell(async () => answer(530, '<html>tunnel</html>', 'text/html'));
  assert.equal(hosted.code, EXIT_UNREACHABLE);
  assert.equal(hosted.stderr,
    'interlock: could not reach https://app.example.test (HTTP 530); the room or the network to it is down.\n');
  const refusedHosted = await doorbell(async () => { throw lookupFailure('ECONNREFUSED'); });
  assert.equal(refusedHosted.stderr,
    'interlock: could not reach https://app.example.test; the room or the network to it is down.\n');
  const local = await doorbell(async () => { throw lookupFailure('ECONNREFUSED'); }, 'http://localhost:8788');
  assert.equal(local.stderr, 'interlock: could not reach http://localhost:8788; make sure Interlock is running.\n');
});

test('a non-UUID operation_id is refused with the sentence that fixes it', async () => {
  const dependencies = connection();
  dependencies.readFile = () => JSON.stringify({ operation_id: 'update-1', expected_revision: 2, note: 'n' });
  dependencies.fetch = async () => answer(400, { ok: false, error: 'invalid-operation' });
  const refused = await cli(['work', 'update', 'W-1', '--connection', 'Marlow', '--file', 'w.json'], dependencies);
  assert.equal(refused.code, EXIT_RUNTIME);
  assert.match(refused.stderr, /refused the command: invalid-operation\. operation_id must be a UUID v4\. Leave it out of the file and interlock writes one \(and prints it, for a retry\)\./);
});

test('each work verb\'s help names the fields its file takes and one example file', async () => {
  for (const verb of ['create', 'update', 'move', 'evidence', 'note', 'share', 'answer', 'report-answer',
    'confirm', 'reopen', 'revise', 'withdraw', 'project-update', 'ask-approval']) {
    const help = await cli(['work', verb, '--help'], {});
    assert.equal(help.code, EXIT_OK, verb);
    assert.match(help.stdout, new RegExp(`^ {6}The file for ${verb} takes: .+\\.$`, 'm'), verb);
    const example = /^ {6}Example file: (.+)$/m.exec(help.stdout);
    assert.ok(example, `${verb}: an example file`);
    const parsed = JSON.parse(example[1]);
    assert.equal(typeof parsed, 'object', verb);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'operation_id'), false, `${verb}: interlock writes the operation id`);
    assert.equal(help.stdout.includes(workFileHelp(verb)), true, verb);
  }
  // The evidence fields that work, as a lead found them.
  const evidence = await cli(['work', 'evidence', '--help'], {});
  for (const field of ['target', 'observed', 'limits', 'reference']) {
    assert.match(evidence.stdout, new RegExp(`Example file: .*"${field}"`), field);
  }
  const list = await cli(['work', 'list', '--help'], {});
  assert.doesNotMatch(list.stdout, /The file for/, 'a verb without a file says nothing about one');
});

async function status(dependencies) {
  dependencies.fetch = async target => {
    if (target.endsWith('/api/ai/presence-kind') || target.endsWith('/api/ai/session') ||
        target.endsWith('/api/ai/last-answered')) return answer(401, { ok: false, error: 'invalid-connection' });
    throw new Error('unexpected ' + target);
  };
  return cli(['status', '--connection', 'Marlow'], dependencies);
}

test('a connection the room stopped accepting is not said to have left', async () => {
  const stopped = await status(connection());
  assert.equal(stopped.code, EXIT_RUNTIME);
  assert.match(stopped.stdout, /^Admitted: no — the room released this connection after 24 h without a check-in \(its computer may have restarted or its session closed\), or the owner removed it in Settings; rejoin with `interlock join`\.$/m);
  assert.doesNotMatch(stopped.stdout, /\bleft\b|\bended\b/);
});

test('a body that echoes the request never shows the connection\'s credential', async () => {
  const token = 'test-bearer-not-a-real-credential';
  const [selector, secret] = ['selectorhalfnotreal01', 'secrethalfnotreal0123456789'];
  const split = `${selector}.${secret}`;
  const pages = [
    // A proxy that reflects the request headers.
    ['echoed header', `GET /api/ai/rings HTTP/1.1\nauthorization: Bearer ${token}\nx-interlock-client: 0.4.7\n`, token],
    // The token begins inside the shown bytes and runs past the cut.
    ['token across the cut', 'x'.repeat(100) + token + 'tail', token],
    // Anything after "Bearer ", whatever it is.
    ['another bearer', 'Authorization: Bearer some-other-value-entirely and more', 'some-other-value-entirely'],
    // Either half of the credential on its own.
    ['secret half', `seen: ${secret} end`, secret, split],
    ['selector half', `seen: ${selector} end`, selector, split],
  ];
  for (const [label, page, hidden, profileToken = token] of pages) {
    assert.ok(Buffer.from(page).indexOf(hidden) < 120, `ARRANGEMENT ${label}: the secret starts inside the shown bytes`);
    const dependencies = connection({ server_url: 'https://app.example.test', token: profileToken });
    dependencies.fetch = async () => answer(200, page, 'text/plain');
    const result = await cli(['doorbell', '--connection', 'Marlow', '--json'], dependencies);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.error, 'not-interlock', `ARRANGEMENT ${label}: the page was read as a non-Interlock answer`);
    assert.match(facts.body_snippet, /\[redacted\]/, label);
    for (const output of [result.stderr, facts.body_snippet]) {
      assert.equal(output.includes(hidden), false, `${label}: ${output}`);
      // No piece of it long enough to be useful survives the cut either.
      assert.equal(output.includes(hidden.slice(0, 10)), false, `${label}: a prefix leaked: ${output}`);
    }
  }
  // Control: a page with no credential is shown as it came.
  const plain = connection({ server_url: 'https://app.example.test' });
  plain.fetch = async () => answer(200, 'plain page, nothing secret', 'text/plain');
  const shown = JSON.parse((await cli(['doorbell', '--connection', 'Marlow', '--json'], plain)).stdout);
  assert.equal(shown.body_snippet, 'plain page, nothing secret');
});
