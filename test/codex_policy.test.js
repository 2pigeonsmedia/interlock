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
  assert.equal(installed.active, false);
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
  assert.match(installed.stdout, /not active/);
  assert.match(installed.stdout, /history --connection Marlow --drain --json/);
  assert.doesNotMatch(installed.stdout, /say/);
  assert.doesNotMatch(installed.stdout + installed.stderr, new RegExp(admitted.token.replace(/[.*]/g, '\\$&')));

  const checked = await capture([
    'codex-policy', 'check', '--connection', 'Marlow', '--json', '--codex-home', tree.codexHome,
  ], dependencies);
  assert.equal(checked.code, EXIT_OK, checked.stderr);
  const payload = JSON.parse(checked.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.active, false);
  assert.equal(payload.restart_required, true);
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
  assert.match(ok.stdout, /say --connection Marlow --file/);
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
  assert.match(result.stderr, /not active/);
});
