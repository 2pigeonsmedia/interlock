'use strict';

// Interlock's doorbell for Claude Code, as two hooks. Nothing to re-arm.
//
//   Stop (asyncRewake)    interlock-doorbell claude-code-hook --connection NAME
//   UserPromptSubmit      interlock-doorbell claude-code-hook --connection NAME --event prompt
//
// After each turn, Claude Code starts the Stop hook in the background. It
// tells the room the seat is listening again, then runs one bounded doorbell
// poll after another (the stdout adapter with --once, under the adapter's own
// lock and cursor). When a poll rings, it declares the seat working, prints
// the ring and exits 2: Claude Code wakes the model with that text. The
// model answers, its turn ends, and Claude Code starts the next waiter.
//
// When a person starts a turn, the UserPromptSubmit hook stops this session's
// waiter and declares the seat working; a ring that arrives meanwhile stays
// eligible and rings when the turn ends.
//
// One waiter per Claude Code session. A waiter whose session is gone exits
// without taking a ring. A waiter that reaches its time limit wakes the model
// once to say so; the next turn's end starts a fresh one. The Stop hook's
// `timeout` must stay above --max-seconds (the recipe: 604800 and 601200).

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// One hour under the hook timeout the recipe sets (604800 s, 7 days), so a
// quiet waiter always says so before Claude Code stops it.
const DEFAULT_MAX_SECONDS = 7 * 24 * 60 * 60 - 60 * 60;
const FAILURE_WAKE_AFTER = 3;
const FAILURE_RETRY_MS = 30_000;
const RUNNER = path.join(__dirname, 'doorbell.js');
const CLI = path.join(__dirname, '..', 'bin', 'interlock.js');

const USAGE = 'usage: interlock-doorbell claude-code-hook --connection NAME [--event stop|prompt] ' +
  '[--state-dir ABSOLUTE_PATH] [--max-seconds N]';

function parse(argv) {
  const result = { connection: null, event: 'stop', stateDir: null, maxSeconds: DEFAULT_MAX_SECONDS };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (seen.has(flag) || typeof value !== 'string' || value.length === 0) return null;
    seen.add(flag);
    if (flag === '--connection') result.connection = value;
    else if (flag === '--event' && (value === 'stop' || value === 'prompt')) result.event = value;
    else if (flag === '--state-dir' && path.isAbsolute(value)) result.stateDir = value;
    else if (flag === '--max-seconds' && /^[1-9][0-9]{0,7}$/.test(value)) result.maxSeconds = Number(value);
    else return null;
  }
  if (typeof result.connection !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result.connection)) return null;
  return result;
}

// The hook's input: Claude Code passes JSON on stdin with the session id.
function sessionFromStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return 'claude-code'; }
  try {
    const value = JSON.parse(raw);
    const id = value && typeof value.session_id === 'string' ? value.session_id : '';
    return /^[A-Za-z0-9_.:-]{1,160}$/.test(id) ? id : 'claude-code';
  } catch (_) { return 'claude-code'; }
}

// The doorbell runner hands in what this needs from it (its state directory
// and its process check), so neither module loads the other back.
let runner = null;

function stateDirFor(options) {
  return options.stateDir || runner.defaultStateDir();
}

function waiterFile(stateDir, connection, session) {
  const key = crypto.createHash('sha256').update(`${connection}\0${session}`).digest('hex').slice(0, 24);
  return path.join(stateDir, `claude-waiter-${key}.json`);
}

function failureFile(stateDir, connection, session) {
  return waiterFile(stateDir, connection, session).replace(/\.json$/, '.failure');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
}

// Stops this session's earlier waiter, by its recorded pid, only when its
// own command line says it is this hook for this connection.
function stopEarlierWaiter(file, connection) {
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
  const pid = record && Number.isSafeInteger(record.pid) ? record.pid : null;
  if (pid === null || pid === process.pid || !alive(pid)) return;
  const args = runner.commandLineOf(pid);
  if (!Array.isArray(args) || !args.includes('claude-code-hook') ||
      args[args.indexOf('--connection') + 1] !== connection) return;
  try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ }
}

function cli(args) {
  return childProcess.spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env, timeout: 20_000 });
}

function wake(text) {
  process.stdout.write(text + '\n');
  process.stderr.write(text + '\n');
  process.exitCode = 2;
}

