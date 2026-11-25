'use strict';

// A connection's token lives in its own file, never in the profile. Older
// profiles are split in place on first use, and no crash point leaves a
// connection without its token. Ended or expired connections drop it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const profileModule = require('../src/client/profiles.js');

const POSIX = process.platform !== 'win32';

function credential() {
  const selector = crypto.randomBytes(16).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  return {
    token: `${selector}.${secret}`, selector,
    digest: crypto.createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function place() {
  const connectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-token-split-'));
  return { connectionDir, profiles: profileModule.openProfiles({ connectionDir }) };
}

function candidate(name, overrides = {}) {
  return Object.assign({
    name, product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'https://room.example.test', request_id: crypto.randomUUID(), created_at: 1,
  }, credential(), overrides);
}

function admit(profiles, body, expiresAt = Date.now() + 60 * 60 * 1000) {
  return profiles.markAdmitted(body.name, {
    request_id: body.request_id, subject_id: 'seat-1', name: body.name, product: body.product,
    product_provenance: body.product_provenance, admitted_at: 2, expires_at: expiresAt,
  });
}

// Every file in the directory (not the lock directory) that holds the token,
// as names.
function holders(dir, token) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile())
    .filter(entry => fs.readFileSync(path.join(dir, entry.name), 'utf8').includes(token))
    .map(entry => entry.name).sort();
}

function tokenFiles(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.token')).sort();
}

// A profile as an older Interlock wrote it: the token inside the profile.
function writeLegacy(dir, body, state = 'admitted', expiresAt = Date.now() + 60 * 60 * 1000) {
  const record = {
    schema: 2, name: body.name, product: body.product, product_provenance: body.product_provenance,
    server_url: body.server_url, request_id: body.request_id, token: body.token, selector: body.selector,
    digest: body.digest, state, created_at: 1,
    admitted_at: state === 'admitted' ? 2 : null, subject_id: state === 'admitted' ? 'seat-1' : null,
    expires_at: state === 'admitted' ? expiresAt : null, cursor: 7,
  };
  fs.writeFileSync(path.join(dir, body.name.toLowerCase() + '.json'), JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

test('a new connection keeps its token out of the profile, in its own 0600 file', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  profiles.createUnadmitted(body);
  admit(profiles, body);
  assert.deepEqual(holders(connectionDir, body.token), [`marlow.${body.request_id}.token`]);
  const profileText = fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8');
  assert.equal(profileText.includes(body.token), false);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(profileText), 'token'), false);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(connectionDir, `marlow.${body.request_id}.token`)).mode & 0o777, 0o600);
  }
  // The CLI still gets the token, for this connection only.
  assert.equal(profiles.load('Marlow').token, body.token);
});

test('an older profile is split in place on first use, and keeps working', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  writeLegacy(connectionDir, body);
  assert.deepEqual(holders(connectionDir, body.token), ['marlow.json'], 'ARRANGEMENT: the token starts in the profile');
  const loaded = profiles.load('Marlow');
  assert.equal(loaded.token, body.token);
  assert.equal(loaded.cursor, 7, 'the rest of the profile is kept');
  assert.deepEqual(holders(connectionDir, body.token), [`marlow.${body.request_id}.token`]);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(connectionDir, `marlow.${body.request_id}.token`)).mode & 0o777, 0o600);
  }
  // Round trip: a second use reads the split form unchanged.
  assert.equal(profiles.load('Marlow').token, body.token);
  assert.deepEqual(holders(connectionDir, body.token), [`marlow.${body.request_id}.token`]);
});

test('a crash between the two writes of the split leaves a working profile, finished on next use', () => {
  const { connectionDir } = place();
  const body = candidate('Marlow');
  writeLegacy(connectionDir, body);
  // The profile rewrite (the second write) fails as a crash would.
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith('marlow.json')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    return realRename(from, to);
  };
  try {
    assert.throws(() => profileModule.openProfiles({ connectionDir }).load('Marlow'), /simulated crash/);
  } finally {
    fs.renameSync = realRename;
  }
  // ARRANGEMENT: the crash landed between the writes, with the token in both files.
  assert.deepEqual(holders(connectionDir, body.token), [`marlow.${body.request_id}.token`, 'marlow.json'].sort());
  const reopened = profileModule.openProfiles({ connectionDir });
  assert.equal(reopened.load('Marlow').token, body.token, 'never neither: the connection still works');
  assert.deepEqual(holders(connectionDir, body.token), [`marlow.${body.request_id}.token`], 'the split is finished');
});

test('a crash before the token file is written leaves the older profile untouched', () => {
  const { connectionDir } = place();
  const body = candidate('Marlow');
  const before = writeLegacy(connectionDir, body);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file).includes('.token')) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    return realWrite(file, ...rest);
  };
  try {
    assert.throws(() => profileModule.openProfiles({ connectionDir }).load('Marlow'), /simulated crash/);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8')), before);
  assert.deepEqual(tokenFiles(connectionDir), [], 'no partial token file is left');
  assert.equal(profileModule.openProfiles({ connectionDir }).load('Marlow').token, body.token);
});

