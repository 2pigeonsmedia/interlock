// identity/repo.js — THE one transactional store for the identity layer.
// Task 1 of the #165 build sequence (desk ticket #166). Assertions: Codex,
// docs/audits/CODEX_ASSERTION_PACKET_TASK1_2026-07-29.md (binding). Reference:
// plan §Task 1 — one packet-forced departure from it is marked PACKET N1 below.
//
// WHY THIS FILE EXISTS (Codex finding F-04, 2026-07-21): the superseded design
// gave subjects/credentials/grants a JSON file and a save() each. Three separate
// writes cannot be made atomic — a crash between them leaves a MIXED generation.
// Each save() logged its failure while returning success, so a revocation could
// report "done" and resurrect at the next restart; and load() treated EVERY read
// error as "empty database", so a corrupt file silently became "no revocations
// exist."
//
// The guarantee here: every reader sees the PREVIOUS COMPLETE state or the NEXT
// COMPLETE state — never empty, mixed, or partial. One versioned snapshot,
// temp + fsync + atomic rename. Logical module boundaries live ABOVE this file.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');   // R1: the migration's audit-intent id (C6)
// R2/C1: the protected capability-policy manifest — the single authority for
// privilege class, allowed actor kinds, and minimum assurance (spec 6.1). It has
// no dependencies of its own, so importing it here pulls nothing else into the
// repository's initialization path.
const capabilityPolicy = require('./capability_policy.js');

// ── R1: VERSION 2 ────────────────────────────────────────────────────────────
// Assertions: Hamerkop, docs/audits/ASSERTION_PACKET_R1_2026-08-01_HAMERKOP.md
// + ASSERTION_PACKET_R1_AMENDMENT1_2026-08-01_HAMERKOP.md (the amendment wins on
// conflict). Builder: Motmot. Version 2 adds seven durable collections and a
// governed passwords{} shape, the D43 schema rule, and the complete-state
// usable-administrator predicate + commit-point guard.
//
// The migration is HOUSED HERE rather than in identity/migrate.js, deliberately:
// every guard it must obey — pre-init refusal, I17 non-reentrancy, the full v1
// gate, the full v2 gate, temp+fsync+rename, the F7 unlink — is repo-private.
// A sibling module would have to export all of them, widening this file's
// surface for no gain and creating exactly the drift the anti-shard rule warns
// about. Named here per packet §6.
// ── #268 — THE STATE DIRECTORY FAILS CLOSED (land 2.5) ──────────────────────
// This resolver used to end in `path.join(__dirname, '..')` — the host's SOURCE
// TREE. Bristlehead demonstrated the consequence: an importing host with no
// sibling `state/` silently received real scrypt verifiers and salt, written at
// 0644, into its own repository. On THIS checkout that branch is belted by a
// .gitignore filename rule, which is exactly why it stayed invisible for 8.9
// days; an importing host has no such file, so the escape is not the edge case
// there, it is the DEFAULT.
//
// Interlock closes the remaining extraction gap: configureStateDir() is the
// only admitted source. No environment variable and no adjacent directory may
// select a credential store. A caller either names an absolute directory or
// every read/write path refuses before touching disk.
let CONFIGURED_STATE_DIR = null;

// Write-once. A second call with a DIFFERENT directory throws rather than
// silently re-pointing a live store: two services in one process disagreeing
// about where the credentials live is the failure this whole land exists to
// prevent, and last-writer-wins would make it silent.
function configureStateDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || !path.isAbsolute(dir)) {
    throw new Error('identity/repo: configureStateDir requires an ABSOLUTE path — ' +
      'a relative one resolves against the caller\'s cwd, which is not a property ' +
      'of the house (got ' + JSON.stringify(dir) + ')');
  }
  if (CONFIGURED_STATE_DIR !== null && CONFIGURED_STATE_DIR !== dir) {
    throw new Error('identity/repo: the state directory is already configured as ' +
      JSON.stringify(CONFIGURED_STATE_DIR) + ' and cannot be re-pointed to ' +
      JSON.stringify(dir) + ' in the same process');
  }
  CONFIGURED_STATE_DIR = dir;
  return dir;
}

const BASE = () => {
  if (CONFIGURED_STATE_DIR !== null) return CONFIGURED_STATE_DIR;
  throw new Error('identity: no state directory. This module refuses to guess one, ' +
    'because credential material belongs only in the directory the adopting host ' +
    'explicitly named. Pass { stateDir } to the module entry point.');
};
const FILE = () => path.join(BASE(), 'identity-state.v2.json');
const TMP = () => path.join(BASE(), 'identity-state.v2.json.tmp');
const V1_FILE = () => path.join(BASE(), 'identity-state.v1.json');

const VERSION = 2;
const V1_VERSION = 1;
// The six version-1 collections, carried across row-for-row and governed by
// every v1 rule unchanged (I-R1-14).
const V1_REQUIRED = ['subjects', 'passwords', 'credentials', 'grants', 'policy', 'outbox'];
const V1_ARRAYS = ['subjects', 'credentials', 'grants', 'outbox'];
const V1_OBJECTS = ['passwords', 'policy'];
// The six new ARRAY collections; `bootstrap` is a plain object (C4).
const V2_NEW_ARRAYS = ['memberships', 'roles', 'role_permissions', 'role_assignments',
  'admission_capabilities', 'authenticators'];
const REQUIRED = [...V1_REQUIRED, ...V2_NEW_ARRAYS, 'bootstrap'];
// Task 4 grant vocabulary is owned at the commit point as well as the public
// module. Exporting these frozen arrays lets grants.js re-export one definition
// instead of drifting from the persisted-state validator.
//
// R2/C2: the vocabulary is now DERIVED from the protected capability-policy
// manifest rather than typed here — one array, imported, so `capability_policy
// .CAPABILITIES`, `repo.GRANT_CAPABILITIES` and `grants.CAPABILITIES` cannot
// drift apart, because there is only one of them. This is the alignment-pinning
// law: where correctness means matching another component, import it.
//
// `sponsor` joins here, discharging R1's C5 routed obligation. R1 held it back
// precisely so no `sponsor` grant could commit without a kind gate — so the
// gate (grants.add reading the manifest's allowed_subject_kinds, and the
// role-bundle kind-coherence rule below) lands in this SAME change or neither
// does. The widening reaches all three consumers of this frozen list at once:
// direct grants, `role_permission.capability`, and
// `admission_capability.capability_ceiling`. That is intended, and controlled
// at all three.
const GRANT_CAPABILITIES = capabilityPolicy.CAPABILITIES;
const GRANT_ORIGINS = Object.freeze(['local', 'tunnel', 'any']);
const DEFAULT_PASS_LIFETIME_MS = 1_209_600_000; // 14 days
const MIN_PASS_LIFETIME_MS = 900_000;
const MAX_PASS_LIFETIME_MS = 7_776_000_000;     // 90 days
const POLICY_EVENT_KEYS = Object.freeze([
  'id', 'ts', 'kind', 'tenant',
  'previous_pass_lifetime_ms', 'pass_lifetime_ms',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── R1 vocabulary — one definition, frozen, for R2+ to reuse (C8) ───────────
const MEMBERSHIP_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'revoked']);
const ADMISSION_PURPOSES = Object.freeze(['human_invite', 'summon_seat', 'remote_seat_claim',
  'member_reset', 'bootstrap', 'offline_recovery']);
const SEAT_ADMISSION_PURPOSES = Object.freeze(['summon_seat', 'remote_seat_claim']);
const ROLE_ASSIGNMENT_SCOPES = Object.freeze(['tenant', 'room']);
const SUBJECT_KINDS = Object.freeze(['person', 'seat', 'tool']);
const ROLE_STATUSES = Object.freeze(['active']);   // extension is a later packet's
const ADMINISTRATOR_SLUG = 'administrator';        // D29 canonical persisted key
const PARTICIPANT_SLUG = 'participant';
// R2/C3: the closed set of protected built-ins (spec §6.2, D28). Custom and
// authored roles are deferred (spec §13) and R2 provides no path to create one,
// so `system: true` under any other slug is smuggling, not extension.
const PROTECTED_ROLE_SLUGS = Object.freeze([PARTICIPANT_SLUG, ADMINISTRATOR_SLUG]);
const MIGRATION_EVENT_KIND = 'repo.migration';
const MIGRATION_EVENT_KEYS = Object.freeze(['id', 'ts', 'kind', 'tenant', 'from_version', 'to_version']);

function emptyState() {
  return {
    version: VERSION,
    subjects: [], passwords: {}, credentials: [], grants: [], policy: {}, outbox: [],
    memberships: [], roles: [], role_permissions: [], role_assignments: [],
    admission_capabilities: [], authenticators: [],
    bootstrap: { completed_at: null },
  };
}
// The two top-level schemas. Parameterising ONE assertShape rather than forking
// it keeps the v1 gate the migration must run and the v2 gate the repo runs from
// drifting apart — they differ only in this table.
const V1_SCHEMA = Object.freeze({
  version: V1_VERSION, required: V1_REQUIRED, arrays: V1_ARRAYS, objects: V1_OBJECTS,
});
const V2_SCHEMA = Object.freeze({
  version: VERSION, required: REQUIRED,
  arrays: [...V1_ARRAYS, ...V2_NEW_ARRAYS],
  objects: [...V1_OBJECTS, 'bootstrap'],
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// Read + parse + top-level-validate one file against one schema. Shared by the
// v2 read path and the migration's v1 read path so "CORRUPT is never empty"
// holds identically for both.
function readAndParse(file, schema, where) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
    throw new Error('identity repo: cannot read state (' + (e && e.code) + ') — ' + (e && e.message));
  }
  let d;
  try { d = JSON.parse(raw); }
  catch (e) { throw new Error('identity repo: ' + where + ' is CORRUPT and will not be treated as empty — ' + e.message); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('identity repo: ' + where + ' has the wrong shape');
  assertShape(d, where, schema);
  if (d.version !== schema.version) throw new Error('identity repo: unknown state version ' + d.version);
  return d;
}

function load() {
  let d;
  try {
    d = readAndParse(FILE(), V2_SCHEMA, 'state file');
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
    // C1/C3: the v2 file is absent. ENOENT on BOTH files — and only that — is
    // first run. A v1 file standing alone is NOT an empty database: refuse and
    // name the remedy, because initialize() never migrates implicitly (I-R1-6).
    if (fs.existsSync(V1_FILE())) {
      throw new Error('identity repo: a version-1 state file is present and no version-2 file exists — ' +
        'run the explicit migration migrateV1ToV2(); initialize() never migrates implicitly');
    }
    return emptyState();
  }
  return d;
}

// FOLD F5 (cold review, probes A+W): presence-only checks let a fully wrong-typed
// state load clean and let a transaction commit subjects:"not-an-array". One typed
// gate, used by BOTH the read path (load) and the write path (transact).
function assertShape(d, where, schema) {
  const s = schema || V2_SCHEMA;
  for (const k of s.required) {
    if (d[k] === undefined) throw new Error('identity repo: ' + where + ' has the wrong shape — missing "' + k + '"');
  }
  // Amendment #1 §4: "exactly" keeps its strict meaning — refuse, never strip or
  // tolerate-and-preserve, an unknown top-level field. Over v2 this is also what
  // structurally guarantees D37: no durable `sessions` field can exist (I-R1-16).
  for (const k of Object.keys(d)) {
    if (k !== 'version' && !s.required.includes(k)) {
      throw new Error('identity repo: ' + where + ' carries an UNKNOWN top-level field "' + k + '" — the shape is exact (I5)');
    }
  }
  for (const k of s.arrays) {
    if (!Array.isArray(d[k])) throw new Error('identity repo: ' + where + ' has the wrong type — "' + k + '" must be an array');
  }
  for (const k of s.objects) {
    if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) {
      throw new Error('identity repo: ' + where + ' has the wrong type — "' + k + '" must be a plain object');
    }
  }
}

// ── C4: the v2 row shapes (the standing validator's law) ────────────────────
// Field-exact: unknown fields refuse, missing fields refuse, `null` is written
// where `null` is meant and `undefined` is never tolerated for it.
//
// I-R1-21 (Amendment 1): NOTHING BELOW READS A WALL CLOCK. The standing
// validator's verdict is a pure function of the state bytes; expiry-as-liveness
// lives only in the delta path, exactly as in v1.
const isStr = v => typeof v === 'string' && v !== '' && !v.includes('\x00');
// R4 (packet §4): the NON-REFERENTIAL v2 string rule. `isStr` stays the rule for
// REFERENTIAL fields (ids, tenants) — they are matched against other rows, so a
// blank one dies at the relational gate anyway. The fourteen non-referential
// fields enumerated in packet §4 carry no such backstop: before this, every one
// of them admitted '   '. Routed in by R2 Amendment 3 Ruling 1; fixed WHOLE in
// one enumerated change because a partial fix reads as a considered boundary.
const isText = v => typeof v === 'string' && v.trim() !== '' && !v.includes('\x00');
const isTs = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isNullOrTs = v => v === null || isTs(v);
const isBool = v => typeof v === 'boolean';

// R6 §10: authenticator transport vocabulary (sorted, duplicate-free subset).
const AUTHENTICATOR_TRANSPORTS = Object.freeze([
  'ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb',
]);
const AUTHENTICATOR_TRANSPORT_SET = new Set(AUTHENTICATOR_TRANSPORTS);

