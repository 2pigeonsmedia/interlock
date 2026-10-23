// identity/test/run.js — the module's OWN test runner.
//
// The module's suites live under identity/test/ and run on their own runner.
// The host's test/identity.*.test.js suites stay where they are.
//
//   node identity/test/run.js          # from anywhere; paths are self-resolved
//
// It needs node >= 20 and nothing else: no host package.json script, no host
// harness, no server, no network, no room key. That is the point — a stranger
// who is handed this folder can run its tests without meeting the deployment
// it currently lives in.
//
// ⚠ WHAT RUNS THIS (a check without a scheduled runner is decoration). These
// suites ARE scheduled, both ways:
//   · per-commit — the host's pre-commit hook selects identity/test/*.test.js
//     by PATH whenever the identity surface is staged, and fail-closes if the
//     selection is empty;
//   · nightly — the upstream host's nightly runner globs
//     identity/test/*.test.js beside the host estate.
//
// A header that UNDER-claims its own coverage is as wrong as one that
// over-claims: it reads as caution and so goes unchallenged, and it invites
// someone to retire a live suite as unscheduled. Keep this list true.
//
// The honest remaining gap, narrower: what nothing invokes is THIS FILE.
// Both schedulers glob the suites directly, so the zero-match refusal below is
// a guard for a human typing the command, not one on the scheduled path.
// THE ZERO-MATCH RULE: a glob that matches nothing makes the loop body run zero
// times and the runner exit 0 — a silent no-op wearing a tick. So the corpus is
// resolved, asserted non-empty, and PRINTED before anything runs.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = __dirname;

const suites = fs.readdirSync(TEST_DIR)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(TEST_DIR, name));

if (suites.length === 0) {
  console.error('identity/test/run.js: ✖ REFUSED — zero suites matched *.test.js in ' + TEST_DIR + '.');
  console.error('  Empty is what "clean" and "broken" both look like. A runner that finds no');
  console.error('  tests must block, never print a green over nothing.');
  process.exit(1);
}

console.log('identity module suite — corpus (' + suites.length + '):');
for (const suite of suites) console.log('  ' + path.relative(TEST_DIR, suite));
console.log('');

const result = spawnSync(process.execPath, ['--test', ...suites], {
  stdio: 'inherit',
  cwd: TEST_DIR,
});

if (result.error) {
  console.error('identity/test/run.js: ✖ the runner could not start node --test: ' + result.error.message);
  process.exit(1);
}
// A signal death is not a test failure and must not be reported as one.
if (result.signal) {
  console.error('identity/test/run.js: ✖ the suite was killed by signal ' + result.signal +
    ' — this is NOT a green and NOT an ordinary red.');
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
