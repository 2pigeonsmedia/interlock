'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const { openProfiles } = require('../src/client/profiles.js');
const { acquireInstanceLock } = require('../src/instance_lock.js');

function fixture(name = 'Marlow') {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-profiles-')), 'nested');
  const store = openProfiles({ connectionDir });
  const credential = identity.newAiCredential();
  const body = {
    name,
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    server_url: 'http://localhost:8788',
    request_id: crypto.randomUUID(),
    token: credential.token,
    selector: credential.selector,
    digest: credential.digest,
    created_at: 1_000,
  };
  return { body, connectionDir, credential, store };
}

function admit(world, overrides = {}) {
  return world.store.markAdmitted(world.body.name, Object.assign({
    request_id: world.body.request_id,
    subject_id: 'seat-1',
    name: world.body.name,
    product: world.body.product,
    product_provenance: world.body.product_provenance,
    expires_at: 50_000,
    admitted_at: 2_000,
  }, overrides));
}

function replacementBody(world, overrides = {}) {
  const credential = identity.newAiCredential();
  return Object.assign({}, world.body, {
    request_id: crypto.randomUUID(),
    token: credential.token,
    selector: credential.selector,
    digest: credential.digest,
    created_at: 3_000,
  }, overrides);
}

test('an unadmitted candidate is private, explicit, and never overwritten implicitly', () => {
  const world = fixture();
  const created = world.store.createUnadmitted(world.body);
  assert.equal(created.state, 'unadmitted');
  assert.equal(world.store.load('MARLOW').token, world.credential.token);
  assert.equal(world.store.exists('Marlow'), true);
  assert.throws(() => world.store.createUnadmitted(world.body), error =>
    error && error.code === 'profile-exists');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(world.connectionDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(world.connectionDir, 'marlow.json')).mode & 0o777, 0o600);
  }
});

test('Allow marks only the exact candidate admitted and retains its one bearer', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  const admitted = world.store.markAdmitted('Marlow', {
    request_id: world.body.request_id,
    subject_id: 'seat-1',
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    expires_at: 50_000,
    admitted_at: 2_000,
  });
  assert.equal(admitted.state, 'admitted');
  assert.equal(admitted.cursor, 0);
  assert.equal(admitted.token, world.credential.token);
  assert.deepEqual(world.store.markAdmitted('Marlow', {
    request_id: world.body.request_id,
    subject_id: 'seat-1',
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    expires_at: 50_000,
    admitted_at: 99_999,
  }), admitted, 'an exact retry must not rewrite the first admission receipt');
  assert.throws(() => world.store.markAdmitted('Marlow', {
    request_id: crypto.randomUUID(),
    subject_id: 'seat-2',
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    expires_at: 50_000,
    admitted_at: 2_000,
  }), error => error && error.code === 'profile-collision');
});

test('local summaries are ordered, validated, and never expose bearer material', () => {
  const world = fixture('Zulu');
  world.store.createUnadmitted(world.body);
  const second = fixture('Alpha').body;
  second.request_id = crypto.randomUUID();
  second.token = identity.newAiCredential().token;
  const [selector, secret] = second.token.split('.');
  second.selector = selector;
  second.digest = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  world.store.createUnadmitted(second);

  const rows = world.store.summaries();
  assert.deepEqual(rows.map(row => row.name), ['Alpha', 'Zulu']);
  assert.deepEqual(Object.keys(rows[0]), [
    'name', 'product', 'server_url', 'state', 'expires_at',
  ]);
  assert.equal(JSON.stringify(rows).includes(second.token), false);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[0]), true);
});

test('cursor updates are monotonic, durable, and limited to admitted profiles', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  assert.throws(() => world.store.updateCursor('Marlow', world.body.request_id, 1), error =>
    error && error.code === 'profile-collision');
  world.store.markAdmitted('Marlow', {
    request_id: world.body.request_id,
    subject_id: 'seat-1',
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    expires_at: 50_000,
    admitted_at: 2_000,
  });
  assert.equal(world.store.updateCursor('Marlow', world.body.request_id, 9).cursor, 9);
  assert.equal(openProfiles({ connectionDir: world.connectionDir }).load('Marlow').cursor, 9);
  assert.equal(world.store.updateCursor('Marlow', world.body.request_id, 8).cursor, 9,
    'a delayed reader cannot move a concurrently advanced cursor backward');
  assert.equal(openProfiles({ connectionDir: world.connectionDir }).load('Marlow').cursor, 9);
});