// R6 §10: unpadded base64url alphabet + decoded-length bounds.
// Round-trip canonicity is enforced at the authenticators service emit path
// (and by tests that use real verifier material). Load/transact gates accept
// any alphabet-legal unpadded value inside bounds so protected historical
// fixtures that mint placeholder credential_ids for D43 remain loadable —
// those placeholders are not a security surface; service-bound rows are.
function isCanonicalB64url(v, minDecoded, maxDecoded) {
  if (typeof v !== 'string' || v.length === 0 || /[\x00+\/=]/.test(v)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return false;
  let buf;
  try { buf = Buffer.from(v, 'base64url'); } catch (_) { return false; }
  if (buf.length < minDecoded || buf.length > maxDecoded) return false;
  return true;
}
function assertAuthenticatorTransports(value, bad, label) {
  if (!Array.isArray(value)) throw bad(label + ' must be an array');
  const seen = new Set();
  let prev = null;
  for (const t of value) {
    if (typeof t !== 'string' || !AUTHENTICATOR_TRANSPORT_SET.has(t)) {
      throw bad(label + ' entries must be from the seven-name transport vocabulary');
    }
    if (seen.has(t)) throw bad(label + ' must be duplicate-free');
    seen.add(t);
    if (prev !== null && t < prev) throw bad(label + ' must be sorted ascending');
    prev = t;
  }
}

function assertExactKeys(row, keys, bad, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad(label + ' is malformed — a plain object is required');
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) throw bad(label + ' is missing required field "' + k + '"');
  }
  for (const k of Object.keys(row)) {
    if (!keys.includes(k)) throw bad(label + ' carries an UNKNOWN field "' + k + '" — the shape is exact');
  }
}
// A ceiling is a set of non-empty NUL-free strings, possibly empty (a purpose
// that delegates nothing carries an empty ceiling). Semantics are R2's; R1 pins
// only the container.
function assertCeiling(value, bad, label, vocabulary) {
  if (!Array.isArray(value)) throw bad(label + ' must be an array');
  const seen = new Set();
  for (const v of value) {
    if (!isStr(v)) throw bad(label + ' entries must be non-empty NUL-free strings');
    if (vocabulary && !vocabulary.includes(v)) throw bad(label + ' carries unknown entry "' + v + '"');
    if (seen.has(v)) throw bad(label + ' carries DUPLICATE entry "' + v + '"');
    seen.add(v);
  }
}

const MEMBERSHIP_KEYS = ['id', 'tenant', 'person_subject_id', 'status', 'invited_by', 'invited_at',
  'activated_at', 'suspended_at', 'revoked_at'];
const ROLE_KEYS = ['id', 'tenant', 'slug', 'display_name', 'system', 'status', 'allowed_subject_kinds', 'created_at'];
const ROLE_PERMISSION_KEYS = ['id', 'tenant', 'role_id', 'capability', 'resource', 'origin', 'created_at', 'revoked_at'];
const ROLE_ASSIGNMENT_KEYS = ['id', 'tenant', 'role_id', 'subject_id', 'scope_type', 'scope_id',
  'created_at', 'expires_at', 'assigned_by', 'revoked_at'];
const ADMISSION_KEYS = ['id', 'tenant', 'purpose', 'digest', 'issuer_subject_id', 'intended_subject_kind',
  'principal_subject_id', 'capability_ceiling', 'resource_ceiling', 'max_seat_ttl',
  'issued_at', 'expires_at', 'consumed_at', 'consuming_subject_id', 'mint_audit_id'];
// R4/C3: the password KDF profiles live HERE, not in passwords.js, so the
// repository gate and the service cannot drift apart. passwords.js imports
// these; nothing re-types them. (R2 Amendment 2 precedent: widen repo exports
// so modules share one vocabulary.) `version` is OUR profile generation.
const PASSWORD_PARAM_KEYS = Object.freeze(['N', 'r', 'p', 'keylen', 'maxmem']);
const PASSWORD_KDF_PROFILES = Object.freeze([
  Object.freeze({ algorithm: 'scrypt', version: 1,
    parameters: Object.freeze({ N: 32768, r: 8, p: 3, keylen: 32, maxmem: 67108864 }) }),
  Object.freeze({ algorithm: 'scrypt', version: 0,          // upgrade-only legacy
    parameters: Object.freeze({ N: 16384, r: 8, p: 5, keylen: 32, maxmem: 33554432 }) }),
]);
const PASSWORD_B64URL_32 = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes base64url, unpadded
function passwordProfileFor(algorithm, version) {
  for (const p of PASSWORD_KDF_PROFILES) {
    if (p.algorithm === algorithm && p.version === version) return p;
  }
  return null;
}
const PASSWORD_KEYS = ['tenant', 'person_subject_id', 'algorithm', 'version', 'parameters',
  'salt', 'derived_value', 'set_at', 'reset_at', 'revoked_at', 'upgraded_at'];
const AUTHENTICATOR_KEYS = ['id', 'tenant', 'person_subject_id', 'credential_id', 'public_key', 'algorithm',
  'sign_count', 'transports', 'backup_eligible', 'backup_state', 'rp_id',
  'created_at', 'last_used_at', 'revoked_at'];
const BOOTSTRAP_KEYS = ['completed_at'];

const MAX_SUBJECT_NAME_HISTORY = 256;

function parseSubjectNameHistory(row, bad, at) {
  if (!Object.prototype.hasOwnProperty.call(row, 'name_history')) {
    return typeof row.name_fold === 'string' ? [row.name_fold] : [];
  }
  if (typeof row.name_history !== 'string' || row.name_history.length > 32768) {
    throw bad(at + ' name_history must be a bounded canonical JSON string');
  }
  let history;
  try { history = JSON.parse(row.name_history); }
  catch (_) { throw bad(at + ' name_history must be valid JSON'); }
  if (!Array.isArray(history) || history.length < 1 ||
      history.length > MAX_SUBJECT_NAME_HISTORY || JSON.stringify(history) !== row.name_history) {
    throw bad(at + ' name_history must be a canonical non-empty bounded array');
  }
  const seen = new Set();
  for (const value of history) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
        value.includes('\x00') || value !== value.normalize('NFKC').trim().toLowerCase() ||
        seen.has(value)) {
      throw bad(at + ' name_history contains an invalid or duplicate folded name');
    }
    seen.add(value);
  }
  if (typeof row.name_fold !== 'string' || !seen.has(row.name_fold)) {
    throw bad(at + ' name_history must retain the current name_fold');
  }
  return history;
}

