'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const identity = require('identity');
const profileModule = require('../src/client/profiles.js');

const {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  HISTORY_DRAIN_BYTES,
  HISTORY_DRAIN_MESSAGES,
  run,
  joinOptions,
  runRecover,
  runStart,
  startPort,
} = require('../src/cli.js');

function capture(argv) {
  let stdout = '';
  let stderr = '';

  const code = run(argv, {
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
  });

  return { code, stderr, stdout };
}

test('the empty CLI prints honest current help', () => {
  const result = capture([]);

  assert.equal(result.code, EXIT_OK);
  assert.match(result.stdout, /One shared chat room/);
  assert.match(result.stdout, /An AI runs "interlock join"/);
  assert.match(result.stdout, /history --connection NAME/);
  assert.match(result.stdout, /backup --to ABSOLUTE_PATH/);
  assert.match(result.stdout, /restore --from ABSOLUTE_PATH/);
  assert.match(result.stdout, /recover \[--port PORT\]/);
  assert.match(result.stdout, /Every later AI command names that exact connection explicitly/);
  assert.equal(result.stderr, '');
});

test('backup reports the verified sensitive scope and external connection exclusion', () => {
  const calls = [];
  const result = captureCommand(['backup', '--to', '/safe/interlock-2026-08-22'], {
    clock: () => 1234,
    config: {
      resolveDataDir: () => '/data/interlock',
      resolveConnectionDir: () => '/separate/ai-connections',
    },
    backup: {
      backupInstallation(options) {
        calls.push(options);
        return { path: options.target, files: 12, bytes: 3456 };
      },
    },
  });
  return Promise.resolve(result).then(receipt => {
    assert.equal(receipt.code, EXIT_OK, receipt.stderr);
    assert.equal(receipt.stderr, '');
    assert.deepEqual(calls, [{
      dataDir: '/data/interlock',
      target: '/safe/interlock-2026-08-22',
      clock: calls[0].clock,
    }]);
    assert.match(receipt.stdout, /Backup complete/);
    assert.match(receipt.stdout, /plaintext and sensitive/);
    assert.match(receipt.stdout, /transcripts and identity state/);
    assert.match(receipt.stdout, /except transient server and connection-profile lock records/);
    assert.match(receipt.stdout, /Not included: external AI connection directory/);
  });
});

test('backup states when nested AI bearer profiles are included', async () => {
  const result = await captureCommand(['backup', '--to', '/safe/copy'], {
    config: {
      resolveDataDir: () => '/data/interlock',
      resolveConnectionDir: () => '/data/interlock/connections',
    },
    backup: {
      backupInstallation: options => ({ path: options.target, files: 2, bytes: 40 }),
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /may contain raw bearer credentials/);
});

test('restore is non-overwriting and reports an exact successful handoff', async () => {
  const dependencies = {
    config: {
      resolveDataDir: () => '/data/interlock',
      resolveConnectionDir: () => '/data/interlock/connections',
    },
    backup: {
      restoreInstallation: options => ({ path: options.dataDir, files: 9, bytes: 800 }),
    },
  };
  const result = await captureCommand(['restore', '--from', '/safe/copy'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Restore complete/);
  assert.match(result.stdout, /Run "interlock start"/);

  dependencies.backup.restoreInstallation = () => {
    const error = new Error('occupied');
    error.code = 'data-dir-exists';
    throw error;
  };
  const refused = await captureCommand(['restore', '--from', '/safe/copy'], dependencies);
  assert.equal(refused.code, EXIT_RUNTIME);
  assert.match(refused.stderr, /refuses to overwrite/);
  assert.equal(refused.stdout, '');
});

test('backup and restore option shapes are closed', async () => {
  for (const argv of [
    ['backup'], ['backup', '--from', '/x'], ['backup', '--to', '/x', '--extra'],
    ['backup', '--to', 'relative-copy'],
    ['restore'], ['restore', '--to', '/x'], ['restore', '--from', '/x', '--extra'],
    ['restore', '--from', 'relative-copy'],
  ]) {
    const result = await captureCommand(argv);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.stderr, /usage/);
  }
  assert.equal(require('../src/cli.js').storageOptions('unknown', ['--from', '/x']), null);
});

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

async function captureJoin(argv, dependencies) {
  let stdout = '';
  let stderr = '';
  const code = await run(['join', ...argv], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stderr, stdout };
}

function localJoinProfile(options = {}) {
  const connectionDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-local-profile-')), 'profiles',
  );
  const profiles = profileModule.openProfiles({ connectionDir });
  const credential = identity.newAiCredential();
  const body = {
    name: options.name || 'Marlow',
    product: options.product || 'Codex CLI',
    product_provenance: 'client-reported',
    server_url: options.server_url || 'http://localhost:8788',
    request_id: crypto.randomUUID(),
    token: credential.token,
    selector: credential.selector,
    digest: credential.digest,
    created_at: 1_000,
  };
  profiles.createUnadmitted(body);
  if (options.admitted !== false) {
    profiles.markAdmitted(body.name, {
      request_id: body.request_id,
      subject_id: options.subject_id || 'seat-marlow',
      name: body.name,
      product: body.product,
      product_provenance: body.product_provenance,
      expires_at: options.expires_at || 50_000,
      admitted_at: 2_000,
    });
  }
  const file = path.join(connectionDir, body.name.toLowerCase() + '.json');
  return { body, connectionDir, file, profile: profiles.load(body.name) };
}

async function captureCommand(argv, dependencies = {}, stdin = null) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
    stdin,
  }, dependencies);
  return { code, stderr, stdout };
}

function admittedConnection(overrides = {}) {
  const profile = Object.assign({
    schema: 2,
    name: 'Marlow',
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    server_url: 'http://localhost:8788',
    request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: 'test-bearer-not-a-real-credential',
    selector: 'selectorselectorselecto',
    digest: 'a'.repeat(64),
    state: 'admitted',
    created_at: 1,
    admitted_at: 2,
    subject_id: 'seat-1',
    expires_at: 99_999,
    cursor: 0,
  }, overrides);
  const events = [];
  const profiles = {
    load(name) {
      events.push(['load', name]);
      return Object.freeze(Object.assign({}, profile));
    },
    updateCursor(name, requestId, cursor) {
      events.push(['cursor', name, requestId, cursor]);
    },
    acquireReadLease() { return { release() {} }; },
    forgetAdmitted(name) { events.push(['forget', name]); },
  };
  return {
    events,
    profile,
    profiles,
    dependencies: {
      clock: () => 100,
      config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
      profiles: {
        validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
        openProfiles: () => profiles,
      },
    },
  };
}

function publicMessage(overrides = {}) {
  return Object.assign({
    id: 1,
    ts: 10,
    byline: 'Ana',
    kind: 'person',
    session: null,
    text: 'hello @Marlow',
    product: null,
    product_provenance: null,
    delivery: [{ name: 'Marlow', session: null, acknowledged_at: null }],
  }, overrides);
}

test('join options are closed and preserve only non-secret adapter hints', () => {
  assert.deepEqual(joinOptions([]), {
    name: null, product: null, url: 'http://localhost:8788',
  });
  assert.deepEqual(joinOptions([
    '--product', 'Codex CLI', '--name', 'Marlow', '--url', 'http://localhost:9123',
  ]), {
    name: 'Marlow', product: 'Codex CLI', url: 'http://localhost:9123',
  });
  for (const args of [
    ['--token', 'secret'], ['--name'], ['--name', 'One', '--name', 'Two'], ['Marlow'],
  ]) assert.equal(joinOptions(args), null);
});