test('a reader from an ended generation cannot advance its replacement cursor', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const endedRequestId = world.body.request_id;
  const replacement = replacementBody(world);
  world.store.createStaged(replacement);
  world.store.markStagedAdmitted('Marlow', {
    request_id: replacement.request_id,
    subject_id: 'seat-2',
    name: replacement.name,
    product: replacement.product,
    product_provenance: replacement.product_provenance,
    expires_at: 80_000,
    admitted_at: 4_000,
  });

  assert.throws(() => world.store.updateCursor('Marlow', endedRequestId, 25), error =>
    error && error.code === 'profile-collision');
  const current = world.store.load('Marlow');
  assert.equal(current.request_id, replacement.request_id);
  assert.equal(current.cursor, 0);
});

test('concurrent processes serialize cursor commits and retain the greatest cursor', async () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const lockDirectory = path.join(world.connectionDir, '.profile-locks', 'marlow');
  const held = acquireInstanceLock({ dataDir: lockDirectory });
  const modulePath = path.resolve(__dirname, '..', 'src', 'client', 'profiles.js');
  const childCode = [
    "const { openProfiles } = require(process.argv[2]);",
    "process.stdout.write('ready\\n');",
    'const updated = openProfiles({ connectionDir: process.argv[1] })',
    '.updateCursor(process.argv[3], process.argv[4], Number(process.argv[5]));',
    "process.stdout.write('cursor=' + updated.cursor + '\\n');",
  ].join('');
  const children = [10, 20].map(cursor => spawn(process.execPath, [
    '-e', childCode, world.connectionDir, modulePath, 'Marlow', world.body.request_id,
    String(cursor),
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const exitPromises = children.map(child => once(child, 'exit'));
  const errors = ['', ''];
  children.forEach((child, index) => {
    child.stderr.on('data', chunk => { errors[index] += chunk.toString('utf8'); });
  });
  try {
    await Promise.all(children.map(child => once(child.stdout, 'data')));
  } finally {
    held.release();
  }
  const exits = await Promise.all(exitPromises);
  assert.deepEqual(exits.map(([code]) => code), [0, 0], errors.join('\n'));
  assert.equal(openProfiles({ connectionDir: world.connectionDir }).load('Marlow').cursor, 20);
  assert.deepEqual(fs.readdirSync(world.connectionDir).filter(name => name.includes('.tmp')), []);
});

test('one reader lease per connection refuses a silent concurrent cursor consumer', () => {
  const world = fixture();
  const first = world.store.acquireReadLease('Marlow');
  assert.throws(() => world.store.acquireReadLease('marlow'), error =>
    error && error.code === 'reader-active');
  first.release();

  const replacement = world.store.acquireReadLease('MARLOW');
  assert.equal(replacement.owner.pid, process.pid);
  replacement.release();
  assert.equal(fs.existsSync(path.join(
    world.connectionDir, '.profile-locks', 'marlow', 'reader', 'instance.lock',
  )), false);
});

// Windows answers an open of a file another process is deleting or renaming
// with EPERM, EBUSY or EACCES. These replace the call for the first few opens
// or reads of one path, as a contender mid-release would make them fail.
function refuseOnLockPath(lockPath, method, code, times, before = null) {
  const real = fs[method];
  const state = { refused: 0, restore: () => { fs[method] = real; } };
  fs[method] = function (file, ...rest) {
    if (file === lockPath && state.refused < times) {
      state.refused += 1;
      const error = new Error(`${code}: operation not permitted, ${method} '${file}'`);
      error.code = code;
      throw error;
    }
    return real.call(this, file, ...rest);
  };
  if (before) {
    const realOpen = fs.openSync;
    let fakedExists = false;
    fs.openSync = function (file, ...rest) {
      if (file === lockPath && !fakedExists) {
        fakedExists = true;
        const error = new Error(`EEXIST: file already exists, open '${file}'`);
        error.code = 'EEXIST';
        throw error;
      }
      return realOpen.call(this, file, ...rest);
    };
    const restore = state.restore;
    state.restore = () => { fs.openSync = realOpen; restore(); };
  }
  return state;
}

// A refused read happens once, before the lock is taken: after that the owner
// reads its own lock file, which no contender is deleting.
for (const [label, method, code, times, viaExisting] of [
  ['open refused with EPERM', 'openSync', 'EPERM', 3, false],
  ['open refused with EBUSY', 'openSync', 'EBUSY', 3, false],
  ['read of a held lock refused with EPERM', 'readFileSync', 'EPERM', 1, true],
]) {
  test(`a lock another process is releasing is waited for (${label})`, () => {
    const world = fixture();
    world.store.createUnadmitted(world.body);
    admit(world);
    const lockPath = path.join(world.connectionDir, '.profile-locks', 'marlow', 'instance.lock');
    const fault = refuseOnLockPath(lockPath, method, code, times, viaExisting);
    let updated;
    try {
      updated = world.store.updateCursor('Marlow', world.body.request_id, 7);
    } finally {
      fault.restore();
    }
    assert.equal(fault.refused, times, `ARRANGEMENT: the lock path refused ${times} time(s) with ${code}`);
    assert.equal(updated.cursor, 7, 'the cursor commit waited and then succeeded');
    assert.equal(fs.existsSync(lockPath), false, 'and released its lock');
  });
}

test('a reader lease waits for a reader lock another process is releasing', () => {
  const world = fixture();
  const lockPath = path.join(world.connectionDir, '.profile-locks', 'marlow', 'reader', 'instance.lock');
  const fault = refuseOnLockPath(lockPath, 'openSync', 'EPERM', 3);
  let lease;
  try {
    lease = world.store.acquireReadLease('Marlow');
  } finally {
    fault.restore();
  }
  assert.equal(fault.refused, 3, 'ARRANGEMENT: the reader lock path refused three times');
  assert.equal(lease.owner.pid, process.pid);
  lease.release();
});

test('EACCES on the lock path is a wait only on Windows; elsewhere it is a permission error', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const lockPath = path.join(world.connectionDir, '.profile-locks', 'marlow', 'instance.lock');
  const fault = refuseOnLockPath(lockPath, 'openSync', 'EACCES', 3);
  let outcome;
  try {
    outcome = world.store.updateCursor('Marlow', world.body.request_id, 7);
  } catch (error) {
    outcome = error;
  } finally {
    fault.restore();
  }
  if (process.platform === 'win32') {
    assert.equal(fault.refused, 3, 'ARRANGEMENT: the lock path refused three times');
    assert.equal(outcome.cursor, 7, 'on Windows the commit waited and succeeded');
  } else {
    assert.equal(fault.refused, 1, 'ARRANGEMENT: the first open was refused');
    assert.equal(outcome.code, 'EACCES', 'elsewhere the permission error is reported at once');
  }
});

test('a sharing violation that outlasts the wait is reported as busy with its cause', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const lockPath = path.join(world.connectionDir, '.profile-locks', 'marlow', 'instance.lock');
  const fault = refuseOnLockPath(lockPath, 'openSync', 'EPERM', Infinity);
  try {
    assert.throws(() => world.store.updateCursor('Marlow', world.body.request_id, 7), error =>
      error && error.code === 'profile-busy' && error.cause && error.cause.code === 'EPERM');
  } finally {
    fault.restore();
  }
  assert.ok(fault.refused > 1, `ARRANGEMENT: the wait retried (${fault.refused} refusals)`);
});