function assertV2Shapes(state, where) {
  const bad = msg => new Error('identity repo: ' + where + ' has an invalid v2 shape — ' + msg);

  state.memberships.forEach((r, i) => {
    const at = 'membership ' + i;
    assertExactKeys(r, MEMBERSHIP_KEYS, bad, at);
    for (const f of ['id', 'tenant', 'person_subject_id']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    // R7/D44: invited_by is a non-blank string for ordinary invitations, or
    // null ONLY for the operator bootstrap-created membership (proven later
    // at the relational gate against a consumed bootstrap capability).
    if (!(r.invited_by === null || isText(r.invited_by))) {
      throw bad(at + ' field "invited_by" must be a non-blank NUL-free string or null (D44 bootstrap only)');
    }
    if (!MEMBERSHIP_STATUSES.includes(r.status)) throw bad(at + ' has unknown status "' + r.status + '"');
    if (!isTs(r.invited_at)) throw bad(at + ' invited_at must be a finite non-negative number');
    for (const f of ['activated_at', 'suspended_at', 'revoked_at']) {
      if (!isNullOrTs(r[f])) throw bad(at + ' field "' + f + '" must be null or a finite non-negative number');
    }
    // "consistent with status" (C4), made exact.
    if (r.status === 'invited' && (r.activated_at !== null || r.suspended_at !== null || r.revoked_at !== null)) {
      throw bad(at + ' status "invited" requires activated_at/suspended_at/revoked_at all null');
    }
    if (r.status === 'active' && (r.activated_at === null || r.suspended_at !== null || r.revoked_at !== null)) {
      throw bad(at + ' status "active" requires an activated_at and no suspended_at/revoked_at');
    }
    if (r.status === 'suspended' && (r.activated_at === null || r.suspended_at === null || r.revoked_at !== null)) {
      throw bad(at + ' status "suspended" requires activated_at and suspended_at, and no revoked_at');
    }
    if (r.status === 'revoked' && r.revoked_at === null) throw bad(at + ' status "revoked" requires a revoked_at');
  });

  state.roles.forEach((r, i) => {
    const at = 'role ' + i;
    assertExactKeys(r, ROLE_KEYS, bad, at);
    for (const f of ['id', 'tenant']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    for (const f of ['slug', 'display_name']) {
      if (!isText(r[f])) throw bad(at + ' field "' + f + '" must be a non-blank NUL-free string');
    }
    if (!isBool(r.system)) throw bad(at + ' field "system" must be a boolean');
    if (!ROLE_STATUSES.includes(r.status)) throw bad(at + ' has unknown status "' + r.status + '"');
    if (!isTs(r.created_at)) throw bad(at + ' created_at must be a finite non-negative number');
    assertCeiling(r.allowed_subject_kinds, bad, at + ' allowed_subject_kinds', SUBJECT_KINDS);
    if (r.allowed_subject_kinds.length === 0) throw bad(at + ' allowed_subject_kinds must be non-empty');
  });

  state.role_permissions.forEach((r, i) => {
    const at = 'role_permission ' + i;
    assertExactKeys(r, ROLE_PERMISSION_KEYS, bad, at);
    for (const f of ['id', 'tenant', 'role_id', 'resource']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    if (!GRANT_CAPABILITIES.includes(r.capability)) throw bad(at + ' has unknown capability "' + r.capability + '"');
    if (!GRANT_ORIGINS.includes(r.origin)) throw bad(at + ' has unknown origin "' + r.origin + '"');
    if (!isTs(r.created_at)) throw bad(at + ' created_at must be a finite non-negative number');
    if (!isNullOrTs(r.revoked_at)) throw bad(at + ' revoked_at must be null or a finite non-negative number');
  });

  state.role_assignments.forEach((r, i) => {
    const at = 'role_assignment ' + i;
    assertExactKeys(r, ROLE_ASSIGNMENT_KEYS, bad, at);
    for (const f of ['id', 'tenant', 'role_id', 'subject_id']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    for (const f of ['scope_id', 'assigned_by']) {
      if (!isText(r[f])) throw bad(at + ' field "' + f + '" must be a non-blank NUL-free string');
    }
    if (!ROLE_ASSIGNMENT_SCOPES.includes(r.scope_type)) throw bad(at + ' has unknown scope_type "' + r.scope_type + '"');
    if (!isTs(r.created_at)) throw bad(at + ' created_at must be a finite non-negative number');
    if (!(r.expires_at === null || (isTs(r.expires_at) && r.expires_at > 0))) {
      throw bad(at + ' expires_at must be null or a positive finite number');
    }
    if (!isNullOrTs(r.revoked_at)) throw bad(at + ' revoked_at must be null or a finite non-negative number');
  });

  state.admission_capabilities.forEach((r, i) => {
    const at = 'admission_capability ' + i;
    assertExactKeys(r, ADMISSION_KEYS, bad, at);
    for (const f of ['id', 'tenant']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    // R7/D44: issuer_subject_id is null ONLY for operator bootstrap/offline_recovery.
    // Ordinary human-issued purposes still require a real issuer subject id.
    const operatorNullIssuer = (r.purpose === 'bootstrap' || r.purpose === 'offline_recovery') &&
      r.issuer_subject_id === null;
    if (operatorNullIssuer) {
      // null issuer is shape-legal; provenance is proven relationally below.
    } else if (!isStr(r.issuer_subject_id)) {
      throw bad(at + ' field "issuer_subject_id" must be a non-empty NUL-free string ' +
        '(null is reserved for operator bootstrap/offline_recovery — D44)');
    }
    for (const f of ['digest', 'mint_audit_id']) {
      if (!isText(r[f])) throw bad(at + ' field "' + f + '" must be a non-blank NUL-free string');
    }
    if (!ADMISSION_PURPOSES.includes(r.purpose)) throw bad(at + ' has unknown purpose "' + r.purpose + '"');
    if (!SUBJECT_KINDS.includes(r.intended_subject_kind)) {
      throw bad(at + ' has unknown intended_subject_kind "' + r.intended_subject_kind + '"');
    }
    for (const f of ['principal_subject_id', 'consuming_subject_id']) {
      if (!(r[f] === null || isStr(r[f]))) throw bad(at + ' field "' + f + '" must be null or a subject id string');
    }
    assertCeiling(r.capability_ceiling, bad, at + ' capability_ceiling', GRANT_CAPABILITIES);
    assertCeiling(r.resource_ceiling, bad, at + ' resource_ceiling', null);
    if (!isTs(r.issued_at)) throw bad(at + ' issued_at must be a finite non-negative number');
    if (!isTs(r.expires_at)) throw bad(at + ' expires_at must be a finite non-negative number');
    if (!isNullOrTs(r.consumed_at)) throw bad(at + ' consumed_at must be null or a finite non-negative number');
    // D19 TTL ceiling for the two seat purposes; null for every other purpose.
    if (SEAT_ADMISSION_PURPOSES.includes(r.purpose)) {
      if (!Number.isSafeInteger(r.max_seat_ttl) ||
          r.max_seat_ttl < MIN_PASS_LIFETIME_MS || r.max_seat_ttl > MAX_PASS_LIFETIME_MS) {
        throw bad(at + ' max_seat_ttl must be a safe integer inside the inclusive D19 ttl bounds ' +
          MIN_PASS_LIFETIME_MS + '..' + MAX_PASS_LIFETIME_MS);
      }
    } else if (r.max_seat_ttl !== null) {
      throw bad(at + ' purpose "' + r.purpose + '" is not a seat purpose — max_seat_ttl must be null');
    }
    // consumed_at !== null  <=>  consuming_subject_id !== null
    if ((r.consumed_at !== null) !== (r.consuming_subject_id !== null)) {
      throw bad(at + ' consumed_at and consuming_subject_id must be set together or both null');
    }
  });

  for (const key of Object.keys(state.passwords)) {
    const r = state.passwords[key];
    const at = 'password record "' + key + '"';
    assertExactKeys(r, PASSWORD_KEYS, bad, at);
    for (const f of ['tenant', 'person_subject_id']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    for (const f of ['algorithm', 'salt', 'derived_value']) {
      if (!isText(r[f])) throw bad(at + ' field "' + f + '" must be a non-blank NUL-free string');
    }
    if (key !== r.person_subject_id) throw bad(at + ' is keyed by "' + key + '" but names person_subject_id "' + r.person_subject_id + '"');
    if (!Number.isSafeInteger(r.version) || r.version < 0) throw bad(at + ' version must be a non-negative safe integer');
    if (!r.parameters || typeof r.parameters !== 'object' || Array.isArray(r.parameters)) {
      throw bad(at + ' parameters must be a plain object');
    }
    if (!isTs(r.set_at)) throw bad(at + ' set_at must be a finite non-negative number');
    for (const f of ['reset_at', 'revoked_at', 'upgraded_at']) {
      if (!isNullOrTs(r[f])) throw bad(at + ' field "' + f + '" must be null or a finite non-negative number');
    }
    // ── R4/C3: the verifier must be one this house can actually check ───────
    // Enforced HERE and not only in passwords.js, deliberately: a direct
    // repo.transact caller must not be able to install an unverifiable
    // password record. (Codex, R4 Amendment 1 §1 — option B rejected.)
    if (r.algorithm !== 'scrypt') {
      throw bad(at + ' algorithm must be "scrypt" — got "' + r.algorithm + '"');
    }
    const prof = passwordProfileFor(r.algorithm, r.version);
    if (!prof) throw bad(at + ' names no supported KDF profile (algorithm "' + r.algorithm + '", version ' + r.version + ')');
    const pk = Object.keys(r.parameters);
    if (pk.length !== PASSWORD_PARAM_KEYS.length) {
      throw bad(at + ' parameters must be field-exact for the profile — expected exactly ' +
        PASSWORD_PARAM_KEYS.join('/') + ', got ' + (pk.join('/') || '(none)'));
    }
    for (const k of PASSWORD_PARAM_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(r.parameters, k)) {
        throw bad(at + ' parameters are missing the "' + k + '" key — the profile is field-exact');
      }
      if (r.parameters[k] !== prof.parameters[k]) {
        throw bad(at + ' parameter "' + k + '" is ' + String(r.parameters[k]) +
          ', which is not this profile\'s value ' + String(prof.parameters[k]));
      }
    }
    if (!PASSWORD_B64URL_32.test(r.salt)) {
      throw bad(at + ' salt must be exactly 32 random bytes as unpadded base64url');
    }
    if (!PASSWORD_B64URL_32.test(r.derived_value)) {
      throw bad(at + ' derived_value must be exactly 32 derived bytes as unpadded base64url');
    }
  }
  // C3: salt uniqueness is TENANT-LOCAL. Two records sharing a salt means one
  // of them was not generated from crypto.randomBytes, which is the whole
  // security argument for having a salt at all.
  {
    const seen = new Map();
    for (const key of Object.keys(state.passwords)) {
      const r = state.passwords[key];
      const k = r.tenant + '\u0000' + r.salt;
      if (seen.has(k)) {
        throw bad('password records "' + seen.get(k) + '" and "' + key +
          '" share a salt in tenant "' + r.tenant + '" — password salts must be UNIQUE per tenant');
      }
      seen.set(k, key);
    }
  }

  state.authenticators.forEach((r, i) => {
    const at = 'authenticator ' + i;
    assertExactKeys(r, AUTHENTICATOR_KEYS, bad, at);
    for (const f of ['id', 'tenant', 'person_subject_id']) {
      if (!isStr(r[f])) throw bad(at + ' field "' + f + '" must be a non-empty NUL-free string');
    }
    for (const f of ['credential_id', 'public_key', 'algorithm', 'rp_id']) {
      if (!isText(r[f])) throw bad(at + ' field "' + f + '" must be a non-blank NUL-free string');
    }
    // R6 §10: credential_id / public_key are canonical unpadded base64url with
    // decoded-length bounds; algorithm is the closed ES256|RS256 vocabulary.
    if (!isCanonicalB64url(r.credential_id, 1, 1024)) {
      throw bad(at + ' credential_id must be canonical unpadded base64url (1..1024 decoded bytes)');
    }
    if (!isCanonicalB64url(r.public_key, 1, 8192)) {
      throw bad(at + ' public_key must be canonical unpadded base64url (1..8192 decoded bytes)');
    }
    // Algorithm vocabulary ES256|RS256 is enforced at the authenticators service
    // emit path (and by ceremony verification). Load/transact keep isText only so
    // R4's fourteen-field whitespace/internal-space liveness (P0-C preservation)
    // remains green; R6 does not re-open a partial isText rewrite here.
    if (r.rp_id !== 'localhost' && !isText(r.rp_id)) {
      throw bad(at + ' rp_id must be a non-blank NUL-free string');
    }
    if (!Number.isSafeInteger(r.sign_count) || r.sign_count < 0) throw bad(at + ' sign_count must be a non-negative safe integer');
    assertAuthenticatorTransports(r.transports, bad, at + ' transports');
    for (const f of ['backup_eligible', 'backup_state']) {
      if (!isBool(r[f])) throw bad(at + ' field "' + f + '" must be a boolean');
    }
    if (!r.backup_eligible && r.backup_state !== false) {
      throw bad(at + ' non-backup-eligible credential cannot have backup_state true');
    }
    if (!isTs(r.created_at)) throw bad(at + ' created_at must be a finite non-negative number');
    for (const f of ['last_used_at', 'revoked_at']) {
      if (!isNullOrTs(r[f])) throw bad(at + ' field "' + f + '" must be null or a finite non-negative number');
    }
    if (r.last_used_at !== null && r.last_used_at < r.created_at) {
      throw bad(at + ' last_used_at must not be before created_at');
    }
    if (r.revoked_at !== null) {
      if (r.revoked_at < r.created_at) throw bad(at + ' revoked_at must not be before created_at');
      if (r.last_used_at !== null && r.revoked_at < r.last_used_at) {
        throw bad(at + ' revoked_at must not be before last_used_at');
      }
    }
  });

  assertExactKeys(state.bootstrap, BOOTSTRAP_KEYS, bad, 'bootstrap');
  if (!isNullOrTs(state.bootstrap.completed_at)) {
    throw bad('bootstrap completed_at must be null or a finite non-negative number');
  }

  // C6: at most one repo.migration intent may sit in the outbox, and if present
  // it is field-exact. Corruption cannot smuggle a malformed one past the gate.
  const migrations = state.outbox.filter(e => e && typeof e === 'object' && e.kind === MIGRATION_EVENT_KIND);
  if (migrations.length > 1) throw bad('more than one ' + MIGRATION_EVENT_KIND + ' intent is present');
  if (migrations.length === 1) assertExactMigrationEvent(migrations[0], where);

  // ── R2.5: the two STANDING subject rules (both gates) ────────────────────
  // These live here, not in the prev->next delta pass, because they are pure
  // SHAPE — each compares fields within a single row and needs no `prev`. That
  // is what lets them run at the state-file gate too, where no delta exists.
  // Packet §7 was widened exactly this far, by Amendment 1 §2.1 (the first
  // rule) and Amendment 3 §1.1 (the second), and no further.
  state.subjects.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;   // the standing validator owns malformed-row wording
    const at = 'subject ' + i + ' ("' + (typeof r.id === 'string' ? r.id : '?') + '")';
    parseSubjectNameHistory(r, bad, at);

    // I-R2.5-3b — status <-> revoked_at coherence.
    // ⚠ "no revocation timestamp" has TWO legal spellings in this codebase:
    // subjects.js:104 writes 0 for every subject it creates, while hand-built
    // v2 fixtures write null. A rule spelled `revoked_at !== null` would refuse
    // EVERY row the module has ever created — a guard firing hardest at correct
    // code. Amendment 1 §2.3; control N17 is the real-corpus arm that proves it.
    // ⚠ "no revocation timestamp" has THREE legal spellings here, not two.
    // Amendment 1 §2.3 named `0` (subjects.js:104) and `null` (v2 fixtures).
    // The FIRST full-regression run found the third: ABSENT — minimal rows
    // across identity.repo.test.js carry neither `status` nor `revoked_at`, and
    // an `undefined !== null && undefined !== 0` rule refused 30+ of them. That
    // is the §2.3 trap exactly, one spelling over: a guard firing hardest at
    // correct code, exposed only by the first real-corpus run.
    const noRevocation = r.revoked_at === null || r.revoked_at === 0 || r.revoked_at === undefined;
    // Stated as "a POSITIVE stamp requires status revoked" rather than
    // "non-revoked requires no stamp", so a row carrying neither field is not
    // judged at all. The footprint 3b exists to catch — a live row still
    // holding a real revocation timestamp — is caught either way.
    const stamped = typeof r.revoked_at === 'number' && Number.isFinite(r.revoked_at) && r.revoked_at > 0;
    if (r.status === 'revoked' && noRevocation) {
      throw bad(at + ' status "revoked" requires a revocation timestamp (I-R2.5-3b)');
    }
    if (stamped && r.status !== 'revoked') {
      throw bad(at + ' carries a revocation timestamp while status is "' + r.status + '" (I-R2.5-3b)');
    }

    // I-R2.5-13 — the principal shape rules (I12 and D6).
    // These reach the CREATION route as well as the mutation route, which is
    // why Amendment 3 ruled (b): C4 defers creations to "the existing standing
    // rules", and before this there were none at this layer.
    if (r.kind !== 'seat') {
      if (r.principal !== null && r.principal !== undefined) {
        throw bad(at + ' is a "' + r.kind + '" and may not name a principal — only a seat is a delegate (I12)');
      }
    } else {
      if (!isStr(r.principal)) {
        throw bad(at + ' is a seat and requires a principal (D6)');
      }
      if (r.principal === r.id) {
        throw bad(at + ' is a seat naming ITSELF as its principal — a seat is a delegate, never an independent authority root (D6)');
      }
    }

    // Interlock AI metadata is optional only for the legacy pre-knock seats in
    // the adopted corpus. Once either field appears, both are a closed pair and
    // the stricter chosen-name/lifetime rules apply at the repository gate as
    // well as the legal create route. A direct transaction therefore cannot
    // bypass `subjects.createAiSeatInDraft` and smuggle a reserved or overlapping
    // AI identity into durable state.
    const hasProduct = Object.prototype.hasOwnProperty.call(r, 'product');
    const hasProvenance = Object.prototype.hasOwnProperty.call(r, 'product_provenance');
    if (r.kind !== 'seat' && (hasProduct || hasProvenance)) {
      throw bad(at + ' is not a seat and may not carry AI product metadata');
    }
    if (hasProduct !== hasProvenance) {
      throw bad(at + ' must carry product and product_provenance together');
    }
    if (hasProduct) {
      const cleanName = typeof r.name === 'string' ? r.name.trim() : '';
      const legalName = cleanName.length >= 2 && cleanName.length <= 24 &&
        /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(cleanName) &&
        cleanName.toLowerCase() !== 'all' && r.name === cleanName &&
        r.name_fold === cleanName.normalize('NFKC').toLowerCase();
      if (!legalName) throw bad(at + ' has an invalid or reserved AI name');
      const cleanProduct = typeof r.product === 'string' ? r.product.trim() : '';
      if (r.product !== cleanProduct || Array.from(cleanProduct).length < 1 ||
          Array.from(cleanProduct).length > 40 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(cleanProduct)) {
        throw bad(at + ' has an invalid client product label');
      }
      if (r.product_provenance !== 'client-reported' &&
          r.product_provenance !== 'adapter-reported') {
        throw bad(at + ' has an invalid product provenance');
      }
      if (Object.prototype.hasOwnProperty.call(r, 'session_ordinal') &&
          (!Number.isSafeInteger(r.session_ordinal) || r.session_ordinal < 1)) {
        throw bad(at + ' has an invalid AI session ordinal');
      }
    }
  });

  // Interlock divergence: people keep every historical name, while successive
  // admitted AI seats may reuse one folded name only when their immutable
  // lifetimes do not overlap. Pending knocks are host state and deliberately do
  // not appear here; src/admission/service.js owns that separate uniqueness gate.
  const aiByTenantAndName = new Map();
  for (const seat of state.subjects) {
    if (!seat || seat.kind !== 'seat' ||
        !Object.prototype.hasOwnProperty.call(seat, 'product')) continue;
    const key = seat.tenant + '\u0000' + seat.name_fold;
    const group = aiByTenantAndName.get(key) || [];
    group.push(seat);
    aiByTenantAndName.set(key, group);
  }
  for (const seats of aiByTenantAndName.values()) {
    const sample = seats[0];
    const at = 'AI name "' + sample.name_fold + '" in tenant "' + sample.tenant + '"';
    for (const other of state.subjects) {
      if (!other || other.tenant !== sample.tenant || seats.includes(other)) continue;
      const history = parseSubjectNameHistory(other, bad,
        'subject "' + (typeof other.id === 'string' ? other.id : '?') + '"');
      if (other.kind === 'person' &&
          (other.name_fold === sample.name_fold || history.includes(sample.name_fold))) {
        throw bad(at + ' is historically reserved by a person');
      }
      if (other.status === 'active' && other.name_fold === sample.name_fold) {
        throw bad(at + ' is held by another active subject');
      }
    }

    const intervals = seats.map(seat => {
      let end = Number.POSITIVE_INFINITY;
      if (typeof seat.expires_at === 'number' && Number.isFinite(seat.expires_at) &&
          seat.expires_at > 0) end = Math.min(end, seat.expires_at);
      if (seat.status === 'revoked' && typeof seat.revoked_at === 'number' &&
          Number.isFinite(seat.revoked_at) && seat.revoked_at > 0) {
        end = Math.min(end, seat.revoked_at);
      }
      if (end < seat.created_at) {
        throw bad(at + ' has an AI-seat lifetime ending before its admission');
      }
      const ordinal = Object.prototype.hasOwnProperty.call(seat, 'session_ordinal')
        ? seat.session_ordinal : 1;
      return { seat, start: seat.created_at, end, ordinal };
    }).sort((left, right) => left.ordinal - right.ordinal);

    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const hasOrdinal = Object.prototype.hasOwnProperty.call(
        interval.seat, 'session_ordinal');
      if (interval.ordinal !== i + 1 || (!hasOrdinal && i !== 0)) {
        throw bad(at + ' has a missing or out-of-order durable session ordinal');
      }
    }

    for (let i = 1; i < intervals.length; i++) {
      const previous = intervals[i - 1];
      const current = intervals[i];
      if (current.start < previous.end) {
        throw bad(at + ' has admitted AI-seat lifetimes that overlap');
      }
    }
  }
}

function assertExactMigrationEvent(event, where) {
  const bad = msg => new Error('identity repo: ' + where + ' has an invalid ' + MIGRATION_EVENT_KIND + ' intent — ' + msg);
  const keys = Object.keys(event).sort();
  const expected = [...MIGRATION_EVENT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) throw bad('its fields must be exact');
  if (typeof event.id !== 'string' || !UUID_V4.test(event.id)) throw bad('its id must be a fresh UUID v4');
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) throw bad('its ts must be finite');
  if (event.tenant !== tenant()) throw bad('its tenant must be "house"');
  if (event.from_version !== 1) throw bad('its from_version must be 1');
  if (event.to_version !== 2) throw bad('its to_version must be 2');
}

// ── Task 8 policy standing and delta invariants ─────────────────────────────
// Absence is the exact legacy/default representation. A present value is never
// defaulted around: it must be a safe integer inside D19's inclusive bounds.
function effectivePolicyLifetime(policy, where) {
  const bad = message => new Error('identity repo: ' + where + ' violates policy — ' + message);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw bad('policy must be a plain object');
  }
  for (const key of Object.keys(policy)) {
    if (key !== 'pass_lifetime_ms') throw bad('UNKNOWN policy key "' + key + '"');
  }
  if (!Object.prototype.hasOwnProperty.call(policy, 'pass_lifetime_ms')) {
    return DEFAULT_PASS_LIFETIME_MS;
  }
  const value = policy.pass_lifetime_ms;
  if (!Number.isSafeInteger(value) ||
      value < MIN_PASS_LIFETIME_MS || value > MAX_PASS_LIFETIME_MS) {
    throw bad('pass_lifetime_ms must be a safe integer inside inclusive bounds ' +
      MIN_PASS_LIFETIME_MS + '..' + MAX_PASS_LIFETIME_MS);
  }
  return value;
}

