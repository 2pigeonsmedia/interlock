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
