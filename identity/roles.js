// identity/roles.js — the protected role registry, a LOGICAL module over repo.js.
//
// R2 of the Plan 1.5 recovery sequence (desk tickets #173 / build #185).
// Assertions: Ouzel — ASSERTION_PACKET_R2_2026-08-01_OUZEL.md + AMENDMENT1 +
// AMENDMENT2 (all three bind; later wins on conflict). Builder: Tailorbird.
//
// WHY THIS FILE EXISTS: spec §6.2 adds two protected built-ins that runtime
// administration may assign and revoke but CANNOT rewrite. Before this, the
// The upstream host had no reusable authority at all — every permission was a direct grant
// hung on one subject, so "everyone in main chat" had no expressible form and
// revoking a class of access meant hunting individual rows.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   · It creates nothing but the protected built-ins. Custom roles, groups,
//     inheritance, negative permissions and public role authoring are deferred
//     (spec §13) and R2 provides no path to any of them (I-R2-8). The ABSENCE
//     is the guarantee — a control pins this module's surface so an addition is
//     a red test rather than a diff nobody read.
//   · It makes NO authorization decision. Reads return raw registry rows, the
//     `grants.js` precedent. can() composition is R3's (packet §10).
//   · It holds NO state of its own (the subjects.js I2 precedent): no cache, no
//     memo, no seeded copy. That is what makes "revocation bites on the next
//     request" true by construction rather than by comment.
//
// The storage rules that make role-based smuggling impossible — the
// protected-slug rule, kind coherence, and system-bundle immutability — live in
// repo.js at the commit point, not here. A convention another module can break
// is not an invariant, so this module must never be the only thing that checked.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');

// The two protected slugs (D28). Canonical persisted keys, never display labels
// (D29): `administrator` is always `administrator` on disk, whatever a
// deployment calls it on screen. Imported from the repository rather than
// re-typed — the alignment law (C2), and grants.js:18 is the live specimen of
// what re-typing costs.
const PARTICIPANT = 'participant';
const ADMINISTRATOR = repo.ADMINISTRATOR_SLUG;

// ── the protected manifests, verbatim from spec §6.2 / packet C3 ────────────
// `participant` carries exactly read+write on the four shared surfaces: no
// private room or document, no summon, no sponsor, no administrative authority.
// A document needing stricter handling resolves to `doc:<id>` and therefore does
// NOT inherit `docs:main`.
const PARTICIPANT_RESOURCES = Object.freeze(['room:main', 'docs:main', 'board', 'tickets']);

// `administrator` carries `admin` SEPARATELY on each administrative resource
// plus `read` on audit. It is deliberately not a wildcard: it gives no content
// access by itself and does not imply participant, summon, or sponsor. Listing
// the resources one by one is the point — a wildcard would silently absorb every
// resource a later task invents.
const ADMINISTRATOR_ADMIN_RESOURCES = Object.freeze([
  'membership', 'roles', 'credentials', 'authenticators', 'rooms', 'tools', 'policy:pass_lifetime',
]);

const PROTECTED = Object.freeze({
  [PARTICIPANT]: Object.freeze({
    allowed_subject_kinds: Object.freeze(['person', 'seat']),
    default_display_name: 'Participant',
    bundle: Object.freeze([
      ...PARTICIPANT_RESOURCES.map(resource => Object.freeze({ capability: 'read', resource })),
      ...PARTICIPANT_RESOURCES.map(resource => Object.freeze({ capability: 'write', resource })),
    ]),
  }),
  [ADMINISTRATOR]: Object.freeze({
    allowed_subject_kinds: Object.freeze(['person']),
    // D21: never hard-code a person's name, a host-specific display label, one
    // machine, or one domain. The host may display `Owner`; the product default
    // is `admin`.
    default_display_name: 'admin',
    bundle: Object.freeze([
      ...ADMINISTRATOR_ADMIN_RESOURCES.map(resource => Object.freeze({ capability: 'admin', resource })),
      Object.freeze({ capability: 'read', resource: 'audit' }),
    ]),
  }),
});

function requireTenant(tenant, where) {
  if (typeof tenant !== 'string' || tenant.trim() === '') {
    throw new Error('roles.' + where + ': tenant is required — no method defaults it (I5/D3)');
  }
}