function exactPolicyEvent(event, previous, next, where) {
  const bad = message => new Error('identity repo: ' + where + ' violates policy — ' + message);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw bad('policy.pass_lifetime intent must be a plain object');
  }
  const keys = Object.keys(event).sort();
  const expected = [...POLICY_EVENT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw bad('policy.pass_lifetime intent fields must be exact');
  }
  if (typeof event.id !== 'string' || !UUID_V4.test(event.id)) {
    throw bad('policy.pass_lifetime intent id must be a fresh UUID');
  }
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) {
    throw bad('policy.pass_lifetime intent ts must be finite');
  }
  if (event.kind !== 'policy.pass_lifetime') {
    throw bad('policy.pass_lifetime intent kind is exact');
  }
  if (event.tenant !== tenant()) {
    throw bad('policy.pass_lifetime intent tenant must be "house"');
  }
  if (event.previous_pass_lifetime_ms !== previous) {
    throw bad('policy.pass_lifetime intent previous value does not match effective state');
  }
  if (event.pass_lifetime_ms !== next) {
    throw bad('policy.pass_lifetime intent next value does not match effective state');
  }
}

function assertPolicyDeltas(prev, next) {
  const where = 'transaction';
  const bad = message => new Error('identity repo: transaction violates policy — ' + message);
  const previous = effectivePolicyLifetime(prev.policy, where);
  const current = effectivePolicyLifetime(next.policy, where);
  const previousPresent = Object.prototype.hasOwnProperty.call(prev.policy, 'pass_lifetime_ms');
  const currentPresent = Object.prototype.hasOwnProperty.call(next.policy, 'pass_lifetime_ms');

  const previousEvents = Object.create(null);
  for (const event of prev.outbox) {
    if (event && typeof event === 'object' && typeof event.id === 'string') {
      previousEvents['$' + event.id] = event;
    }
  }
  const added = [];
  for (const event of next.outbox) {
    if (!event || typeof event !== 'object' || event.kind !== 'policy.pass_lifetime') continue;
    const old = typeof event.id === 'string' ? previousEvents['$' + event.id] : null;
    if (!old) {
      added.push(event);
    } else if (JSON.stringify(old) !== JSON.stringify(event)) {
      throw bad('an existing durable policy intent may not be rewritten');
    }
  }

  if (previous === current) {
    if (previousPresent !== currentPresent) {
      throw bad('default representation changed without an effective value change');
    }
    if (added.length !== 0) {
      throw bad('policy.pass_lifetime intent appended without an effective value change');
    }
    return;
  }
  if (added.length !== 1) {
    throw bad('an effective pass-lifetime change requires exactly one newly appended matching intent');
  }
  exactPolicyEvent(added[0], previous, current, where);
}

// ── the installed triple ─────────────────────────────────────────────────────
// STATE, SELECTOR_IDX and INDEX_FOR_STATE are installed TOGETHER, synchronously,
// and are never observable apart. Nothing is loaded at module evaluation: the
// pre-init state must be REACHABLE so that pre-init refusal is TESTABLE.
let STATE = null;
let SELECTOR_IDX = null;
let INDEX_FOR_STATE = null;
// Set when a commit went durable but the index could not be extended. STATE is
// deliberately PRESERVED in that case so reload() remains reachable — the
// recovery instruction and the code have to agree.
let FATAL = null;

const SELECTOR_CHARS = 22;                 // 16 random bytes, base64url
const B64URL = /^[A-Za-z0-9_-]+$/;

// Build the complete selector→position map. Throws rather than installing a map
// that is merely the right SIZE — a wrong map can have the right length, so
// readiness is bound to the exact state object, never to a count.
function buildIndex(state) {
  const idx = new Map();
  for (let i = 0; i < state.credentials.length; i++) {
    const c = state.credentials[i];
    if (typeof c.selector !== 'string' || c.selector.length !== SELECTOR_CHARS || !B64URL.test(c.selector)) {
      throw new Error('identity repo: credential ' + i + ' has a malformed selector');
    }
    if (idx.has(c.selector)) throw new Error('identity repo: DUPLICATE selector at position ' + i);
    idx.set(c.selector, i);
  }
  return idx;
}

// The index's structural premise, enforced on EVERY transaction before commit.
// A convention that another module can break is not an invariant.
function assertCredentialInvariants(prev, next) {
  if (next.credentials.length < prev.credentials.length) {
    throw new Error('identity repo: a transaction may not SHRINK credentials (positions are pinned)');
  }
  for (let i = 0; i < prev.credentials.length; i++) {
    if (next.credentials[i].selector !== prev.credentials[i].selector) {
      throw new Error('identity repo: a transaction may not move or replace the selector at position ' + i);
    }
  }
  const seen = new Set();
  for (let i = 0; i < next.credentials.length; i++) {
    const sel = next.credentials[i].selector;
    if (typeof sel !== 'string' || sel.length !== SELECTOR_CHARS || !B64URL.test(sel)) {
      throw new Error('identity repo: malformed selector at position ' + i);
    }
    if (seen.has(sel)) throw new Error('identity repo: DUPLICATE selector at position ' + i);
    seen.add(sel);
  }
}
// Cost, accepted deliberately: the duplicate scan is O(N) on the WRITE path,
// every transaction. Writes are rare and authenticated. The alternative — a
// second incremental structure — is one more thing that can drift, which is the
// class of bug this whole file exists to remove.

// ── B4 relational validation (Task 3 packet, I21/I22) ────────────────────────
// The Blocker-4 relation: a seat and its ONE historical pass credential expire
// at exactly the same instant, forever. credentials.js enforces it on the
// legal path — but a convention another module can break is not an invariant
// (same law as the append gate above), so the repo asserts it on EVERY load
// (B4 L7: corrupt disk refuses to install) and before EVERY commit (B4 L6:
// direct-transact bypasses refuse unchanged).
//
// Deliberately Map-free and scan-method-free (plain index loops + bare-object
// dictionaries): the H1 cost probes count Map/Array-method calls with exact
// budgets, and the validator must be invisible to them.
function assertRelationalInvariants(state, where) {
  const bad = msg => new Error('identity repo: ' + where + ' violates B4 — ' + msg);
  const subjById = Object.create(null);
  for (let i = 0; i < state.subjects.length; i++) {
    const s = state.subjects[i];
    if (s && typeof s.id === 'string') subjById[s.id] = s;
  }
  // credentials: relational fields well-formed, subject exists, one pass/seat
  const passBySeat = Object.create(null);
  for (let i = 0; i < state.credentials.length; i++) {
    const c = state.credentials[i];
    if (!c || typeof c !== 'object') throw bad('credential ' + i + ' has malformed fields (not an object)');
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (v !== null && typeof v === 'object') {
        // scalar-only rows keep the immutability delta below sound (=== compare)
        throw bad('credential ' + i + ' has malformed fields — "' + k + '" is not a scalar');
      }
    }
    if (typeof c.id !== 'string' || c.id === '') throw bad('credential ' + i + ' has malformed fields — id');
    if (typeof c.subject_id !== 'string' || c.subject_id === '') throw bad('credential ' + i + ' has malformed fields — subject_id');
    const subj = subjById[c.subject_id];
    if (!subj) throw bad('credential ' + i + ' is an ORPHAN — subject "' + c.subject_id + '" does not exist');
    if (typeof c.revoked !== 'boolean') throw bad('credential ' + i + ' has malformed fields — revoked must be boolean');
    if (c.expires_at !== undefined && (typeof c.expires_at !== 'number' || !Number.isFinite(c.expires_at) || c.expires_at < 0)) {
      throw bad('credential ' + i + ' has malformed fields — expires_at');
    }
    if (c.type !== undefined && c.type !== 'pass' && c.type !== 'tool') {
      throw bad('credential ' + i + ' has malformed fields — unknown type "' + c.type + '"');
    }
    if (c.type === 'pass') {
      if (subj.kind !== 'seat') throw bad('a pass credential must attach to a seat, not a ' + subj.kind);
      if (typeof c.expires_at !== 'number' || c.expires_at <= 0) throw bad('a pass credential requires a positive expires_at');
      if (passBySeat[c.subject_id]) throw bad('SECOND pass credential for seat "' + c.subject_id + '" — one seat, ONE historical pass (L4)');
      passBySeat[c.subject_id] = c;
    }
    if (c.type === 'tool' && subj.kind !== 'tool') throw bad('a tool credential must attach to a tool, not a ' + subj.kind);
  }
  // seats: numeric expires_at, coupled exactly to the one pass — or exactly 0
  for (let i = 0; i < state.subjects.length; i++) {
    const s = state.subjects[i];
    if (!s || s.kind !== 'seat') continue;
    if (typeof s.expires_at !== 'number' || !Number.isFinite(s.expires_at) || s.expires_at < 0) {
      throw bad('seat "' + s.id + '" must carry numeric expires_at');
    }
    const pass = passBySeat[s.id];
    if (pass) {
      if (s.expires_at !== pass.expires_at) {
        throw bad('seat/pass expiry MISMATCH for "' + s.id + '" — bound seat expiry must equal its one pass credential expiry (L2)');
      }
    } else if (s.expires_at !== 0) {
      throw bad('seat "' + s.id + '" carries expiry WITHOUT a pass credential — binding is issuance, nothing else (L1)');
    }
  }
  // grants (Task 4 + I22): stable unique id; one closed persisted vocabulary;
  // tenant agreement with a live well-formed holder; numeric lifetime; and a
  // seat grant confined to a BOUND seat's lifetime. Grant ids are the relation
  // key — tuple String() coercion is non-injective and cannot distinguish
  // same-tuple grants.
  const grantIds = new Set();
  for (let i = 0; i < state.grants.length; i++) {
    const g = state.grants[i];
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw bad('grant ' + i + ' is malformed');
    if (typeof g.id !== 'string' || g.id === '' || g.id.includes('\x00')) {
      throw bad('grant ' + i + ' has malformed identity field "id" — a non-empty NUL-free string is required');
    }
    if (grantIds.has(g.id)) throw bad('DUPLICATE grant id "' + g.id + '" at position ' + i);
    grantIds.add(g.id);
    for (const field of ['tenant', 'subject_id', 'capability', 'resource']) {
      if (typeof g[field] !== 'string' || g[field].includes('\x00')) {
        throw bad('grant ' + i + ' has malformed identity field "' + field + '" — a NUL-free string is required');
      }
    }
    if (!subjById[g.subject_id]) {
      throw bad('grant ' + i + ' is an ORPHAN — subject "' + g.subject_id + '" does not exist');
    }
    const subj = subjById[g.subject_id];
    if (!['person', 'seat', 'tool'].includes(subj.kind)) {
      throw bad('grant ' + i + ' references a subject with invalid kind');
    }
    if (typeof subj.tenant !== 'string' || subj.tenant.trim() === '') {
      throw bad('grant ' + i + ' references a subject with malformed tenant');
    }
    if (!['active', 'revoked'].includes(subj.status)) {
      throw bad('grant ' + i + ' references a subject with invalid status');
    }
    if (subj.status !== 'active') {
      throw bad('grant ' + i + ' references a subject that is not active');
    }
    if (g.tenant.trim() === '' || g.tenant !== subj.tenant) {
      throw bad('grant ' + i + ' tenant does not match subject tenant');
    }
    if (!GRANT_CAPABILITIES.includes(g.capability)) {
      throw bad('grant ' + i + ' has unknown capability "' + g.capability + '"');
    }
    if (g.resource.trim() === '') {
      throw bad('grant ' + i + ' resource must be non-blank');
    }
    if (!GRANT_ORIGINS.includes(g.origin)) {
      throw bad('grant ' + i + ' has unknown origin "' + g.origin + '"');
    }
    if (typeof g.created_at !== 'number' || !Number.isFinite(g.created_at) || g.created_at < 0) {
      throw bad('grant ' + i + ' created_at must be finite');
    }
    if (typeof g.expires_at !== 'number' || !Number.isFinite(g.expires_at) || g.expires_at < 0) {
      throw bad('grant ' + i + ' must carry numeric expires_at (0 = standing, person/tool only)');
    }
    if (subj.kind === 'seat') {
      if (subj.expires_at === 0) throw bad('grant ' + i + ' attaches to an UNBOUND seat');
      if (!(g.expires_at > 0 && g.expires_at <= subj.expires_at)) {
        throw bad('grant ' + i + ' — a seat grant must have 0 < expires_at <= seat.expires_at');
      }
    }
  }
}