test('interactive join asks for product and room name as separate facts', async () => {
  const connectionDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-name-')), 'profiles',
  );
  const questions = [];
  const answers = ['OpenAI Codex CLI', '', 'Codex'];
  let body = null;
  let time = 1_000;
  const result = await captureJoin([], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async question => {
      questions.push(question);
      return answers.shift();
    },
    async fetch(url, options) {
      assert.equal(url, 'http://localhost:8788/api/ai/admissions');
      body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true,
        state: 'allowed',
        request_id: body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 50_000,
        enrollment: {
          subject_id: 'seat-codex',
          name: body.name,
          product: body.product,
          product_provenance: body.product_provenance,
          expires_at: 50_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(questions, [
    'AI product (for example Claude Code, Codex CLI, or Grok CLI): ',
    'AI name for this room: ',
    'AI name for this room: ',
  ]);
  assert.equal(body.product, 'OpenAI Codex CLI');
  assert.equal(body.name, 'Codex', 'the product label must never silently become the room name');
  assert.match(result.stdout, /Connected as Codex \(OpenAI Codex CLI\)/);
  assert.doesNotMatch(result.stdout, /Connected as OpenAI/);
});

test('join stores the bearer locally, knocks digest-only, and prints exact follow-on commands', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-')), 'profiles');
  const seen = [];
  let call = 0;
  let confirmationCalls = 0;
  let time = 1_000;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    async fetch(url, options) {
      if (url.endsWith('/api/ai/session')) {
        confirmationCalls += 1;
        return fakeResponse(401, { ok: false, error: 'invalid-connection' });
      }
      if (url.endsWith('/api/ai/head')) {
        return fakeResponse(200, { ok: true, head: 12, connection_session: null });
      }
      assert.equal(url, 'http://localhost:8788/api/ai/admissions');
      const body = JSON.parse(options.body);
      seen.push(body);
      assert.equal(body.token, undefined);
      call += 1;
      if (call === 1) return fakeResponse(200, Object.assign({
        ok: true, state: 'waiting', expires_at: 50_000,
      }, body));
      return fakeResponse(200, {
        ok: true,
        state: 'allowed',
        request_id: body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 50_000,
        enrollment: {
          subject_id: 'seat-1',
          name: body.name,
          product: body.product,
          product_provenance: body.product_provenance,
          expires_at: 50_000,
        },
      });
    },
    ask: async () => { throw new Error('valid adapter hints must not prompt'); },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /Waiting for the owner to allow Marlow/);
  assert.match(result.stdout, /Connected as Marlow \(Codex CLI\)/);
  assert.match(result.stdout, /interlock history --connection Marlow --drain/);
  assert.match(result.stdout, /interlock history --connection Marlow --skip-to-current/);
  assert.match(result.stdout, /interlock listen --connection Marlow/);
  assert.match(result.stdout,
    /listen returns after one message or about a minute; run it again/,
    'join output must teach the listen contract, not just the command — two seats went silently deaf learning it the hard way');
  assert.match(result.stdout, /A listener that is not re-armed is deaf/);
  assert.match(result.stdout, /add --json and loop until "messages" is empty/);
  assert.match(result.stdout, /Your seat starts at the room's current moment/,
    'a new seat must start at current, not consume the transcript');
  assert.doesNotMatch(result.stdout, /starts at the beginning of the transcript/);
  assert.match(result.stdout, /read what the task needs/i);
  assert.match(result.stdout, /skip-to-current[^]*not a read/i);
  assert.match(result.stdout, /one history or listen at a time/);
  assert.match(result.stdout, /GUIDE\.md, served at \/help/);
  assert.equal(result.stderr, '');
  assert.equal(seen.length, 2);
  assert.equal(confirmationCalls, 1,
    'each bounded waiting response checks whether its exact candidate was already admitted');
  assert.deepEqual(seen[1], seen[0], 'every retained wait resubmits the exact stable digest-only knock');
  const profile = JSON.parse(fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8'));
  assert.equal(profile.state, 'admitted');
  assert.equal(profile.cursor, 12, 'fresh admit initializes the local cursor at the head, not 0');
  assert.equal(typeof profile.token, 'string');
  assert.equal(result.stdout.includes(profile.token), false);
  assert.equal(result.stderr.includes(profile.token), false);
});

test('join confirms and reuses the exact admitted local seat without a knock', async () => {
  const world = localJoinProfile();
  const before = fs.readFileSync(world.file, 'utf8');
  const requests = [];
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 3_000,
    identity: { newAiCredential() { throw new Error('reconnect must not mint'); } },
    ask: async () => { throw new Error('exact reconnect must not prompt'); },
    async fetch(url, options) {
      requests.push({ url, options });
      assert.equal(url, 'http://localhost:8788/api/ai/session');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, 'Bearer ' + world.profile.token);
      return fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: world.profile.subject_id,
          name: world.profile.name,
          product: world.profile.product,
          product_provenance: world.profile.product_provenance,
          expires_at: world.profile.expires_at,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0].url, /admissions/);
  assert.doesNotMatch(requests[0].url, /\/api\/ai\/head/,
    'reconnect of an admitted seat must not skip unread mail via the head route');
  assert.match(result.stdout, /Connected as Marlow \(Codex CLI\)/);
  assert.match(result.stdout, /interlock listen --connection Marlow/);
  assert.doesNotMatch(result.stdout, /Waiting for the owner/);
  assert.equal(result.stderr, '');
  assert.equal(fs.readFileSync(world.file, 'utf8'), before,
    'reconnect confirms but does not rewrite the local bearer profile');
});

test('join deliberately finishes its exact interrupted candidate without knocking again', async () => {
  const world = localJoinProfile({ admitted: false });
  const requests = [];
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 3_000,
    identity: { newAiCredential() { throw new Error('reconnect must not mint'); } },
    ask: async () => { throw new Error('exact reconnect must not prompt'); },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/api/ai/head')) {
        return fakeResponse(200, { ok: true, head: 0, connection_session: null });
      }
      assert.equal(url, 'http://localhost:8788/api/ai/session');
      assert.equal(options.headers.authorization, 'Bearer ' + world.profile.token);
      return fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: 'seat-interrupted',
          name: world.profile.name,
          product: world.profile.product,
          product_provenance: world.profile.product_provenance,
          expires_at: 50_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests.some(request => request.url.includes('/admissions')), false);
  const admitted = JSON.parse(fs.readFileSync(world.file, 'utf8'));
  assert.equal(admitted.state, 'admitted');
  assert.equal(admitted.subject_id, 'seat-interrupted');
  assert.equal(admitted.token, world.profile.token);
  assert.match(result.stdout, /Connected as Marlow/);
});

test('interactive join shows matching local names before a separate session chooses a new one', async () => {
  const world = localJoinProfile();
  const result = await captureJoin(['--product', 'Codex CLI'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 3_000,
    ask: async () => 'Finch',
    async fetch(url, options) {
      assert.equal(url, 'http://localhost:8788/api/ai/admissions');
      const body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true,
        state: 'allowed',
        request_id: body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 60_000,
        enrollment: {
          subject_id: 'seat-finch',
          name: body.name,
          product: body.product,
          product_provenance: body.product_provenance,
          expires_at: 60_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /Local connection names for Codex CLI/);
  assert.match(result.stdout, /Marlow \(admitted locally\)/);
  assert.match(result.stdout, /Choose one of those names to reconnect/);
  assert.match(result.stdout, /Connected as Finch \(Codex CLI\)/);
});

test('join never turns a failed existing-profile reconnect into a new admission', async t => {
  const cases = [
    {
      name: 'open-shaped unadmitted refusal',
      profile: { admitted: false },
      args: ['--product', 'Codex CLI', '--name', 'Marlow'],
      expected: /exact unfinished candidate.*not confirmed.*no new admission/s,
      fetch: () => fakeResponse(401, {
        ok: false, error: 'invalid-connection', unexpected: true,
      }),
    },
    {
      name: 'different product',
      profile: {},
      args: ['--product', 'Grok CLI', '--name', 'Marlow'],
      expected: /belongs to Codex CLI, not Grok CLI.*No new admission/s,
      fetch: null,
    },
    {
      name: 'different local Interlock',
      profile: {},
      args: [
        '--product', 'Codex CLI', '--name', 'Marlow', '--url', 'http://localhost:9123',
      ],
      expected: /belongs to http:\/\/localhost:8788, not this Interlock.*No new admission/s,
      fetch: null,
    },
    {
      name: 'mismatched server confirmation',
      profile: {},
      args: ['--product', 'Codex CLI', '--name', 'Marlow'],
      expected: /did not confirm the exact local connection.*no new admission/s,
      fetch: world => fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: 'another-seat',
          name: world.profile.name,
          product: world.profile.product,
          product_provenance: world.profile.product_provenance,
          expires_at: world.profile.expires_at,
        },
      }),
    },
    {
      name: 'open-shaped server confirmation',
      profile: {},
      args: ['--product', 'Codex CLI', '--name', 'Marlow'],
      expected: /did not confirm the exact local connection.*no new admission/s,
      fetch: world => fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: world.profile.subject_id,
          name: world.profile.name,
          product: world.profile.product,
          product_provenance: world.profile.product_provenance,
          expires_at: world.profile.expires_at,
          unexpected: true,
        },
      }),
    },
    {
      name: 'open-shaped credential refusal',
      profile: {},
      args: ['--product', 'Codex CLI', '--name', 'Marlow'],
      expected: /expired or revoked.*no new admission/s,
      fetch: () => fakeResponse(401, {
        ok: false, error: 'invalid-connection', unexpected: true,
      }),
    },
    {
      name: 'unreachable local server',
      profile: {},
      args: ['--product', 'Codex CLI', '--name', 'Marlow'],
      expected: /could not reach.*no new admission/s,
      fetch: () => { throw new TypeError('offline'); },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const world = localJoinProfile(scenario.profile);
      const before = fs.readFileSync(world.file, 'utf8');
      const requests = [];
      const result = await captureJoin(scenario.args, {
        config: { resolveConnectionDir: () => world.connectionDir },
        clock: () => 3_000,
        identity: { newAiCredential() { throw new Error('failure must not mint'); } },
        ask: async () => { throw new Error('failure must not prompt for another name'); },
        async fetch(url, options) {
          requests.push({ url, options });
          assert.doesNotMatch(url, /admissions/, 'existing-profile failure must never knock');
          if (scenario.fetch === null) throw new Error('this case must not call fetch');
          return scenario.fetch(world);
        },
      });
      assert.equal(result.code, EXIT_RUNTIME, result.stdout);
      assert.match(result.stderr, scenario.expected);
      assert.equal(fs.readFileSync(world.file, 'utf8'), before,
        'failed reconnect must retain the exact local profile');
      assert.equal(requests.some(request => request.url.includes('/admissions')), false);
    });
  }
});

