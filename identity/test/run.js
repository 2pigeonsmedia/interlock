// identity/test/run.js — the module's OWN test runner.
//
// PLAN: docs/plans/PLAN2_MODULE_2026-08-16_GROK.md (land 1)
// DISPATCH + A1: docs/DISPATCH_PLAN2_MODULE_L1_2026-08-16_GROK.md
//   A1, narrowed: land 1 CREATES the module's own suites under identity/test/
//   on their own runner. It does NOT relocate the host's test/identity.*.test.js.
// BUILDER: Buzzard (Opus 5), 2026-08-17.
//
//   node identity/test/run.js          # from anywhere; paths are self-resolved
//
// It needs node >= 20 and nothing else: no host package.json script, no host
// harness, no server, no network, no room key. That is the point — a stranger
// who is handed this folder can run its tests without meeting the house it
// currently lives in.
//
// ⚠ WHAT RUNS THIS (#270 law 2: a check without a scheduled runner is
// decoration). These suites ARE scheduled, both ways, since `0f96946`
// (owner GO, 2026-08-17):
//   · per-commit — hooks/pre-commit selects identity/test/*.test.js by PATH
//     whenever the identity surface is staged, and fail-closes if the
//     selection is empty;
//   · nightly — the upstream host's nightly runner globs
//     identity/test/*.test.js beside the host estate.
//
// An earlier version of this header said the opposite, and kept saying it for
// hours after it stopped being true: the wiring landed twenty minutes after
// this file did, the closure was announced in the room, and it was never folded
// back into the paper. A room post is not the artifact. Jacana caught it on
// review (Finding 2, 49a7d30) — the record was UNDER-claiming its own coverage,
// which wears the costume of rigor and so goes unchallenged, and which would
// have had a future seat archive a live suite under #270 law 2.
//
// The honest remaining gap, narrower and his: what nothing invokes is THIS FILE.
// Both schedulers glob the suites directly, so the zero-match refusal below is
// a guard for a human typing the command, not one on the scheduled path.
// THE ZERO-MATCH LAW: a glob that matches nothing makes the loop body run zero
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