test('on Windows, a lock file another process holds exclusively is waited for', {
  skip: process.platform !== 'win32' && 'needs a Windows sharing violation',
}, async () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const lockDirectory = path.join(world.connectionDir, '.profile-locks', 'marlow');
  const lockPath = path.join(lockDirectory, 'instance.lock');
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.writeFileSync(lockPath, 'held\n');
  // Another process opens the lock file with no sharing, lets it go 300 ms
  // later and deletes it, as a contender releasing its lock would.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$f = [System.IO.File]::Open($env:LOCK_PATH, "Open", "ReadWrite", "None")',
    '[Console]::Out.WriteLine("held"); [Console]::Out.Flush()',
    'Start-Sleep -Milliseconds 300',
    '$f.Close(); Remove-Item -LiteralPath $env:LOCK_PATH',
  ].join('; ')], { env: Object.assign({}, process.env, { LOCK_PATH: lockPath }), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(holder, 'exit');
  let stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  await once(holder.stdout, 'data');
  assert.throws(() => fs.readFileSync(lockPath), error =>
    error && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code),
    'ARRANGEMENT: the held lock file refuses a read the way a contender sees it');
  const updated = world.store.updateCursor('Marlow', world.body.request_id, 9);
  assert.equal(updated.cursor, 9, 'the cursor commit waited for the holder to let go');
  const [code] = await exited;
  assert.equal(code, 0, 'ARRANGEMENT: the holder released and deleted the file: ' + stderr);
});

