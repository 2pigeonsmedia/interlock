'use strict';

// identity/test/public_construction_probe.js
//
// F3 (Codex, land 2.5 review): the adoption gate said the entry point
// "constructs when given one" and then executed REFUSALS ONLY. A step whose
// TITLE claims more than its body does cannot catch the finding it appears to
// cover — and in this case it structurally could not catch F1.
//
// This probe is the missing half: it CONSTRUCTS through the public entry point
// and drives a real sign-in and a real grant-authorized write, using
// `require('./index.js')` and the module's own shipped fixture arrangement.
// It imports NO host file and reconstructs NO security piece.
//
// It is a plain script, not a *.test.js, so it can be invoked directly by the
// gate inside an extracted archive where no test runner contract is assumed.
// `identity/test/module_public_contract.test.js` runs the same flow in-corpus.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  // The fixture arranges a real person with a real password verifier. It ships
  // WITH the module, so using it is not reaching into a host.
  const F = require('./fixture.js');
  const ctx = await F.fixture();

  // ── everything below this line goes through the PUBLIC entry point ─────────
  const identity = require('../index.js');

  const instance = identity.create({
    stateDir: ctx.dir,
    tenant: 'house',            // #193: the HOST names its house
    cookieName: identity.COOKIE_NAME,
    originClass: 'local',
    hostLabel: 'adoption-gate',
    rpId: 'localhost',                 // the module binds only the localhost RP today
    challengeOrigin: 'http://localhost',
    origin: F.ORIGIN,
    liveOrigin: F.ORIGIN,
  });

  assert.ok(instance && typeof instance === 'object', 'create() must return an instance');
  for (const k of ['service', 'login', 'sessions', 'authorizeWrite', 'authorizeBearer', 'resolveSession', 'grants']) {
    assert.ok(instance[k], 'the public contract must expose ' + k +
      ' — a host that has to build this itself is the boundary problem, not the boundary');
  }

  // ── 1. SIGN IN, through the module's own login service ────────────────────
  const now = Date.now();
  const result = await instance.login.login({
    name: 'Owner',
    password: F.PASSWORD,
    source: '203.0.113.9',
    request_origin: F.ORIGIN,
    sec_fetch_site: 'same-origin',
    now,
  });
  assert.strictEqual(result.ok, true,
    'a fixture person must be able to sign in through the PUBLIC contract; got ' +
    JSON.stringify(result && result.reason));
  assert.ok(result.set_cookie, 'the module must issue its own cookie');
  assert.ok(result.csrf_token, 'the module must issue a CSRF secret');

  const cookieHeader = String(result.set_cookie).split(';')[0];
  assert.ok(cookieHeader.startsWith(identity.COOKIE_NAME + '='),
    'ARRANGEMENT: the cookie must be the module\'s own name, or the write below ' +
    'would be refused for the wrong reason');

  const meta = {
    cookie_header: cookieHeader,
    request_origin: F.ORIGIN,
    sec_fetch_site: 'same-origin',
    csrf_token: result.csrf_token,
    now: Date.now(),
  };

  // ── 2. WITHOUT A GRANT, THE SAME SESSION IS REFUSED ───────────────────────
  // Asserted BEFORE the grant, so the allow below cannot be credited to a
  // permissive default. This is the negative half that makes the positive mean
  // something.
  const before = instance.authorizeWrite(meta, 'write', 'room:main');
  assert.strictEqual(before.allow, false,
    'a valid session with NO grant must be refused at the authorization rung');
  assert.strictEqual(before.rung, 'authorization',
    'it must be refused at the AUTHORIZATION rung, not the session rung — a session ' +
    'failure here would mean this proves nothing about grants');

  // ── 3. GRANT, then the SAME call is allowed ───────────────────────────────
  instance.grants.add({
    tenant: 'house',            // #193: the HOST names its house
    subject_id: ctx.person.id,
    capability: 'write',
    resource: 'room:main',
    origin: 'any',
    assurance: 'L1',
    granted_by: ctx.person.id,
  });

  const after = instance.authorizeWrite(
    Object.assign({}, meta, { now: Date.now(), csrf_token: result.csrf_token }),
    'write', 'room:main');
  assert.strictEqual(after.allow, true,
    'session + grant must be ALLOWED through the public contract; got ' +
    JSON.stringify(after));
  assert.strictEqual(after.subject_id, ctx.person.id,
    'the decision must be about the subject THE SESSION named');

  // ── 4. state stayed inside the directory we named ─────────────────────────
  const store = path.join(ctx.dir, 'identity-state.v2.json');
  assert.ok(fs.existsSync(store),
    'the store must live in the EXPLICIT directory, not somewhere the module chose');

  // ── 5. THE README'S OWN EXAMPLE MUST ACTUALLY CONSTRUCT ───────────────────
  // Codex's R1: the documented canonical example refused immediately
  // ("origin must be one bounded canonical HTTPS origin"). A usage contract that
  // cannot run is worse than no example — a reader debugs their own environment
  // against a configuration that never worked.
  //
  // So the README is not merely corrected, it is PINNED: the first ```js block
  // is extracted and EXECUTED in a child process. If the docs drift from the
  // code, this fails. Where correctness means matching another component,
  // assert the match rather than describing it.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const block = readme.match(/```js\n([\s\S]*?)```/);
  assert.ok(block, 'ARRANGEMENT: the README must contain a js example to execute');
  const example = block[1];
  assert.match(example, /identity\.create\(/,
    'ARRANGEMENT: the extracted block must be the CREATE example, not another snippet');

  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-readme-'));
  const runnable = example
    .replace("require('identity')", "require(" + JSON.stringify(path.join(__dirname, '..', 'index.js')) + ")")
    .replace("'/absolute/path/you/own'", JSON.stringify(docDir))
    + "\nif (!house || !house.service) { throw new Error('the README example produced no instance'); }"
    + "\nconst h = house.service.health();"
    + "\nif (h.ok !== true) { throw new Error('the README example constructed an UNHEALTHY service'); }"
    + "\nprocess.stdout.write('README-EXAMPLE-OK');";
  assert.ok(runnable.includes(docDir) && !runnable.includes("require('identity')"),
    'ARRANGEMENT: both substitutions must have applied, or this executes the wrong thing');

  const scriptPath = path.join(docDir, 'readme_example.js');
  fs.writeFileSync(scriptPath, runnable);
  const out = require('node:child_process').execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8', env: Object.assign({}, process.env, { LEGACY_HOST_STATE_DIR: undefined }),
  });
  assert.match(out, /README-EXAMPLE-OK/,
    'the README example must CONSTRUCT and report healthy — a usage contract that cannot ' +
    'run sends a reader debugging their own environment against a configuration that ' +
    'never worked');

  console.log('PUBLIC-CONSTRUCTION OK — sign-in, refusal without grant, ' +
    'grant-authorized write, state confined to the named directory, README example EXECUTED');
}

main().catch((e) => { console.error('PUBLIC-CONSTRUCTION FAILED: ' + e.message); process.exit(1); });
