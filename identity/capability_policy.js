// identity/capability_policy.js — THE protected capability-policy manifest.
//
// WHY THIS FILE EXISTS, AND WHY IT IS CODE AND NOT A COLLECTION: the design
// requires ONE protected, versioned, server-owned
// manifest to be the authority for privilege class, allowed actor kinds, and
// minimum assurance — consumed identically by role validation, direct-grant
// validation, can(), and the later route-policy validator, so that no mutable
// role, grant, route entry, or request can downgrade it.
//
// It is a frozen module rather than a `capability_policies` row set because a
// new top-level repository field would change the version-2 shape and re-open
// the repository's exact `REQUIRED` field set — and that exactness is what
// structurally guarantees that no durable `sessions` field can exist. Storing
// policy as data would also make the authority mutable by the very transactions
// it is supposed to govern. A code artifact cannot be edited by a caller at all.
//
// It has NO dependencies, deliberately: repo.js imports it at load, so anything
// it required would be pulled into the repository's own initialization path.
//
// THE SPELLING RULE: administrative classification comes from
// the capability, never from a role slug, display label, or a substring such as
// `admin`. Everything downstream asks THIS TABLE, never a name.
'use strict';

const MANIFEST_VERSION = 1;

// The whole table. A capability absent from here DOES NOT EXIST —
// which is why every accessor below refuses an unknown slug instead of
// answering a default. Order is fixed: the v1 four keep their
// order and `sponsor` lands last, so no persisted consumer sees a reordering.
const MANIFEST = Object.freeze([
  row('read', 'ordinary', ['person', 'seat', 'tool'], 1),
  row('write', 'ordinary', ['person', 'seat', 'tool'], 1),
  row('admin', 'administrative', ['person'], 2),
  row('summon', 'ordinary', ['person'], 1),
  row('sponsor', 'ordinary', ['person'], 1),
]);

// Frozen ALL THE WAY DOWN. Precedent: elsewhere a shallow freeze let
// a shared template be poisoned in-process while an `isFrozen()` check on the
// root stayed green. Here the nested `allowed_subject_kinds` array is the
// poisonable surface, and a mutable kind list IS a policy surface.
function row(capability, privilege_class, allowed_subject_kinds, minimum_assurance) {
  return Object.freeze({
    capability,
    privilege_class,
    allowed_subject_kinds: Object.freeze([...allowed_subject_kinds]),
    minimum_assurance,
  });
}

// ONE definition of the capability vocabulary, derived from the manifest rather
// than typed beside it. `repo.GRANT_CAPABILITIES` is this same frozen object
// (one shared vocabulary), and `grants.CAPABILITIES` re-exports that in turn — so the three
// cannot drift, because there is only one array.
const CAPABILITIES = Object.freeze(MANIFEST.map(r => r.capability));

// A LOOKUP: answers null for an unknown capability. Deliberately the one
// accessor that does, and the deciding accessors below therefore re-check
// rather than delegating to it — a decision function that inherits a lookup's
// null would be answering "no policy" as though it meant "no restriction".
function policyFor(capability) {
  if (typeof capability !== 'string') return null;
  return MANIFEST.find(r => r.capability === capability) || null;
}

// DENY BY DEFAULT AS A SHAPE PROPERTY, not as a caller's discipline. Each of
// these refuses loudly rather than returning `false` / `[]` / `1`, because a
// permissive default is exactly how an unenumerated capability would acquire
// authority silently — and the omission would be invisible at every call site.
function requirePolicy(capability, where) {
  const p = policyFor(capability);
  if (!p) {
    throw new Error('capability_policy.' + where + ': unknown capability ' + JSON.stringify(capability) +
      ' — the manifest is the whole table and a capability absent from it does not exist (spec 6.1)');
  }
  return p;
}

function isAdministrative(capability) {
  return requirePolicy(capability, 'isAdministrative').privilege_class === 'administrative';
}

function allowedKinds(capability) {
  return requirePolicy(capability, 'allowedKinds').allowed_subject_kinds;
}

// STORED AND EXPORTED ONLY. This module enforces no assurance anywhere — that
// belongs to the later assurance layer. Stated here so a later reader does not mistake the presence of
// the number for a live gate.
function minimumAssurance(capability) {
  return requirePolicy(capability, 'minimumAssurance').minimum_assurance;
}

module.exports = {
  MANIFEST, MANIFEST_VERSION, CAPABILITIES,
  policyFor, isAdministrative, allowedKinds, minimumAssurance,
};