test('a token file that does not match its profile is refused, not used', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  profiles.createUnadmitted(body);
  admit(profiles, body);
  const file = path.join(connectionDir, `marlow.${body.request_id}.token`);
  const other = credential();
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(Object.assign(record, { token: other.token })) + '\n');
  assert.throws(() => profiles.load('Marlow'), error => error.code === 'corrupt-profile');
});

test('a live profile whose token file is gone is refused loudly', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  profiles.createUnadmitted(body);
  admit(profiles, body);
  fs.unlinkSync(path.join(connectionDir, `marlow.${body.request_id}.token`));
  assert.throws(() => profiles.load('Marlow'), error => error.code === 'corrupt-profile');
});

test('a rejoin keeps each request\'s token apart and drops the old one once admitted', () => {
  const { connectionDir, profiles } = place();
  const first = candidate('Marlow');
  profiles.createUnadmitted(first);
  admit(profiles, first);
  const second = candidate('Marlow');
  profiles.createStaged(second);
  assert.equal(fs.readFileSync(path.join(connectionDir, 'marlow.joining'), 'utf8').includes(second.token), false,
    'the waiting join holds no token either');
  assert.equal(profiles.loadStaged('Marlow').token, second.token);
  assert.equal(profiles.load('Marlow').token, first.token, 'the live connection keeps its own token meanwhile');
  profiles.markStagedAdmitted('Marlow', {
    request_id: second.request_id, subject_id: 'seat-2', name: 'Marlow', product: second.product,
    product_provenance: second.product_provenance, admitted_at: 3, expires_at: Date.now() + 60 * 60 * 1000,
  });
  assert.equal(profiles.load('Marlow').token, second.token);
  assert.deepEqual(tokenFiles(connectionDir), [`marlow.${second.request_id}.token`]);
  assert.deepEqual(holders(connectionDir, first.token), [], 'the replaced token is gone');
});

test('ended connections drop their token file', () => {
  const { connectionDir, profiles } = place();
  const left = candidate('Marlow');
  profiles.createUnadmitted(left);
  admit(profiles, left);
  assert.equal(tokenFiles(connectionDir).length, 1, 'ARRANGEMENT: a token file exists');
  profiles.forgetAdmitted('Marlow');
  assert.deepEqual(tokenFiles(connectionDir), []);

  const abandoned = candidate('Ana');
  profiles.createUnadmitted(abandoned);
  assert.equal(tokenFiles(connectionDir).length, 1, 'ARRANGEMENT: the waiting join has a token file');
  profiles.removeUnadmitted('Ana', abandoned.request_id);
  assert.deepEqual(tokenFiles(connectionDir), []);

  const live = candidate('Bea');
  profiles.createUnadmitted(live);
  admit(profiles, live);
  const staged = candidate('Bea');
  profiles.createStaged(staged);
  assert.equal(tokenFiles(connectionDir).length, 2, 'ARRANGEMENT: live and waiting tokens');
  profiles.removeStaged('Bea', staged.request_id);
  assert.deepEqual(tokenFiles(connectionDir), [`bea.${live.request_id}.token`]);
});

test('an expired connection drops its token file but still reads as expired', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  profiles.createUnadmitted(body);
  admit(profiles, body, 5_000);
  assert.equal(tokenFiles(connectionDir).length, 1, 'ARRANGEMENT: the token file exists before the expiry is seen');
  assert.equal(profiles.dropSpentToken('Marlow', 4_999), false, 'not yet expired by the caller\'s clock: kept');
  assert.equal(tokenFiles(connectionDir).length, 1);
  assert.equal(profiles.dropSpentToken('Marlow', 5_000), true);
  assert.deepEqual(tokenFiles(connectionDir), []);
  assert.deepEqual(holders(connectionDir, body.token), []);
  const loaded = profiles.load('Marlow');
  assert.deepEqual([loaded.state, loaded.expires_at, loaded.token], ['admitted', 5_000, null]);

  // An older profile that has already expired loses its token on the same call.
  const old = candidate('Ana');
  writeLegacy(connectionDir, old, 'admitted', 5_000);
  assert.equal(profiles.dropSpentToken('Ana', 6_000), true);
  assert.deepEqual(holders(connectionDir, old.token), []);
  assert.equal(profiles.load('Ana').token, null);
});

test('the listing reads no token file', () => {
  const { connectionDir, profiles } = place();
  const body = candidate('Marlow');
  profiles.createUnadmitted(body);
  admit(profiles, body);
  const realRead = fs.readFileSync;
  const read = [];
  fs.readFileSync = (file, ...rest) => { read.push(String(file)); return realRead(file, ...rest); };
  let rows;
  try { rows = profiles.summaries(); } finally { fs.readFileSync = realRead; }
  assert.ok(read.some(file => file.endsWith('marlow.json')), 'ARRANGEMENT: the listing reads the profile');
  assert.equal(read.some(file => file.endsWith('.token')), false, read.join(', '));
  assert.equal(JSON.stringify(rows).includes(body.token), false);
});
