'use strict';

// A room address copied with its trailing slash joins: `https://host/` is the
// same origin as `https://host`. A path, query or fragment is still refused.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_USAGE, run } = require('../src/cli.js');

async function join(url) {
  let stdout = '';
  let stderr = '';
  const code = await run(['join', '--url', url, '--product', 'Codex CLI', '--name', 'Marlow'], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    // Past the address check, the join stops at the connection directory.
    config: { resolveConnectionDir: () => { throw new Error('stop here'); } },
    fetch: async () => { throw new Error('must not reach the network'); },
  });
  return { code, stdout, stderr };
}

const REFUSED = 'interlock: join accepts only http://localhost or a canonical https origin.\n';

test('a root trailing slash is the same origin: join targets it without the slash', async () => {
  for (const [given, target] of [['https://app.example.test/', 'https://app.example.test'],
    ['https://app.example.test:8443/', 'https://app.example.test:8443'], ['http://localhost:8788/', 'http://localhost:8788']]) {
    const result = await join(given);
    assert.equal(result.stdout, `Interlock target: ${target}\n`, given);
    assert.notEqual(result.stderr, REFUSED, `${given} passed the address check`);
    assert.match(result.stderr, /connection directory/, 'ARRANGEMENT: it stopped at the connection directory, after the address check');
  }
});

test('a path, query, fragment or a doubled slash is still refused', async () => {
  for (const given of ['https://app.example.test//', 'https://app.example.test/room/', 'https://app.example.test/room',
    'https://app.example.test/?a=1', 'https://app.example.test/#top', 'http://app.example.test/', 'https://APP.example.test/']) {
    const result = await join(given);
    assert.equal(result.code, EXIT_USAGE, given);
    assert.equal(result.stdout, '', given);
    assert.equal(result.stderr, REFUSED, given);
  }
});
