'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function npmInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && path.isAbsolute(candidate) &&
        path.basename(candidate) === 'npm-cli.js' && fs.existsSync(candidate)) {
      return { command: process.execPath, args: [candidate, ...args] };
    }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function packageReport() {
  const npm = npmInvocation(['pack', '--dry-run', '--json']);
  const result = childProcess.spawnSync(npm.command, npm.args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0,
    (result.error && result.error.message) || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  return report[0].files.map(file => file.path);
}

test('the release package surface includes newcomer/runtime proof and excludes private planning', () => {
  const files = new Set(packageReport());
  for (const required of [
    'GUIDE.md', 'BACKUP.md', 'RECOVERY.md', 'SECURITY.md',
    'UPGRADE.md', 'THIRD_PARTY_NOTICES.md',
    'LICENSE', 'README.md', 'package.json', 'bin/interlock.js',
    'src/server.js', 'src/codex_policy.js', 'src/web/source.html', 'identity/index.js',
    'docs/PROTOCOL.md', 'docs/CODEX_POLICY.md', 'docs/DOORBELL.md',
    'integrations/doorbell.js',
    'docs/screenshots/connect-an-ai.png',
    'test/guide.test.js', 'test/source_offer.test.js', 'test/product_scope.test.js',
    'test/doorbell.integration.test.js',
  ]) {
    assert.equal(files.has(required), true, `release package surface is missing ${required}`);
  }
  for (const privatePath of [
    'START_HERE.md',
    'CONNECT_AN_AI.md',
    'test/start_here.test.js',
    'docs/INTERLOCK_V0.1_BUILD_PLAN.md',
    'docs/README_PREVIEW_DRAFT.md',
    'docs/PHASE_3_RECOVERY_EVIDENCE.md',
    'docs/audits/PRODUCT_BOUNDARY_REVIEW_2026-08-21_OX-ALPHA.md',
    'docs/interlock-og.png',
    'docs/interlock-og.source.html',
    '.github/FUNDING.yml',
    'test/plan_alignment.test.js',
  ]) {
    assert.equal(files.has(privatePath), false,
      `private or superseded development artifact leaked: ${privatePath}`);
  }
});

test('the release package surface has no repository metadata, private process tree, inherited host mockup, or credential shape', () => {
  const files = packageReport();
  const forbiddenPaths = [
    /^\.github\//,
    /^docs\/audits\//,
    /^docs\/screenshots\/(?!connect-an-ai\.png$)/,
    /^docs\/.*(?:EVIDENCE|BUILD_PLAN|CONTINGENCY|PREVIEW_DRAFT)/,
    /^identity\/login_surface\//,
    /(?:^|\/)(?:data|connections)(?:\/|$)/,
    /(?:^|\/)(?:\.env|instance\.lock)$/,
    /(?:^|\/)(?:transcript-|interlock-backup\.json)/,
  ];
  for (const file of files) {
    assert.equal(forbiddenPaths.some(pattern => pattern.test(file)), false,
      `private or installation-state path leaked: ${file}`);
  }

  const sensitiveText = [
    ['private key', new RegExp('-----BEGIN ' + '(?:(?:RSA|EC|OPENSSH) )?' + 'PRIVATE KEY-----')],
    ['GitHub token', new RegExp('gh' + 'p_[A-Za-z0-9]{20,}|github_' + 'pat_[A-Za-z0-9_]{20,}')],
    ['OpenAI key', new RegExp('s' + 'k-(?:proj|live)-[A-Za-z0-9_-]{16,}')],
    ['AWS key', new RegExp('AK' + 'IA[0-9A-Z]{16}')],
    ['raw bearer', new RegExp('Bearer\\s+[A-Za-z0-9._~-]{32,}')],
    ['connection token JSON', new RegExp('"to' + 'ken"\\s*:\\s*"[A-Za-z0-9._~-]{32,}"')],
    ['private WSL path', new RegExp('/mnt/[a-z]/Users/[^/\\\\]+(?:/|\\\\)')],
    ['private workspace path', new RegExp('01 Cow' + 'ork|02 Co' + 'dex')],
    ['private cloud account', new RegExp('macin' + 'cloud|user' + '952973|NY' + '466', 'i')],
  ];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const [kind, pattern] of sensitiveText) {
      assert.doesNotMatch(text, pattern, `${kind} leaked in ${file}`);
    }
  }
});