test('an exact dead unfinished candidate is replaced by one fresh knock', async t => {
  for (const scenario of [
    { name: 'first admission', staged: false },
    { name: 'ended-name replacement', staged: true },
  ]) {
    await t.test(scenario.name, async () => {
      const world = localJoinProfile(scenario.staged
        ? { expires_at: 2_500 }
        : { admitted: false });
      const profiles = profileModule.openProfiles({ connectionDir: world.connectionDir });
      const predecessorBytes = scenario.staged ? fs.readFileSync(world.file, 'utf8') : null;
      let dead = world.profile;
      if (scenario.staged) {
        const credential = identity.newAiCredential();
        dead = profiles.createStaged({
          name: world.profile.name,
          product: world.profile.product,
          product_provenance: world.profile.product_provenance,
          server_url: world.profile.server_url,
          request_id: crypto.randomUUID(),
          token: credential.token,
          selector: credential.selector,
          digest: credential.digest,
          created_at: 2_501,
        });
      }

      const requests = [];
      let expiredBody = null;
      let freshBody = null;
      let time = 3_000;
      const sleeps = [];
      const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
        config: { resolveConnectionDir: () => world.connectionDir },
        clock: () => time,
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
          time += milliseconds;
        },
        ask: async () => { throw new Error('the same name must recover without prompting'); },
        async fetch(url, options) {
          requests.push({ url, options });
          if (url.endsWith('/api/ai/session')) {
            assert.equal(options.headers.authorization, 'Bearer ' + dead.token,
              'only the exact dead candidate is confirmed');
            return fakeResponse(401, { ok: false, error: 'invalid-connection' });
          }
          assert.equal(url, 'http://localhost:8788/api/ai/admissions');
          const body = JSON.parse(options.body);
          if (expiredBody === null) {
            expiredBody = body;
            assert.equal(expiredBody.request_id, dead.request_id,
              'the exact retained request is checked idempotently before replacement');
            assert.equal(expiredBody.selector, dead.selector);
            assert.equal(expiredBody.digest, dead.digest);
            return fakeResponse(200, {
              ok: true,
              state: 'expired',
              request_id: expiredBody.request_id,
              name: expiredBody.name,
              product: expiredBody.product,
              product_provenance: expiredBody.product_provenance,
              expires_at: 900_000,
            });
          }
          if (scenario.staged) {
            assert.equal(fs.readFileSync(world.file, 'utf8'), predecessorBytes,
              'the admitted predecessor stays untouched while the fresh replacement knocks');
          }
          if (freshBody === null) {
            freshBody = body;
            assert.notEqual(freshBody.request_id, dead.request_id);
            assert.notEqual(freshBody.selector, dead.selector);
            assert.notEqual(freshBody.digest, dead.digest);
            assert.equal(freshBody.token, undefined);
            return fakeResponse(409, {
              ok: false,
              error: 'cooldown',
              retry_after: 3_060,
            });
          }
          assert.deepEqual(body, freshBody,
            'the cooldown retry must preserve the one fresh credential and request id');
          return fakeResponse(200, {
            ok: true,
            state: 'allowed',
            request_id: freshBody.request_id,
            name: freshBody.name,
            product: freshBody.product,
            product_provenance: freshBody.product_provenance,
            expires_at: 80_000,
            enrollment: {
              subject_id: 'seat-fresh',
              name: freshBody.name,
              product: freshBody.product,
              product_provenance: freshBody.product_provenance,
              expires_at: 80_000,
            },
          });
        },
      });

      assert.equal(result.code, EXIT_OK, result.stderr);
      assert.match(result.stdout, /earlier join request.*no longer waiting.*fresh knock/is);
      assert.match(result.stdout, /cooling down.*retry automatically/is);
      assert.deepEqual(sleeps, [60]);
      assert.equal(requests.filter(request => request.url.endsWith('/api/ai/session')).length, 1);
      assert.equal(requests.filter(request => request.url.endsWith('/api/ai/admissions')).length, 3);
      const admitted = profiles.load('Marlow');
      assert.equal(admitted.state, 'admitted');
      assert.equal(admitted.subject_id, 'seat-fresh');
      assert.equal(admitted.request_id, freshBody.request_id);
      assert.notEqual(admitted.token, dead.token);
      assert.equal(profiles.stagedExists('Marlow'), false);
    });
  }
});

test('a still-waiting unfinished candidate resumes only its exact knock', async () => {
  const world = localJoinProfile({ admitted: false });
  let sessionChecks = 0;
  let admissionChecks = 0;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 3_000,
    identity: { newAiCredential() { throw new Error('resume must not mint'); } },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/head')) {
        return fakeResponse(200, { ok: true, head: 0, connection_session: null });
      }
      if (url.endsWith('/api/ai/session')) {
        sessionChecks += 1;
        assert.equal(options.headers.authorization, 'Bearer ' + world.profile.token);
        if (sessionChecks === 1) {
          return fakeResponse(401, { ok: false, error: 'invalid-connection' });
        }
        return fakeResponse(200, {
          ok: true,
          connection: {
            subject_id: 'seat-resumed-wait',
            name: world.profile.name,
            product: world.profile.product,
            product_provenance: world.profile.product_provenance,
            expires_at: 80_000,
          },
        });
      }
      admissionChecks += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.request_id, world.profile.request_id);
      assert.equal(body.selector, world.profile.selector);
      assert.equal(body.digest, world.profile.digest);
      return fakeResponse(200, {
        ok: true,
        state: 'waiting',
        request_id: body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 50_000,
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(sessionChecks, 2);
  assert.equal(admissionChecks, 1);
  const admitted = profileModule.openProfiles({ connectionDir: world.connectionDir }).load('Marlow');
  assert.equal(admitted.subject_id, 'seat-resumed-wait');
  assert.equal(admitted.token, world.profile.token);
});

test('a non-terminal refusal preserves the exact resumed candidate for diagnosis', async () => {
  const world = localJoinProfile({ admitted: false });
  const before = fs.readFileSync(world.file, 'utf8');
  let admissionChecks = 0;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 3_000,
    identity: { newAiCredential() { throw new Error('uncertainty must not mint'); } },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/session')) {
        return fakeResponse(401, { ok: false, error: 'invalid-connection' });
      }
      admissionChecks += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.request_id, world.profile.request_id);
      assert.equal(body.selector, world.profile.selector);
      assert.equal(body.digest, world.profile.digest);
      return fakeResponse(409, { ok: false, error: 'request-id-collision' });
    },
  });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(admissionChecks, 1);
  assert.match(result.stderr, /not safely retired.*kept.*no new admission/s);
  assert.equal(fs.readFileSync(world.file, 'utf8'), before);
});

test('expired and server-refused seats stage a fresh bearer and replace only after Allow', async t => {
  for (const scenario of [
    { name: 'locally expired', profile: { expires_at: 2_500 }, oldChecks: 0 },
    { name: 'server-refused', profile: {}, oldChecks: 1 },
  ]) {
    await t.test(scenario.name, async () => {
      const world = localJoinProfile(scenario.profile);
      const oldBytes = fs.readFileSync(world.file, 'utf8');
      const requests = [];
      const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
        config: { resolveConnectionDir: () => world.connectionDir },
        clock: () => 3_000,
        ask: async () => { throw new Error('exact ended name must not prompt'); },
        async fetch(url, options) {
          requests.push({ url, options });
          if (url.endsWith('/api/ai/session')) {
            assert.equal(options.headers.authorization, 'Bearer ' + world.profile.token);
            return fakeResponse(401, { ok: false, error: 'invalid-connection' });
          }
          assert.equal(url, 'http://localhost:8788/api/ai/admissions');
          assert.equal(fs.readFileSync(world.file, 'utf8'), oldBytes,
            'the admitted predecessor stays durable while its replacement waits');
          const body = JSON.parse(options.body);
          assert.notEqual(body.request_id, world.profile.request_id);
          assert.equal(body.token, undefined);
          assert.equal(JSON.stringify(body).includes(world.profile.token), false);
          return fakeResponse(200, {
            ok: true,
            state: 'allowed',
            request_id: body.request_id,
            name: body.name,
            product: body.product,
            product_provenance: body.product_provenance,
            expires_at: 80_000,
            enrollment: {
              subject_id: 'seat-replacement',
              name: body.name,
              product: body.product,
              product_provenance: body.product_provenance,
              expires_at: 80_000,
            },
          });
        },
      });
      assert.equal(result.code, EXIT_OK, result.stderr);
      assert.equal(requests.filter(request => request.url.endsWith('/api/ai/session')).length,
        scenario.oldChecks);
      assert.equal(requests.filter(request => request.url.endsWith('/api/ai/admissions')).length, 1);
      const admitted = JSON.parse(fs.readFileSync(world.file, 'utf8'));
      assert.equal(admitted.subject_id, 'seat-replacement');
      assert.notEqual(admitted.request_id, world.profile.request_id);
      assert.notEqual(admitted.token, world.profile.token);
      assert.equal(fs.existsSync(path.join(world.connectionDir, 'marlow.joining')), false);
    });
  }
});

