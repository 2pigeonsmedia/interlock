'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const identity = require('identity');
const profileModule = require('../src/client/profiles.js');
const policy = require('../src/codex_policy.js');
const { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, run } = require('../src/cli.js');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-codex-policy-'));
  const nodePath = path.join(root, 'codex-node');
  const scriptPath = path.join(root, 'interlock.js');
  const codexHome = path.join(root, 'codex-home');
  const rulesDir = path.join(codexHome, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(nodePath, 'node');
  fs.writeFileSync(scriptPath, 'script');
  fs.writeFileSync(path.join(rulesDir, 'default.rules'), 'prefix_rule(pattern=["echo"], decision="allow")\n');
  return { root, nodePath, scriptPath, codexHome, rulesDir };
}

function parsePatterns(text) {
  const blocks = [...text.matchAll(/pattern = \[\n([\s\S]*?)\n    \],/g)];
  return blocks.map(block => block[1].trim().split('\n').map(line => JSON.parse(line.trim().replace(/,$/, ''))));
}

function prefixAllows(text, command) {
  return parsePatterns(text).some(pattern =>
    pattern.length <= command.length && pattern.every((item, index) => item === command[index]));
}

function checker(rulesPath, command) {
  const text = fs.readFileSync(rulesPath, 'utf8');
  return prefixAllows(text, command) ? { decision: 'allow', matchedRules: [{}] } : { matchedRules: [] };
}

function admittedDir(name = 'Marlow') {
  const connectionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-codex-conn-')), 'profiles');
  const profiles = profileModule.openProfiles({ connectionDir });
  const credential = identity.newAiCredential();
  const body = {
    name,
    product: 'Codex CLI',
    product_provenance: 'client-reported',
    server_url: 'http://localhost:8788',
    request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: credential.token,
    selector: credential.selector,
    digest: credential.digest,
    created_at: 1_000,
  };
  profiles.createUnadmitted(body);
  profiles.markAdmitted(name, {
    request_id: body.request_id,
    subject_id: 'seat-1',
    name,
    product: body.product,
    product_provenance: body.product_provenance,
    expires_at: Date.now() + 86_400_000,
    admitted_at: 2_000,
  });
  return { connectionDir, token: credential.token };
}

async function capture(argv, dependencies = {}, stdin = null) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
    stdin,
  }, dependencies);
  return { code, stdout, stderr };
}

test('generated rules pin absolute node and script and never generic node', () => {
  const text = policy.generatePolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: '/abs/codex/node',
    scriptPath: '/abs/pkg/bin/interlock.js',
  });
  assert.match(text, new RegExp(policy.MARKER));
  assert.match(text, /"\/abs\/codex\/node"/);
  assert.match(text, /"\/abs\/pkg\/bin\/interlock\.js"/);
  assert.match(text, /advances that connection cursor/);
  const patterns = parsePatterns(text);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0], [
    '/abs/codex/node', '/abs/pkg/bin/interlock.js', 'history', '--connection', 'Marlow', '--drain', '--json',
  ]);
  assert.notEqual(patterns[0][0], 'node');
  assert.notEqual(patterns[0][1], 'bin/interlock.js');
  assert.equal(path.isAbsolute(patterns[0][0]), true);
  assert.equal(path.isAbsolute(patterns[0][1]), true);
});

test('participate adds say --file and receive does not', () => {
  const receive = policy.generatePolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: '/n/node',
    scriptPath: '/s/interlock.js',
  });
  const participate = policy.generatePolicy({
    connection: 'Marlow',
    mode: 'participate',
    nodePath: '/n/node',
    scriptPath: '/s/interlock.js',
  });
  assert.equal(parsePatterns(receive).length, 1);
  assert.equal(parsePatterns(participate).length, 2);
  assert.ok(participate.includes('without per-message Auto-review'));
  assert.equal(prefixAllows(receive, ['/n/node', '/s/interlock.js', 'say', '--connection', 'Marlow', '--file', 'x']),
    false);
  assert.equal(prefixAllows(participate, ['/n/node', '/s/interlock.js', 'say', '--connection', 'Marlow', '--file', 'x']),
    true);
});