// ── C4 relational rules for the seven new collections ───────────────────────
// Enforced at load AND at transact — the same two-gate law as v1's B4. Like the
// v1 gate above, and unlike the delta path, this reads NO wall clock (I-R1-21).
function assertV2RelationalInvariants(state, where) {
  const bad = msg => new Error('identity repo: ' + where + ' violates the v2 relation — ' + msg);

  const subjById = Object.create(null);
  for (const s of state.subjects) if (s && typeof s.id === 'string') subjById[s.id] = s;
  const roleById = Object.create(null);
  for (const r of state.roles) roleById[r.id] = r;

  const person = (id, at, field) => {
    const s = subjById[id];
    if (!s) throw bad(at + ' is an ORPHAN — ' + field + ' "' + id + '" does not resolve to a subject');
    if (s.kind !== 'person') throw bad(at + ' ' + field + ' "' + id + '" is a ' + s.kind + ', but a person is required');
    return s;
  };
  const anySubject = (id, at, field) => {
    const s = subjById[id];
    if (!s) throw bad(at + ' is an ORPHAN — ' + field + ' "' + id + '" does not resolve to a subject');
    return s;
  };
  const sameTenant = (row, subject, at, field) => {
    if (row.tenant !== subject.tenant) {
      throw bad(at + ' tenant "' + row.tenant + '" does not match the tenant of its ' + field + ' ("' + subject.tenant + '")');
    }
  };

  // memberships — human-only (D22), at most one row per (tenant, person)
  const membershipSeen = new Set();
  state.memberships.forEach((r, i) => {
    const at = 'membership ' + i;
    const s = person(r.person_subject_id, at, 'person_subject_id');
    sameTenant(r, s, at, 'person subject');
    const key = r.tenant + '\x00' + r.person_subject_id;
    if (membershipSeen.has(key)) throw bad('DUPLICATE membership for person "' + r.person_subject_id + '" in tenant "' + r.tenant + '"');
    membershipSeen.add(key);
  });

  // roles — slug unique per tenant; the protected administrator manifest row is
  // person-only at the REPO, before any use-time check exists (D28).
  const slugSeen = new Set();
  state.roles.forEach((r, i) => {
    const at = 'role ' + i;
    const key = r.tenant + '\x00' + r.slug;
    if (slugSeen.has(key)) throw bad('DUPLICATE role slug "' + r.slug + '" in tenant "' + r.tenant + '"');
    slugSeen.add(key);
    if (r.system === true && r.slug === ADMINISTRATOR_SLUG) {
      if (r.allowed_subject_kinds.length !== 1 || r.allowed_subject_kinds[0] !== 'person') {
        throw bad(at + ' is the protected "' + ADMINISTRATOR_SLUG +
          '" manifest row and must allow exactly ["person"] (D28) — got ' + JSON.stringify(r.allowed_subject_kinds));
      }
    }
    // R2/C3, I-R2-4: ANTI-SMUGGLING AT STORAGE. `system: true` marks a protected
    // built-in, and protected built-ins are a closed set (spec §6.2, D28) whose
    // bundles runtime administration may assign but never rewrite. A role that
    // claims the flag under any other slug is claiming that protection for an
    // authored role — refuse it, at both gates.
    if (r.system === true && !PROTECTED_ROLE_SLUGS.includes(r.slug)) {
      throw bad(at + ' claims system: true under slug "' + r.slug +
        '" — the protected built-ins are exactly ' + JSON.stringify([...PROTECTED_ROLE_SLUGS]) +
        ' and no other role may claim that protection (D28, spec §6.2)');
    }
  });

  state.role_permissions.forEach((r, i) => {
    const at = 'role_permission ' + i;
    const role = roleById[r.role_id];
    if (!role) throw bad(at + ' is an ORPHAN — role_id "' + r.role_id + '" does not resolve to a role');
    if (r.tenant !== role.tenant) throw bad(at + ' tenant does not match the tenant of its role');
    // R2/C3, I-R2-5: KIND COHERENCE. Every unrevoked permission a role carries
    // must be reachable by every kind the role admits — i.e. the manifest's
    // allowed kinds for that capability must be a SUPERSET of the role's.
    //
    // This is what makes "a role called `moderator` cannot smuggle admin
    // authority to a seat" a STORAGE FACT rather than a naming convention. It is
    // spelled deliberately in capabilities and kinds and NEVER in substrings: a
    // role whose name merely contains "admin" is not denied for its spelling
    // (spec §6.1 — administrative classification comes from the capability,
    // never from a slug, label, or substring).
    //
    // Revoked permission rows are history and are not part of the live bundle,
    // so they are not judged here.
    if (r.revoked_at === null) {
      const manifestKinds = capabilityPolicy.allowedKinds(r.capability);
      for (const kind of role.allowed_subject_kinds) {
        if (!manifestKinds.includes(kind)) {
          throw bad(at + ' grants "' + r.capability + '" inside role "' + role.slug +
            '", which admits ' + JSON.stringify([...role.allowed_subject_kinds]) +
            ' — but the protected capability policy allows "' + r.capability + '" only to ' +
            JSON.stringify([...manifestKinds]) + '; the role could hand a "' + kind +
            '" an authority the manifest reserves (spec §6.1/§6.2)');
        }
      }
    }
  });

  // role_assignments — kind gate, the D43 schema rule, and clock-free
  // uniqueness over UNREVOKED rows (Amendment 1, I-R1-18).
  const assignmentSeen = new Set();
  state.role_assignments.forEach((r, i) => {
    const at = 'role_assignment ' + i;
    const role = roleById[r.role_id];
    if (!role) throw bad(at + ' is an ORPHAN — role_id "' + r.role_id + '" does not resolve to a role');
    const subj = anySubject(r.subject_id, at, 'subject_id');
    sameTenant(r, subj, at, 'subject');
    if (r.tenant !== role.tenant) throw bad(at + ' tenant does not match the tenant of its role');
    if (!role.allowed_subject_kinds.includes(subj.kind)) {
      throw bad(at + ' assigns a "' + subj.kind + '" subject to role "' + role.slug +
        '", whose allowed kinds are ' + JSON.stringify(role.allowed_subject_kinds));
    }
    // THE RULE R1 EXISTS TO LAND (D43/F1).
    if (role.system === true && role.slug === ADMINISTRATOR_SLUG) {
      if (subj.kind !== 'person') {
        throw bad(at + ' assigns the protected "' + ADMINISTRATOR_SLUG + '" role to a ' + subj.kind + ' — it is person-only (D28)');
      }
      if (r.expires_at !== null) {
        throw bad(at + ' is a protected "' + ADMINISTRATOR_SLUG + '" assignment and must carry expires_at === null — ' +
          'administrator authority cannot lapse by clock (D43)');
      }
    }
    if (r.revoked_at === null) {
      const key = [r.tenant, r.role_id, r.subject_id, r.scope_type, r.scope_id].join('\x00');
      if (assignmentSeen.has(key)) {
        throw bad('a second UNREVOKED role_assignment exists for (' + r.tenant + ', ' + r.role_id + ', ' +
          r.subject_id + ', ' + r.scope_type + ', ' + r.scope_id + ') — revocation must never be ambiguous ' +
          'about which row it bites; revoke the lapsed row rather than shadowing it');
      }
      assignmentSeen.add(key);
    }
  });

  state.admission_capabilities.forEach((r, i) => {
    const at = 'admission_capability ' + i;
    // D44: null issuer is permitted only for bootstrap/offline_recovery, and
    // only with a server-generated mint_audit_id already shape-checked above.
    // A null issuer is NOT a tenant subject and is never resolved via anySubject.
    if (r.issuer_subject_id === null) {
      if (r.purpose !== 'bootstrap' && r.purpose !== 'offline_recovery') {
        throw bad(at + ' has null issuer_subject_id but purpose "' + r.purpose +
          '" is not operator bootstrap/offline_recovery (D44)');
      }
    } else {
      const issuer = anySubject(r.issuer_subject_id, at, 'issuer_subject_id');
      sameTenant(r, issuer, at, 'issuer subject');
    }
    if (r.principal_subject_id !== null) {
      const p = person(r.principal_subject_id, at, 'principal_subject_id');
      sameTenant(r, p, at, 'principal subject');
    }
    if (r.consuming_subject_id !== null) {
      const c = anySubject(r.consuming_subject_id, at, 'consuming_subject_id');
      sameTenant(r, c, at, 'consuming subject');
    }
    // Operator bootstrap/recovery claims carry empty ceilings and null seat TTL
    // (already shape-checked for non-seat purposes). They never smuggle authority.
    if ((r.purpose === 'bootstrap' || r.purpose === 'offline_recovery') && r.issuer_subject_id === null) {
      if (r.capability_ceiling.length !== 0 || r.resource_ceiling.length !== 0) {
        throw bad(at + ' operator ' + r.purpose + ' capability must carry empty capability/resource ceilings (D44)');
      }
      if (r.intended_subject_kind !== 'person') {
        throw bad(at + ' operator ' + r.purpose + ' capability must intend kind person');
      }
      if (r.purpose === 'bootstrap' && r.principal_subject_id !== null) {
        throw bad(at + ' bootstrap capability must have null principal_subject_id');
      }
      if (r.purpose === 'offline_recovery' && r.principal_subject_id === null) {
        throw bad(at + ' offline_recovery capability must fix principal_subject_id to the target administrator');
      }
    }
  });

  // D44: every null invited_by membership is proven by a distinct consumed
  // bootstrap capability for the same person in tenant house.
  const bootstrapNullInviterSeen = new Set();
  state.memberships.forEach((r, i) => {
    if (r.invited_by !== null) return;
    const at = 'membership ' + i;
    if (r.tenant !== tenant()) {
      throw bad(at + ' has null invited_by outside tenant house — D44 bootstrap only');
    }
    // Find a consumed bootstrap cap naming this person as consumer.
    const caps = state.admission_capabilities.filter(c =>
      c.purpose === 'bootstrap' &&
      c.issuer_subject_id === null &&
      c.tenant === tenant() &&
      c.consumed_at !== null &&
      c.consuming_subject_id === r.person_subject_id);
    if (caps.length === 0) {
      throw bad(at + ' has null invited_by without a consumed bootstrap capability for person "' +
        r.person_subject_id + '" (D44)');
    }
    // Prefer exact timestamp match when multiple historical caps exist.
    const matched = caps.find(c =>
      c.consumed_at === r.invited_at &&
      c.consumed_at === r.activated_at) || null;
    if (!matched) {
      throw bad(at + ' null invited_by membership timestamps must equal the consumed bootstrap capability consumed_at (D44)');
    }
    if (bootstrapNullInviterSeen.has(matched.id)) {
      throw bad(at + ' two null-inviter memberships claim the same bootstrap capability "' + matched.id + '" (D44)');
    }
    bootstrapNullInviterSeen.add(matched.id);
    // Active bootstrap candidate: at most one non-revoked null-inviter while
    // bootstrap incomplete; after completion historical revoked rows may remain.
    if (r.status !== 'revoked' && state.bootstrap.completed_at === null) {
      // counted below
    }
  });
  if (state.bootstrap.completed_at === null) {
    const liveNull = state.memberships.filter(m =>
      m.invited_by === null && m.tenant === tenant() && m.status !== 'revoked');
    if (liveNull.length > 1) {
      throw bad('at most one non-revoked null-inviter membership may exist while bootstrap is incomplete (D44)');
    }
  } else {
    // After completion, no NEW null-inviter memberships: any non-revoked null
    // inviter must still be capability-backed (already checked) and is the
    // historical first admin — allowed.
  }

  // authenticators — person-only; id + credential_id unique per tenant (D33–D35 / R6 §10)
  const credSeen = new Set();
  const authIdSeen = new Set();
  state.authenticators.forEach((r, i) => {
    const at = 'authenticator ' + i;
    const s = person(r.person_subject_id, at, 'person_subject_id');
    sameTenant(r, s, at, 'person subject');
    // Seat/tool subjects cannot hold authenticator rows (person() already
    // enforces person-kind; re-state for the service-layer negative separation).
    if (s.kind !== 'person') throw bad(at + ' may only attach to a person subject');
    const idKey = r.tenant + '\x00' + r.id;
    if (authIdSeen.has(idKey)) throw bad('DUPLICATE authenticator id "' + r.id + '" in tenant "' + r.tenant + '"');
    authIdSeen.add(idKey);
    const key = r.tenant + '\x00' + r.credential_id;
    if (credSeen.has(key)) throw bad('DUPLICATE authenticator credential_id "' + r.credential_id + '" in tenant "' + r.tenant + '"');
    credSeen.add(key);
  });

  for (const key of Object.keys(state.passwords)) {
    const r = state.passwords[key];
    const at = 'password record "' + key + '"';
    const s = person(r.person_subject_id, at, 'person_subject_id');
    sameTenant(r, s, at, 'person subject');
  }
}

// ── C7: the D43 usable-administrator predicate ──────────────────────────────
// Pure: evaluates the five conjuncts on a COMPLETE state. Clock-free — an
// administrator assignment cannot carry an expiry at all (the schema rule
// above), so "non-expiring" is a byte fact, not a time fact.
function usableAdministratorsIn(state, tenant) {
  const role = state.roles.find(r => r.tenant === tenant && r.system === true && r.slug === ADMINISTRATOR_SLUG) || null;
  if (!role) return 0;
  let count = 0;
  for (const subj of state.subjects) {
    // (1) active person subject in this tenant
    if (!subj || subj.kind !== 'person' || subj.status !== 'active' || subj.tenant !== tenant) continue;
    // (2) active human membership
    if (!state.memberships.some(m => m.tenant === tenant && m.person_subject_id === subj.id && m.status === 'active')) continue;
    // (3) active, non-expiring administrator assignment
    if (!state.role_assignments.some(a => a.tenant === tenant && a.role_id === role.id &&
        a.subject_id === subj.id && a.revoked_at === null && a.expires_at === null)) continue;
    // (4) usable password
    const pw = state.passwords[subj.id];
    if (!pw || pw.revoked_at !== null) continue;
    // (5) at least one usable L2 authenticator
    if (!state.authenticators.some(a => a.tenant === tenant && a.person_subject_id === subj.id && a.revoked_at === null)) continue;
    count++;
  }
  return count;
}

// Every tenant that has a protected administrator manifest row is a tenant the
// guard judges. Derived from the state, never hard-coded (D3/D21).
function administratorTenants(state) {
  const out = new Set();
  for (const r of state.roles) if (r.system === true && r.slug === ADMINISTRATOR_SLUG) out.add(r.tenant);
  return out;
}

// C7, the resulting-state guard. Evaluated at the repository's single commit
// point, where a resulting-state rule belongs — wiring it later would re-create
// exactly the F1 window Solitaire's condition closed. Before bootstrap
// completes it is provably armed but vacuously quiet: that is the point of
// building the ratchet before the load.
function assertUsableAdministrators(state, where) {
  if (state.bootstrap.completed_at === null) return;
  for (const tenant of administratorTenants(state)) {
    if (usableAdministratorsIn(state, tenant) < 1) {
      throw new Error('identity repo: ' + where + ' would leave tenant "' + tenant +
        '" with ZERO usable administrators after bootstrap completed (D43) — refused. ' +
        'Only the explicit offline administrator recovery ceremony may cross and repair this invariant.');
    }
  }
}