test('declined or expired replacement removes only the stage and preserves the old bearer', async t => {
  for (const state of ['declined', 'expired']) {
    await t.test(state, async () => {
      const world = localJoinProfile({ expires_at: 2_500 });
      const oldBytes = fs.readFileSync(world.file, 'utf8');
      const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
        config: { resolveConnectionDir: () => world.connectionDir },
        clock: () => 3_000,
        async fetch(url, options) {
          assert.equal(url, 'http://localhost:8788/api/ai/admissions');
          const body = JSON.parse(options.body);
          return fakeResponse(200, {
            ok: true, state, request_id: body.request_id,
            name: body.name, product: body.product,
            product_provenance: body.product_provenance, expires_at: 50_000,
          });
        },
      });
      assert.equal(result.code, EXIT_RUNTIME);
      assert.equal(fs.readFileSync(world.file, 'utf8'), oldBytes);
      assert.equal(fs.existsSync(path.join(world.connectionDir, 'marlow.joining')), false);
      assert.match(result.stderr, state === 'declined' ? /owner declined/ : /expired before/);
    });
  }
});

test('an ambiguous replacement preserves both credentials and deliberate join resumes only it', async () => {
  const world = localJoinProfile({ expires_at: 2_500 });
  const oldBytes = fs.readFileSync(world.file, 'utf8');
  let clockCall = 0;
  const times = [3_000, 4_000, 4_001, 1_000_000];
  const firstRequests = [];
  const ambiguous = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => times[Math.min(clockCall++, times.length - 1)],
    sleep: async () => {},
    async fetch(url, options) {
      firstRequests.push({ url, options });
      if (url.endsWith('/api/ai/admissions')) throw new TypeError('response-disrupted');
      return fakeResponse(401, { ok: false, error: 'invalid-connection' });
    },
  });
  assert.equal(ambiguous.code, EXIT_RUNTIME);
  assert.match(ambiguous.stderr, /could not be confirmed.*kept for diagnosis/s);
  assert.equal(fs.readFileSync(world.file, 'utf8'), oldBytes);
  const profiles = profileModule.openProfiles({ connectionDir: world.connectionDir });
  const staged = profiles.loadStaged('Marlow');
  assert.notEqual(staged.token, world.profile.token);
  assert.equal(firstRequests.some(request =>
    request.options.headers && request.options.headers.authorization ===
      'Bearer ' + world.profile.token), false,
  'a locally expired bearer is never presented');

  const resumedRequests = [];
  const resumed = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => world.connectionDir },
    clock: () => 5_000,
    identity: { newAiCredential() { throw new Error('resume must not mint'); } },
    async fetch(url, options) {
      resumedRequests.push({ url, options });
      if (url.endsWith('/api/ai/head')) {
        return fakeResponse(200, { ok: true, head: 0, connection_session: null });
      }
      assert.equal(url, 'http://localhost:8788/api/ai/session');
      assert.equal(options.headers.authorization, 'Bearer ' + staged.token);
      return fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: 'seat-resumed',
          name: staged.name,
          product: staged.product,
          product_provenance: staged.product_provenance,
          expires_at: 90_000,
        },
      });
    },
  });
  assert.equal(resumed.code, EXIT_OK, resumed.stderr);
  assert.equal(resumedRequests.length, 2);
  assert.equal(resumedRequests.some(request => request.url.includes('/admissions')), false);
  const admitted = JSON.parse(fs.readFileSync(world.file, 'utf8'));
  assert.equal(admitted.subject_id, 'seat-resumed');
  assert.equal(admitted.token, staged.token);
  assert.equal(fs.existsSync(path.join(world.connectionDir, 'marlow.joining')), false);
});

test('join confirms its own minted seat after an ambiguous Allow response', async () => {
  const connectionDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-confirm-')), 'profiles',
  );
  let time = 1_000;
  let admissionCalls = 0;
  let confirmationCalls = 0;
  let confirmationAuthorization = null;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    sleep: async () => { throw new Error('a confirmed seat must not wait or knock again'); },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/admissions')) {
        admissionCalls += 1;
        throw Object.assign(new Error('response-disrupted'), { name: 'TypeError' });
      }
      assert.equal(url, 'http://localhost:8788/api/ai/session');
      assert.match(options.headers.authorization, /^Bearer /);
      confirmationAuthorization = options.headers.authorization;
      confirmationCalls += 1;
      return fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: 'seat-confirmed',
          name: 'Marlow',
          product: 'Codex CLI',
          product_provenance: 'client-reported',
          expires_at: 50_000,
        },
      });
    },
    ask: async () => { throw new Error('valid adapter hints must not prompt'); },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(admissionCalls, 1);
  assert.equal(confirmationCalls, 1);
  assert.match(result.stdout, /Connected as Marlow \(Codex CLI\)/);
  assert.equal(result.stderr, '');
  const profile = JSON.parse(fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8'));
  assert.equal(profile.state, 'admitted');
  assert.equal(profile.subject_id, 'seat-confirmed');
  assert.equal(confirmationAuthorization, 'Bearer ' + profile.token,
    'confirmation must use only the exact locally held candidate credential');
  assert.equal(result.stdout.includes(profile.token), false);
});

test('join self-heals when a stale waiting response follows a successful Allow', async () => {
  const connectionDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-stale-wait-')), 'profiles',
  );
  let time = 2_000;
  let admissionCalls = 0;
  let confirmationCalls = 0;
  const result = await captureJoin(['--product', 'Claude Code', '--name', 'Quailfinch'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    sleep: async () => { throw new Error('a confirmed seat must not wait or knock again'); },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/admissions')) {
        admissionCalls += 1;
        const body = JSON.parse(options.body);
        return fakeResponse(200, Object.assign({
          ok: true, state: 'waiting', expires_at: 60_000,
        }, body));
      }
      assert.equal(url, 'http://localhost:8788/api/ai/session');
      confirmationCalls += 1;
      return fakeResponse(200, {
        ok: true,
        connection: {
          subject_id: 'seat-quailfinch',
          name: 'Quailfinch',
          product: 'Claude Code',
          product_provenance: 'client-reported',
          expires_at: 60_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(admissionCalls, 1);
  assert.equal(confirmationCalls, 1);
  assert.match(result.stdout, /Connected as Quailfinch \(Claude Code\)/);
  assert.doesNotMatch(result.stdout, /Waiting for the owner/);
  const profile = JSON.parse(fs.readFileSync(path.join(connectionDir, 'quailfinch.json'), 'utf8'));
  assert.equal(profile.state, 'admitted');
  assert.equal(profile.subject_id, 'seat-quailfinch');
});

test('an explicit --name that is taken fails fast without prompting', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-name-taken-')), 'profiles');
  let time = 2_000;
  const result = await captureJoin(['--product', 'Claude Code', '--name', 'Claude'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async () => { throw new Error('explicit --name must not prompt'); },
    async fetch(_url, options) {
      const body = JSON.parse(options.body);
      return fakeResponse(409, { ok: false, error: 'name-taken' });
    },
  });
  assert.equal(result.code, EXIT_RUNTIME, result.stderr);
  assert.match(result.stderr, /already used or waiting/);
  assert.doesNotMatch(result.stderr, /Choose another/);
  assert.equal(fs.existsSync(path.join(connectionDir, 'claude.json')), false);
});

test('an explicit --name that is invalid fails fast without prompting', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-name-invalid-')), 'profiles');
  const result = await captureJoin(['--product', 'Claude Code', '--name', 'x'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => 2_000,
    ask: async () => { throw new Error('explicit --name must not prompt'); },
    async fetch() { throw new Error('invalid --name must not knock'); },
  });
  assert.equal(result.code, EXIT_USAGE, result.stderr);
  assert.match(result.stderr, /2–24 letters or digits/);
});

test('an interactive join can choose another name after a taken knock', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-rename-')), 'profiles');
  const names = [];
  const answers = ['Claude', 'Finch'];
  let time = 2_000;
  const result = await captureJoin(['--product', 'Claude Code'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async () => answers.shift(),
    async fetch(url, options) {
      if (String(url).endsWith('/api/ai/head')) {
        return fakeResponse(200, { ok: true, head: 0, connection_session: null });
      }
      const body = JSON.parse(options.body);
      names.push(body.name);
      if (body.name === 'Claude') return fakeResponse(409, { ok: false, error: 'name-taken' });
      return fakeResponse(200, {
        ok: true, state: 'allowed', request_id: body.request_id,
        name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 60_000,
        enrollment: {
          subject_id: 'seat-finch', name: body.name, product: body.product,
          product_provenance: body.product_provenance, expires_at: 60_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(names, ['Claude', 'Finch']);
  assert.equal(fs.existsSync(path.join(connectionDir, 'claude.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(connectionDir, 'finch.json'))).state, 'admitted');
  assert.match(result.stderr, /Choose another/);
});

test('a declined join deletes only its unadmitted candidate and fails loudly', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-decline-')), 'profiles');
  let time = 3_000;
  const result = await captureJoin(['--product', 'Grok CLI', '--name', 'Grok'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(_url, options) {
      const body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true, state: 'declined', request_id: body.request_id,
        name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 50_000,
      });
    },
  });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /owner declined/);
  assert.equal(fs.existsSync(path.join(connectionDir, 'grok.json')), false);
});

test('an expired join deletes only its unadmitted candidate and says it expired', async () => {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-expiry-')), 'profiles');
  let time = 4_000;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Swift'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async () => { throw new Error('must not prompt'); },
    async fetch(_url, options) {
      const body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true, state: 'expired', request_id: body.request_id,
        name: body.name, product: body.product,
        product_provenance: body.product_provenance, expires_at: 50_000,
      });
    },
  });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /expired before it was allowed/);
  assert.equal(fs.existsSync(path.join(connectionDir, 'swift.json')), false);
});