test('install writes atomically, refuses a modified owned file, and remove is exact', () => {
  const tree = makeTree();
  const spec = {
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  };
  const installed = policy.installPolicy(spec);
  assert.equal(installed.active, 'unknown');
  assert.equal(installed.restartRequired, true);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, policy.OWNED_NAME)), true);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, 'default.rules')), true);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, 'interlock-codex-policy.rules.tmp')), false);

  const beforeDefault = fs.readFileSync(path.join(tree.rulesDir, 'default.rules'), 'utf8');
  fs.appendFileSync(installed.path, '\n# edited\n');
  assert.throws(() => policy.installPolicy(Object.assign({}, spec, { mode: 'participate' })),
    /owned-file-modified/);
  assert.throws(() => policy.removePolicy(spec), /owned-file-modified/);
  assert.equal(fs.readFileSync(path.join(tree.rulesDir, 'default.rules'), 'utf8'), beforeDefault);
});

test('downgrade from participate to receive removes send authority', () => {
  const tree = makeTree();
  const spec = {
    connection: 'Marlow',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  };
  policy.installPolicy(Object.assign({}, spec, { mode: 'participate' }));
  assert.match(fs.readFileSync(path.join(tree.rulesDir, policy.OWNED_NAME), 'utf8'), /say/);
  policy.installPolicy(Object.assign({}, spec, { mode: 'receive' }));
  const text = fs.readFileSync(path.join(tree.rulesDir, policy.OWNED_NAME), 'utf8');
  assert.doesNotMatch(text, /"say"/);
  assert.equal(prefixAllows(text, [tree.nodePath, tree.scriptPath, 'say', '--connection', 'Marlow', '--file', 'x']),
    false);
});

test('install refuses a symlink policy path and a relative script', () => {
  assert.throws(() => policy.generatePolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: '/n/node',
    scriptPath: 'bin/interlock.js',
  }), /invalid-script/);
  const tree = makeTree();
  assert.throws(() => policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.nodePath,
    checkExecpolicy: checker,
    fs,
  }), /invalid-codex-home/);
});