// seedProtectedRoles(tenant, { display_names }) — the module's ONLY creation
// path, and it creates only protected built-ins.
//
// IDEMPOTENT BY REFUSAL, not by no-op: if either protected slug already exists
// in the tenant it refuses loudly and writes nothing. A silent no-op would be
// read by a caller as "seeded", and a partial re-seed would be worse still — so
// the whole thing lands in ONE transaction or none of it does.
function seedProtectedRoles(tenant, opts) {
  requireTenant(tenant, 'seedProtectedRoles');
  const labels = (opts && opts.display_names) || {};
  for (const slug of Object.keys(labels)) {
    if (!PROTECTED[slug]) {
      throw new Error('roles.seedProtectedRoles: display_names names "' + slug +
        '", which is not a protected role — presentation may be chosen, roles may not be invented (I-R2-8)');
    }
    if (typeof labels[slug] !== 'string' || labels[slug].trim() === '') {
      throw new Error('roles.seedProtectedRoles: display_name for "' + slug + '" must be a non-blank string');
    }
  }

  return repo.transact(state => seedProtectedRolesInDraft(state, {
    tenant, display_names: labels, now: Date.now(),
  }));
}

// R7: shared seed body for bootstrap completion (one transaction with assignments).
function seedProtectedRolesInDraft(state, opts) {
  const { tenant, display_names, now } = opts || {};
  requireTenant(tenant, 'seedProtectedRoles');
  if (tenant !== repo.tenant()) {
    throw new Error('roles.seedProtectedRolesInDraft: first-release seed is house-only (R7-D3)');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('roles.seedProtectedRolesInDraft: now must be a finite number');
  }
  const labels = display_names || {};
  const existing = state.roles.find(r => r.tenant === tenant && Object.keys(PROTECTED).includes(r.slug));
  if (existing) {
    throw new Error('roles.seedProtectedRoles: tenant "' + tenant + '" is already seeded — role "' +
      existing.slug + '" already exists. Seeding is idempotent BY REFUSAL: a silent no-op could be read ' +
      'as "seeded", and a partial re-seed would be worse.');
  }

  const created = [];
  for (const slug of [PARTICIPANT, ADMINISTRATOR]) {
    const manifest = PROTECTED[slug];
    const role = {
      id: crypto.randomUUID(),
      tenant,
      slug,
      display_name: labels[slug] || manifest.default_display_name,
      system: true,
      status: 'active',
      allowed_subject_kinds: [...manifest.allowed_subject_kinds],
      created_at: now,
    };
    state.roles.push(role);
    for (const p of manifest.bundle) {
      state.role_permissions.push({
        id: crypto.randomUUID(),
        tenant,
        role_id: role.id,
        capability: p.capability,
        resource: p.resource,
        origin: 'any',
        created_at: now,
        revoked_at: null,
      });
    }
    state.outbox.push({
      id: crypto.randomUUID(), ts: now, kind: 'role.seed',
      tenant, role_id: role.id, slug, bundle_size: manifest.bundle.length,
    });
    created.push(role);
  }
  return created;
}

// ── reads: raw registry data, no authorization decision ─────────────────────
// repo.read() runs FIRST in each, so readiness and FATAL compose even for
// malformed arguments (the subjects.js I3 precedent).

function bySlug(tenant, slug) {
  const state = repo.read();
  requireTenant(tenant, 'bySlug');
  return state.roles.find(r => r.tenant === tenant && r.slug === slug) || null;
}

// By OPAQUE id, and therefore the one lookup without a tenant parameter — an id
// is unguessable and names no cross-tenant enumeration surface, which slugs do.
function get(id) {
  return repo.read().roles.find(r => r.id === id) || null;
}

function list(tenant) {
  const state = repo.read();
  requireTenant(tenant, 'list');
  return state.roles.filter(r => r.tenant === tenant);
}

// The RAW bundle, revoked rows included — it is history, and deciding which
// rows are live is an authorization judgment this module does not make.
function permissions(tenant, role_id) {
  const state = repo.read();
  requireTenant(tenant, 'permissions');
  return state.role_permissions.filter(p => p.tenant === tenant && p.role_id === role_id);
}

module.exports = { seedProtectedRoles, seedProtectedRolesInDraft, bySlug, get, list, permissions };