test('the CLI reports the frozen v0.1.2 package version', () => {
  const result = capture(['--version']);

  assert.equal(result.code, EXIT_OK);
  assert.equal(result.stdout, '0.1.2\n');
  assert.equal(result.stderr, '');
});

test('start accepts only an optional bounded numeric port', () => {
  assert.equal(startPort([]), undefined);
  assert.equal(startPort(['--port', '9123']), 9123);
  for (const args of [
    ['9123'], ['--host', '0.0.0.0'], ['--port'], ['--port', '0'],
    ['--port', '65536'], ['--port', '12x'], ['--port', '1234', 'extra'],
  ]) assert.equal(startPort(args), null, args.join(' '));
});

test('start reports the loopback URL and data directory, then closes cleanly', async () => {
  let closed = false;
  let received = null;
  let stdout = '';
  let stderr = '';
  const code = await runStart(['--port', '9123'], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    env: { INTERLOCK_DATA_DIR: '/tmp/interlock-cli-test' },
    platform: 'linux',
    homedir: '/home/test',
    config: { resolveDataDir: () => '/tmp/interlock-cli-test' },
    server: {
      DEFAULT_PORT: 8788,
      async startInterlockServer(options) {
        received = options;
        return {
          dataDir: options.dataDir,
          url: `http://localhost:${options.port}`,
          async close() { closed = true; },
        };
      },
    },
    waitForShutdown: async () => 'SIGINT',
  });
  assert.equal(code, EXIT_OK);
  assert.deepEqual(received, { dataDir: '/tmp/interlock-cli-test', port: 9123 });
  assert.equal(closed, true);
  assert.match(stdout, /Open: http:\/\/localhost:9123/);
  assert.match(stdout, /Data: \/tmp\/interlock-cli-test/);
  assert.match(stdout, /Interlock stopped/);
  assert.equal(stderr, '');
});

test('start refuses bad arguments before touching the server', async () => {
  let started = false;
  let stderr = '';
  const code = await runStart(['--host', '0.0.0.0'], {
    stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
  }, {
    server: { DEFAULT_PORT: 8788, async startInterlockServer() { started = true; } },
  });
  assert.equal(code, EXIT_USAGE);
  assert.equal(started, false);
  assert.match(stderr, /usage: interlock start/);
  assert.notEqual(code, EXIT_RUNTIME);
});

test('start reports an existing or unverifiable owner distinctly', async () => {
  for (const [errorCode, expected] of [
    ['already-running', /already running/],
    ['owner-unverifiable', /ownership cannot be verified safely/],
    ['corrupt-lock', /ownership cannot be verified safely/],
  ]) {
    let stderr = '';
    const code = await runStart([], {
      stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
    }, {
      config: { resolveDataDir: () => '/tmp/interlock-cli-lock-test' },
      server: {
        DEFAULT_PORT: 8788,
        async startInterlockServer() {
          const error = new Error('injected');
          error.code = errorCode;
          throw error;
        },
      },
    });
    assert.equal(code, EXIT_RUNTIME);
    assert.match(stderr, expected);
    assert.doesNotMatch(stderr, /loopback port/);
  }
});

test('start states when it recovered an abruptly stopped owner record', async () => {
  let stdout = '';
  const code = await runStart([], {
    stdout: { write: value => { stdout += String(value); } }, stderr: { write() {} },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-cli-recovered-lock-test' },
    server: {
      DEFAULT_PORT: 8788,
      async startInterlockServer(options) {
        return {
          dataDir: options.dataDir,
          recoveredStaleLock: true,
          url: `http://localhost:${options.port}`,
          async close() {},
        };
      },
    },
    waitForShutdown: async () => 'SIGINT',
  });
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /Recovered the ownership record left by a stopped Interlock process/);
});

test('start closes and fails honestly after a post-listen server error', async () => {
  let closed = false;
  let stderr = '';
  const code = await runStart([], {
    stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-runtime-error-test' },
    server: {
      DEFAULT_PORT: 8788,
      async startInterlockServer(options) {
        return {
          dataDir: options.dataDir,
          url: `http://localhost:${options.port}`,
          failure: Promise.resolve(new Error('injected listener failure')),
          async close() { closed = true; },
        };
      },
    },
    waitForShutdown: () => new Promise(() => {}),
  });
  assert.equal(code, EXIT_RUNTIME);
  assert.equal(closed, true);
  assert.match(stderr, /stopped unexpectedly/);
  assert.doesNotMatch(stderr, /shutdown did not complete cleanly/);
});

test('recover reports the local URL, closes after browser completion, and gives the restart handoff', async () => {
  let received = null;
  let closed = false;
  let startedAfterRecovery = null;
  let stdout = '';
  let stderr = '';
  const code = await runRecover(['--port', '9123'], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-recovery-cli-test' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer(options) {
        received = options;
        return {
          dataDir: options.dataDir,
          url: `http://localhost:${options.port}`,
          completed: Promise.resolve({ owner_name: 'Ana', audit_ready: true }),
          failure: new Promise(() => {}),
          status: () => ({ completed: true, capability_expires_at: Date.now() }),
          async close() { closed = true; },
        };
      },
    },
    async startAfterRecovery(args) {
      assert.equal(closed, true, 'the recovery listener and lock must retire before normal start');
      startedAfterRecovery = args;
      return EXIT_OK;
    },
    waitForShutdown: () => new Promise(() => {}),
  });
  assert.equal(code, EXIT_OK, stderr);
  assert.deepEqual(received, { dataDir: '/tmp/interlock-recovery-cli-test', port: 9123 });
  assert.equal(closed, true);
  assert.deepEqual(startedAfterRecovery, ['--port', '9123']);
  assert.match(stdout, /Open: http:\/\/localhost:9123/);
  assert.match(stdout, /replaces the owner password and passkey/);
  assert.match(stdout, /Owner recovery complete/);
  assert.match(stdout, /Starting normal Interlock/);
  assert.match(stdout, /Sign in to Interlock/);
  assert.equal(stderr, '');
});

test('recover cancellation reports an already-started window without claiming replacement', async () => {
  let stdout = '';
  const code = await runRecover([], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write() {} },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-recovery-cancel-test' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer(options) {
        return {
          url: `http://localhost:${options.port}`,
          completed: new Promise(() => {}),
          failure: new Promise(() => {}),
          status: () => ({ completed: false, capability_expires_at: Date.now() + 60_000 }),
          async close() {},
        };
      },
    },
    waitForShutdown: async () => 'SIGINT',
  });
  assert.equal(code, EXIT_OK);
  assert.match(stdout, /stopped without replacing/);
  assert.match(stdout, /at most 15 minutes/);
  assert.doesNotMatch(stdout, /Owner recovery complete/);
});

test('recover reports a durable replacement honestly when only audit delivery fails', async () => {
  let stdout = '';
  let stderr = '';
  const code = await runRecover([], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-recovery-audit-test' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer(options) {
        return {
          url: `http://localhost:${options.port}`,
          completed: Promise.resolve({ owner_name: 'Ana', audit_ready: false }),
          failure: new Promise(() => {}),
          status: () => ({ completed: true, capability_expires_at: Date.now() }),
          async close() {},
        };
      },
    },
    waitForShutdown: () => new Promise(() => {}),
  });
  assert.equal(code, EXIT_RUNTIME);
  assert.match(stderr, /password and passkey were replaced/);
  assert.match(stderr, /Do not repeat recovery/);
  assert.doesNotMatch(stdout, /Owner recovery complete/);
  assert.doesNotMatch(stderr, /did not finish.*recovery/i,
    'an audit-delivery fault must not deny the already-durable credential replacement');
});

test('recover reports a durable replacement when Ctrl+C wins the completion race', async () => {
  let closed = false;
  let stdout = '';
  let stderr = '';
  const code = await runRecover([], {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-recovery-race-test' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer(options) {
        return {
          url: `http://localhost:${options.port}`,
          completed: new Promise(() => {}),
          failure: new Promise(() => {}),
          status: () => ({ completed: closed, audit_ready: closed,
            capability_expires_at: Date.now() }),
          async close() { closed = true; },
        };
      },
    },
    waitForShutdown: async () => 'SIGINT',
  });
  assert.equal(code, EXIT_RUNTIME);
  assert.equal(closed, true);
  assert.match(stderr, /password and passkey were replaced/);
  assert.match(stderr, /completion handoff was interrupted/);
  assert.match(stderr, /Do not repeat recovery/);
  assert.doesNotMatch(stdout, /stopped without replacing|Owner recovery complete/);
});