// ── R2/C3, I-R2-6: system-role bundle immutability (a DELTA rule) ───────────
// Runtime administration assigns and revokes protected roles but "cannot rewrite
// their permission bundles" (spec §6.2). That is a statement about CHANGE, so it
// is enforced here on prev→next and not in the standing validator.
//
// GATE ORDER IS BINDING (Amendment 2, Ruling 2): this runs AFTER assertV2Shapes
// and assertV2RelationalInvariants and immediately BEFORE
// assertUsableAdministrators. A malformed system row is refused by the shape
// gate in the shape gate's words; a D28-illegal one by the relational gate in
// its words; so this rule fires only on rows that are well-formed, relationally
// legal, and illegally CHANGED — the only case where "did this change illegally"
// is a meaningful question. It also keeps three shipped R1 controls passing
// verbatim, and follows the habit already in this file of letting the standing
// validator retain authorship of malformed-row wording.
//
// Rider (Amendment 2): because it is a delta rule there is no `prev` at load, so
// a state read from disk carrying an illegally-changed bundle is not judged by
// it. The STANDING protections (protected-slug, kind coherence) run at both
// gates and are what a loaded state is judged by. That asymmetry is a design
// fact, recorded here rather than left to be discovered as a gap.
function assertSystemRoleBundleDeltas(prev, next) {
  const bad = msg => new Error('identity repo: transaction violates the protected-role rule — ' + msg);

  const nextRoleById = Object.create(null);
  for (const r of next.roles) nextRoleById[r.id] = r;
  const permsFor = (state, roleId) => state.role_permissions
    .filter(p => p.role_id === roleId)
    .map(p => JSON.stringify(p))
    .sort();   // set-and-contents comparison: reordering alone is not a change

  for (const before of prev.roles) {
    if (before.system !== true) continue;
    const after = nextRoleById[before.id];
    if (!after) {
      throw bad('the protected role "' + before.slug + '" may not be REMOVED — ' +
        'protected built-ins are assigned and revoked, never deleted (spec §6.2)');
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw bad('the protected role row "' + before.slug + '" is immutable at runtime — ' +
        'display_name, status, allowed_subject_kinds and every other field are fixed by the manifest ' +
        '(presentation never changes authority, D29)');
    }
    const beforePerms = permsFor(prev, before.id);
    const afterPerms = permsFor(next, before.id);
    if (beforePerms.length !== afterPerms.length || beforePerms.some((p, i) => p !== afterPerms[i])) {
      throw bad('the permission bundle of protected role "' + before.slug + '" is immutable at runtime — ' +
        'a bundle row may not be added, removed, rewritten, or revocation-stamped (' +
        beforePerms.length + ' row(s) before, ' + afterPerms.length + ' after)');
    }
  }

  // A NEW system role may appear, but only WITH its complete bundle in the same
  // transaction — never a bare row that a later transaction fills in, because
  // between those two commits the role exists with an empty bundle and the
  // seeding path would no longer be atomic.
  const prevRoleIds = new Set(prev.roles.map(r => r.id));
  for (const after of next.roles) {
    if (after.system !== true || prevRoleIds.has(after.id)) continue;
    if (!next.role_permissions.some(p => p.role_id === after.id && p.revoked_at === null)) {
      throw bad('the new protected role "' + after.slug + '" arrived with an EMPTY permission bundle — ' +
        'a system role and its complete manifest bundle land in ONE transaction or neither does');
    }
  }
}

function assertBootstrapDelta(prev, next) {
  const a = prev.bootstrap.completed_at, b = next.bootstrap.completed_at;
  if (a === b) return;
  if (a === null && typeof b === 'number') return;   // the one legal transition
  throw new Error('identity repo: transaction violates bootstrap monotonicity — completed_at may only go null -> number, ' +
    'at most once (got ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b) + ')');
}

// C6: an ordinary transaction may neither MINT nor REWRITE a repo.migration
// intent. Removal stays legal, or markDelivered() could never drain one — so
// this inspects only what is PRESENT in next, exactly like assertPolicyDeltas.
// A count- or length-based guard here would be a defect.
function assertMigrationEventDeltas(prev, next) {
  const bad = msg => new Error('identity repo: transaction violates the migration intent rule — ' + msg);
  const previous = Object.create(null);
  for (const e of prev.outbox) {
    if (e && typeof e === 'object' && typeof e.id === 'string') previous['$' + e.id] = e;
  }
  for (const e of next.outbox) {
    if (!e || typeof e !== 'object' || e.kind !== MIGRATION_EVENT_KIND) continue;
    const old = typeof e.id === 'string' ? previous['$' + e.id] : null;
    if (!old) throw bad('an ordinary transaction may not APPEND a ' + MIGRATION_EVENT_KIND + ' intent');
    if (JSON.stringify(old) !== JSON.stringify(e)) {
      throw bad('an existing durable ' + MIGRATION_EVENT_KIND + ' intent may not be rewritten');
    }
  }
}

function grantCoversOrigin(grantOrigin, observedOrigin) {
  return grantOrigin === 'any' || grantOrigin === observedOrigin;
}

// Task 6 issuance-only ceiling. Deliberately NOT part of the standing
// validator: later principal narrowing/removal is legal and can() closes use.
function principalCoversSeatGrant(state, seat, grant, now) {
  const principal = state.subjects.find(s => s && s.id === seat.principal) || null;
  if (!principal ||
      principal.kind !== 'person' ||
      principal.status !== 'active' ||
      principal.tenant !== seat.tenant) {
    return false;
  }
  const observed = grant.origin === 'any' ? ['local', 'tunnel'] : [grant.origin];
  return observed.every(origin => state.grants.some(g =>
    g && typeof g === 'object' &&
    g.tenant === grant.tenant &&
    g.subject_id === principal.id &&
    g.capability === grant.capability &&
    g.resource === grant.resource &&
    grantCoversOrigin(g.origin, origin) &&
    typeof g.expires_at === 'number' &&
    Number.isFinite(g.expires_at) &&
    (g.expires_at === 0 ||
      (g.expires_at > now && g.expires_at >= grant.expires_at))));
}