// Watches for the end of the session this waiter serves.
function parentWatch() {
  const parent = process.ppid;
  return () => {
    if (process.platform !== 'win32') return process.ppid !== parent;
    try { process.kill(parent, 0); return false; } catch (error) { return !!error && error.code === 'ESRCH'; }
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// One --once pass of the stdout adapter, as a child this waiter can stop.
function pass(options, session, stateDir, current) {
  return new Promise(resolve => {
    const child = childProcess.spawn(process.execPath, [RUNNER, 'run', '--adapter', 'stdout',
      '--connection', options.connection, '--session', session, '--state-dir', stateDir, '--once'],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    current.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { current.child = null; resolve({ code, stdout, stderr }); });
  });
}

async function runStop(options) {
  const session = sessionFromStdin();
  const stateDir = stateDirFor(options);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = waiterFile(stateDir, options.connection, session);
  stopEarlierWaiter(file, options.connection);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, pid: process.pid, started_at: Date.now() }) + '\n',
    { encoding: 'utf8', mode: 0o600 });
  const current = { child: null };
  const stop = () => {
    if (current.child) current.child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const sessionGone = parentWatch();
  // The turn is over: the seat listens again (C1). An older room does not
  // know the word; that is fine.
  cli(['doorbell', 'resume', '--connection', options.connection]);
  const deadline = Date.now() + options.maxSeconds * 1000;
  const failureMark = failureFile(stateDir, options.connection, session);
  let failures = 0;
  while (Date.now() < deadline) {
    if (sessionGone()) return;
    const result = await pass(options, session, stateDir, current);
    if (sessionGone()) return;
    const rang = result.stdout.split('\n').filter(text => text.startsWith('Interlock rang for '));
    if (rang.length > 0) {
      try { fs.unlinkSync(failureMark); } catch (_) { /* none */ }
      cli(['doorbell', 'pause', '--connection', options.connection, '--reason', 'turn']);
      wake(rang.join('\n'));
      return;
    }
    if (result.code === 0) { failures = 0; continue; }
    // Another adapter holds the connection for a moment (the previous
    // waiter's pass finishing): wait and try again, quietly.
    const reason = (result.stderr.split('\n').find(Boolean) || `exit ${result.code}`).slice(0, 600);
    failures += 1;
    if (failures >= FAILURE_WAKE_AFTER) {
      // Said once per distinct failure, so a model that ends its turn on it
      // is not woken by the same words again and again.
      // The same failure, told apart from a new one by its words without the
      // file each failure saves its output to.
      const kind = reason.replace(/raw output preserved at [^;\n]*/g, 'raw output preserved');
      let said = '';
      try { said = fs.readFileSync(failureMark, 'utf8'); } catch (_) { /* first time */ }
      if (said !== kind) {
        try { fs.writeFileSync(failureMark, kind, { encoding: 'utf8', mode: 0o600 }); } catch (_) { /* best effort */ }
        wake(`Interlock doorbell for ${options.connection} is failing and cannot wake you until it is fixed: ${reason} ` +
          '(Said once. It keeps retrying quietly.)');
        return;
      }
    }
    // Tests shorten the retry; a value can only shorten it.
    const asked = Number(process.env.INTERLOCK_CLAUDE_HOOK_RETRY_MS);
    await sleep(Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, FAILURE_RETRY_MS) : FAILURE_RETRY_MS);
  }
  wake(`Interlock doorbell for ${options.connection}: this waiter reached its time limit. Nothing is wrong; ` +
    'end your turn and a fresh waiter starts.');
}

function runPrompt(options) {
  const session = sessionFromStdin();
  const stateDir = stateDirFor(options);
  stopEarlierWaiter(waiterFile(stateDir, options.connection, session), options.connection);
  // A person started a turn: the seat is working (C1).
  cli(['doorbell', 'pause', '--connection', options.connection, '--reason', 'turn']);
}

async function main(argv, from) {
  runner = from;
  const options = parse(argv);
  if (!options) {
    process.stderr.write(`interlock doorbell adapter: ${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.event === 'prompt') return runPrompt(options);
  return runStop(options);
}

module.exports = Object.freeze({ main, parse, DEFAULT_MAX_SECONDS });
