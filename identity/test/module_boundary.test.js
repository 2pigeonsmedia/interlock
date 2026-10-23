// identity/test/module_boundary.test.js — the module's boundary check.
//
// Requirement: no leftover authority door in the module.
//
// Run: node identity/test/run.js
//
// THE CHECK: the module must not require a host server file, and the core
// surface must be free of five host-authority identifiers. Those five are
// declared exactly once in this file, in the frozen list below. They are
// referred to BY DESCRIPTION everywhere else on purpose: a guard that quotes
// its own subject in prose is a guard that fires on itself, which is exactly
// what an earlier version of this file did.
//
// THE SUBJECT IS NARROWED: the surface for *done* is the core set —
// login.js, passwords.js, l1_sessions.js, can.js, grants.js, memberships.js,
// plus the files in identity/test/. `identity/sessions.js` still holds a legacy
// scheme list and the host still requires it; that is a NAMED LEFTOVER for now
// and is deliberately NOT in this denominator. This file states that
// denominator out loud rather than letting a green imply folder-wide coverage.
//
// ⚠ WHAT EACH CONTROL CAN DO — the runtime-graph control and the source-text
// sweep are aimed at DIFFERENT things, and neither is a second brace on the
// other:
//   - the runtime require graph can CONFIRM and REFUTE. It observes what the
//     module actually loaded, so it sees a dynamic or computed require that no
//     source scan can see.
//   - the source-text sweep can REFUTE ONLY. A hit is a real finding; a clean
//     result is NOT proof that no leftover authority path exists under some
//     other name. A source-text control read as proof of a runtime property
//     can ship green over a false property, and it is not being asked to carry
//     that weight here.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./fixture.js');

// ⛔ THE ONE DECLARATION. Each of these strings must appear EXACTLY ONCE in
// this file — the self-count test below asserts that, so a later edit cannot
// bury a real use of one of these identifiers inside the very file excused
// from the scan.
const FORBIDDEN_AUTHORITY_TOKENS = Object.freeze([
  'checkKey', 'X-Room-Key', 'ROOM_KEY', 'admin_key', 'MCP_TOKEN',
]);

// This file declares the tokens, so it cannot be its own subject. It is the
// ONLY exclusion, it is named here, and the self-count test covers it by a
// different rule.
const SELF = path.join(__dirname, path.basename(__filename));

const rel = f => path.relative(F.MODULE_DIR, f);

// A declared dependency lives under a directory named EXACTLY `node_modules`.
//
// ⚠ This was `p.includes('node_modules')` — a SUBSTRING test — until an
// adversarial probe broke it. `../node_modules_shadow/leak.js` contains the
// substring, so a file planted one directory over was silently reclassified as
// a trusted dependency and exempted from the escape check. The control was
// real, rigorous, and matching an unrelated token — and it took an adversary
// to find it.
//
// Segments, never substrings. Compared case-sensitively, because the exemption
// is for the real directory and not for anything that resembles it.
function isDeclaredDependency(filePath) {
  const packageRoot = path.dirname(fs.realpathSync(F.MODULE_DIR));
  const relative = path.relative(packageRoot, filePath);
  return relative.split(path.sep)[0] === 'node_modules';
}

function makeEscapeFilter(insideDir) {
  return p => !p.startsWith(insideDir) && !isDeclaredDependency(p);
}

// THE DENOMINATOR IS OBSERVED, NOT HAND-WRITTEN.
//
// The first version of this file scanned a hand-written list of six modules.
// An independent probe proved that wrong the only way it can be proved — by escape:
// `require('./sessions.js')` added to can.js stayed 12/12 GREEN, and a planted
// identifier in `repo.js` (which grants.js:12 genuinely requires) stayed 12/12
// GREEN. The scanned surface was smaller than the surface the module actually
// loads, so the control could not see a leftover door in a file it reaches
// every run. That is a control aimed one artifact off: real, rigorous, and
// pointed next to the risk rather than at it.
//
// The corpus is therefore whatever the core entry points ACTUALLY pull in,
// read from the runtime graph, plus this folder's own test files. A file that
// enters the module's reach enters the sweep in the same instant — including
// the named leftovers, which is exactly the property required here: they are
// out of the graph today, and if one is ever wired in, the sweep meets it.
const LAND1_ENTRY_POINTS = F.LAND1_SURFACE;