test('a contender waits through an incomplete lock record without reaping it', async () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const lockDirectory = path.join(world.connectionDir, '.profile-locks', 'marlow');
  const lockPath = path.join(lockDirectory, 'instance.lock');
  const childCode = [
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const fd = fs.openSync(process.argv[1], 'wx', 0o600);",
    "process.stdout.write('open\\n');",
    'setTimeout(() => {',
    'const record = { schema: 1, pid: process.pid, platform: process.platform,',
    'hostname: os.hostname(), started_at: Date.now(), instance_id: crypto.randomUUID() };',
    "fs.writeSync(fd, JSON.stringify(record) + '\\n'); fs.fsyncSync(fd);",
    'setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(process.argv[1]); }, 100);',
    '}, 50);',
  ].join('');
  const child = spawn(process.execPath, ['-e', childCode, lockPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  await once(child.stdout, 'data');
  assert.equal(world.store.updateCursor('Marlow', world.body.request_id, 7).cursor, 7);
  const [code] = await exited;
  assert.equal(code, 0, stderr);
});

test('a schema-1 profile migrates once with its cursor beginning at zero', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  const file = path.join(world.connectionDir, 'marlow.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  legacy.schema = 1;
  delete legacy.cursor;
  fs.writeFileSync(file, JSON.stringify(legacy) + '\n', { mode: 0o600 });

  const migrated = openProfiles({ connectionDir: world.connectionDir }).load('Marlow');
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.cursor, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), migrated);
});

test('leave removes only an admitted profile', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  assert.throws(() => world.store.forgetAdmitted('Marlow'), error =>
    error && error.code === 'profile-collision');
  world.store.markAdmitted('Marlow', {
    request_id: world.body.request_id,
    subject_id: 'seat-1',
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    expires_at: 50_000,
    admitted_at: 2_000,
  });
  world.store.forgetAdmitted('Marlow');
  assert.equal(world.store.exists('Marlow'), false);
});

test('decline cleanup removes only its matching unadmitted candidate', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  assert.throws(() => world.store.removeUnadmitted('Marlow', crypto.randomUUID()), error =>
    error && error.code === 'profile-collision');
  world.store.removeUnadmitted('Marlow', world.body.request_id);
  assert.equal(world.store.exists('Marlow'), false);
  assert.throws(() => world.store.load('Marlow'), error => error && error.code === 'profile-not-found');
});

test('a replacement candidate is staged beside its exact admitted predecessor', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const mainFile = path.join(world.connectionDir, 'marlow.json');
  const stagedFile = path.join(world.connectionDir, 'marlow.joining');
  const before = fs.readFileSync(mainFile, 'utf8');
  const replacement = replacementBody(world);

  const staged = world.store.createStaged(replacement);
  assert.equal(staged.request_id, replacement.request_id);
  assert.equal(staged.state, 'unadmitted');
  assert.equal(world.store.loadStaged('MARLOW').token, replacement.token);
  assert.equal(fs.readFileSync(mainFile, 'utf8'), before,
    'staging must not spend or rewrite the admitted bearer');
  assert.deepEqual(world.store.summaries().map(row => [row.name, row.state]), [
    ['Marlow', 'admitted'],
  ], 'staged credentials are not ordinary selectable profiles');
  const envelope = JSON.parse(fs.readFileSync(stagedFile, 'utf8'));
  assert.equal(envelope.replaces_request_id, world.body.request_id);
  assert.equal(envelope.candidate.request_id, replacement.request_id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stagedFile).mode & 0o777, 0o600);
  assert.throws(() => world.store.forgetAdmitted('Marlow'), error =>
    error && error.code === 'profile-collision');
  assert.throws(() => world.store.removeStaged('Marlow', crypto.randomUUID()), error =>
    error && error.code === 'profile-collision');
  world.store.removeStaged('Marlow', replacement.request_id);
  assert.equal(world.store.stagedExists('Marlow'), false);
  assert.equal(fs.readFileSync(mainFile, 'utf8'), before);
});