test('recover refuses bad arguments and distinguishes a running installation', async () => {
  let started = false;
  let stderr = '';
  const usage = await runRecover(['--host', '0.0.0.0'], {
    stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
  }, {
    recovery: { DEFAULT_PORT: 8788, async startRecoveryServer() { started = true; } },
  });
  assert.equal(usage, EXIT_USAGE);
  assert.equal(started, false);
  assert.match(stderr, /usage: interlock recover/);

  stderr = '';
  const running = await runRecover([], {
    stdout: { write() {} }, stderr: { write: value => { stderr += String(value); } },
  }, {
    config: { resolveDataDir: () => '/tmp/interlock-recovery-running-test' },
    recovery: {
      DEFAULT_PORT: 8788,
      async startRecoveryServer() {
        const error = new Error('injected');
        error.code = 'already-running';
        throw error;
      },
    },
  });
  assert.equal(running, EXIT_RUNTIME);
  assert.match(stderr, /stop Interlock before recovering/);
  assert.doesNotMatch(stderr, /loopback port/);
});

test('say refuses a message body passed in argv', async () => {
  const result = await captureCommand(['say', 'hello from argv']);

  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /refusing message text in command arguments/);
  assert.match(result.stderr, /say --file PATH/);
  assert.match(result.stderr, /say --stdin/);
});

test('post-join commands refuse missing connections and say refuses ambiguous sources', async () => {
  for (const argv of [
    ['say'],
    ['say', '--file'],
    ['say', '--file', '--stdin'],
    ['say', '--stdin', 'extra'],
    ['say', '--file', 'message.md'],
    ['say', '--connection', 'Marlow', '--file', 'message.md', 'extra'],
    ['say', '--connection', 'Marlow', '--file', 'message.md', '--drain'],
  ]) {
    const result = await captureCommand(argv);
    assert.equal(result.code, EXIT_USAGE, argv.join(' '));
    assert.match(result.stderr, /refusing message text in command arguments/);
  }
  for (const command of ['history', 'listen', 'leave']) {
    const result = await captureCommand([command]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.stderr, /--connection NAME/);
  }
  const extraHistory = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain', '--json', 'extra'],
  );
  assert.equal(extraHistory.code, EXIT_USAGE);
  assert.match(extraHistory.stderr, /--connection NAME/);
});

test('history refuses a second reader instead of silently sharing its cursor', async () => {
  const world = admittedConnection();
  world.profiles.acquireReadLease = () => {
    const error = new Error('already reading');
    error.code = 'reader-active';
    throw error;
  };
  let fetched = false;
  world.dependencies.fetch = async () => {
    fetched = true;
    throw new Error('must not fetch');
  };

  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /already being read by another history\/listen process/);
  assert.match(result.stderr, /stop the previous command/);
  assert.equal(fetched, false);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('one real local connection has only one active history/listen consumer', async () => {
  const world = localJoinProfile({ expires_at: 50_000 });
  let resolveFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let fetchCalls = 0;
  const dependencies = {
    clock: () => 100,
    config: { resolveConnectionDir: () => world.connectionDir },
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstStarted();
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      return fakeResponse(200, {
        ok: true, messages: [], cursor: 0, timed_out: false, connection_session: null,
      });
    },
  };

  const firstPromise = captureCommand(['listen', '--connection', 'Marlow'], dependencies);
  await started;
  const second = await captureCommand(['history', '--connection', 'Marlow'], dependencies);
  assert.equal(second.code, EXIT_RUNTIME);
  assert.match(second.stderr, /already being read by another history\/listen process/);
  assert.equal(fetchCalls, 1, 'the refused reader must not reach the room');

  resolveFirst(fakeResponse(200, {
    ok: true, messages: [], cursor: 0, timed_out: true, connection_session: null,
  }));
  const first = await firstPromise;
  assert.equal(first.code, EXIT_OK, first.stderr);

  const afterRelease = await captureCommand(
    ['history', '--connection', 'Marlow'], dependencies,
  );
  assert.equal(afterRelease.code, EXIT_OK, afterRelease.stderr);
  assert.equal(fetchCalls, 2);
});

test('history receives, acknowledges, renders, and durably advances one explicit connection', async () => {
  const world = admittedConnection();
  const calls = [];
  world.dependencies.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/api/ai/receipts')) {
      assert.deepEqual(JSON.parse(options.body), { message_ids: [2] });
      return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
    }
    assert.equal(options.headers.authorization, `Bearer ${world.profile.token}`);
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ id: 2 })],
      cursor: 2,
      timed_out: false,
      connection_session: null,
    });
  };
  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /\[2\] Ana/);
  assert.match(result.stdout, /hello @Marlow/);
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 2],
  ]);
  assert.equal(calls[0].url,
    'http://localhost:8788/api/ai/messages?after=0&limit=1&wait=0');
  assert.equal(result.stdout.includes(world.profile.token), false);
  assert.equal(result.stderr, '');
});

test('one-message history acknowledges only the current reused-name generation', async () => {
  const cases = [
    {
      id: 2,
      text: 'addressed to the ended generation',
      session: 1,
      receiptIds: [],
    },
    {
      id: 3,
      text: 'addressed to the current generation',
      session: 2,
      receiptIds: [3],
    },
  ];
  for (const scenario of cases) {
    const world = admittedConnection();
    const receiptBodies = [];
    world.dependencies.fetch = async (url, options) => {
      if (url.includes('/api/ai/receipts')) {
        receiptBodies.push(JSON.parse(options.body));
        return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
      }
      return fakeResponse(200, {
        ok: true,
        messages: [publicMessage({
          id: scenario.id,
          text: scenario.text,
          delivery: [{
            name: 'Marlow', session: scenario.session, acknowledged_at: null,
          }],
        })],
        cursor: scenario.id,
        timed_out: false,
        connection_session: 2,
      });
    };

    const result = await captureCommand(
      ['history', '--connection', 'Marlow'], world.dependencies);
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.deepEqual(receiptBodies,
      scenario.receiptIds.length > 0 ? [{ message_ids: scenario.receiptIds }] : []);
    assert.deepEqual(world.events, [
      ['load', 'Marlow'],
      ['cursor', 'Marlow', world.profile.request_id, scenario.id],
    ]);
  }
});

test('history renders a fetched page but refuses to advance a replaced local seat', async () => {
  const world = admittedConnection();
  world.profiles.updateCursor = (name, requestId, cursor) => {
    assert.deepEqual([name, requestId, cursor], [
      'Marlow', world.profile.request_id, 2,
    ]);
    const error = new Error('replaced while the request was in flight');
    error.code = 'profile-collision';
    throw error;
  };
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true,
    messages: [publicMessage({ id: 2, delivery: [] })],
    cursor: 2,
    timed_out: false,
    connection_session: null,
  });

  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stdout, /\[2\] Ana/);
  assert.match(result.stderr, /local cursor could not be saved/);
});

test('history and listen render the durable reused-name session discriminator', async () => {
  for (const command of ['history', 'listen']) {
    const world = admittedConnection();
    world.dependencies.fetch = async url => {
      if (url.includes('/api/ai/receipts')) {
        return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
      }
      return fakeResponse(200, {
        ok: true,
        messages: [publicMessage({
          id: 2,
          byline: 'mArLoW',
          kind: 'seat',
          session: 2,
          text: 'new generation',
          product: 'Codex CLI',
          product_provenance: 'client-reported',
          delivery: [],
        })],
        cursor: 2,
        timed_out: false,
        connection_session: null,
      });
    };
    const result = await captureCommand([command, '--connection', 'Marlow'], world.dependencies);
    assert.equal(result.code, EXIT_OK, result.stderr);
    assert.match(result.stdout,
      /\[2\] mArLoW \(Codex CLI, client-reported · Session 2\):/);
  }
});

test('message schema skew reports an incompatible CLI instead of a network outage', async () => {
  const world = admittedConnection();
  const current = publicMessage();
  const { session: _messageSession, ...legacyMessage } = current;
  legacyMessage.delivery = current.delivery.map(row => {
    const { session: _deliverySession, ...legacyDelivery } = row;
    return legacyDelivery;
  });
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true,
    messages: [legacyMessage],
    cursor: 1,
    timed_out: false,
    connection_session: null,
  });

  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /answered[^]*does not match this CLI version/);
  assert.match(result.stderr, /same Interlock release as the running room/);
  assert.doesNotMatch(result.stderr, /could not reach|make sure Interlock is running/);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('history refuses a multi-message page before acknowledging or advancing', async () => {
  const world = admittedConnection();
  const calls = [];
  world.dependencies.fetch = async (url, options) => {
    calls.push({ url, options });
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ id: 1 }), publicMessage({ id: 2 })],
      cursor: 2,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /response does not match this CLI version/);
  assert.equal(calls.length, 1, 'an oversized page must not reach the receipt endpoint');
  assert.equal(calls[0].url,
    'http://localhost:8788/api/ai/messages?after=0&limit=1&wait=0');
  assert.deepEqual(world.events, [['load', 'Marlow']],
    'an oversized page must not advance the local cursor');
});

