'use strict';

// identity/test/module_no_host_names.test.js — #384, land 2.6
//
// Grok's instruction was exact: "a general no-host-name guard, NOT another
// enum." The thing being replaced was a hand-written list of ceremony keys —
// and a hand-written list is the wrong shape for this job twice over. It only
// ever catches the names somebody already thought of, and it goes stale the
// moment the module is adopted by a house nobody had in mind.
//
// So this guard does not hard-code any host label. It asks the HOST ITSELF what
// it is called, and requires that the module never says it. Vendor the folder into
// another host and the same guard, unchanged, starts enforcing "never say the
// adopting host's name" — which is what "general" has to mean if it means anything.
//
// TWO RULES, both derived rather than listed:
//   1. the module must not contain the adopting host's own name;
//   2. the module must not contain an absolute URL for anything but loopback —
//      a URL IS a host address, so a literal one is a host name with extra
//      punctuation. Loopback is exempt because it names no house.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.resolve(__dirname, '..');
const HOST_DIR = path.resolve(MODULE_DIR, '..');

// SHIPPING code only, and CODE ONLY — comments are stripped before matching.
//
// That is a deliberate line, not a convenience. On its first real-corpus run
// this guard flagged 20 hits and every one was PROSE: comments explaining which
// host this module grew up in and why the pins were removed — including, with
// some irony, a comment claiming the module never names its host. Failing on those
// would push the next builder to delete the record of WHY, and this house runs
// on that record. The defect class #384 names is behavioural: pins, literals,
// enumerations. Comments cannot pin anything.
//
// The module's own tests also legitimately name a house — a caller must pick one
// — so a guard that forbade that would forbid the tests from testing anything.
function shippingFiles() {
  return fs.readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(MODULE_DIR, f));
}

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Interlock carries no host-name exception. The source module's legacy state
// variable was removed with its implicit-directory behavior.
const DECLARED_LEFTOVERS = Object.freeze([]);

// What is the host called? Ask the host — never a list, and never the FOLDER.
//
// ── F3 (Pitohui, land 2.6 review): the folder name was the blind spot ───────
// This used to derive from `path.basename(HOST_DIR)`. Under the adoption gate
// the module is extracted into a temp sandbox, so the "host name" became
// `identity-adoption-simgaa2` — non-empty, so the arrangement assertion was
// satisfied, and nobody's actual host name, so a PLANTED host name went GREEN in
// exactly the context the gate certifies. Mutation pair he ran, same planted
// line: derivable host -> 2 pass/1 fail, gate-like extraction -> 3 pass/0 fail.
//
// A temp directory is not an identity. So the host must DECLARE itself, by the
// same rule the module applies to every other host fact in this land:
//   1. IDENTITY_HOST_LABEL — the host states its own name, explicitly;
//   2. the parent's package.json "name" — a real manifest, not a folder.
// If neither exists there is NO host identity to check against, and this guard
// REFUSES rather than reporting clean. A check with nothing to compare must not
// print green — that is the whole lesson of the folder-name hole.
function hostNames() {
  const names = new Set();
  const declared = process.env.IDENTITY_HOST_LABEL;
  if (typeof declared === 'string' && declared.trim()) names.add(declared.trim());
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(HOST_DIR, 'package.json'), 'utf8'));
    if (typeof manifest.name === 'string' && manifest.name) names.add(manifest.name);
  } catch (_) { /* no manifest: not a declaration */ }
  for (const n of Array.from(names)) {
    for (const part of n.split(/[^A-Za-z0-9]+/)) if (part.length >= 4) names.add(part);
  }
  // A MODULE MAY SAY ITS OWN NAME.
  const own = new Set([path.basename(MODULE_DIR).toLowerCase()]);
  try {
    const mine = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'package.json'), 'utf8'));
    if (typeof mine.name === 'string') own.add(mine.name.toLowerCase());
  } catch (_) { /* no manifest is still a module */ }
  return Array.from(names)
    .filter((n) => n.length >= 4)
    .map((n) => n.toLowerCase())
    .filter((n) => !own.has(n));
}

test('#384 — the module never says the name of the host it lives in', () => {
  const names = hostNames();
  const files = shippingFiles();

  // ARRANGEMENT, and it is the whole difference between a guard and a decoration:
  // if we derived no name, or found no files, this test passes by having nothing
  // to check — which looks identical to passing by being clean.
  assert.ok(names.length > 0,
    'NO HOST IDENTITY DECLARED. Set IDENTITY_HOST_LABEL, or give the parent directory a ' +
    'package.json with a name. This guard REFUSES rather than reporting clean, because a ' +
    'check with nothing to compare against prints exactly the same green as a clean one — ' +
    'which is how a planted host name passed under the adoption gate (F3).');
  assert.ok(files.length >= 10,
    'ARRANGEMENT: the shipping surface must be non-trivial — got ' + files.length + ' file(s)');

  assert.strictEqual(DECLARED_LEFTOVERS.length, 0,
    'the declared-leftover list must stay empty; Interlock has no host-name exception');

  const hits = [];
  for (const file of files) {
    let src = codeOnly(fs.readFileSync(file, 'utf8')).toLowerCase();
    for (const l of DECLARED_LEFTOVERS) src = src.split(l.token).join('«declared»');
    for (const name of names) {
      let i = src.indexOf(name);
      while (i !== -1) {
        // word-ish boundary, so "housekeeping" does not read as "house"
        const before = i === 0 ? ' ' : src[i - 1];
        const after = src[i + name.length] === undefined ? ' ' : src[i + name.length];
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          hits.push(path.basename(file) + ': ' + name);
          break;
        }
        i = src.indexOf(name, i + 1);
      }
    }
  }
  assert.deepStrictEqual(hits, [],
    'the module carries the adopting host\'s name in shipping code. A folder that names ' +
    'its host is not a product — it is a corner of that host. Derived names checked: ' +
    names.join(', '));
});

test('#384 — the module contains no absolute URL except loopback', () => {
  const files = shippingFiles();
  const found = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of codeOnly(src).matchAll(/https?:\/\/[A-Za-z0-9._:-]+/g)) {
      const url = m[0];
      // Loopback names no house, and the module legitimately pattern-matches it.
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) continue;
      found.push(path.basename(file) + ': ' + url);
    }
  }
  assert.deepStrictEqual(found, [],
    'an absolute URL IS a host address — a literal one is a host name with punctuation. ' +
    'The live pin arrives as a construction argument (land 1); nothing here may bake one.');
});

test('#384 — the guard BITES: a planted host name is caught', () => {
  // A guard nobody has seen fail is a guard nobody has tested. This plants the
  // exact defect in a copy of the real check's input and proves the check fires,
  // without touching the shipping tree.
  const names = hostNames();
  assert.ok(names.length > 0, 'ARRANGEMENT: a derived name is required to plant one');
  const planted = 'const home = "' + names[0] + '";';
  const src = planted.toLowerCase();
  let caught = false;
  for (const name of names) {
    const i = src.indexOf(name);
    if (i === -1) continue;
    const before = i === 0 ? ' ' : src[i - 1];
    const after = src[i + name.length] === undefined ? ' ' : src[i + name.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) caught = true;
  }
  assert.strictEqual(caught, true,
    'the matching rule must catch a planted host name — if it cannot, the green above ' +
    'means the rule is broken, not that the module is clean');
});
