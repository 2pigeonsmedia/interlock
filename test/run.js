'use strict';

// Runs the suite one `node --test` process per file, several at once (as
// `node --test` does), with a bound on each file. A file still running at
// the bound is killed and fails by name, so a test that leaves a socket,
// timer or child process open fails the run in minutes instead of holding
// it until the CI job limit. Node's own --test-force-exit is not used: under
// load it can end a file before all its tests have run, and report green.
//
//   node test/run.js [file ...]     default: test/*.test.js, identity/test/*.test.js

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// No single test runs this long; the slowest takes under a minute.
const TEST_TIMEOUT_MS = 180_000;
// No file runs this long; the slowest takes about a minute.
const FILE_TIMEOUT_MS = Number(process.env.INTERLOCK_TEST_FILE_TIMEOUT_MS) || 300_000;
const CONCURRENCY = Math.max(1, os.availableParallelism() - 1);

function defaultFiles() {
  const list = dir => fs.readdirSync(path.join(ROOT, dir)).filter(name => name.endsWith('.test.js')).sort()
    .map(name => path.join(dir, name));
  return list('test').concat(list(path.join('identity', 'test')));
}

function count(output, key) {
  const match = new RegExp('^ℹ ' + key + ' (\\d+)$', 'm').exec(output);
  return match ? Number(match[1]) : 0;
}

// Every file's process, so a timeout or an interrupted run stops the whole
// tree: `node --test` starts the file in a process of its own, and killing
// only the outer one would leave the test running.
const running = new Set();

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    child.kill('SIGKILL');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const child of running) killTree(child);
    process.exit(130);
  });
}

function runFile(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = childProcess.spawn(process.execPath, ['--test', '--test-timeout=' + TEST_TIMEOUT_MS, file], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group on POSIX, so the whole tree can be stopped.
      detached: process.platform !== 'win32',
    });
    running.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, FILE_TIMEOUT_MS);
    // 'exit', not 'close': a process the file started may still hold the pipes.
    child.once('exit', code => {
      clearTimeout(timer);
      running.delete(child);
      // A file that ended on its own may still leave processes in its group.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* the group is gone */ }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ file, code, timedOut, output, ms: Date.now() - started });
    });
  });
}

async function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
  const queue = files.slice();
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const failedFiles = [];
  async function worker() {
    while (queue.length > 0) {
      const result = await runFile(queue.shift());
      process.stdout.write(result.output.endsWith('\n') || result.output === '' ? result.output : result.output + '\n');
      for (const key of Object.keys(totals)) totals[key] += count(result.output, key);
      if (result.timedOut) {
        failedFiles.push(result.file);
        process.stdout.write(`✖ ${result.file} did not finish within ${FILE_TIMEOUT_MS / 1000} s and was stopped\n`);
      } else if (result.code !== 0) {
        failedFiles.push(result.file);
      }
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  process.stdout.write(`\nℹ files ${files.length}\n`);
  for (const [key, value] of Object.entries(totals)) process.stdout.write(`ℹ ${key} ${value}\n`);
  process.stdout.write(`ℹ duration_ms ${Date.now() - started}\n`);
  if (failedFiles.length > 0) {
    process.stdout.write(`\n✖ failing files:\n${failedFiles.map(file => '✖ ' + file).join('\n')}\n`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