test('CLI install receive, check, and remove round-trip without leaking a token', async () => {
  const tree = makeTree();
  const admitted = admittedDir('Marlow');
  const dependencies = {
    config: { resolveConnectionDir: () => admitted.connectionDir },
    codexHome: undefined,
    homedir: tree.root,
    checkExecpolicy: checker,
    codexNodePath: tree.nodePath,
    interlockScriptPath: tree.scriptPath,
    env: { CODEX_HOME: tree.codexHome },
  };
  const installed = await capture([
    'codex-policy', 'install', '--connection', 'Marlow', '--mode', 'receive',
    '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(installed.code, EXIT_OK, installed.stderr);
  assert.match(installed.stdout, /Syntax check only/);
  assert.match(installed.stdout, /unknown/);
  assert.match(installed.stdout, /"history","--connection","Marlow","--drain","--json"/);
  assert.doesNotMatch(installed.stdout, /say/);
  assert.doesNotMatch(installed.stdout + installed.stderr, new RegExp(admitted.token.replace(/[.*]/g, '\\$&')));

  const checked = await capture([
    'codex-policy', 'check', '--connection', 'Marlow', '--json', '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(checked.code, EXIT_OK, checked.stderr);
  const payload = JSON.parse(checked.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.active, 'unknown');
  assert.equal(payload.syntax_only, true);
  assert.equal(payload.restart_required, null);
  assert.doesNotMatch(checked.stdout, /token|bearer/i);

  const removed = await capture([
    'codex-policy', 'remove', '--connection', 'Marlow', '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(removed.code, EXIT_OK, removed.stderr);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, policy.OWNED_NAME)), false);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, 'default.rules')), true);
});

test('CLI participate requires confirmation and refuses extra arguments', async () => {
  const tree = makeTree();
  const admitted = admittedDir('Marlow');
  const dependencies = {
    config: { resolveConnectionDir: () => admitted.connectionDir },
    checkExecpolicy: checker,
    codexNodePath: tree.nodePath,
    interlockScriptPath: tree.scriptPath,
    env: { CODEX_HOME: tree.codexHome },
    confirmParticipate: async () => false,
  };
  const refused = await capture([
    'codex-policy', 'install', '--connection', 'Marlow', '--mode', 'participate',
    '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(refused.code, EXIT_USAGE);
  assert.match(refused.stderr, /not confirmed/);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, policy.OWNED_NAME)), false);

  dependencies.confirmParticipate = async () => true;
  const extra = await capture([
    'codex-policy', 'install', '--connection', 'Marlow', '--mode', 'participate',
    '--codex-home', tree.codexHome, 'extra',
  ], dependencies);
  assert.equal(extra.code, EXIT_USAGE);

  const ok = await capture([
    'codex-policy', 'install', '--connection', 'Marlow', '--mode', 'participate',
    '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(ok.code, EXIT_OK, ok.stderr);
  assert.match(ok.stdout, /"say","--connection","Marlow","--file"/);
});

test('CLI check fails closed when execpolicy is unavailable', async () => {
  const tree = makeTree();
  const admitted = admittedDir('Marlow');
  policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  });
  const result = await capture([
    'codex-policy', 'check', '--connection', 'Marlow', '--codex-home', tree.codexHome,
  ], {
    config: { resolveConnectionDir: () => admitted.connectionDir },
    checkExecpolicy: () => null,
  });
  assert.equal(result.code, EXIT_RUNTIME);
  assert.match(result.stderr, /not active|unavailable|unsupported/);
});

test('a Windows Node reached from WSL keeps the script argument Windows-native', () => {
  const text = policy.generatePolicy({
    connection: 'Marlow',
    mode: 'receive',
    executionHost: 'wsl',
    nodePath: 'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\node.exe',
    scriptPath: 'C:\\Users\\x\\npm\\node_modules\\interlock\\bin\\interlock.js',
  });
  assert.match(text, /\/mnt\/c\/Users\/x\/AppData\/Local\/OpenAI\/Codex\/bin\/node\.exe/);
  const patterns = [...text.matchAll(/pattern = \[\n([\s\S]*?)\n    \],/g)].map(block =>
    block[1].trim().split('\n').map(line => JSON.parse(line.trim().replace(/,$/, ''))));
  assert.equal(patterns.length, 1);
  assert.ok(patterns[0][0].startsWith('/mnt/c/'));
  assert.equal(patterns[0][1], 'C:\\Users\\x\\npm\\node_modules\\interlock\\bin\\interlock.js');
});

test('a native host gives its WSL checker a WSL rules path', () => {
  const rulesPath = 'C:\\Users\\x\\.codex\\rules\\interlock-codex-policy.rules.tmp';
  const checkerPath = 'C:\\Users\\x\\.codex\\bin\\wsl\\80652e088c21f249\\codex';
  const wslRulesPath = ['', 'mnt', 'c', 'Users', 'x', '.codex', 'rules',
    'interlock-codex-policy.rules.tmp'].join('/');
  assert.equal(policy.rulesPathForChecker(rulesPath, 'win32', checkerPath),
    wslRulesPath);
  assert.equal(policy.rulesPathForChecker(rulesPath, 'win32',
    'C:\\Users\\x\\AppData\\Local\\OpenAI\\Codex\\bin\\b99306303521e97e\\codex.exe'),
    rulesPath, 'a native checker must keep the native rules path');
});

test('unpinned missing checker is unavailable not rejected', () => {
  const tree = makeTree();
  const checkerPath = path.join(tree.root, 'codex');
  fs.writeFileSync(checkerPath, 'checker');
  assert.throws(() => policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    checkerPath,
    codexHome: tree.codexHome,
    spawnSync() {
      const error = new Error('spawn ENOENT');
      error.code = 'ENOENT';
      return { error, status: null, signal: null, stdout: '', stderr: '' };
    },
    fs,
  }), /execpolicy-unavailable/);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, policy.OWNED_NAME)), false);
});

test('versioned active checker wins over a stale unversioned sibling', () => {
  const tree = makeTree();
  const versionDir = path.join(tree.codexHome, 'bin', 'wsl', '4f759bc6b64517c4');
  fs.mkdirSync(versionDir, { recursive: true });
  const active = path.join(versionDir, 'codex');
  const stale = path.join(path.dirname(tree.nodePath), 'codex.exe');
  fs.writeFileSync(active, 'active');
  fs.writeFileSync(stale, 'stale');
  assert.equal(policy.resolveCodexChecker({
    execPath: active,
    codexHome: tree.codexHome,
    fs,
  }), active);
  const second = path.join(tree.codexHome, 'bin', 'wsl', 'aaaaaaaaaaaaaaaa');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'codex'), 'other');
  assert.throws(() => policy.resolveCodexChecker({
    codexHome: tree.codexHome,
    fs,
  }), /ambiguous-codex-checker/);
});