test('Allow atomically replaces only the predecessor named by the staged receipt', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const replacement = replacementBody(world);
  world.store.createStaged(replacement);
  const admission = {
    request_id: replacement.request_id,
    subject_id: 'seat-2',
    name: replacement.name,
    product: replacement.product,
    product_provenance: replacement.product_provenance,
    expires_at: 80_000,
    admitted_at: 4_000,
  };

  const admitted = world.store.markStagedAdmitted('Marlow', admission);
  assert.equal(admitted.request_id, replacement.request_id);
  assert.equal(admitted.subject_id, 'seat-2');
  assert.equal(admitted.token, replacement.token);
  assert.equal(world.store.stagedExists('Marlow'), false);
  assert.deepEqual(world.store.load('Marlow'), admitted);
});

test('staged replacement refuses a changed predecessor and preserves both files', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const replacement = replacementBody(world);
  world.store.createStaged(replacement);
  const mainFile = path.join(world.connectionDir, 'marlow.json');
  const changedCredential = identity.newAiCredential();
  const changed = Object.assign({}, world.store.load('Marlow'), {
    request_id: crypto.randomUUID(),
    token: changedCredential.token,
    selector: changedCredential.selector,
    digest: changedCredential.digest,
    subject_id: 'seat-concurrent',
  });
  fs.writeFileSync(mainFile, JSON.stringify(changed) + '\n', { mode: 0o600 });
  const changedBytes = fs.readFileSync(mainFile, 'utf8');

  assert.throws(() => world.store.markStagedAdmitted('Marlow', {
    request_id: replacement.request_id,
    subject_id: 'seat-2',
    name: replacement.name,
    product: replacement.product,
    product_provenance: replacement.product_provenance,
    expires_at: 80_000,
    admitted_at: 4_000,
  }), error => error && error.code === 'profile-collision');
  assert.equal(fs.readFileSync(mainFile, 'utf8'), changedBytes);
  assert.equal(world.store.loadStaged('Marlow').request_id, replacement.request_id);
});

test('staged replacement cleanup is idempotent after the main rename committed', () => {
  const world = fixture();
  world.store.createUnadmitted(world.body);
  admit(world);
  const replacement = replacementBody(world);
  world.store.createStaged(replacement);
  const mainFile = path.join(world.connectionDir, 'marlow.json');
  const committed = Object.assign({}, world.store.loadStaged('Marlow'), {
    state: 'admitted',
    admitted_at: 4_000,
    subject_id: 'seat-2',
    expires_at: 80_000,
  });
  fs.writeFileSync(mainFile, JSON.stringify(committed) + '\n', { mode: 0o600 });

  const recovered = world.store.markStagedAdmitted('Marlow', {
    request_id: replacement.request_id,
    subject_id: 'seat-2',
    name: replacement.name,
    product: replacement.product,
    product_provenance: replacement.product_provenance,
    expires_at: 80_000,
    admitted_at: 9_000,
  });
  assert.deepEqual(recovered, committed,
    'retry keeps the first durable admission receipt instead of rewriting it');
  assert.equal(world.store.stagedExists('Marlow'), false);
});

test('corrupt, unsafe-name, non-loopback, and token-mismatch profiles fail loud', () => {
  for (const mutate of [
    body => { body.name = '../escape'; },
    body => { body.server_url = 'http://127.0.0.1:8788'; },
    body => { body.token = body.token.slice(0, -1) + (body.token.endsWith('A') ? 'B' : 'A'); },
  ]) {
    const world = fixture();
    mutate(world.body);
    assert.throws(() => world.store.createUnadmitted(world.body));
  }

  const world = fixture();
  world.store.createUnadmitted(world.body);
  fs.writeFileSync(path.join(world.connectionDir, 'marlow.json'), '{}\n');
  assert.throws(() => world.store.load('Marlow'), error => error && error.code === 'corrupt-profile');
});

test('validUrl accepts the canonical localhost loopback form and a canonical https origin, nothing else', () => {
  const { validUrl } = require('../src/client/profiles.js');
  assert.equal(validUrl('http://localhost:8788'), true);
  assert.equal(validUrl('https://app.example.test'), true);
  assert.equal(validUrl('https://app.example.test:8443'), true);
  for (const bad of ['http://app.example.test', 'https://app.example.test/', 'https://localhost', 'http://127.0.0.1:8788', 'https://APP.example.test', 'ftp://x']) {
    assert.equal(validUrl(bad), false, bad);
  }
});
