'use strict';

// The restart command a doorbell prints when it gives up is pasted into a
// shell. On Windows that shell is often cmd.exe, which does not treat single
// quotes as quoting, so there the command uses double quotes, escaped by the
// rules a Windows program reads its arguments with. POSIX quoting is unchanged.

const assert = require('node:assert/strict');
const test = require('node:test');

const { restartCommand } = require('../integrations/doorbell.js');

const OPTIONS = {
  adapter: 'stdout', connection: 'Marlow', session: '6f1c2a9e-0d4b-4c8e-9a51-3b7d2e8f6a10', stateDir: null,
};

// How a Windows program splits its command line into arguments (the C
// runtime's rules): 2n backslashes before a quote are n backslashes and the
// quote toggles quoting; 2n+1 are n backslashes and a literal quote;
// backslashes elsewhere are literal.
function windowsArgv(line) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\') {
      let count = 0;
      while (line[index] === '\\') { count += 1; index += 1; }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current += '\\'.repeat(count);
        index -= 1;
      }
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (character === ' ' && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const PATHS = [
  'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\interlock-x\\state',
  'C:\\Program Files\\Interlock state\\',
  'C:\\odd"name\\state',
  'C:\\odd\\"name',
  'C:\\trailing\\\\',
  '/home/marlow/.local/state/interlock',
];

test('on Windows the restart command double-quotes and round-trips every argument', () => {
  for (const stateDir of PATHS) {
    const printed = restartCommand(Object.assign({}, OPTIONS, { stateDir }), 'win32');
    assert.doesNotMatch(printed, /'/, `${stateDir}: no single quotes for cmd.exe`);
    assert.deepEqual(windowsArgv(printed), [
      'interlock-doorbell', 'run', '--adapter', 'stdout', '--connection', 'Marlow',
      '--session', OPTIONS.session, '--state-dir', stateDir,
    ], `${stateDir}: ${printed}`);
  }
  // A plain argument stays bare, and a quoted one reads as the person expects.
  assert.equal(restartCommand(Object.assign({}, OPTIONS, { stateDir: PATHS[0] }), 'win32'),
    `interlock-doorbell run --adapter stdout --connection Marlow --session ${OPTIONS.session} ` +
    '--state-dir "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\interlock-x\\state"');
});

test('the reference parser is not hollow: it rejects the POSIX form of a Windows path', () => {
  const posix = restartCommand(Object.assign({}, OPTIONS, { stateDir: PATHS[1] }), 'linux');
  assert.notDeepEqual(windowsArgv(posix).slice(-1), [PATHS[1]],
    'single quotes do not group a path with spaces under the Windows rules');
});

test('POSIX quoting is unchanged', () => {
  assert.equal(restartCommand(Object.assign({}, OPTIONS, { stateDir: '/tmp/run~1/state' }), 'linux'),
    `interlock-doorbell run --adapter stdout --connection Marlow --session ${OPTIONS.session} --state-dir '/tmp/run~1/state'`);
  assert.equal(restartCommand(Object.assign({}, OPTIONS, { stateDir: "/tmp/it's" }), 'darwin'),
    `interlock-doorbell run --adapter stdout --connection Marlow --session ${OPTIONS.session} --state-dir '/tmp/it'\\''s'`);
  assert.equal(restartCommand(OPTIONS, 'linux'),
    `interlock-doorbell run --adapter stdout --connection Marlow --session ${OPTIONS.session}`);
});