test('a crash-residue lock does not permanently block revoke', () => {
  const tree = makeTree();
  const spec = {
    connection: 'Marlow',
    mode: 'participate',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  };
  policy.installPolicy(spec);
  fs.writeFileSync(path.join(tree.rulesDir, `${policy.OWNED_NAME}.lock`),
    `${JSON.stringify({
      pid: 99999999,
      platform: process.platform,
      hostname: require('node:os').hostname(),
      started_at: 1,
      instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })}\n`);
  const removed = policy.removePolicy(spec);
  assert.equal(fs.existsSync(removed.removed), false);
  assert.match(removed.codexHome, /codex-home/);
});

test('absolute CODEX_HOME is honored even when it does not exist yet', () => {
  const tree = makeTree();
  const explicit = path.join(tree.root, 'explicit-home');
  const spec = {
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    homedir: tree.root,
    env: { CODEX_HOME: explicit },
    checkExecpolicy: checker,
    fs,
  };
  const installed = policy.installPolicy(spec);
  assert.equal(installed.codexHome, explicit);
  assert.equal(installed.path, path.join(explicit, 'rules', policy.OWNED_NAME));
  assert.equal(fs.existsSync(path.join(tree.codexHome, 'rules', policy.OWNED_NAME)), false);
  assert.ok(installed.removeCommand.includes('--codex-home'));
  assert.ok(installed.removeCommand.some(part => String(part).includes('explicit-home')));
  assert.ok(installed.checkCommand.includes('--codex-home'));
});

test('OtherName installs because the negative connection is derived', () => {
  const tree = makeTree();
  const installed = policy.installPolicy({
    connection: 'OtherName',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkerPath: tree.nodePath,
    checkExecpolicy: checker,
    fs,
  });
  assert.equal(installed.connection, 'OtherName');
  assert.ok(installed.removeCommand.includes('--codex-checker'));
});

test('a digest-valid v1 owned file can be removed and upgraded', () => {
  const tree = makeTree();
  const text = policy.generatePolicyV1({
    connection: 'Marlow',
    mode: 'participate',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
  });
  fs.writeFileSync(path.join(tree.rulesDir, policy.OWNED_NAME), text);
  const removed = policy.removePolicy({
    connection: 'Marlow',
    codexHome: tree.codexHome,
    fs,
  });
  assert.equal(fs.existsSync(removed.removed), false);
  fs.writeFileSync(path.join(tree.rulesDir, policy.OWNED_NAME), text);
  const upgraded = policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  });
  assert.match(fs.readFileSync(upgraded.path, 'utf8'), new RegExp(policy.MARKER));
  assert.doesNotMatch(fs.readFileSync(upgraded.path, 'utf8'), /"say"/);
});

