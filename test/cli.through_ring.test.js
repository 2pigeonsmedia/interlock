'use strict';

// A message the seat read with the command its ring names is read: a fresh
// doorbell polling from a cursor older than it does not ring it again. The
// owner's live case: a host stopped the adapter between its nudge and its
// cursor save, the seat ran `history --through N`, and the next adapter,
// started from the old cursor, rang N a second time. In a real room.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');
const room = require('./helpers/room_server.js');

// A connection the CLI loads by name; the cursor moves like the real profile's.
function connection(runtime, seat) {
  const profile = {
    schema: 2, name: seat.name, product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: runtime.url, request_id: crypto.randomUUID(), token: seat.token,
    selector: 'selectorselectorselecto', digest: 'a'.repeat(64), state: 'admitted',
    created_at: 1, admitted_at: 2, subject_id: 'unused', expires_at: Number.MAX_SAFE_INTEGER, cursor: 0,
  };
  return {
    profile,
    dependencies: {
      config: { resolveConnectionDir: () => '/unused' },
      profiles: {
        validName: value => value === seat.name,
        openProfiles: () => ({
          load: () => Object.freeze(Object.assign({}, profile)),
          updateCursor(name, requestId, cursor) { profile.cursor = Math.max(profile.cursor, cursor); },
          acquireReadLease: () => ({ release() {} }),
        }),
      },
      readFile: () => { throw new Error('no files'); },
      fetch: async (url, init = {}) => {
        const target = new URL(url);
        const response = await room.call(runtime, {
          path: target.pathname + target.search,
          method: init.method || 'GET',
          body: init.body === undefined ? undefined : JSON.parse(init.body),
          headers: { authorization: init.headers.authorization },
        });
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.json,
        };
      },
    },
  };
}

async function cli(seat, argv) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv.concat(['--connection', seat.profile.name]), {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, seat.dependencies);
  return { code, stdout, stderr };
}

test('after history --through N, a doorbell polling from an older cursor does not ring N again', async () => {
  const { runtime } = await room.startRoom('interlock-cli-through-ring-');
  try {
    const device = await room.bootstrap(runtime);
    const owner = await room.elevate(runtime, await room.login(runtime), device);
    const scout = connection(runtime, await room.admitSeat(runtime, owner, 'Scout'));
    const skipped = await cli(scout, ['history', '--skip-to-current']);
    assert.equal(skipped.code, EXIT_OK, skipped.stderr);
    const staleCursor = scout.profile.cursor;
    const first = await room.post(runtime, '/api/messages', { text: '@Scout shall I rerun?' }, owner);
    assert.equal(first.status, 201, first.text);
    const firstId = first.json.message.id;

    const rang = await cli(scout, ['doorbell', '--after', String(staleCursor), '--json']);
    assert.equal(rang.code, EXIT_OK, rang.stderr);
    assert.deepEqual(JSON.parse(rang.stdout).rings.map(ring => ring.id), [firstId],
      'arrangement: the doorbell rings the unread mention');

    const read = await cli(scout, ['history', '--through', String(firstId)]);
    assert.equal(read.code, EXIT_OK, read.stderr);
    assert.match(read.stdout, new RegExp(`Read through message ${firstId}\\.\\n`));
    const page = (await room.aiGet(runtime, `/api/ai/messages?after=${firstId - 1}&limit=100&wait=0`,
      scout.profile.token)).json;
    assert.notEqual(page.messages.find(message => message.id === firstId)
      .delivery.find(entry => entry.name === 'Scout').acknowledged_at, null,
    'arrangement: the read acknowledged it');

    // A later unread mention, so the waiting poll answers at once either way.
    const second = await room.post(runtime, '/api/messages', { text: '@Scout and one more' }, owner);
    assert.equal(second.status, 201, second.text);
    const again = await cli(scout, ['doorbell', '--after', String(staleCursor), '--json']);
    assert.equal(again.code, EXIT_OK, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout).rings.map(ring => ring.id), [second.json.message.id],
      'the fresh doorbell rang the already-read message again');
  } finally {
    await runtime.close();
  }
});
