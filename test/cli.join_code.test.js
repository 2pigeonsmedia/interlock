'use strict';

// #821: `join` carries a member's one-time AI join code, from `--code`, from
// stdin with `--code -`, or from INTERLOCK_JOIN_CODE, so the code need not
// sit in shell history. Without one it sends no `join_code` field at all (a
// 0.3.11 room refuses unknown fields). A refused code says what to do.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');

const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

const ORIGIN = 'https://app.example.test';

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

async function join(extraArgs, { env = {}, stdin = null, refuse = null } = {}) {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-code-')), 'profiles');
  let stdout = '';
  let stderr = '';
  const knocks = [];
  const io = {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  };
  if (stdin !== null) io.stdin = Readable.from([stdin]);
  const code = await run(['join', '--url', ORIGIN, '--product', 'Codex CLI', '--name', 'Kestrel', ...extraArgs], io, {
    config: { resolveConnectionDir: () => connectionDir },
    env,
    clock: (() => { let time = 1_000; return () => ++time; })(),
    async fetch(target, options) {
      if (target.endsWith('/api/ai/session')) return fakeResponse(401, { ok: false, error: 'invalid-connection' });
      if (target.endsWith('/api/ai/head')) return fakeResponse(200, { ok: true, head: 3, connection_session: null });
      const body = JSON.parse(options.body);
      knocks.push(body);
      if (refuse) return fakeResponse(400, { ok: false, error: refuse });
      return fakeResponse(200, {
        ok: true, state: 'allowed', request_id: body.request_id, name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 50_000,
        enrollment: { subject_id: 'seat-1', name: body.name, product: body.product,
          product_provenance: body.product_provenance, expires_at: 50_000 },
      });
    },
    ask: async () => { throw new Error('must not prompt'); },
  });
  return { code, stdout, stderr, knocks, connectionDir };
}

test('arrangement: without a code the knock carries no join_code field', async () => {
  const result = await join([]);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(Object.hasOwn(result.knocks[0], 'join_code'), false);
});

test('--code CODE is sent with the knock', async () => {
  const result = await join(['--code', 'ABCDE-FGHJK']);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.knocks[0].join_code, 'ABCDE-FGHJK');
});

test('--code - reads the code from stdin (first line, trimmed)', async () => {
  const result = await join(['--code', '-'], { stdin: '  ABCDE-FGHJK  \nignored\n' });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.knocks[0].join_code, 'ABCDE-FGHJK');
});

test('INTERLOCK_JOIN_CODE is used when no --code is given; --code wins over it', async () => {
  const fromEnv = await join([], { env: { INTERLOCK_JOIN_CODE: 'ZZZZZ-YYYYY' } });
  assert.equal(fromEnv.knocks[0].join_code, 'ZZZZZ-YYYYY');
  const both = await join(['--code', 'ABCDE-FGHJK'], { env: { INTERLOCK_JOIN_CODE: 'ZZZZZ-YYYYY' } });
  assert.equal(both.knocks[0].join_code, 'ABCDE-FGHJK');
});

test('a refused code says so and what to do, and creates no connection', async () => {
  const result = await join(['--code', 'ABCDE-FGHJK'], { refuse: 'invalid-join-code' });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /refused that join code: it is wrong, already used, expired or cancelled\. Ask your person for a new one\./);
});

test('an older room that refuses the field is named as such', async () => {
  const result = await join(['--code', 'ABCDE-FGHJK'], { refuse: 'invalid-request' });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /older than 0\.4\.0, which has no member join codes/);
});

test('the code is sent, never written: no profile file holds it', async () => {
  const result = await join(['--code', 'ABCDE-FGHJK']);
  assert.equal(result.code, EXIT_OK, result.stderr);
  const files = fs.readdirSync(result.connectionDir, { recursive: true })
    .filter(file => fs.statSync(path.join(result.connectionDir, file)).isFile());
  assert.ok(files.some(file => file.endsWith('kestrel.json')), 'ARRANGEMENT: the profile was written');
  for (const file of files) {
    const text = fs.readFileSync(path.join(result.connectionDir, file), 'utf8');
    assert.equal(text.includes('ABCDE'), false, `${file} holds no part of the code`);
  }
  assert.equal(result.stdout.includes('ABCDE-FGHJK'), false, 'nor is it echoed');
});
