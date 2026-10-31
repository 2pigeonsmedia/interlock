'use strict';

// `interlock history --project`: a lens on what is printed. Messages stamped
// for another project are left out unless they address this AI; unstamped
// and whole-room messages always print; a footer counts what was left out.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { EXIT_OK, EXIT_USAGE, run } = require('../src/cli.js');

function message(id, text, delivery = []) {
  return { id, ts: id, byline: 'Scout', kind: 'seat', session: null, text,
    product: 'Codex CLI', product_provenance: 'client-reported', delivery };
}

function stamp(seq, messageId, project, reason = 'assignment') {
  return { seq, ts: seq, kind: 'stamp', by: 'Scout', message_id: messageId, project, reason, record_id: null };
}

const MESSAGES = [
  message(1, 'orchard work'),
  message(2, 'household work'),
  message(3, 'household, rang Lead', [{ name: 'Lead', session: null, acknowledged_at: 5 }]),
  message(4, 'household, asks Lead'),
  message(5, 'unstamped'),
  message(6, 'whole room'),
  message(7, 'household at first, re-stamped orchard'),
];

const ROWS = [
  stamp(1, 1, 'orchard'),
  stamp(2, 2, 'household'),
  stamp(3, 3, 'household'),
  { seq: 4, ts: 4, kind: 'post', by: 'Scout', message_id: 4,
    ask: { of: 'Lead', of_kind: 'seat', means: null, deliver: 'now', project: 'household' },
    answers: [], status: null, read_through: null, discusses: null },
  stamp(5, 4, 'household', 'ask'),
  stamp(6, 6, null, 'set'),
  stamp(7, 7, 'household'),
  stamp(8, 7, 'orchard', 'set'),
];

function world(rows = ROWS, messages = MESSAGES) {
  const profile = {
    schema: 2, name: 'Lead', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: crypto.randomUUID(), token: 'test-bearer-not-a-real-credential',
    selector: 'selectorselectorselecto', digest: 'a'.repeat(64), state: 'admitted',
    created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: Number.MAX_SAFE_INTEGER, cursor: 0,
  };
  const urls = [];
  const dependencies = {
    config: { resolveConnectionDir: () => '/unused' },
    profiles: {
      validName: () => true,
      openProfiles: () => ({
        load: () => Object.freeze(Object.assign({}, profile)),
        updateCursor(name, requestId, cursor) { profile.cursor = Math.max(profile.cursor, cursor); },
        acquireReadLease: () => ({ release() {} }),
      }),
    },
    fetch: async url => {
      const target = new URL(String(url));
      urls.push(target.pathname + target.search);
      const after = Number(target.searchParams.get('after'));
      let body;
      if (target.pathname === '/api/ai/annotations') {
        const limit = Number(target.searchParams.get('limit'));
        const page = rows.filter(row => row.seq > after).slice(0, limit);
        body = { ok: true, rows: page, cursor: page.length ? page[page.length - 1].seq : Math.min(after, rows.length), first_id: 1 };
      } else {
        const next = messages.find(row => row.id > after);
        body = { ok: true, messages: next ? [next] : [], cursor: next ? next.id : after, timed_out: false, connection_session: null };
      }
      return { ok: true, status: 200, json: async () => body };
    },
  };
  return { dependencies, urls, profile };
}

async function history(argv, rows, messages) {
  const w = world(rows, messages);
  let stdout = '';
  let stderr = '';
  const code = await run(['history', '--connection', 'Lead'].concat(argv),
    { stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } } }, w.dependencies);
  const printed = [...stdout.matchAll(/^\[(\d+)\] /gm)].map(match => Number(match[1]));
  return { code, stdout, stderr, printed, cursor: w.profile.cursor };
}

test('history --project prints that project, what addresses this AI and unstamped messages, with a footer', async () => {
  const all = await history(['--drain']);
  assert.equal(all.code, EXIT_OK, all.stderr);
  assert.deepEqual(all.printed, [1, 2, 3, 4, 5, 6, 7], 'ARRANGEMENT: without the lens every message prints');
  assert.ok(!/not shown/.test(all.stdout), 'and there is no footer');

  const lens = await history(['--drain', '--project', 'orchard']);
  assert.equal(lens.code, EXIT_OK, lens.stderr);
  assert.deepEqual(lens.printed, [1, 3, 4, 5, 6, 7],
    'household-only #2 is left out; #3 rang this AI, #4 asks it, #5 is unstamped, #6 is the whole room, #7 was re-stamped');
  assert.match(lens.stdout, /\n1 message stamped for other projects not shown\.\n$/);
  assert.equal(lens.cursor, all.cursor, 'the lens reads and moves the cursor exactly as the same history without it');

  const other = await history(['--drain', '--project', 'household']);
  assert.deepEqual(other.printed, [2, 3, 4, 5, 6]);
  assert.match(other.stdout, /\n2 messages stamped for other projects not shown\.\n$/);
});

