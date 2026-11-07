'use strict';

// `--help` or `-h` anywhere in an `interlock` command prints that command's
// own usage lines and exits 0, before any other argument is checked.

const assert = require('node:assert/strict');
const test = require('node:test');

const { EXIT_OK, run } = require('../src/cli.js');

function capture(argv) {
  let out = '';
  let err = '';
  const io = { stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } } };
  const code = run(argv, io, {});
  return Promise.resolve(code).then(exit => ({ exit, out, err }));
}

// The usage entries of the full help, as [command, verbs] pairs.
async function usageEntries() {
  const { out } = await capture(['--help']);
  const entries = [];
  for (const line of out.split('\n')) {
    const match = /^ {2}interlock ([a-z][a-z-]*)(?: ([a-z|-]+))?/.exec(line);
    if (!match) continue;
    const verbs = match[2] && !match[2].startsWith('-') ? match[2].split('|') : [null];
    for (const verb of verbs) entries.push([match[1], verb, line]);
  }
  return { full: out, entries };
}

test('every command in the help, with --help anywhere, prints only its own usage and exits 0', async () => {
  const { full, entries } = await usageEntries();
  assert.ok(entries.length >= 30, 'ARRANGEMENT: the help lists the commands: ' + entries.length);
  const fullLines = new Set(full.split('\n'));
  for (const [command, verb] of entries) {
    const head = verb ? [command, verb] : [command];
    for (const argv of [
      [...head, '--help'],
      [...head, '-h'],
      [...head, '--connection', 'Scout', '--json', '--help'],
      ['-h', ...head].slice(0, 1).concat(head).slice(1).concat(['-h']),
      [...head, 'extra', 'words', '--help'],
    ]) {
      const result = await capture(argv);
      const label = argv.join(' ');
      assert.equal(result.exit, EXIT_OK, `${label}: exit 0 (${result.err})`);
      assert.equal(result.err, '', `${label}: nothing on stderr`);
      assert.doesNotMatch(result.out, /refusing/, `${label}: never the refusal`);
      const lines = result.out.split('\n').filter(text => text !== '');
      assert.ok(lines.length >= 1, `${label}: prints usage`);
      for (const text of lines) {
        assert.ok(fullLines.has(text), `${label}: every line comes from the help: ${text}`);
      }
      assert.ok(lines.some(text => text.startsWith('  interlock ' + command + (verb ? ' ' : '')) &&
        (!verb || text.split(' ')[4].split('|').includes(verb))), `${label}: its own usage line is printed`);
      assert.ok(lines.every(text => !/^ {2}interlock [a-z]/.test(text) || text.startsWith('  interlock ' + command + ' ') ||
        text === '  interlock ' + command), `${label}: no other command's usage`);
    }
  }
});

test('work list --help is usage, not the extra-arguments refusal', async () => {
  const result = await capture(['work', 'list', '--help']);
  assert.equal(result.exit, EXIT_OK);
  assert.match(result.out, /^ {2}interlock work list --connection NAME/m);
  assert.doesNotMatch(result.out, /interlock work get/);
});

test('an unknown command with --help shows the whole help', async () => {
  const { full } = await usageEntries();
  const result = await capture(['no-such-command', '--help']);
  assert.equal(result.exit, EXIT_OK);
  assert.equal(result.out, full);
});