// The observed graph, read from a FRESH CHILD PROCESS.
//
// ⚠ THIS USED TO RUN IN-PROCESS AND WAS BLIND. With a hostile
// `require('../node_modules_shadow/leak.js')` planted in can.js, the suite
// stayed **24/24 GREEN**. The mechanism is test ORDER, not weak logic — the
// corpus test runs first and loads the outside module; `F.evictModule()` only
// walks identity/, so it cannot evict what lives outside it; the outside entry
// is therefore already in `require.cache` when the runtime-graph control takes
// its `before` snapshot, and its `pulled` set — new entries only — excludes
// the very escape it exists to find. Run alone, that control went red. Run in
// the suite, it went green. Correct in isolation and false in company, which
// is the worst combination there is, because the suite is what everyone reads.
//
// No in-process eviction can fix this honestly: the observation would still
// depend on every module any earlier test happened to touch. So the observation
// moves to a child process that has no history at all. Its cache starts empty,
// which is the only state this measurement can trust.
function observeGraph() {
  const script = [
    "const path = require('path');",
    "const MODULE = " + JSON.stringify(F.MODULE_DIR) + ";",
    "const ENTRIES = " + JSON.stringify(F.LAND1_SURFACE) + ";",
    "const before = new Set(Object.keys(require.cache));",
    "for (const n of ENTRIES) require(path.join(MODULE, n));",
    "const pulled = Object.keys(require.cache).filter(p => !before.has(p));",
    "process.stdout.write(JSON.stringify(pulled));",
  ].join('\n');

  // A throwaway state dir: requiring the module must never resolve against the
  // live tree, and a child inherits this process's environment otherwise.
  const stateDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-graph-'));
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LEGACY_HOST_STATE_DIR: stateDir }),
  });

  assert.strictEqual(run.status, 0,
    'ARRANGEMENT: the graph-observing child must exit 0 — a child that died tells us nothing ' +
    'about the graph, and an empty result from a dead process reads exactly like a clean one. ' +
    'stderr: ' + String(run.stderr || '').slice(0, 800));
  let pulled;
  try { pulled = JSON.parse(run.stdout); }
  catch (_) {
    throw new Error('ARRANGEMENT: the child produced unparseable output — ' +
      JSON.stringify(String(run.stdout).slice(0, 300)));
  }
  assert.ok(Array.isArray(pulled) && pulled.length > 0,
    'ARRANGEMENT: the child must actually load modules — an empty graph is the silent no-op ' +
    'this whole control exists to refuse');

  const inside = fs.realpathSync(F.MODULE_DIR) + path.sep;
  return {
    inside,
    pulled,
    members: pulled.filter(p => p.startsWith(inside)).sort(),
    // ONE predicate, used everywhere. This line held its own inline SUBSTRING
    // copy of the rule while the segment version sat four lines above with the
    // arrangement control pointed at it — so the repaired predicate was tested
    // and the shipped one was not. Two definitions of a rule is one definition
    // and one liability.
    escapes: pulled.filter(makeEscapeFilter(inside)),
  };
}

function observedCorpus() {
  const graph = observeGraph();
  const own = fs.readdirSync(__dirname)
    .filter(n => n.endsWith('.js'))
    .map(n => path.join(__dirname, n))
    .filter(f => f !== SELF);
  const corpus = [...graph.members, ...own];
  assert.ok(graph.members.length > 0,
    'ARRANGEMENT: the observed graph must be non-empty — a corpus derived from a graph that ' +
    'loaded nothing is the silent no-op this repair exists to remove');
  assert.ok(corpus.length > 0, 'the corpus must be non-empty — a scan over nothing passes everything');
  for (const file of corpus) {
    assert.ok(fs.existsSync(file), 'corpus member must EXIST on disk: ' + file);
    assert.ok(fs.statSync(file).size > 0, 'corpus member must be non-empty: ' + file);
  }
  return corpus;
}

// ── the corpus test: the denominator is published, not implied ──────────────
test('module boundary (corpus) — the scanned corpus is OBSERVED, non-degenerate, and printed', () => {
  const corpus = observedCorpus();
  const names = corpus.map(rel).sort();

  // The corpus must be STRICTLY WIDER than the entry points. If it ever equals
  // them, the graph observation silently collapsed back to the hand-written
  // list this repair replaced, and both escapes described above come back with it.
  const entryNames = LAND1_ENTRY_POINTS.slice().sort();
  const beyond = names.filter(n => !entryNames.includes(n) && !n.startsWith('test' + path.sep));
  assert.ok(beyond.length > 0,
    'the observed corpus must reach BEYOND the six entry points — got only ' +
    JSON.stringify(names) + '. A corpus equal to its entry points is the hand-written ' +
    'denominator wearing a new name.');
  for (const required of ['repo.js', 'subjects.js', 'audit.js']) {
    assert.ok(names.includes(required),
      'the observed corpus must contain ' + required + ' — it is reached every run, and a ' +
      'leftover door in it was invisible to the hand-written sweep');
  }

  assert.ok(fs.existsSync(SELF), 'the one excluded file must exist: ' + rel(SELF));
  assert.ok(!corpus.includes(SELF), 'the token-declaring file is the ONLY exclusion, and it is excluded');

  console.log('  observed corpus (' + corpus.length + '): ' + names.join(' '));
  console.log('  reached beyond the ' + LAND1_ENTRY_POINTS.length + ' entry points: ' + beyond.join(' '));
  console.log('  excluded (1): ' + rel(SELF) + ' — declares the token list; covered by the self-count test');
});