test('history --drain repeats exact one-message transactions inside one reader lease', async () => {
  const world = admittedConnection();
  const getUrls = [];
  const receiptBodies = [];
  world.dependencies.fetch = async (url, options) => {
    if (url.includes('/api/ai/receipts')) {
      receiptBodies.push(JSON.parse(options.body));
      return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
    }
    getUrls.push(url);
    const after = Number(new URL(url).searchParams.get('after'));
    if (after >= 3) return fakeResponse(200, {
      ok: true, messages: [], cursor: 3, timed_out: false, connection_session: null,
    });
    const id = after + 1;
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ id, text: `drained message ${id}` })],
      cursor: id,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /\[1\] Ana[^]*drained message 1/);
  assert.match(result.stdout, /\[2\] Ana[^]*drained message 2/);
  assert.match(result.stdout, /\[3\] Ana[^]*drained message 3/);
  assert.deepEqual(getUrls, [0, 1, 2, 3].map(after =>
    `http://localhost:8788/api/ai/messages?after=${after}&limit=1&wait=0`));
  assert.deepEqual(receiptBodies, [1, 2, 3].map(id => ({ message_ids: [id] })));
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 1],
    ['cursor', 'Marlow', world.profile.request_id, 2],
    ['cursor', 'Marlow', world.profile.request_id, 3],
  ]);
});

test('history --drain leaves the first message outside its byte budget untouched', async () => {
  const world = admittedConnection();
  const getUrls = [];
  const receiptBodies = [];
  const firstText = `FIRST ${'x'.repeat(Math.ceil(HISTORY_DRAIN_BYTES * 0.6))}`;
  const secondText = `SECOND ${'y'.repeat(Math.ceil(HISTORY_DRAIN_BYTES * 0.6))}`;
  world.dependencies.fetch = async (url, options) => {
    if (url.includes('/api/ai/receipts')) {
      receiptBodies.push(JSON.parse(options.body));
      return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
    }
    getUrls.push(url);
    const after = Number(new URL(url).searchParams.get('after'));
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({
        id: after + 1,
        text: after === 0 ? firstText : secondText,
      })],
      cursor: after + 1,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /FIRST/);
  assert.doesNotMatch(result.stdout, /SECOND/,
    'the fetched overflow message must remain outside this command output');
  assert.deepEqual(getUrls, [
    'http://localhost:8788/api/ai/messages?after=0&limit=1&wait=0',
    'http://localhost:8788/api/ai/messages?after=1&limit=1&wait=0',
  ]);
  assert.deepEqual(receiptBodies, [{ message_ids: [1] }],
    'the fetched overflow message must not be acknowledged');
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 1],
  ], 'the fetched overflow message must not advance the cursor');
});

test('history --drain preserves one legal message atomically above the batch budget', async () => {
  const world = admittedConnection();
  const text = `LARGE ${'z'.repeat(HISTORY_DRAIN_BYTES + 1_000)}`;
  let getCalls = 0;
  world.dependencies.fetch = async (url, options) => {
    if (url.includes('/api/ai/receipts')) {
      assert.deepEqual(JSON.parse(options.body), { message_ids: [1] });
      return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
    }
    getCalls += 1;
    return fakeResponse(200, {
      ok: true, messages: [publicMessage({ text })], cursor: 1, timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.ok(result.stdout.includes(text), 'the large message body must be complete');
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') > HISTORY_DRAIN_BYTES);
  assert.equal(getCalls, 1, 'an atomic oversized message ends this drain immediately');
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 1],
  ]);
});

test('history --drain emits one JSON batch and refuses the flag on other commands', async () => {
  const world = admittedConnection();
  let fetchCalls = 0;
  world.dependencies.fetch = async url => {
    fetchCalls += 1;
    const after = Number(new URL(url).searchParams.get('after'));
    if (after === 2) return fakeResponse(200, {
      ok: true, messages: [], cursor: 2, timed_out: false, connection_session: null,
    });
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ id: after + 1, delivery: [] })],
      cursor: after + 1,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand([
    'history', '--connection', 'Marlow', '--drain', '--json',
  ], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    messages: [
      publicMessage({ id: 1, delivery: [] }),
      publicMessage({ id: 2, delivery: [] }),
    ],
    cursor: 2,
    timed_out: false,
    connection_session: null,
  });
  assert.equal(fetchCalls, 3);

  for (const argv of [
    ['listen', '--connection', 'Marlow', '--drain'],
    ['history', '--connection', 'Marlow', '--drain', '--drain'],
    ['history', '--connection', 'Marlow', '--drain', '--skip-to-current'],
    ['listen', '--connection', 'Marlow', '--skip-to-current'],
    ['history', '--connection', 'Marlow', '--drain', '--before', '3'],
    ['history', '--connection', 'Marlow', '--skip-to-current', '--find', 'alpha'],
  ]) {
    const refused = await captureCommand(argv, world.dependencies);
    assert.equal(refused.code, EXIT_USAGE);
    assert.match(refused.stderr, /usage/);
  }
  assert.equal(fetchCalls, 3, 'invalid option shapes must refuse before fetching');
});

test('history --skip-to-current jumps the local cursor without fetching or acknowledging', async () => {
  const world = admittedConnection({ cursor: 4 });
  const urls = [];
  world.dependencies.fetch = async (url, options) => {
    urls.push({ url, method: options && options.method, body: options && options.body });
    return fakeResponse(200, { ok: true, head: 12, connection_session: 3 });
  };
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--skip-to-current'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Skipped to current \(cursor 4 → 12\)/);
  assert.match(result.stdout, /not fetched and was not marked delivered/);
  assert.deepEqual(urls, [{
    url: 'http://localhost:8788/api/ai/head',
    method: 'GET',
    body: undefined,
  }]);
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 12],
  ]);
});

test('history --skip-to-current JSON names the gap and never shares the messages route', async () => {
  const world = admittedConnection({ cursor: 0 });
  world.dependencies.fetch = async url => {
    assert.equal(url, 'http://localhost:8788/api/ai/head');
    return fakeResponse(200, { ok: true, head: 800, connection_session: null });
  };
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--skip-to-current', '--json'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, from: 0, head: 800, cursor: 800, connection_session: null,
  });
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 800],
  ]);
});

function peekEnvelope(overrides = {}) {
  return Object.assign({
    ok: true,
    messages: [publicMessage({ id: 2, text: 'older', delivery: [] })],
    next_before: 2,
    first_id: 1,
    searched_from: 2,
    searched_to: 5,
    complete: false,
    connection_session: null,
  }, overrides);
}

test('history --before peeks without moving the live cursor', async () => {
  const world = admittedConnection({ cursor: 40 });
  const urls = [];
  world.dependencies.fetch = async (url, options) => {
    urls.push({ url, method: options && options.method, body: options && options.body });
    return fakeResponse(200, peekEnvelope());
  };
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--before', '6'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /\[2\] Ana/);
  assert.match(result.stdout, /Searched #2–#5\. Continue with --before 2/);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'http://localhost:8788/api/ai/peek?before=6&limit=100');
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('history --find acks fetched addressed rows and reports coverage', async () => {
  const world = admittedConnection({ cursor: 40 });
  const urls = [];
  world.dependencies.fetch = async (url, options) => {
    urls.push({ url, body: options && options.body });
    if (String(url).includes('/api/ai/receipts')) {
      return fakeResponse(200, { ok: true, acknowledged: 1, added: 1 });
    }
    return fakeResponse(200, peekEnvelope({
      messages: [publicMessage({ id: 3, text: 'needle here' })],
      searched_from: 1,
      searched_to: 9,
      next_before: null,
      complete: true,
    }));
  };
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--find', 'needle'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /needle here/);
  assert.match(result.stdout, /Searched #1–#9\. Complete/);
  assert.equal(urls[0].url, 'http://localhost:8788/api/ai/peek?find=needle&limit=100');
  assert.equal(urls[1].url, 'http://localhost:8788/api/ai/receipts');
  assert.deepEqual(JSON.parse(urls[1].body), { message_ids: [3] });
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('history --skip-to-current does not move backward when the tip is behind the cursor', async () => {
  const world = admittedConnection({ cursor: 800 });
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true, head: 0, connection_session: null,
  });
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--skip-to-current'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /Current tip is 0; local cursor 800 is ahead/);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('history --skip-to-current refuses a malformed head envelope without moving the cursor', async () => {
  const world = admittedConnection({ cursor: 4 });
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true, head: 12, connection_session: '3',
  });
  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--skip-to-current'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /does not match this CLI version/);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('fresh join fail-open keeps cursor 0 when the head GET hiccups after Allow', async () => {
  const connectionDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-cli-join-failopen-')), 'profiles',
  );
  let time = 1_000;
  const result = await captureJoin(['--product', 'Codex CLI', '--name', 'Marlow'], {
    config: { resolveConnectionDir: () => connectionDir },
    clock: () => ++time,
    ask: async () => { throw new Error('valid adapter hints must not prompt'); },
    async fetch(url, options) {
      if (url.endsWith('/api/ai/head')) {
        return fakeResponse(503, { ok: false, error: 'chat-unavailable' });
      }
      const body = JSON.parse(options.body);
      return fakeResponse(200, {
        ok: true,
        state: 'allowed',
        request_id: body.request_id,
        name: body.name,
        product: body.product,
        product_provenance: body.product_provenance,
        expires_at: 50_000,
        enrollment: {
          subject_id: 'seat-1',
          name: body.name,
          product: body.product,
          product_provenance: body.product_provenance,
          expires_at: 50_000,
        },
      });
    },
  });
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /Connected as Marlow/);
  assert.match(result.stdout, /Could not read the current tip; this seat starts at the beginning/);
  assert.doesNotMatch(result.stdout, /starts at the current tip/);
  const profile = JSON.parse(fs.readFileSync(path.join(connectionDir, 'marlow.json'), 'utf8'));
  assert.equal(profile.state, 'admitted');
  assert.equal(profile.cursor, 0);
});

