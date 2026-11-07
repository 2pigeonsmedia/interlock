'use strict';

// --help or -h anywhere, through the real binaries a person types, not run():
// `interlock start` and `recover` are handed off before run(), and
// `interlock-doorbell` has its own parser.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const INTERLOCK = path.join(ROOT, 'bin', 'interlock.js');
const DOORBELL = path.join(ROOT, 'integrations', 'doorbell.js');

function exec(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('interlock start and recover answer --help or -h anywhere with their usage, exit 0, and start nothing', () => {
  for (const args of [['start', '--help'], ['start', '-h'], ['start', '--port', '5000', '--help'],
    ['recover', '--help'], ['recover', '--port', '5', '-h']]) {
    const result = exec(INTERLOCK, args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
    assert.equal(result.err, '', args.join(' '));
    assert.match(result.out, new RegExp(`^ {2}interlock ${args[0]} `, 'm'), args.join(' '));
    assert.doesNotMatch(result.out, /interlock history/, `${args.join(' ')}: only its own usage`);
  }
});

test('interlock-doorbell answers --help or -h anywhere with that subcommand\'s usage and exit 0', () => {
  for (const [args, own] of [
    [['run', '--help'], 'run'], [['run', '--connection', 'X', '-h'], 'run'],
    [['status', '--help'], 'status'], [['guide', '-h'], 'guide'],
    [['--help'], null], [['run', '--adapter', 'stdout', '--connection', 'X', '--session', 's', '--help'], 'run'],
  ]) {
    const result = exec(DOORBELL, args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}`);
    assert.equal(result.err, '', args.join(' '));
    if (own) {
      assert.match(result.out, new RegExp(`^ {2}interlock-doorbell ${own}`, 'm'), args.join(' '));
      assert.ok(result.out.split('\n').filter(line => /^ {2}interlock-doorbell /.test(line))
        .every(line => line.startsWith(`  interlock-doorbell ${own}`)), `${args.join(' ')}: only its own usage`);
    } else {
      assert.match(result.out, /Interlock doorbell adapter/);
    }
  }
});