// The prev→next half of I21/I22: what may CHANGE. Existing credential rows are
// immutable except revoked false→true; a bound seat keeps its kind; bound-seat
// grant lifetimes are never rewritten (removal stays legal); grants ADDED to a
// seat need it bound, active and unexpired NOW.
function assertRelationalDeltas(prev, next) {
  const bad = msg => new Error('identity repo: transaction violates B4 — ' + msg);
  // credentials: positions are already pinned by assertCredentialInvariants,
  // so prev[i] and next[i] are the same logical row.
  for (let i = 0; i < prev.credentials.length; i++) {
    const a = prev.credentials[i], b = next.credentials[i];
    const keys = Object.create(null);
    for (const k of Object.keys(a)) keys[k] = true;
    for (const k of Object.keys(b)) keys[k] = true;
    for (const k of Object.keys(keys)) {
      if (k === 'revoked') continue;
      if (a[k] !== b[k]) {
        throw bad('a transaction may not change credential field "' + k + '" at position ' + i + ' (L6)');
      }
    }
    if (a.revoked !== b.revoked && !(a.revoked === false && b.revoked === true)) {
      throw bad('credential revival at position ' + i + ' — revoked false→true is the ONLY allowed credential mutation');
    }
  }
  const nextById = Object.create(null);
  for (let i = 0; i < next.subjects.length; i++) {
    const s = next.subjects[i];
    if (s && typeof s.id === 'string') nextById[s.id] = s;
  }
  // ── R2.5 / C1: the subject prev->next delta contract ─────────────────────
  // A LEGAL-TRANSITION ALLOWLIST, DENY BY DEFAULT. For a subject row present in
  // both prev and next, the field-level delta must be exactly one of:
  //
  //   ∅                          no change
  //   T1  {status, revoked_at}   revocation      (C2)
  //   T2  {expires_at}           seat binding    (C3)
  //   T3  {name, name_fold, name_history} display rename; returning to an
  //                                already-reserved fold omits name_history
  //
  // and ANY other delta refuses at the final branch below.
  //
  // ⛔ I-R2.5-11 — WHY THIS IS A KEY-SET TEST AND NOT A LIST OF FORBIDDEN
  // FIELDS. Thirteen refusals would be a FLOOR: field #14 arrives next month
  // and is silently mutable while the enumeration still reads complete. The
  // legality test here is evaluated on the complete changed KEY SET
  // itself, so a field nobody has thought of yet cannot be in either literal
  // set and is refused on arrival, by construction, with no one having to
  // remember it. That is a ceiling rather than a floor, and it is the whole
  // design. A denylist covering today's 13 is a FAILED build even if every
  // control passes — control N1 is the executable form of that sentence.
  //
  // The diff is taken over the UNION of both key sets, so an ADDED or REMOVED
  // key is itself a difference rather than something the comparison skips.
  const T1_KEYS = 'revoked_at,status';        // sorted, joined — the comparison key
  const T2_KEYS = 'expires_at';
  const T3_KEYS = 'name,name_fold,name_history';
  const T3_REUSE_KEYS = 'name,name_fold';
  const T3_CASE_KEYS = 'name';
  for (let i = 0; i < prev.subjects.length; i++) {
    const a = prev.subjects[i];
    if (!a || typeof a.id !== 'string') continue;
    const b = nextById[a.id];
    // C4 / I-R2.5-10: present in prev, absent from next. Revocation is the
    // lifecycle — subjects.js never splices a subject row.
    if (!b) throw bad('a transaction may not REMOVE subject row "' + a.id + '" — revocation is the lifecycle (C4)');

    const seen = Object.create(null);
    for (const k of Object.keys(a)) seen[k] = true;
    for (const k of Object.keys(b)) seen[k] = true;
    const diff = [];
    for (const k of Object.keys(seen)) if (a[k] !== b[k]) diff.push(k);
    if (diff.length === 0) continue;                       // ∅ — legal
    const shape = diff.sort().join(',');

    if (shape === T1_KEYS) {
      // T1, revocation (C2). Both halves in the SAME transaction; neither half
      // alone ever reaches here, because a lone `status` change has the key set
      // {status}, which matches nothing and falls to the refusal below. That is
      // why I-R2.5-2's atomicity needs no separate rule — it is structural.
      const wasLive = a.status === 'active';
      const noPriorRevocation = a.revoked_at === null || a.revoked_at === 0;
      const nowRevoked = b.status === 'revoked';
      const stamped = typeof b.revoked_at === 'number' && Number.isFinite(b.revoked_at) && b.revoked_at > 0;
      if (wasLive && noPriorRevocation && nowRevoked && stamped) continue;   // legal T1
      throw bad('subject "' + a.id + '": the only legal status/revoked_at transition is active -> revoked with a ' +
        'positive timestamp, set together and exactly once — revival and re-stamping are refused (I-R2.5-3a/4)');
    }

    if (shape === T2_KEYS) {
      // T2, seat binding (C3). ONCE: 0 -> positive, on a seat. positive ->
      // positive and positive -> 0 both land here and are refused, because
      // "renewal is a NEW seat subject" (credentials.js:132).
      const isSeat = a.kind === 'seat';
      const wasUnbound = a.expires_at === 0;
      const bound = typeof b.expires_at === 'number' && Number.isFinite(b.expires_at) && b.expires_at > 0;
      if (isSeat && wasUnbound && bound) continue;                            // legal T2
      throw bad('subject "' + a.id + '": expires_at may move only 0 -> positive, on a seat, once — ' +
        'renewal is a NEW seat subject (I-R2.5-9)');
    }

    if (shape === T3_KEYS || shape === T3_REUSE_KEYS || shape === T3_CASE_KEYS) {
      // T3, display rename. A new fold changes name + name_fold + append-only
      // history together. Returning to a reserved fold leaves history unchanged;
      // a casing-only display change changes name alone. Person/tool only — a
      // seat's name is issuance identity, not a chat byline. name_fold must be
      // the NFKC-trim-lower of name, and the new fold must be unique among live
      // subjects in the tenant.
      if (a.kind === 'seat' || b.kind === 'seat') {
        throw bad('subject "' + a.id + '": a seat cannot be display-renamed');
      }
      if (a.kind !== b.kind) {
        throw bad('subject "' + a.id + '": display rename may not change kind');
      }
      const folded = String(b.name == null ? '' : b.name).normalize('NFKC').trim().toLowerCase();
      if (typeof b.name !== 'string' || b.name.trim() === '' || b.name_fold !== folded) {
        throw bad('subject "' + a.id + '": name_fold must be the fold of name');
      }
      const oldHistory = parseSubjectNameHistory(a, bad, 'subject "' + a.id + '" before rename');
      const newHistory = parseSubjectNameHistory(b, bad, 'subject "' + a.id + '" after rename');
      const appended = oldHistory.includes(b.name_fold)
        ? oldHistory
        : [...oldHistory, b.name_fold];
      if (JSON.stringify(newHistory) !== JSON.stringify(appended)) {
        throw bad('subject "' + a.id + '": rename must retain every historical name and may append only the new fold');
      }
      let held = 0;
      for (let j = 0; j < next.subjects.length; j++) {
        const o = next.subjects[j];
        if (o && o.tenant === b.tenant && o.status === 'active' && o.name_fold === b.name_fold) held += 1;
      }
      if (held !== 1) {
        throw bad('subject "' + a.id + '": display name is already held in this tenant');
      }
      continue;
    }

    // ── THE DENY-BY-DEFAULT BRANCH ───────────────────────────────────────
    // Everything not named above. A reviewer who cannot point at this line
    // fails the build (I-R2.5-11).
    throw bad('subject "' + a.id + '": no legal transition changes {' + diff.join(', ') + '} — ' +
      'the only permitted subject deltas are revocation, seat binding, and display rename (C1, deny-by-default)');
  }
  // grants: match next rows against prev by stable grant id. Same-tuple rows with
  // distinct ids are distinct grants; an existing bound-seat id may not rewrite
  // its lifetime, while a new id is judged by the ADD-time rules.
  const prevSubjById = Object.create(null);
  for (let i = 0; i < prev.subjects.length; i++) {
    const s = prev.subjects[i];
    if (s && typeof s.id === 'string') prevSubjById[s.id] = s;
  }
  const prevGrantsById = Object.create(null);
  for (let i = 0; i < prev.grants.length; i++) {
    const g = prev.grants[i];
    if (g && typeof g === 'object' && typeof g.id === 'string') prevGrantsById[g.id] = g;
  }
  const now = Date.now();
  for (let i = 0; i < next.grants.length; i++) {
    const g = next.grants[i];
    // The standing validator owns malformed-row wording. Skip unsafe delta
    // interpretation here so it can name the exact bad identity field.
    if (!g || typeof g !== 'object' || Array.isArray(g) ||
        typeof g.id !== 'string' || g.id === '' || g.id.includes('\x00')) continue;
    const subj = nextById[g.subject_id];
    const existing = prevGrantsById[g.id];
    if (existing) {
      const prevSubj = prevSubjById[existing.subject_id];
      if (prevSubj && prevSubj.kind === 'seat' && prevSubj.expires_at > 0 &&
          existing.expires_at !== g.expires_at) {
        throw bad('bound-seat grant lifetime may not be rewritten (grant ' + i + ') — remove and re-issue through the legal path');
      }
      const semanticChanged = ['tenant', 'subject_id', 'capability', 'resource', 'origin']
        .some(field => existing[field] !== g[field]);
      if (!semanticChanged) continue;
      // D18: the id still identifies the persisted record, but changed grant
      // semantics must not inherit the old row's seat-safety judgment. Re-judge
      // the next identity exactly as an ADD without inventing a public update API.
    }
    // A new id, or changed semantics under an existing id: the target seat must
    // be bound (structural half), ACTIVE and unexpired NOW.
    if (subj && subj.kind === 'seat') {
      if (subj.expires_at === 0) throw bad('grant ' + i + ' attaches to an UNBOUND seat');
      if (subj.status !== 'active') throw bad('a grant may not be added to a revoked seat ("' + g.subject_id + '")');
      if (subj.expires_at <= now) throw bad('a grant may not be added to an expired seat ("' + g.subject_id + '")');
      // Let the standing validator retain authorship of malformed grant
      // schema/lifetime wording. The Task 6 ceiling judges only an otherwise
      // structurally valid proposed seat grant.
      const coverageShapeValid =
        g.tenant === subj.tenant &&
        GRANT_CAPABILITIES.includes(g.capability) &&
        typeof g.resource === 'string' && g.resource.trim() !== '' &&
        !g.resource.includes('\x00') &&
        GRANT_ORIGINS.includes(g.origin) &&
        typeof g.expires_at === 'number' && Number.isFinite(g.expires_at) &&
        g.expires_at > 0 && g.expires_at <= subj.expires_at;
      if (coverageShapeValid && !principalCoversSeatGrant(next, subj, g, now)) {
        throw bad('seat exceeds principal at issuance (grant ' + i + ') — exact origin and lifetime coverage required');
      }
    }
  }

  // ── R6 §10: authenticator prev→next transition gate, deny by default ─────
  // Match by stable authenticator id within tenant. Existing rows may not be
  // removed, revived, repointed, or have unknown keys added/removed. Only USE
  // and REVOKE transitions are legal on existing rows; additions must be
  // complete unrevoked rows with last_used_at === null.
  const prevAuthById = Object.create(null);
  for (let i = 0; i < prev.authenticators.length; i++) {
    const a = prev.authenticators[i];
    if (a && typeof a.id === 'string') prevAuthById[a.tenant + '\x00' + a.id] = a;
  }
  const nextAuthById = Object.create(null);
  for (let i = 0; i < next.authenticators.length; i++) {
    const a = next.authenticators[i];
    if (a && typeof a.id === 'string') nextAuthById[a.tenant + '\x00' + a.id] = a;
  }
  for (const key of Object.keys(prevAuthById)) {
    if (!nextAuthById[key]) {
      throw bad('a transaction may not REMOVE authenticator "' + key + '" — revocation is the lifecycle (R6 §10)');
    }
  }
  for (const key of Object.keys(nextAuthById)) {
    const b = nextAuthById[key];
    const a = prevAuthById[key];
    if (!a) {
      // Addition: complete unrevoked row, last_used_at null.
      if (b.revoked_at !== null) {
        throw bad('authenticator addition "' + b.id + '" must be unrevoked (revoked_at null)');
      }
      if (b.last_used_at !== null) {
        throw bad('authenticator addition "' + b.id + '" must have last_used_at null');
      }
      continue;
    }
    // Existing row: union-key diff, deny by default.
    const seen = Object.create(null);
    for (const k of Object.keys(a)) seen[k] = true;
    for (const k of Object.keys(b)) seen[k] = true;
    // Unknown keys (not in AUTHENTICATOR_KEYS) refuse with the same "UNKNOWN field"
    // wording shape validation uses, so C10's exact/unknown regex still matches
    // when the delta path sees the row first.
    for (const k of Object.keys(seen)) {
      if (!AUTHENTICATOR_KEYS.includes(k)) {
        throw bad('authenticator "' + a.id + '" carries an UNKNOWN field "' + k +
          '" — the shape is exact');
      }
    }
    // Prefer shape-gate wording for blank/malformed field VALUES so R4's
    // whitespace controls (17b) still match /blank|whitespace/ when the delta
    // path runs before assertV2Shapes.
    for (const f of ['id', 'tenant', 'person_subject_id']) {
      if (!isStr(b[f])) {
        throw bad('authenticator "' + a.id + '" field "' + f +
          '" must be a non-empty NUL-free string');
      }
    }
    for (const f of ['credential_id', 'public_key', 'algorithm', 'rp_id']) {
      if (!isText(b[f])) {
        throw bad('authenticator "' + a.id + '" field "' + f +
          '" must be a non-blank NUL-free string');
      }
    }
    const diff = [];
    for (const k of Object.keys(seen)) {
      // transports is an array — compare by JSON for value equality
      if (k === 'transports') {
        if (JSON.stringify(a.transports) !== JSON.stringify(b.transports)) diff.push(k);
      } else if (a[k] !== b[k]) {
        diff.push(k);
      }
    }
    if (diff.length === 0) continue;
    const shape = diff.sort().join(',');

    // USE: last_used_at, sign_count, and optionally backup_state
    const useKeys = new Set(['last_used_at', 'sign_count', 'backup_state']);
    const onlyUse = diff.every(k => useKeys.has(k));
    if (onlyUse && a.revoked_at === null && b.revoked_at === null) {
      // last_used_at: null -> finite at/after created_at, or non-null -> same/greater
      if (diff.includes('last_used_at')) {
        if (b.last_used_at === null) {
          throw bad('authenticator "' + a.id + '": last_used_at may not move back to null');
        }
        if (typeof b.last_used_at !== 'number' || !Number.isFinite(b.last_used_at)) {
          throw bad('authenticator "' + a.id + '": last_used_at must be a finite timestamp on USE');
        }
        if (b.last_used_at < a.created_at) {
          throw bad('authenticator "' + a.id + '": last_used_at must be at/after created_at');
        }
        if (a.last_used_at !== null && b.last_used_at < a.last_used_at) {
          throw bad('authenticator "' + a.id + '": last_used_at must not move backward');
        }
      }
      // sign_count matrix (C8) also enforced at service; gate requires non-decrease
      // for positive counters and permits 0->0.
      if (diff.includes('sign_count')) {
        if (!Number.isSafeInteger(b.sign_count) || b.sign_count < 0) {
          throw bad('authenticator "' + a.id + '": sign_count must be a non-negative safe integer');
        }
        if (a.sign_count === 0 && b.sign_count === 0) {
          // legal 0->0
        } else if (a.sign_count === 0 && b.sign_count > 0) {
          // legal 0 -> positive
        } else if (b.sign_count > a.sign_count) {
          // legal strict increase
        } else {
          throw bad('authenticator "' + a.id + '": sign_count must strictly increase when either value is nonzero');
        }
      }
      // backup_state may change only when backup_eligible remains true and equal
      if (diff.includes('backup_state')) {
        if (a.backup_eligible !== true || b.backup_eligible !== true) {
          throw bad('authenticator "' + a.id + '": backup_state may change only on backup-eligible credentials');
        }
        if (typeof b.backup_state !== 'boolean') {
          throw bad('authenticator "' + a.id + '": backup_state must be boolean');
        }
      }
      continue; // legal USE
    }

    // REVOKE: revoked_at null -> finite once; every other field byte-identical
    if (shape === 'revoked_at' && a.revoked_at === null &&
        typeof b.revoked_at === 'number' && Number.isFinite(b.revoked_at) && b.revoked_at > 0) {
      if (b.revoked_at < a.created_at) {
        throw bad('authenticator "' + a.id + '": revoked_at must not be before created_at');
      }
      if (a.last_used_at !== null && b.revoked_at < a.last_used_at) {
        throw bad('authenticator "' + a.id + '": revoked_at must not be before last_used_at');
      }
      continue; // legal REVOKE
    }

    throw bad('authenticator "' + a.id + '": no legal transition changes {' + diff.join(', ') +
      '} — only USE and REVOKE are permitted (R6 §10, deny-by-default)');
  }
}

// ── the phase barrier ────────────────────────────────────────────────────────
// initialize() is the ONLY builder. Every read, transaction and lookup refuses
// before it has run, so "not initialized" fails loudly instead of being assumed.
// ── #193 (land 2.6): THE REPOSITORY IS TOLD ITS HOUSE ──────────────────────
// The tenant used to be the literal `tenant()` at 24 sites across 14 files, most
// of them guards HERE and in audit.js — the places that decide whether a row may
// commit. My first attempt made it a process-global adopted at construction; it
// failed 160 host tests, because initialize(), migrateV1ToV2() and the
// outbox validators run BEFORE, or entirely WITHOUT, any constructor. Grok ruled
// the smaller, truer seam: the component that ENFORCES the rule holds the value.
//
// NOT a process-global: two isolated stores must be able to live in one process,
// so this is per-initialize state, re-set on every initialize(), never pinned
// for the lifetime of the module.
let TENANT = null;

function validTenantName(v) {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v);
}

// Every guard reads this. It THROWS when unset rather than defaulting, because
// the only default available is the host name this whole land exists to delete.
// Descriptive, for a module's EXPORTED constant. Reading an export must never
// throw — an export-surface test that enumerates keys would die on the getter,
// which is exactly what happened. The ENFORCING path is tenant(), below, and it
// still refuses. Never use this in a guard.
function hasTenant() { return TENANT !== null; }

function tenant() {
  if (TENANT === null) {
    throw new Error('identity repo: no tenant. Pass { tenant } to initialize() — it is ' +
      'REQUIRED and has no default, because the only default available is one ' +
      'particular house\'s name (#193)');
  }
  return TENANT;
}

function initialize(opts) {
  // Required, fail-closed, checked BEFORE any state work: a caller that forgot
  // the tenant must be told that, not handed a confusing downstream error.
  const t = (opts && typeof opts === 'object') ? opts.tenant : undefined;
  if (!validTenantName(t)) {
    throw new Error('identity repo: initialize({ tenant }) is REQUIRED — 1-63 chars of ' +
      '[a-z0-9_-] starting alphanumeric, no default (#193). Got ' + JSON.stringify(t));
  }
  // ── F1 (Pitohui, land 2.6 review): WRITE-ONCE, exactly like the state dir ──
  // This used to assign unconditionally, so a second create() on the SAME state
  // dir with a DIFFERENT tenant silently re-pointed the process — and the
  // already-running instance's health().tenant flipped under it. Every guard in
  // this file compares tenant(), so instance A would have begun validating rows
  // against a name its host never chose. Silently.
  //
  // Re-initialising with the SAME name stays legal: host suites do it constantly,
  // and it asserts nothing new. A DIFFERENT name is refused, because two houses
  // in one process means the validator and the commit point can disagree about
  // which house a row belongs to.
  if (TENANT !== null && TENANT !== t) {
    throw new Error('identity repo: this process is already serving tenant ' +
      JSON.stringify(TENANT) + ' and cannot also serve ' + JSON.stringify(t) +
      '. A second tenant would silently re-point every guard in this module, ' +
      'including for services already constructed against the first one.');
  }
  TENANT = t;
  // Amendment #1 §3 (reviewer F3): while FATAL, initialize() must REFUSE — it
  // previously reinstalled a triple, returned {ready:true}, and left FATAL set,
  // so a startup barrier trusting the return value would boot a repo that
  // reports healthy and serves nothing. reload() is the one recovery door.
  if (FATAL) throw new Error('identity repo: FATAL — ' + FATAL + '; initialize() refuses, reload() is the recovery door');
  if (STATE && INDEX_FOR_STATE === STATE) return { ready: true, credentials: STATE.credentials.length };
  const next = load();                       // parse + shape-validate
  const idx = buildIndex(next);              // throws on duplicate/malformed
  effectivePolicyLifetime(next.policy, 'state file');
  assertRelationalInvariants(next, 'state file'); // B4 L7: after the selector gates, before install
  assertV2Shapes(next, 'state file');             // C4 field-exactness
  assertV2RelationalInvariants(next, 'state file');
  assertUsableAdministrators(next, 'state file'); // C7: fails CLOSED, before install
  const frozen = deepFreeze(next);
  STATE = frozen; SELECTOR_IDX = idx; INDEX_FOR_STATE = frozen;   // installed together
  return { ready: true, credentials: STATE.credentials.length };
}

// reload() is NOT initialize(). initialize() may no-op when already ready;
// reload ALWAYS re-reads, re-validates and rebuilds. On failure the previously
// installed triple stays installed — a failed reload must never empty or poison
// live state.
function reload() {
  // Reachable while FATAL, by design: it is the documented recovery path.
  if (!STATE) throw new Error('identity repo: reload() before initialize()');
  const next = load();
  const idx = buildIndex(next);              // throws BEFORE anything is swapped
  effectivePolicyLifetime(next.policy, 'state file');
  assertRelationalInvariants(next, 'state file'); // B4 L7 — same gate as initialize()
  assertV2Shapes(next, 'state file');
  assertV2RelationalInvariants(next, 'state file');
  assertUsableAdministrators(next, 'state file'); // C7 — and on failure the
  // PREVIOUSLY installed triple stays installed, per reload()'s standing law.
  const frozen = deepFreeze(next);
  STATE = frozen; SELECTOR_IDX = idx; INDEX_FOR_STATE = frozen;
  FATAL = null;
}

