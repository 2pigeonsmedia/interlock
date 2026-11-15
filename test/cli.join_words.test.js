'use strict';

// What join tells an AI that has never seen Interlock: its help, and its
// refusal when it is run without a terminal to prompt in.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { run, EXIT_OK, EXIT_USAGE } = require('../src/cli.js');

function capture(argv, dependencies = {}, stdin = undefined) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  };
  if (stdin) io.stdin = stdin;
  return Promise.resolve(run(argv, io, dependencies)).then(code => ({ code, stdout, stderr }));
}

test('join --help names the product labels, the doorbell step, status, the connection dir and both recovery verbs', async () => {
  const result = await capture(['join', '--help']);
  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /interlock join --product LABEL --name NAME/);
  assert.match(result.stdout, /--product is required/);
  for (const label of ['Claude Code', 'Codex CLI', 'Grok', 'ChatGPT', 'Opencode']) {
    assert.ok(result.stdout.includes(`"${label}"`), label);
  }
  assert.match(result.stdout, /Arm that doorbell before you end your turn/);
  assert.match(result.stdout, /interlock status --connection NAME/);
  assert.match(result.stdout, /INTERLOCK_CONNECTION_DIR/);
  assert.match(result.stdout, /interlock join --resume --name NAME/);
  assert.match(result.stdout, /interlock join --discard --name NAME/);
  assert.doesNotMatch(result.stdout, /interlock history/, 'only join\'s own entries');
});

test('a join with no terminal to prompt in names --product and gives examples', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-words-')), 'profiles');
  const stdin = Readable.from([]);
  Object.defineProperty(stdin, 'isTTY', { value: false });
  const result = await capture(['join', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => dir },
  }, stdin);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /pass --product and --name/);
  assert.match(result.stderr, /interlock join --product "PRODUCT" --name NAME/);
  assert.match(result.stderr, /--product is your AI product, for example "Claude Code", "Codex CLI"/);
  assert.equal(fs.existsSync(dir), false, 'nothing was created');
});

test('the room page install notes name the PATH step and the official repository', () => {
  const room = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.html'), 'utf8');
  const notes = room.split('If <code>interlock</code> is then not found, put npm\'s global bin folder on PATH.').length - 1;
  assert.equal(notes, 2, 'both install notes (sign-in and Connect an AI) carry the PATH step');
  assert.equal(room.split('<a href="https://github.com/2pigeonsmedia/interlock">github.com/2pigeonsmedia/interlock</a>').length - 1, 2,
    'both name the official repository');
  const guide = fs.readFileSync(path.join(__dirname, '..', 'GUIDE.md'), 'utf8');
  assert.match(guide, /Add npm's global bin \(`npm prefix -g`, `\/bin` outside Windows\) to PATH/);
});

test('join names one way to be woken per product, before it waits', async () => {
  const { run: runCli } = require('../src/cli.js');
  async function joinAs(product) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-words-arm-')), 'profiles');
    let stdout = '';
    let knocks = 0;
    await runCli(['join', '--product', product, '--name', 'Marlow'], {
      stdout: { write: value => { stdout += String(value); } }, stderr: { write() {} },
    }, {
      config: { resolveConnectionDir: () => dir }, clock: () => 2_000, sleep: async () => {},
      doorbellStateDir: path.join(path.dirname(dir), 'doorbells'),
      ask: async () => { throw new Error('no prompt'); },
      async fetch(url, options) {
        if (url.endsWith('/api/ai/admissions')) {
          knocks += 1;
          const sent = JSON.parse(options.body);
          const state = knocks === 1 ? 'waiting' : 'declined';
          return { ok: true, status: 200, async json() {
            return { ok: true, state, request_id: sent.request_id, name: sent.name, product: sent.product,
              product_provenance: sent.product_provenance, expires_at: 9e15 };
          } };
        }
        return { ok: false, status: 401, async json() { return { ok: false, error: 'invalid-connection' }; } };
      },
    });
    return stdout;
  }
  const claude = await joinAs('Claude Code');
  assert.match(claude, /Stop → interlock-doorbell claude-code-hook --connection Marlow with "asyncRewake": true and "timeout": 604800/);
  assert.match(claude, /UserPromptSubmit → interlock-doorbell claude-code-hook --connection Marlow --event prompt/);
  assert.match(claude, /re-arm it on every expiry notice without asking/);
  const codex = await joinAs('Codex CLI');
  assert.match(codex, /interlock-doorbell run --adapter codex --connection Marlow --session <this thread id>/);
  assert.doesNotMatch(codex, /claude-code-hook/);
  const other = await joinAs('Grok');
  assert.match(other, /interlock-doorbell run --adapter stdout --connection Marlow --session <your host session id>/);
  for (const out of [claude, codex, other]) {
    assert.match(out, /Settings → Webhooks; no doorbell process runs/);
    assert.ok(out.indexOf('Arm your doorbell now') < out.indexOf('Waiting for the owner'), 'before it waits');
  }
});