// ── the named leftovers are UNREACHABLE, not merely unswept ─────────────────
test('module boundary (legacy sessions) — sessions.js is absent from the observed graph', () => {
  // An observation promoted to a control. The graph-derived sweep must keep
  // the named leftovers out of reach; this is the assertion that notices the
  // day one is wired in. Note what happens if it ever is: sessions.js carries
  // a legacy scheme list, so entering the graph puts it in the corpus and the
  // source-text sweep fires on it. Unreachable is a stronger claim than
  // unswept, and this is the control that holds it.
  const graph = observeGraph();
  const names = graph.members.map(rel);
  assert.ok(!names.includes('sessions.js'),
    'sessions.js is a NAMED LEFTOVER and must stay out of the reach of the boundary — observed graph: ' +
    JSON.stringify(names));
  assert.ok(fs.existsSync(path.join(F.MODULE_DIR, 'sessions.js')),
    'ARRANGEMENT: sessions.js must EXIST on disk — asserting the absence of a file that is ' +
    'not there proves nothing about reachability');
});

// ── the runtime require graph ───────────────────────────────────────────────
test('module boundary (runtime graph) — loading the boundary surface pulls in NOTHING outside identity/', () => {
  // ⚠ THIS TEST CONSUMES THE FRESH CHILD'S RESULT. It used to do its own
  // in-process walk — evict, snapshot `require.cache`, diff — and that walk
  // was defeated TWICE. The second time is the instructive one: a fix moved the
  // observation into a child process and computed `graph.escapes` there, and
  // then this test went on using the parent walk anyway. The right answer was
  // computed and thrown away. Built is not the same as wired.
  //
  // A single in-process `require` of any core module before this test —
  // which the corpus test performs as a matter of course — put the outside
  // leak in the parent cache, so the parent's `before` snapshot contained it
  // and its `pulled` diff excluded it. The suite returned 24/24 GREEN with a hostile module resident.
  const graph = observeGraph();

  assert.ok(graph.pulled.length > 0,
    'ARRANGEMENT: the child must actually load modules — zero entries would mean this ' +
    'control measured a no-op');

  assert.deepStrictEqual(graph.escapes, [],
    'the boundary surface must not reach outside identity/ — escaped to: ' +
    JSON.stringify(graph.escapes));

  // Said a second way, aimed at the dispatch's exact noun, so a reader does not
  // have to derive it from the general property above.
  const hostServer = graph.escapes.filter(p => path.basename(p) === 'server.js');
  assert.deepStrictEqual(hostServer, [],
    'identity/ must not require a host server.js — found: ' + JSON.stringify(hostServer));

  console.log('  graph (' + graph.members.length + ' modules, observed in a FRESH CHILD) ' +
    'is entirely inside ' + graph.inside);
});

test('module boundary (runtime graph, polluted cache) — a POLLUTED parent cache does not move the observation', () => {
  // The control that stops this being defeated a third time. The attack was
  // a prior in-process load; the defence is that the observation cannot see the
  // parent cache at all. So: pollute the parent deliberately, then prove the
  // answer is byte-identical.
  //
  // Without this, the next person who "simplifies" the graph control back into
  // the parent process gets a green and the defect returns silently.
  const clean = observeGraph();

  F.evictModule();
  for (const name of F.LAND1_SURFACE) F.load(name);        // deliberate pollution
  const parentCacheSize = Object.keys(require.cache).length;
  assert.ok(parentCacheSize > 0, 'ARRANGEMENT: the parent cache must actually be populated');

  const afterPollution = observeGraph();
  assert.deepStrictEqual(afterPollution.pulled.sort(), clean.pulled.sort(),
    'the observed graph must be IDENTICAL before and after the parent cache is polluted — ' +
    'if these differ, the observation is reading this process and Codex\'s attack works again');
  assert.deepStrictEqual(afterPollution.escapes, clean.escapes,
    'the escape set must be unaffected by parent-cache state');
});