test('legacy generators match authentic 30e867c/75c3578 Windows participate bytes', () => {
  const crypto = require('node:crypto');
  const opts = {
    connection: 'Marlow',
    mode: 'participate',
    nodePath: 'C:\\Codex\\node.exe',
    scriptPath: 'C:\\App\\interlock.js',
  };
  const v1 = policy.generatePolicyV1(opts);
  const v2 = policy.generatePolicyV2(opts);
  assert.equal(Buffer.byteLength(v1), 3728);
  assert.equal((v1.match(/prefix_rule\(/g) || []).length, 8);
  assert.equal(
    crypto.createHash('sha256').update(v1, 'utf8').digest('hex'),
    '5912787f37c3979290cbbe962a07dcb86b19b7fd345bd2a7d7d1cb91442b6db0',
  );
  assert.equal(
    crypto.createHash('sha256').update(v2, 'utf8').digest('hex'),
    '70d129a42ddc450816c1c9518217522a55b1fb48e4980e41c86529fafeab623d',
  );
  assert.match(v1, /One Interlock-owned file/);
  assert.match(v1, /\/mnt\/c\/Codex\/node\.exe/);
  assert.match(v2, /\n\nprefix_rule\(\n    pattern = \[\n        "C:\\\\Codex\\\\node\.exe",\n        "C:\\\\App\\\\interlock\.js",\n        "say"/);
  assert.equal(policy.parseOwned(v1).version, 1);
  assert.equal(policy.parseOwned(v2).version, 2);
  const tree = makeTree();
  fs.writeFileSync(path.join(tree.rulesDir, policy.OWNED_NAME), v1);
  const removed = policy.removePolicy({
    connection: 'Marlow',
    codexHome: tree.codexHome,
    fs,
  });
  assert.equal(fs.existsSync(removed.removed), false);
});

test('a digest-valid file with an extra say-only rule is rejected', () => {
  const base = policy.generatePolicyV1({
    connection: 'Marlow',
    mode: 'participate',
    nodePath: '/n/node',
    scriptPath: '/s/interlock.js',
  });
  const tampered = base.replace(/\n$/, '\ndangerous_call()\n');
  const crypto = require('node:crypto');
  const body = tampered.replace(/^# sha256=[0-9a-f]{64}\n/m, '');
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const text = body.replace(`# ${policy.MARKER_V1}\n`, `# ${policy.MARKER_V1}\n# sha256=${digest}\n`);
  assert.equal(policy.parseOwned(text), null);
});

test('leave Other does not fail because a Marlow policy is installed', () => {
  const tree = makeTree();
  policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: tree.codexHome,
    checkExecpolicy: checker,
    fs,
  });
  assert.throws(() => policy.removePolicy({
    connection: 'Other',
    codexHome: tree.codexHome,
    fs,
  }), /not-installed/);
  assert.equal(fs.existsSync(path.join(tree.rulesDir, policy.OWNED_NAME)), true);
});

test('leave fails closed on ambiguous Codex home and keeps the profile', async () => {
  const tree = makeTree();
  const admitted = admittedDir('Marlow');
  const posixHome = path.join(tree.root, 'posix-user');
  const posixCodex = path.join(posixHome, '.codex');
  fs.mkdirSync(path.join(posixCodex, 'rules'), { recursive: true });
  const userProfile = path.join(tree.root, 'win-user');
  fs.mkdirSync(path.join(`${userProfile}\\.codex`, 'rules'), { recursive: true });
  policy.installPolicy({
    connection: 'Marlow',
    mode: 'receive',
    nodePath: tree.nodePath,
    scriptPath: tree.scriptPath,
    codexHome: posixCodex,
    checkExecpolicy: checker,
    fs,
  });
  let hungUp = false;
  const result = await capture(['leave', '--connection', 'Marlow'], {
    config: { resolveConnectionDir: () => admitted.connectionDir },
    homedir: posixHome,
    env: { USERPROFILE: userProfile },
    fetch: async () => {
      hungUp = true;
      throw new Error('leave must not hang up while Codex home is ambiguous');
    },
  });
  assert.equal(result.code, EXIT_USAGE, result.stderr);
  assert.match(result.stderr, /--codex-home/);
  assert.equal(hungUp, false);
  assert.equal(fs.existsSync(path.join(posixCodex, 'rules', policy.OWNED_NAME)), true);
  const remaining = profileModule.openProfiles({ connectionDir: admitted.connectionDir }).load('Marlow');
  assert.equal(remaining.state, 'admitted');
});

test('check does not create a missing home', () => {
  const tree = makeTree();
  const missing = path.join(tree.root, 'no-such-home');
  assert.throws(() => policy.checkPolicy({
    connection: 'Marlow',
    codexHome: missing,
    fs,
  }), /not-installed/);
  assert.equal(fs.existsSync(missing), false);
});

test('CLI remove works after the local profile is gone', async () => {
  const tree = makeTree();
  const admitted = admittedDir('Marlow');
  const dependencies = {
    config: { resolveConnectionDir: () => admitted.connectionDir },
    checkExecpolicy: checker,
    codexNodePath: tree.nodePath,
    interlockScriptPath: tree.scriptPath,
    env: { CODEX_HOME: tree.codexHome },
    confirmParticipate: async () => true,
  };
  const installed = await capture([
    'codex-policy', 'install', '--connection', 'Marlow', '--mode', 'receive',
    '--codex-home', tree.codexHome, '--codex-checker', tree.nodePath,
  ], dependencies);
  assert.equal(installed.code, EXIT_OK, installed.stderr);
  assert.match(installed.stdout, /--codex-checker/);
  fs.rmSync(admitted.connectionDir, { recursive: true, force: true });
  const removed = await capture([
    'codex-policy', 'remove', '--connection', 'Marlow',
    '--codex-home', tree.codexHome,
  ], { env: { CODEX_HOME: tree.codexHome } });
  assert.equal(removed.code, EXIT_OK, removed.stderr);
});