test('history renders a visible UTC datestamp on every message', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true,
    messages: [publicMessage({ id: 1, ts: Date.UTC(2026, 7, 23, 19, 47, 0), delivery: [] })],
    cursor: 1,
    timed_out: false,
    connection_session: null,
  });
  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /2026-08-23 19:47:00 UTC/);
  assert.match(result.stdout, /\[1\] Ana/);
});

test('history --drain has an independent message-count ceiling', async () => {
  const world = admittedConnection();
  let getCalls = 0;
  world.dependencies.fetch = async url => {
    getCalls += 1;
    const after = Number(new URL(url).searchParams.get('after'));
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ id: after + 1, text: 'x', delivery: [] })],
      cursor: after + 1,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(getCalls, HISTORY_DRAIN_MESSAGES);
  assert.match(result.stdout, new RegExp(`\\[${HISTORY_DRAIN_MESSAGES}\\] Ana`));
  assert.deepEqual(world.events.at(-1), [
    'cursor', 'Marlow', world.profile.request_id, HISTORY_DRAIN_MESSAGES,
  ]);
});

test('history --drain hands off its committed batch before reporting a later failure', async () => {
  const world = admittedConnection();
  let getCalls = 0;
  world.dependencies.fetch = async url => {
    getCalls += 1;
    if (getCalls === 2) throw new Error('offline');
    return fakeResponse(200, {
      ok: true,
      messages: [publicMessage({ text: 'committed before the outage', delivery: [] })],
      cursor: 1,
      timed_out: false,
      connection_session: null,
    });
  };

  const result = await captureCommand(
    ['history', '--connection', 'Marlow', '--drain'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stdout, /committed before the outage/);
  assert.match(result.stderr, /could not reach/);
  assert.deepEqual(world.events, [
    ['load', 'Marlow'],
    ['cursor', 'Marlow', world.profile.request_id, 1],
  ]);
});

test('an unconfirmed receipt leaves the cursor unchanged and asks for an at-least-once retry', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async url => {
    if (url.includes('/api/ai/receipts')) throw new Error('offline');
    return fakeResponse(200, {
      ok: true, messages: [publicMessage()], cursor: 1, timed_out: false,
      connection_session: null,
    });
  };
  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stdout, /hello @Marlow/);
  assert.match(result.stderr, /delivery could not be confirmed/);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('an empty listen finishes cleanly with the exact bounded retry command', async () => {
  const world = admittedConnection({ cursor: 7 });
  world.dependencies.fetch = async url => {
    assert.equal(url, 'http://localhost:8788/api/ai/messages?after=7&limit=1&wait=1');
    return fakeResponse(200, {
      ok: true, messages: [], cursor: 7, timed_out: true, connection_session: null,
    });
  };
  const result = await captureCommand(['listen', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stdout,
    'Nothing yet — run `interlock listen --connection Marlow` again.\n');
  assert.equal(result.stderr, '');
});

test('machine-readable output is available only behind the explicit json flag', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true,
    messages: [publicMessage({ delivery: [] })],
    cursor: 1,
    timed_out: false,
    connection_session: null,
  });
  const result = await captureCommand([
    'history', '--connection', 'Marlow', '--json',
  ], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    messages: [publicMessage({ delivery: [] })],
    cursor: 1,
    timed_out: false,
    connection_session: null,
  });
});

test('say reads a file, retries one ambiguous send with one stable id, and never echoes the body', async () => {
  const world = admittedConnection();
  const bodies = [];
  let call = 0;
  world.dependencies.readFile = file => {
    assert.equal(file, 'message.md');
    return 'private message body';
  };
  world.dependencies.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    call += 1;
    if (call === 1) throw new Error('ambiguous disconnect');
    return fakeResponse(201, { ok: true, message: publicMessage({
      id: 9,
      byline: 'Marlow',
      kind: 'seat',
      text: 'private message body',
      product: 'Codex CLI',
      product_provenance: 'client-reported',
      delivery: [],
    }) });
  };
  const result = await captureCommand([
    'say', '--connection', 'Marlow', '--file', 'message.md',
  ], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stdout, 'Sent as Marlow (message 9).\n');
  assert.equal(result.stderr.includes('private message body'), false);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].client_message_id, bodies[1].client_message_id);
  assert.equal(bodies[0].text, 'private message body');
});

test('say schema skew reports an accepted message once and forbids an external retry', async () => {
  const world = admittedConnection();
  let calls = 0;
  world.dependencies.readFile = () => 'already committed body';
  world.dependencies.fetch = async () => {
    calls += 1;
    const current = publicMessage({
      id: 9,
      byline: 'Marlow',
      kind: 'seat',
      text: 'already committed body',
      product: 'Codex CLI',
      product_provenance: 'client-reported',
      delivery: [],
    });
    const { session: _messageSession, ...legacyMessage } = current;
    return fakeResponse(201, { ok: true, message: legacyMessage });
  };

  const result = await captureCommand([
    'say', '--connection', 'Marlow', '--file', 'message.md',
  ], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(calls, 1, 'receipt schema skew must not send the message again');
  assert.match(result.stdout, /Message accepted/);
  assert.match(result.stdout, /Do not retry/);
  assert.match(result.stdout, /same Interlock release as the running room/);
  assert.equal(result.stdout.includes('already committed body'), false);
  assert.equal(result.stderr, '');
});

test('say --stdin preserves UTF-8 characters split across stream chunks', async () => {
  const world = admittedConnection();
  const encoded = Buffer.from('hello 🎉', 'utf8');
  const stdin = Readable.from([
    encoded.subarray(0, encoded.length - 2),
    encoded.subarray(encoded.length - 2),
  ]);
  world.dependencies.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.text, 'hello 🎉');
    return fakeResponse(201, { ok: true, message: publicMessage({
      id: 10,
      byline: 'Marlow',
      kind: 'seat',
      text: body.text,
      product: 'Codex CLI',
      product_provenance: 'client-reported',
      delivery: [],
    }) });
  };
  const result = await captureCommand([
    'say', '--connection', 'Marlow', '--stdin',
  ], world.dependencies, stdin);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stdout, 'Sent as Marlow (message 10).\n');
});

test('terminal output neutralizes control sequences returned by the local server', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async () => fakeResponse(200, {
    ok: true,
    messages: [publicMessage({
      byline: 'Pat\u001b[31mti', text: 'safe\u001b[2J\rnext', delivery: [],
    })],
    cursor: 1,
    timed_out: false,
    connection_session: null,
  });
  const result = await captureCommand(['history', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.equal(result.stdout.includes('\u001b'), false);
  assert.match(result.stdout, /Pat�\[31mti/);
  assert.match(result.stdout, /safe�\[2J\nnext/);
});

test('leave hangs up the seat then forgets only the selected local profile', async () => {
  const world = admittedConnection();
  const urls = [];
  world.dependencies.fetch = async (url, options) => {
    urls.push({ url, method: options && options.method, body: options && options.body });
    return fakeResponse(200, { ok: true, name: 'Marlow', ended_how: 'left' });
  };
  const result = await captureCommand(['leave', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(urls, [{
    url: 'http://localhost:8788/api/ai/leave',
    method: 'POST',
    body: '{}',
  }]);
  assert.deepEqual(world.events, [['load', 'Marlow'], ['forget', 'Marlow']]);
  assert.match(result.stdout, /Left the room as Marlow/);
  assert.match(result.stdout, /Stop any listener for this connection/);
  assert.doesNotMatch(result.stdout, /owner can revoke/);
});

test('leave still forgets locally after an exact 401 already-ended hang-up', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async () => fakeResponse(401, {
    ok: false, error: 'invalid-connection',
  });
  const result = await captureCommand(['leave', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.deepEqual(world.events, [['load', 'Marlow'], ['forget', 'Marlow']]);
});

test('leave keeps the local profile when hang-up cannot reach Interlock', async () => {
  const world = admittedConnection();
  world.dependencies.fetch = async () => { throw new Error('offline'); };
  const result = await captureCommand(['leave', '--connection', 'Marlow'], world.dependencies);
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /kept; run leave again/);
  assert.deepEqual(world.events, [['load', 'Marlow']]);
});

test('unknown commands fail without reflecting untrusted terminal input', () => {
  const result = capture(['dance\u001b[31m']);

  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'interlock: unknown command; run "interlock --help".\n');
  assert.doesNotMatch(result.stderr, /\u001b/);
});