test('module boundary (runtime graph control) — the graph control can SEE an escape', () => {
  // The hollow question, asked of the graph control itself: if the core
  // surface DID reach outside identity/, would that filter notice? Proved on
  // synthetic paths rather than by trusting the expression — a filter that can never produce a
  // non-empty list is a control that can only ever pass.
  const inside = fs.realpathSync(F.MODULE_DIR) + path.sep;
  const isEscape = makeEscapeFilter(inside);
  const outsideDir = path.dirname(fs.realpathSync(F.MODULE_DIR));

  // THE ADVERSARIAL ARRANGEMENT. The substring version exempted
  // every one of these; the segment version flags them all. If this assertion
  // is ever loosened back to a substring test, these are the specimens that
  // die first.
  for (const shadow of [
    path.join(outsideDir, 'node_modules_shadow', 'leak.js'),
    path.join(outsideDir, 'my_node_modules', 'leak.js'),
    path.join(outsideDir, 'node_modules.bak', 'leak.js'),
    path.join(outsideDir, 'vendor', 'node_modules_old', 'leak.js'),
  ]) {
    assert.strictEqual(isEscape(shadow), true,
      'a path merely CONTAINING the text node_modules is not a declared dependency and must ' +
      'be flagged as an escape: ' + shadow);
  }
  assert.strictEqual(isDeclaredDependency(path.join(outsideDir, 'node_modules', 'x', 'index.js')), true,
    'the REAL dependency directory must still be exempt, or this repair breaks every clean run');

  assert.strictEqual(isEscape(path.join(inside, 'can.js')), false,
    'a module inside identity/ must NOT be flagged');
  assert.strictEqual(isEscape(path.join(outsideDir, 'node_modules', 'x', 'index.js')), false,
    'a declared dependency must NOT be flagged');
  assert.strictEqual(isEscape(path.join(outsideDir, 'server.js')), true,
    'a host file OUTSIDE identity/ must be flagged — if this is false the control is hollow');
});

// ── the source-text sweep ───────────────────────────────────────────────────
function sweep(files) {
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const token of FORBIDDEN_AUTHORITY_TOKENS) {
        if (line.includes(token)) hits.push(rel(file) + ':' + (i + 1) + ': ' + token);
      }
    });
  }
  return hits;
}

test('module boundary (source sweep) — no host-authority identifier appears in the boundary corpus', () => {
  assert.deepStrictEqual(sweep(observedCorpus()), [],
    'a host authority identifier appears in the boundary surface — ' +
    JSON.stringify(sweep(observedCorpus()), null, 2));
});

test('module boundary (self-count) — the excluded file uses each identifier exactly ONCE, in its declaration', () => {
  // The exclusion above is a hole unless something covers it. This is that
  // cover, by a different rule than the sweep: each identifier may appear once
  // and only once in this file — in the frozen list at the top. A later edit
  // that puts one of them to real use here takes the count to two and fails.
  const source = fs.readFileSync(SELF, 'utf8');
  for (const token of FORBIDDEN_AUTHORITY_TOKENS) {
    const count = source.split(token).length - 1;
    assert.strictEqual(count, 1,
      'the identifier declared in this file\'s frozen list must appear exactly once in it, ' +
      'and one of them appears ' + count + ' times — if that is a real use, it is a leftover ' +
      'door hiding in the only file the sweep does not read');
  }
});

test('module boundary (source sweep control) — the sweep can SEE a planted identifier', () => {
  // Without this, a typo in the list, a scan that reads zero bytes, or a corpus
  // that resolved to nothing all present as a clean sweep. This proves the
  // matcher fires on a planted positive of every identifier it claims to hunt,
  // and stays silent on ordinary module code.
  const planted = fs.mkdtempSync(path.join(require('os').tmpdir(), 'identity-sweep-'));
  try {
    for (const token of FORBIDDEN_AUTHORITY_TOKENS) {
      const file = path.join(planted, 'planted.js');
      fs.writeFileSync(file, 'const authority = ' + token + '(request);\n');
      const hits = sweep([file]);
      assert.strictEqual(hits.length, 1,
        'the sweep must produce exactly one hit on a planted use — got ' + JSON.stringify(hits));
      assert.ok(hits[0].endsWith(': ' + token), 'the hit must name the identifier it found');
    }
    const clean = path.join(planted, 'clean.js');
    fs.writeFileSync(clean, 'const subject = session.subject_id;\n');
    assert.deepStrictEqual(sweep([clean]), [], 'the sweep must NOT fire on ordinary module code');
  } finally {
    fs.rmSync(planted, { recursive: true, force: true });
  }
});
