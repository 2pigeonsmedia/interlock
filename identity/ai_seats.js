'use strict';

// Interlock's one-room AI admission composition. This file owns the one
// transaction that turns a short claim into a bounded seat and its only bearer
// credential. The host receives the finished public method from index.js; it
// never assembles admission + subject + credential + grants itself.

const crypto = require('node:crypto');
const repo = require('./repo.js');
const admission = require('./admission.js');
const subjects = require('./subjects.js');
const credentials = require('./credentials.js');
const grants = require('./grants.js');

const ROOM_RESOURCE = 'room:main';
const FAIL = Object.freeze({ ok: false, reason: 'invalid-claim' });

function nextHandle(draft, tenant, product) {
  const prefix = subjects.fold(product + '-');
  let highest = 0;
  for (const subject of draft.subjects) {
    if (!subject || subject.tenant !== tenant || typeof subject.name_fold !== 'string' ||
        !subject.name_fold.startsWith(prefix)) continue;
    const suffix = subject.name_fold.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(suffix)) continue;
    const value = Number(suffix);
    if (Number.isSafeInteger(value) && value > highest) highest = value;
  }
  if (highest >= Number.MAX_SAFE_INTEGER) {
    throw new Error('ai_seats: handle counter is exhausted');
  }
  return product + '-' + (highest + 1);
}

function exactCeilings(claim) {
  return claim.capability_ceiling.length === 2 &&
    claim.capability_ceiling[0] === 'read' &&
    claim.capability_ceiling[1] === 'write' &&
    claim.resource_ceiling.length === 1 &&
    claim.resource_ceiling[0] === ROOM_RESOURCE;
}

function createService(opts) {
  const tenant = opts && opts.tenant;
  if (!repo.validTenantName(tenant)) {
    throw new Error('ai_seats.createService: tenant is required');
  }

  function redeemClaim(input) {
    const body = input || {};
    if (body === null || typeof body !== 'object' || Array.isArray(body) ||
        Object.getPrototypeOf(body) !== Object.prototype) return FAIL;
    const keys = Object.keys(body);
    if (keys.some(key => key !== 'secret')) return FAIL;
    const secret = body.secret;
    const now = Date.now();
    if (typeof secret !== 'string' || secret === '') return FAIL;

    const token = credentials.newToken();
    try {
      const result = repo.transact(draft => {
        let handle = null;
        const consumed = admission.consumeSeatClaimInDraft(draft, {
          tenant, purpose: 'summon_seat', secret, now,
        }, claim => {
          if (typeof claim.secret_label !== 'string' ||
              !/^[A-Z][A-Za-z0-9]{0,19}$/.test(claim.secret_label) ||
              !exactCeilings(claim) ||
              !Number.isSafeInteger(claim.max_seat_ttl) ||
              claim.max_seat_ttl < repo.MIN_PASS_LIFETIME_MS ||
              claim.max_seat_ttl > repo.MAX_PASS_LIFETIME_MS) {
            throw new Error('ai_seats: stored claim is outside the one-room seat contract');
          }
          handle = nextHandle(draft, tenant, claim.secret_label);
          return subjects.createSeatInDraft(draft, {
            tenant,
            name: handle,
            principal: claim.principal_subject_id,
            now,
          });
        });

        const seat = consumed.consumer;
        const claim = consumed.record;
        const credential = credentials.issueInDraft(draft, {
          selector: token.selector,
          digest: token.digest,
          subject_id: seat.id,
          type: 'pass',
          ttlMs: claim.max_seat_ttl,
          generation: 1,
          request_id: crypto.randomUUID(),
          now,
        });

        grants.ensurePrincipalPairInDraft(draft, {
          tenant,
          subject_id: claim.principal_subject_id,
          resource: ROOM_RESOURCE,
          origin: 'any',
          now,
        });
        grants.ensureSeatPairInDraft(draft, {
          tenant,
          subject_id: seat.id,
          resource: ROOM_RESOURCE,
          origin: 'any',
          now,
        });

        draft.outbox.push({
          id: crypto.randomUUID(),
          ts: now,
          kind: 'ai-seat.enroll',
          tenant,
          capability_id: claim.id,
          subject_id: seat.id,
          subject_name: seat.name,
          principal_subject_id: seat.principal,
          credential_id: credential.id,
          resource: ROOM_RESOURCE,
          expires_at: credential.expires_at,
        });
        return {
          subject_id: seat.id,
          handle: seat.name,
          expires_at: credential.expires_at,
        };
      });

      return Object.freeze({
        ok: true,
        subject_id: result.subject_id,
        handle: result.handle,
        expires_at: result.expires_at,
        bearer_token: token.token,
      });
    } catch (_) {
      return FAIL;
    }
  }

  return Object.freeze({ redeemClaim });
}

module.exports = { createService, ROOM_RESOURCE };