test('history --project takes a project id and refuses --json and --skip-to-current', async () => {
  for (const argv of [['--project'], ['--project', 'Orchard'], ['--project', 'orchard', '--json'],
    ['--project', 'orchard', '--skip-to-current'], ['--project', 'a', '--project', 'b']]) {
    const result = await history(argv);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.stderr, /\[--project ID\]/);
  }
});

test('history --project against a side-car it cannot read shows everything and says so', async () => {
  const result = await history(['--drain', '--project', 'orchard'], [{ seq: 1, ts: 1, kind: 'stamp', by: 'Scout', message_id: 1 }]);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(result.printed, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(result.stdout, /Project stamps could not be read; every message is shown\.\n$/);
});

// Cold read F1: an answer (or a reply) is stamped with its ask's project, so an
// AI that asked in another project still sees what answers its own ask.
test('history --project shows answers and replies to this AI\'s own ask from another project', async () => {
  const post = (seq, messageId, by, fields) => Object.assign({ seq, ts: seq, kind: 'post', by, message_id: messageId,
    ask: null, answers: [], status: null, read_through: null, discusses: null }, fields);
  const messages = [
    message(1, 'Lead asks Ana, in household'),
    message(2, 'Ana answers it'),
    message(3, 're #1 Ana discusses it'),
    message(4, 'unrelated household'),
    message(5, 'Ana answers someone else\'s ask'),
    message(6, 'Wren asks Ana, in household'),
  ];
  const rows = [
    post(1, 1, 'Lead', { ask: { of: 'Ana', of_kind: 'person', means: 'm', deliver: 'now', project: 'household' } }),
    stamp(2, 1, 'household', 'ask'),
    post(3, 2, 'Ana', { answers: [{ ask_id: 1, choice: 'yes', crossed_by: null, by_addressee: true, closes: true, revision: 1 }] }),
    stamp(4, 2, 'household', 'ask'),
    post(5, 3, 'Ana', { discusses: { ask_id: 1, party: 'addressee' } }),
    stamp(6, 3, 'household', 'ask'),
    stamp(7, 4, 'household', 'assignment'),
    post(8, 6, 'Wren', { ask: { of: 'Ana', of_kind: 'person', means: 'm', deliver: 'now', project: 'household' } }),
    stamp(9, 6, 'household', 'ask'),
    post(10, 5, 'Ana', { answers: [{ ask_id: 6, choice: 'yes', crossed_by: null, by_addressee: true, closes: true, revision: 1 }] }),
    stamp(11, 5, 'household', 'ask'),
  ];
  const all = await history(['--drain'], rows, messages);
  assert.deepEqual(all.printed, [1, 2, 3, 4, 5, 6], 'ARRANGEMENT: without the lens every message prints');
  const lens = await history(['--drain', '--project', 'orchard'], rows, messages);
  assert.equal(lens.code, EXIT_OK, lens.stderr);
  assert.deepEqual(lens.printed, [2, 3],
    'the answer and the reply to Lead\'s own ask print; the ask itself, an unrelated message and an answer to Wren\'s ask do not');
  assert.match(lens.stdout, /\n4 messages stamped for other projects not shown\.\n$/);
});

test('history --project still shows replies to this AI\'s own ask carried across a clear', async () => {
  const messages = [message(40, 'Ana answers the carried ask'), message(41, 'unrelated household')];
  const rows = [
    { seq: 1, ts: 1, kind: 'carry', by: 'Lead', ask_id: 12, archive_id: 'transcript-x', asked_at: 1,
      ask: { of: 'Ana', of_kind: 'person', means: 'm', deliver: 'now', project: 'household' }, kept_open: false },
    { seq: 2, ts: 2, kind: 'post', by: 'Ana', message_id: 40, ask: null, status: null, read_through: null, discusses: null,
      answers: [{ ask_id: 12, choice: 'yes', crossed_by: null, by_addressee: true, closes: true, revision: 1 }] },
    stamp(3, 40, 'household', 'ask'),
    stamp(4, 41, 'household', 'assignment'),
  ];
  const lens = await history(['--drain', '--project', 'orchard'], rows, messages);
  assert.equal(lens.code, EXIT_OK, lens.stderr);
  assert.deepEqual(lens.printed, [40], 'the answer to Lead\'s carried ask prints; the unrelated message does not');
});
