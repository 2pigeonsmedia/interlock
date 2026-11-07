'use strict';

// A connection directory the file system will not let this process secure
// (a read-only mount, a sandbox, a permission) is named as that, apart from
// a profile that is damaged or unsafe. No credential is printed either way.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_RUNTIME, run } = require('../src/cli.js');

function refusing(code) {
  return () => {
    const error = new Error(`${code}: refused, mkdir '/home/someone/.config/interlock/connections'`);
    error.code = code;
    error.path = '/home/someone/.config/interlock/connections';
    throw error;
  };
}

async function capture(argv, openProfiles) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
    stdin: { isTTY: false },
  }, {
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: { validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value), validUrl: () => true, openProfiles },
    fetch: async () => { throw new Error('must not reach the network'); },
  });
  return { code, stdout, stderr };
}

test('a read-only or permission refusal is named as the file system, not as an unsafe profile', async () => {
  for (const [errno, words] of [['EROFS', 'read-only file system'], ['EACCES', 'permission denied'], ['EPERM', 'operation not permitted']]) {
    const result = await capture(['work', 'brief', '--connection', 'Marlow'], refusing(errno));
    assert.equal(result.code, EXIT_RUNTIME);
    assert.ok(result.stderr.includes(`interlock: the local connection directory could not be secured here (${errno}: ${words}).`), result.stderr);
    assert.match(result.stderr, /sandbox/);
    assert.doesNotMatch(result.stderr, /could not be read safely/);
  }
});

test('join names the same refusal when it opens the connection directory', async () => {
  const result = await capture(['join', '--product', 'Codex CLI', '--name', 'Marlow'], refusing('EROFS'));
  assert.equal(result.code, EXIT_RUNTIME);
  assert.ok(result.stderr.includes('interlock: the local connection directory could not be secured here (EROFS: read-only file system).'), result.stderr);
});

test('a damaged profile still reads as one', async () => {
  const result = await capture(['work', 'brief', '--connection', 'Marlow'], () => ({
    load() { const error = new Error('corrupt'); error.code = 'corrupt-profile'; throw error; },
  }));
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(result.stderr, 'interlock: the selected connection profile could not be read safely.\n');
});