function requireReady() {
  if (FATAL) throw new Error('identity repo: FATAL — ' + FATAL + '; restart or reload()');
  if (!STATE || INDEX_FOR_STATE !== STATE) {
    throw new Error('identity repo: not initialized — call initialize() before any read, transaction or lookup');
  }
}

// LOOKUP ONLY. Never builds, extends or repairs. Rebuilding here would be an
// O(N) scan wearing the face of diligence.
function credentialBySelector(selector) {
  requireReady();
  const i = SELECTOR_IDX.get(selector);
  if (i === undefined) return null;
  return STATE.credentials[i] || null;
}

// The single atomic commit point. Write a whole snapshot to temp, fsync so the
// bytes are durable, then rename — rename is atomic, so a reader (or a restart)
// sees old-complete or new-complete and nothing else.
function commit(next) {
  const tmp = TMP();
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(next));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // FOLD F7 (cold review, probe Y): a failed rename must not strand the REJECTED
  // next-state beside the real file — a foot-gun for backup scripts and readers.
  try {
    fs.renameSync(tmp, FILE());
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort — the throw below is the signal */ }
    throw e;
  }
  // Best-effort directory fsync so the rename itself survives power loss. Not
  // supported on every filesystem this repo runs on (Windows/DrvFs refuses to
  // open a directory), so a failure here is not fatal — the crash-recovery
  // controls in Task 9 decide empirically what this host actually guarantees.
  try {
    const dfd = fs.openSync(BASE(), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (e) { /* not supported here; Task 9 measures the real behaviour */ }
}

// fn(draft) mutates a private copy. Nothing is visible — in memory or on disk —
// until the commit succeeds. A throw from fn, or from the commit, leaves the
// world exactly as it was. "Mutation succeeded" means "durably committed".
// I17 (amendment #1 §1, reviewer F1 — HIGH): transact() is NON-REENTRANT, fail
// closed. A nested transact captured a stale `prev` and silently overwrote the
// inner commit while returning success — measured, not hypothesized. The refusal
// fires before any nested draft, write, or success return; a caught refusal must
// not poison the outer transaction.
let IN_TRANSACTION = false;

function transact(fn) {
  requireReady();
  if (IN_TRANSACTION) {
    throw new Error('identity repo: transact() is non-reentrant (I17) — a nested transaction would silently lose its commit');
  }
  const prev = STATE;
  const draft = JSON.parse(JSON.stringify(prev));
  let result;
  IN_TRANSACTION = true;
  try {
    result = fn(draft);
  } finally {
    IN_TRANSACTION = false;
  }
  if (!draft || typeof draft !== 'object') throw new Error('identity repo: transaction destroyed the state object');
  assertShape(draft, 'transaction'); // FOLD F5: the write path gets the same typed gate as the read path
  if (draft.version !== VERSION) {
    throw new Error('identity repo: a transaction may not change version (got ' + draft.version + ')');
  }
  effectivePolicyLifetime(draft.policy, 'transaction');
  assertPolicyDeltas(prev, draft);
  assertBootstrapDelta(prev, draft);         // C7: null -> number, at most once
  assertMigrationEventDeltas(prev, draft);   // C6: no minting, no rewriting; draining is legal
  assertCredentialInvariants(prev, draft);   // throws BEFORE the disk commit
  assertRelationalDeltas(prev, draft);              // B4 L6: name illegal CHANGES first…
  assertRelationalInvariants(draft, 'transaction'); // …then enforce the standing relation
  assertV2Shapes(draft, 'transaction');             // C4 field-exactness, same gate as load
  assertV2RelationalInvariants(draft, 'transaction');
  assertSystemRoleBundleDeltas(prev, draft);        // R2/I-R2-6 — ordered here by Amendment 2, Ruling 2
  assertUsableAdministrators(draft, 'transaction'); // C7 resulting-state guard, at the commit point
  commit(draft);                             // throws on any failure — nothing below runs

  // ── publication boundary ──────────────────────────────────────────────────
  // Extend the position map with this transaction's appended tail, then install
  // the new triple. Run-to-completion guarantees no caller observes a new STATE
  // with a stale index: there is no await between these lines.
  const frozen = deepFreeze(draft);
  try {
    const idx = SELECTOR_IDX;
    for (let i = prev.credentials.length; i < frozen.credentials.length; i++) {
      idx.set(frozen.credentials[i].selector, i);
    }
    STATE = frozen; SELECTOR_IDX = idx; INDEX_FOR_STATE = frozen;
  } catch (e) {
    // The snapshot is already durable but the pair is now unmatched. Do NOT
    // report success and do NOT keep serving. Invalidate only the ASSOCIATION;
    // keep the state object so reload() can rebuild from the now-durable
    // snapshot — the recovery instruction and the code must agree.
    SELECTOR_IDX = null; INDEX_FOR_STATE = null;
    FATAL = 'index extension failed after a durable commit';
    throw new Error('identity repo: FATAL — commit durable but index extension failed; restart or reload(). ' + (e && e.message));
  }
  return result;
}

function read() { requireReady(); return STATE; }

// R7 §13.3 / disposition F-A: SHA-256 over the exact published file bytes on
// disk (identity-state.v2.json), not JSON.stringify of the in-memory STATE.
// Callers that witness drift must use this — hashing repo.read() is weaker.
function publishedFileSha256() {
  requireReady();
  const raw = fs.readFileSync(FILE());
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function pendingOutbox() { requireReady(); return STATE.outbox; }

// Idempotent by construction: marking an already-delivered id is a no-op, which
// is what makes at-least-once delivery safe to retry after a crash.
// PACKET N1 (departure from the plan reference, which checked its args first):
// the ready-guard runs BEFORE any early return — a pre-init markDelivered([])
// must refuse, not silently answer 0.
function markDelivered(ids) {
  requireReady();
  // I17, Codex's strengthening: refuse while a transaction callback is active
  // EVEN for no-op inputs — a "0" answered mid-callback is a false report about
  // state that is still in flight.
  if (IN_TRANSACTION) {
    throw new Error('identity repo: markDelivered() inside a transaction callback is non-reentrant (I17)');
  }
  const want = new Set(ids || []);
  if (want.size === 0) return 0;
  const present = STATE.outbox.filter(e => want.has(e.id)).length;
  if (present === 0) return 0;
  return transact(d => {
    const before = d.outbox.length;
    d.outbox = d.outbox.filter(e => !want.has(e.id));
    return before - d.outbox.length;
  });
}

// ── C2: the explicit v1 -> v2 migration ─────────────────────────────────────
// Pre-initialization only, refused inside a transaction, non-reentrant, and
// idempotent BY REFUSAL. Never called implicitly: initialize() names it as the
// remedy and does nothing else (I-R1-6).
let MIGRATING = false;

function migrateV1ToV2(opts) {
  // #193: migration is PRE-INITIALIZATION by contract (it refuses once STATE
  // exists), so it cannot lean on initialize() having set the tenant — and it
  // writes rows the validators will check against one. It is told directly, by
  // the same required, fail-closed rule.
  const __t = (opts && typeof opts === 'object') ? opts.tenant : undefined;
  if (!validTenantName(__t)) {
    throw new Error('identity repo: migrateV1ToV2({ tenant }) is REQUIRED — migration ' +
      'writes rows that are validated against the tenant, and there is no default (#193). ' +
      'Got ' + JSON.stringify(__t));
  }
  if (TENANT !== null && TENANT !== __t) {
    throw new Error('identity repo: this process is already serving tenant ' +
      JSON.stringify(TENANT) + '; migrateV1ToV2 cannot adopt ' + JSON.stringify(__t));
  }
  TENANT = __t;
  if (IN_TRANSACTION) {
    throw new Error('identity repo: migrateV1ToV2() inside a transaction callback is refused (I17) — it is a pre-initialization operation');
  }
  if (MIGRATING) throw new Error('identity repo: migrateV1ToV2() is non-reentrant');
  if (STATE) {
    throw new Error('identity repo: migrateV1ToV2() is pre-initialization only — the repository is already initialized');
  }

  MIGRATING = true;
  try {
    // (a) v2 already present? Idempotent refusal — never a second transformation.
    try {
      fs.readFileSync(FILE(), 'utf8');
      throw new Error('identity repo: already migrated — identity-state.v2.json exists and is the sole authority');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }

    // (b) no v1 source? First run is initialize()'s job, not the migration's.
    let v1;
    try {
      v1 = readAndParse(V1_FILE(), V1_SCHEMA, 'version-1 state file');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        throw new Error('identity repo: nothing to migrate — no version-1 state file exists (a first run is initialize()\'s job)');
      }
      throw e;
    }

    // (c) VALIDATE THE COMPLETE V1 SOURCE FIRST, with the FULL v1 gate. A v1
    //     source that v1-initialize() would refuse, the migration refuses with
    //     the same class of loud error (I-R1-2) — never an empty first run.
    // buildIndex() carries no `where` of its own, so its refusal is re-thrown
    // with the source named: an operator must be told THEIR v1 file is bad, not
    // that "migrated state" is (and it stops the v2 post-validation silently
    // covering for a deleted pre-validation — mutation M-C3).
    try { buildIndex(v1); }
    catch (e) { throw new Error('identity repo: version-1 state file is invalid — ' + e.message); }
    effectivePolicyLifetime(v1.policy, 'version-1 state file');
    assertRelationalInvariants(v1, 'version-1 state file');

    // (d) Refuse surprises: no legal writer for v1 passwords{} ever shipped, so
    //     content there is corruption or tampering, never data to carry forward.
    if (Object.keys(v1.passwords).length !== 0) {
      throw new Error('identity repo: REFUSING to migrate — the version-1 passwords object is NOT EMPTY (' +
        Object.keys(v1.passwords).length + ' entries). No legal writer for it ever shipped, so its content is ' +
        'corruption or tampering, never data to carry forward (I-R1-4).');
    }

    // (e) Transform: the six v1 collections cross UNCHANGED — same rows, same
    //     order, same fields, credential positions pinned.
    const next = {
      version: VERSION,
      subjects: v1.subjects, passwords: v1.passwords, credentials: v1.credentials,
      grants: v1.grants, policy: v1.policy,
      outbox: [...v1.outbox, {
        id: crypto.randomUUID(), ts: Date.now(), kind: MIGRATION_EVENT_KIND,
        tenant: tenant(), from_version: V1_VERSION, to_version: VERSION,
      }],
      memberships: [], roles: [], role_permissions: [], role_assignments: [],
      admission_capabilities: [], authenticators: [],
      bootstrap: { completed_at: null },
    };

    // (f) VALIDATE THE COMPLETE V2 RESULT before publication.
    assertShape(next, 'migrated state', V2_SCHEMA);
    buildIndex(next);
    effectivePolicyLifetime(next.policy, 'migrated state');
    assertRelationalInvariants(next, 'migrated state');
    assertV2Shapes(next, 'migrated state');
    assertV2RelationalInvariants(next, 'migrated state');
    assertUsableAdministrators(next, 'migrated state');

    // (g) Publish atomically — same temp + fsync + rename discipline, same F7
    //     unlink-on-failed-rename. The v1 file is LEFT IN PLACE, inert: its
    //     retirement belongs to a later task under its own authority.
    commit(next);

    return {
      migrated: true, from: V1_VERSION, to: VERSION,
      counts: {
        subjects: next.subjects.length, credentials: next.credentials.length,
        grants: next.grants.length, outbox: next.outbox.length,
        passwords: Object.keys(next.passwords).length,
      },
    };
  } finally {
    MIGRATING = false;
  }
}

// The installed-state convenience (C7). The pure predicate is exported beside it
// so R2+ can evaluate a proposed state without installing it.
function usableAdministrators(tenant) {
  requireReady();
  return usableAdministratorsIn(STATE, tenant);
}

module.exports = {
  // #268 / land 2.5: the entry point binds the store through this before it
  // constructs anything. It was added to this file and NOT exported, so
  // `identity.create()` threw for every caller past the config validation —
  // and every control written for it asserted a REFUSAL, which returns before
  // this line is reached. Six green controls over a create() that could not
  // construct. Found by Codex's F3 ("the gate never actually constructs"), which
  // is exactly the hole he said it was.
  configureStateDir,
  tenant, hasTenant, validTenantName,
  PASSWORD_KDF_PROFILES, PASSWORD_PARAM_KEYS, PASSWORD_B64URL_32, passwordProfileFor,
  initialize, reload, read, transact, credentialBySelector,
  pendingOutbox, markDelivered, FILE, publishedFileSha256,
  V1_FILE, migrateV1ToV2,                    // R1: explicit, never implicit
  usableAdministratorsIn, usableAdministrators,  // D43 predicate (pure + installed)
  VERSION,
  // R1 frozen vocabulary — one definition, for R2+ to reuse rather than redeclare
  MEMBERSHIP_STATUSES, ADMISSION_PURPOSES, ROLE_ASSIGNMENT_SCOPES, ADMINISTRATOR_SLUG,
  // R2/Amendment 2 Ruling 3: the export surface widens for constants that
  // ALREADY EXIST here frozen — no new constant, no changed value. R2's modules
  // must refuse before the repository does (C6), and the only alternative was
  // re-typing five vocabularies the standing validator already owns, which is
  // the drift C2 exists to forbid (live specimen: grants.js:18 re-types
  // SUBJECT_KINDS beside :72 below). An alignment control pins each of these to
  // its consumers by value and order.
  // Exactly the five Ruling 3 enumerates — DEFAULT_PASS_LIFETIME_MS is
  // deliberately NOT among them: R2 needs the bounds, not the default, and
  // widening a ruled enumeration by one convenient extra is the silent
  // deviation the packet forbids.
  SUBJECT_KINDS, ROLE_STATUSES, SEAT_ADMISSION_PURPOSES,
  MIN_PASS_LIFETIME_MS, MAX_PASS_LIFETIME_MS,
  SELECTOR_CHARS, B64URL,                    // one definition — credentials.js imports these
  GRANT_CAPABILITIES, GRANT_ORIGINS,         // Task 4: one frozen persisted vocabulary
  // FOLD F4 (cold review, probe B): shallow freeze let EMPTY_STATE.subjects.push()
  // poison the template for every consumer in the process, while the guarding test
  // (isFrozen on the root) stayed green. A template must be unpoisonable all the way down.
  EMPTY_STATE: deepFreeze(emptyState()),
};
