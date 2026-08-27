'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_RUNTIME, fatalCategory, fatalMessage, runEntrypoint } =
  require('../src/entrypoint.js');

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    },
    read() { return { stderr, stdout }; },
  };
}

test('the entrypoint dispatches commands through one caught boundary', async () => {
  const calls = [];
  const cli = {
    run(args) { calls.push(['run', args]); return 2; },
    async runStart(args) { calls.push(['start', args]); return 3; },
    async runRecover(args) { calls.push(['recover', args]); return 4; },
  };
  assert.equal(await runEntrypoint({ argv: ['--version'], io: output().io,
    loadCli: () => cli }), 2);
  assert.equal(await runEntrypoint({ argv: ['start', '--port', '9000'], io: output().io,
    loadCli: () => cli }), 3);
  assert.equal(await runEntrypoint({ argv: ['recover'], io: output().io,
    loadCli: () => cli }), 4);
  assert.deepEqual(calls, [
    ['run', ['--version']],
    ['start', ['--port', '9000']],
    ['recover', []],
  ]);
});

test('a missing module reports the installation boundary without leaking its path or message', async () => {
  const receipt = output();
  const secret = 'Bearer private-token-from-C:\\Users\\person\\Interlock';
  const error = Object.assign(new Error(`Cannot find module identity ${secret}`), {
    code: 'MODULE_NOT_FOUND',
  });
  const code = await runEntrypoint({
    argv: ['join'],
    io: receipt.io,
    loadCli() { throw error; },
  });
  const rendered = receipt.read();
  assert.equal(code, EXIT_RUNTIME);
  assert.equal(rendered.stdout, '');
  assert.match(rendered.stderr, /category: installation-modules/);
  assert.match(rendered.stderr, /trusted Interlock source.*operating-system and Node environment/);
  assert.equal(rendered.stderr.includes(secret), false);
  assert.equal(rendered.stderr.includes(error.message), false);
});

test('known local failures get safe actionable categories', async t => {
  const cases = [
    ['EACCES', 'local-file-access'],
    ['ENOENT', 'required-local-file'],
    ['ENOSPC', 'local-storage'],
    ['EMFILE', 'runtime-file-limit'],
    ['ENOMEM', 'runtime-memory'],
  ];
  for (const [errorCode, category] of cases) {
    await t.test(errorCode, async () => {
      const receipt = output();
      const cli = {
        run() {
          return Promise.reject(Object.assign(new Error('private path and token'), {
            code: errorCode,
          }));
        },
        runStart() { throw new Error('unused'); },
        runRecover() { throw new Error('unused'); },
      };
      assert.equal(await runEntrypoint({ argv: ['join'], io: receipt.io,
        loadCli: () => cli }), EXIT_RUNTIME);
      assert.equal(fatalCategory({ code: errorCode }), category);
      assert.match(receipt.read().stderr, new RegExp(`category: ${category}`));
      assert.doesNotMatch(receipt.read().stderr, /private path|token/);
    });
  }
});

test('unknown errors stay useful without reflecting attacker-controlled details', async () => {
  const secret = 'sk-live-private-value and /private/user/path';
  const rendered = fatalMessage(Object.assign(new TypeError(secret), { code: secret }));
  assert.match(rendered, /category: internal/);
  assert.match(rendered, /operating system, Node version/);
  assert.doesNotMatch(rendered, /sk-live|private\/user|private-value/);
});

test('fatal classification never invokes an attacker-controlled code getter', () => {
  let invoked = false;
  const error = {};
  Object.defineProperty(error, 'code', {
    get() {
      invoked = true;
      throw new Error('secret from getter');
    },
  });
  assert.equal(fatalCategory(error), 'internal');
  assert.equal(invoked, false);
});
