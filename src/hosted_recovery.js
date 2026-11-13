'use strict';

// The operator half of hosted owner recovery, behind `interlock recover --hosted`.
// It runs with the normal server stopped, on the machine that holds the data:
// access to that machine is the proof of ownership. It issues one code and
// starts no listener; the owner redeems the code on the hosted origin.

const fs = require('node:fs');
const path = require('node:path');

const identity = require('identity');
const { acquireInstanceLock } = require('./instance_lock.js');
const { recordedDataDirOrigin } = require('./server.js');

const HOSTED_RECOVERY_TTL_MS = identity.HOSTED_RECOVERY_TTL_MS;

function fail(code, message) {
  const error = new Error('interlock hosted recovery: ' + (message || code));
  error.code = code;
  return error;
}

async function issueHostedRecoveryCode(options) {
  const { dataDir, now } = options || {};
  if (typeof dataDir !== 'string' || dataDir.includes('\0') || !path.isAbsolute(dataDir)) {
    throw fail('invalid-data-dir', 'dataDir must be absolute');
  }
  // Refuse before anything on disk changes: a loopback room keeps the
  // stopped-server localhost recovery, and a directory with no record never served.
  const recorded = recordedDataDirOrigin(dataDir);
  let origin = null;
  try { origin = typeof recorded === 'string' ? new URL(recorded) : null; } catch (_) { origin = null; }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== recorded) {
    const error = fail('not-hosted', 'this data directory is not a hosted room');
    error.recordedOrigin = recorded;
    throw error;
  }
  const stateDir = path.join(dataDir, 'identity');
  let stateStat;
  try {
    const dirStat = fs.lstatSync(stateDir);
    stateStat = fs.lstatSync(path.join(stateDir, 'identity-state.v2.json'));
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw fail('installation-invalid');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw fail('installation-missing');
    throw error;
  }
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) throw fail('installation-invalid');

  const lock = acquireInstanceLock({ dataDir });
  try {
    const issued = await identity.issueHostedRecovery(Object.assign(
      { stateDir, tenant: 'interlock', origin: recorded },
      now === undefined ? {} : { now },
    ));
    lock.assertOwned();
    return Object.freeze({
      code: issued.secret,
      expires_at: issued.expires_at,
      owner_name: issued.owner_name,
      origin: recorded,
    });
  } finally {
    lock.release();
  }
}

module.exports = Object.freeze({
  HOSTED_RECOVERY_TTL_MS,
  issueHostedRecoveryCode,
});
