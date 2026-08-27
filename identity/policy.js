// identity/policy.js — bounded pass-lifetime policy state for Plan 1.
//
// Task 8 assertion authority:
// docs/audits/CODEX_ASSERTION_PACKET_TASK8_2026-07-30.md
// docs/audits/CODEX_PACKET_AMENDMENT1_TASK8_2026-07-31.md
//
// This is a state primitive only. Authorization remains the caller's concern;
// credentials.issue() still requires an explicit TTL and imports no policy.
'use strict';
const crypto = require('crypto');
const repo = require('./repo.js');

const DEFAULT_PASS_LIFETIME_MS = 1_209_600_000; // 14 days
const MIN_PASS_LIFETIME_MS = 900_000;
const MAX_PASS_LIFETIME_MS = 7_776_000_000;     // 90 days
const PLAN1_GENERATION = 1;

const NO_CHANGE = Symbol('policy.pass_lifetime no change');

function requireLifetime(value, where) {
  if (!Number.isSafeInteger(value) ||
      value < MIN_PASS_LIFETIME_MS ||
      value > MAX_PASS_LIFETIME_MS) {
    throw new Error(where + ': pass lifetime must be a safe integer inside inclusive bounds ' +
      MIN_PASS_LIFETIME_MS + '..' + MAX_PASS_LIFETIME_MS);
  }
  return value;
}

function effectiveLifetime(policy, where) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(where + ': policy must be a plain object');
  }
  const keys = Object.keys(policy);
  for (const key of keys) {
    if (key !== 'pass_lifetime_ms') {
      throw new Error(where + ': unknown policy key "' + key + '"');
    }
  }
  if (!Object.prototype.hasOwnProperty.call(policy, 'pass_lifetime_ms')) {
    return DEFAULT_PASS_LIFETIME_MS;
  }
  return requireLifetime(policy.pass_lifetime_ms, where);
}

function passLifetimeMs() {
  return effectiveLifetime(repo.read().policy, 'policy.passLifetimeMs');
}

function setPassLifetimeMs(ms) {
  requireLifetime(ms, 'policy.setPassLifetimeMs');
  try {
    return repo.transact(state => {
      const previous = effectiveLifetime(state.policy, 'policy.setPassLifetimeMs');
      if (previous === ms) {
        const noChange = new Error('policy pass lifetime unchanged');
        noChange[NO_CHANGE] = true;
        throw noChange;
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      state.policy.pass_lifetime_ms = ms;
      state.outbox.push({
        id,
        ts: now,
        kind: 'policy.pass_lifetime',
        tenant: repo.tenant(),
        previous_pass_lifetime_ms: previous,
        pass_lifetime_ms: ms,
      });
      return ms;
    });
  } catch (error) {
    if (error && error[NO_CHANGE]) return ms;
    throw error;
  }
}

function acceptedGenerations() {
  return Object.freeze([PLAN1_GENERATION]);
}

module.exports = {
  passLifetimeMs,
  setPassLifetimeMs,
  acceptedGenerations,
  DEFAULT_PASS_LIFETIME_MS,
  MIN_PASS_LIFETIME_MS,
  MAX_PASS_LIFETIME_MS,
  PLAN1_GENERATION,
};
