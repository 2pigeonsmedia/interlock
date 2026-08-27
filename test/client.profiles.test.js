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
