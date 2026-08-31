'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNED_NAME = 'interlock-codex-policy.rules';
const MARKER_V1 = 'INTERLOCK-CODEX-POLICY 1';
const MARKER_V2 = 'INTERLOCK-CODEX-POLICY 2';
const MARKER = 'INTERLOCK-CODEX-POLICY 3';
const MODES = Object.freeze(['receive', 'participate']);
const AI_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

function failure(code, detail) {
  const error = new Error(detail ? 'codex_policy: ' + code + ': ' + detail : 'codex_policy: ' + code);
  error.code = code;
  return error;
}

function validConnectionName(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 24 &&
    AI_NAME.test(value) && value.toLowerCase() !== 'all';
}

function isAbs(value) {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function hasDotDot(value) {
  return String(value).split(/[\\/]/).includes('..');
}

function requireAbsolute(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
      !isAbs(value) || hasDotDot(value)) {
    throw failure(code);
  }
  return value;
}

function requireRegularFile(filePath, ioFs, code) {
  const resolved = requireAbsolute(filePath, code);
  let stat;
  try { stat = ioFs.lstatSync(resolved); } catch (_) { throw failure(code); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure(code);
  return resolved;
}

function requireDirectory(dirPath, ioFs, code) {
  const resolved = requireAbsolute(dirPath, code);
  let stat;
  try { stat = ioFs.lstatSync(resolved); } catch (_) { throw failure(code); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(code);
  return resolved;
}

function starlarkString(value) {
  return JSON.stringify(value);
}

function prefixRule(pattern, justification) {
  const items = pattern.map(item => `        ${starlarkString(item)},`).join('\n');
  return [
    'prefix_rule(',
    '    pattern = [',
    items,
    '    ],',
    '    decision = "allow",',
    `    justification = ${starlarkString(justification)},`,
    ')',
    '',
  ].join('\n');
}

function invocationAliases(absPath) {
  const aliases = [];
  function add(value) {
    if (typeof value === 'string' && value.length > 0 && !aliases.includes(value)) aliases.push(value);
  }
  add(absPath);
  const posix = String(absPath).replace(/\\/g, '/');
  const winDrive = /^([A-Za-z]):(?:\/|\\)(.*)$/.exec(absPath);
  if (winDrive) {
    add(`${winDrive[1].toUpperCase()}:\\${winDrive[2].replace(/\//g, '\\')}`);
    add(`/mnt/${winDrive[1].toLowerCase()}/${winDrive[2].replace(/\\/g, '/')}`);
  }
  const mnt = /^\/mnt\/([a-z])\/(.+)$/.exec(posix);
  if (mnt) {
    add(`${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`);
    add(`/mnt/${mnt[1]}/${mnt[2]}`);
  }
  return aliases;
}

function invocationPairs(nodePath, scriptPath) {
  const pairs = [];
  const seen = new Set();
  for (const node of invocationAliases(nodePath)) {
    for (const script of invocationAliases(scriptPath)) {
      const key = node + '\0' + script;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([node, script]);
    }
  }
  return pairs;
}

function executionHostOf(checkerPath) {
  const posix = String(checkerPath || '').replace(/\\/g, '/');
  if (/\/bin\/wsl\//i.test(posix)) return 'wsl';
  if (/\.exe$/i.test(checkerPath || '') || /^[A-Za-z]:[\\/]/.test(checkerPath || '')) return 'windows';
  return process.platform === 'win32' ? 'windows' : 'wsl';
}

function pathForHost(absPath, host) {
  const aliases = invocationAliases(absPath);
  if (host === 'wsl') {
    const wsl = aliases.find(value => value.startsWith('/mnt/') || value.startsWith('/home/') ||
      (value.startsWith('/') && !value.startsWith('/mnt/')));
    return wsl || aliases.find(value => value.startsWith('/mnt/')) || absPath;
  }
  const win = aliases.find(value => /^[A-Za-z]:[\\/]/.test(value));
  return win || absPath;
}

function verifiedPair(nodePath, scriptPath, host) {
  const node = pathForHost(nodePath, host);
  const script = pathForHost(scriptPath, host);
  if (host === 'windows' && (!/^[A-Za-z]:[\\/]/.test(node) || !/^[A-Za-z]:[\\/]/.test(script))) {
    throw failure('invalid-path');
  }
  if (host === 'wsl' && (!node.startsWith('/') || !script.startsWith('/'))) {
    throw failure('invalid-path');
  }
  return [node, script];
}

function historyPattern(nodePath, scriptPath, name) {
  return [nodePath, scriptPath, 'history', '--connection', name, '--drain', '--json'];
}

function sayPattern(nodePath, scriptPath, name) {
  return [nodePath, scriptPath, 'say', '--connection', name, '--file'];
}

function generatePolicy(options) {
  const name = options.connection;
  const mode = options.mode;
  const nodePath = options.nodePath;
  const scriptPath = options.scriptPath;
  if (!validConnectionName(name)) throw failure('invalid-connection');
  if (!MODES.includes(mode)) throw failure('invalid-mode');
  if (typeof nodePath !== 'string' || nodePath.includes('\0') || !isAbs(nodePath) ||
      hasDotDot(nodePath)) {
    throw failure('invalid-node');
  }
  if (typeof scriptPath !== 'string' || scriptPath.includes('\0') || !isAbs(scriptPath) ||
      hasDotDot(scriptPath) || path.basename(scriptPath) !== 'interlock.js' &&
      path.win32.basename(scriptPath) !== 'interlock.js') {
    throw failure('invalid-script');
  }

  const host = options.executionHost || 'wsl';
  if (host !== 'wsl' && host !== 'windows') throw failure('invalid-path');
  const requestId = options.requestId || null;
  const subjectId = options.subjectId || null;
  const [node, script] = verifiedPair(nodePath, scriptPath, host);
  const history = prefixRule(
    historyPattern(node, script, name),
    'Interlock receive: canonical history --drain --json for this named connection. Drain acknowledges addressed rows and advances that connection cursor.',
  );
  const say = mode === 'participate' ? prefixRule(
    sayPattern(node, script, name),
    'Interlock participate: canonical say --file for this named connection. Codex may send any readable file through this seat without per-message Auto-review. No payload inspection, classification, redaction, or restriction.',
  ) : '';
  const body = [
    `# ${MARKER}`,
    '# Generated by interlock codex-policy. Do not edit.',
    '# One Interlock-owned file. Installing for a connection replaces any previous Interlock policy.',
    `# connection=${name}`,
    `# mode=${mode}`,
    `# host=${host}`,
    `# node=${node}`,
    `# script=${script}`,
    requestId ? `# request_id=${requestId}` : '# request_id=',
    subjectId ? `# subject_id=${subjectId}` : '# subject_id=',
    '',
    history,
    say,
  ].join('\n').replace(/\n+$/, '\n');
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return body.replace(`# ${MARKER}\n`, `# ${MARKER}\n# sha256=${digest}\n`);
}

function generateLegacyPolicy(marker, options) {
  const name = options.connection;
  const mode = options.mode;
  const nodePath = options.nodePath;
  const scriptPath = options.scriptPath;
  if (!validConnectionName(name)) throw failure('invalid-connection');
  if (!MODES.includes(mode)) throw failure('invalid-mode');
  if (typeof nodePath !== 'string' || nodePath.includes('\0') || !isAbs(nodePath) ||
      hasDotDot(nodePath)) {
    throw failure('invalid-node');
  }
  if (typeof scriptPath !== 'string' || scriptPath.includes('\0') || !isAbs(scriptPath) ||
      hasDotDot(scriptPath) || path.basename(scriptPath) !== 'interlock.js' &&
      path.win32.basename(scriptPath) !== 'interlock.js') {
    throw failure('invalid-script');
  }

  const pairs = invocationPairs(nodePath, scriptPath);
  const history = pairs.map(([node, script]) => prefixRule(
    historyPattern(node, script, name),
    'Interlock receive: canonical history --drain --json for this named connection. Drain acknowledges addressed rows and advances that connection cursor.',
  )).join('');
  const say = mode === 'participate' ? pairs.map(([node, script]) => prefixRule(
    sayPattern(node, script, name),
    'Interlock participate: canonical say --file for this named connection. Codex may send any readable file through this seat without per-message Auto-review. No payload inspection, classification, redaction, or restriction.',
  )).join('') : '';
  const body = [
    `# ${marker}`,
    '# Generated by interlock codex-policy. Do not edit.',
    '# One Interlock-owned file. Installing for a connection replaces any previous Interlock policy.',
    `# connection=${name}`,
    `# mode=${mode}`,
    `# node=${nodePath}`,
    `# script=${scriptPath}`,
    '',
    history,
    say,
  ].join('\n').replace(/\n+$/, '\n');
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return body.replace(`# ${marker}\n`, `# ${marker}\n# sha256=${digest}\n`);
}

function generatePolicyV1(options) {
  return generateLegacyPolicy(MARKER_V1, options);
}

function generatePolicyV2(options) {
  return generateLegacyPolicy(MARKER_V2, options);
}

function parseOwned(text) {
  if (typeof text !== 'string') return null;
  let version = null;
  if (text.startsWith(`# ${MARKER}\n`)) version = 3;
  else if (text.startsWith(`# ${MARKER_V2}\n`)) version = 2;
  else if (text.startsWith(`# ${MARKER_V1}\n`)) version = 1;
  else return null;
  const connection = text.match(/^# connection=([A-Za-z0-9-]+)$/m);
  const mode = text.match(/^# mode=(receive|participate)$/m);
  const node = text.match(/^# node=(.+)$/m);
  const script = text.match(/^# script=(.+)$/m);
  const digest = text.match(/^# sha256=([0-9a-f]{64})$/m);
  const host = text.match(/^# host=(wsl|windows)$/m);
  const requestId = text.match(/^# request_id=([A-Za-z0-9._-]*)$/m);
  const subjectId = text.match(/^# subject_id=([A-Za-z0-9._-]*)$/m);
  if (!connection || !mode || !node || !script || !digest) return null;
  const body = text.replace(`# sha256=${digest[1]}\n`, '');
  const computed = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  if (computed !== digest[1]) return null;
  const parsed = {
    connection: connection[1],
    mode: mode[1],
    nodePath: node[1],
    scriptPath: script[1],
    sha256: digest[1],
    version,
    executionHost: host ? host[1] : null,
    requestId: requestId && requestId[1] ? requestId[1] : null,
    subjectId: subjectId && subjectId[1] ? subjectId[1] : null,
  };
  try {
    if (version === 3 && generatePolicy(parsed) !== text) return null;
    if (version === 2 && generatePolicyV2(parsed) !== text) return null;
    if (version === 1 && generatePolicyV1(parsed) !== text) return null;
  } catch (_) { return null; }
  return parsed;
}

function policyPaths(rulesDir) {
  return { owned: path.join(rulesDir, OWNED_NAME) };
}

function uniqueTmpPath(rulesDir) {
  return path.join(rulesDir,
    `${OWNED_NAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
}

function explicitEnvHome(options) {
  const envHome = options.env && options.env.CODEX_HOME;
  if (typeof envHome !== 'string' || envHome.length === 0) return null;
  if (!isAbs(envHome) || hasDotDot(envHome)) throw failure('invalid-codex-home');
  return envHome;
}

function fallbackHomes(options) {
  const homes = [];
  const homedir = options.homedir || os.homedir();
  if (typeof homedir === 'string' && homedir.length > 0) {
    homes.push(path.join(homedir, '.codex'));
  }
  const userProfile = options.env && options.env.USERPROFILE;
  if (typeof userProfile === 'string' && userProfile.length > 0) {
    const winHome = `${userProfile.replace(/[\\/]$/, '')}\\.codex`;
    homes.push(winHome);
    for (const alias of invocationAliases(winHome)) homes.push(alias);
  }
  return [...new Set(homes)];
}

function ensureRulesDir(home, ioFs) {
  if (!ioFs.existsSync(home)) ioFs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const root = requireDirectory(home, ioFs, 'invalid-codex-home');
  const rules = path.join(root, 'rules');
  if (!ioFs.existsSync(rules)) ioFs.mkdirSync(rules, { recursive: true, mode: 0o700 });
  return requireDirectory(rules, ioFs, 'invalid-codex-home');
}

function resolveRulesDir(options, ioFs, create) {
  function open(home) {
    if (create) return ensureRulesDir(home, ioFs);
    const rules = path.join(home, 'rules');
    if (!ioFs.existsSync(home) || !ioFs.existsSync(rules)) throw failure('not-installed');
    return requireDirectory(rules, ioFs, 'not-installed');
  }
  if (options.codexHome) return open(options.codexHome);
  const envHome = explicitEnvHome(options);
  if (envHome) return open(envHome);
  if (!create) {
    const existing = [];
    for (const home of fallbackHomes(options)) {
      try { existing.push(requireDirectory(path.join(home, 'rules'), ioFs, 'not-installed')); } catch (_) { /* skip */ }
    }
    const unique = [...new Set(existing)];
    if (unique.length === 1) return unique[0];
    throw failure(unique.length > 1 ? 'ambiguous-codex-home' : 'not-installed');
  }
  const existing = [];
  for (const home of fallbackHomes(options)) {
    try { existing.push(requireDirectory(home, ioFs, 'invalid-codex-home')); } catch (_) { /* skip */ }
  }
  const unique = [...new Set(existing)];
  if (unique.length > 1) throw failure('ambiguous-codex-home');
  const home = unique[0] || (options.homedir || os.homedir()
    ? path.join(options.homedir || os.homedir(), '.codex')
    : null);
  if (!home) throw failure('ambiguous-codex-home');
  return ensureRulesDir(home, ioFs);
}

function resolvedCodexHome(rulesDir) {
  return path.basename(rulesDir) === 'rules' ? path.dirname(rulesDir) : rulesDir;
}

function shellQuote(value) {
  if (typeof value !== 'string') return '';
  if (/^[A-Za-z0-9:._\\/-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function policyHandoff(action, connection, codexHome, checkerPath) {
  const argv = ['interlock', 'codex-policy', action, '--connection', connection, '--codex-home', codexHome];
  if (checkerPath) argv.push('--codex-checker', checkerPath);
  return argv;
}

function quotedArgv(parts) {
  return parts.map(shellQuote).join(' ');
}

function displayHistoryArgv(nodePath, scriptPath, connection, host) {
  const [node, script] = verifiedPair(nodePath, scriptPath, host || 'wsl');
  return historyPattern(node, script, connection);
}

function resolveCodexNode(options, ioFs) {
  if (options.nodePath) return requireRegularFile(options.nodePath, ioFs, 'invalid-node');
  const candidates = [];
  const localAppData = options.env && options.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push(path.join(localAppData, 'OpenAI', 'Codex', 'bin',
      options.platform === 'win32' ? 'node.exe' : 'node'));
  }
  const execPath = options.execPath;
  if (typeof execPath === 'string' && /openai[\\/]codex/i.test(execPath)) {
    candidates.push(execPath);
  }
  const existing = [];
  for (const candidate of candidates) {
    try { existing.push(requireRegularFile(candidate, ioFs, 'invalid-node')); } catch (_) { /* skip */ }
  }
  const unique = [...new Set(existing)];
  if (unique.length !== 1) throw failure('ambiguous-codex-node');
  return unique[0];
}

function resolveInterlockScript(options, ioFs) {
  const scriptPath = options.scriptPath || path.resolve(__dirname, '..', 'bin', 'interlock.js');
  const resolved = requireRegularFile(scriptPath, ioFs, 'invalid-script');
  if (path.basename(resolved) !== 'interlock.js' &&
      path.win32.basename(resolved) !== 'interlock.js') {
    throw failure('invalid-script');
  }
  return resolved;
}

function versionedCheckerDir(filePath) {
  const posix = String(filePath).replace(/\\/g, '/');
  const wsl = /\/bin\/wsl\/([0-9a-f]{8,})(?:\/|$)/i.exec(posix);
  if (wsl) return { kind: 'wsl', id: wsl[1] };
  const win = /\/OpenAI\/Codex\/bin\/([0-9a-f]{8,})(?:\/|$)/i.exec(posix);
  if (win) return { kind: 'win', id: win[1] };
  return null;
}

function checkerInDir(dir, ioFs) {
  for (const name of ['codex', 'codex.exe']) {
    const candidate = path.join(dir, name);
    try { return requireRegularFile(candidate, ioFs, 'execpolicy-unavailable'); } catch (_) { /* next */ }
  }
  return null;
}

function scanVersionedCheckers(root, ioFs) {
  const found = [];
  if (!root || !ioFs.existsSync(root)) return found;
  let entries;
  try { entries = ioFs.readdirSync(root, { withFileTypes: true }); } catch (_) { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8,}$/i.test(entry.name)) continue;
    const checker = checkerInDir(path.join(root, entry.name), ioFs);
    if (checker) found.push(checker);
  }
  return found;
}

function isUnversionedChecker(filePath) {
  const posix = String(filePath).replace(/\\/g, '/');
  if (/\/OpenAI\/Codex\/bin\/codex(?:\.exe)?$/i.test(posix)) return true;
  if (/\/bin\/wsl\/codex(?:\.exe)?$/i.test(posix) && !/\/bin\/wsl\/[0-9a-f]{8,}\//i.test(posix)) {
    return true;
  }
  return false;
}

function resolveCodexChecker(options, ioFsIn) {
  const ioFs = ioFsIn || options.fs || fs;
  if (options.checkerPath) {
    if (isUnversionedChecker(options.checkerPath)) throw failure('stale-codex-checker');
    return requireRegularFile(options.checkerPath, ioFs, 'execpolicy-unavailable');
  }
  const selected = [];
  const execPath = options.execPath;
  if (typeof execPath === 'string' && execPath.length > 0) {
    const versioned = versionedCheckerDir(execPath);
    if (versioned) {
      const checker = checkerInDir(path.dirname(execPath), ioFs);
      if (checker) selected.push(checker);
    }
  }
  const homes = [];
  try { homes.push(resolvedCodexHome(resolveRulesDir(options, ioFs, false))); } catch (_) { /* no home yet */ }
  for (const home of homes) {
    selected.push(...scanVersionedCheckers(path.join(home, 'bin', 'wsl'), ioFs));
    selected.push(...scanVersionedCheckers(path.join(home, 'bin'), ioFs));
  }
  const localAppData = options.env && options.env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    selected.push(...scanVersionedCheckers(path.join(localAppData, 'OpenAI', 'Codex', 'bin'), ioFs));
  }
  const unique = [...new Set(selected)];
  if (unique.length === 1) return unique[0];
  throw failure(unique.length > 1 ? 'ambiguous-codex-checker' : 'execpolicy-unavailable');
}

function readOwned(rulesDir, ioFs) {
  const owned = policyPaths(rulesDir).owned;
  if (!ioFs.existsSync(owned)) return null;
  const stat = ioFs.lstatSync(owned);
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure('owned-file-unsafe');
  return ioFs.readFileSync(owned, 'utf8');
}

function linuxStarttime(pid, ioFs) {
  try {
    const stat = ioFs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const closeParen = stat.lastIndexOf(')');
    return stat.slice(closeParen + 2).split(' ')[19] || null;
  } catch (_) { return null; }
}

function lockOwnerState(record, ioFs) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
      typeof record.platform !== 'string' || typeof record.hostname !== 'string' ||
      !Number.isSafeInteger(record.started_at) || typeof record.instance_id !== 'string') {
    return 'unverifiable';
  }
  if (record.platform !== process.platform ||
      record.hostname.toLowerCase() !== os.hostname().toLowerCase()) {
    return 'unverifiable';
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'stale';
    if (error && error.code === 'EPERM') return 'active';
    return 'unverifiable';
  }
  if (record.starttime && process.platform === 'linux') {
    const live = linuxStarttime(record.pid, ioFs || fs);
    if (live && live !== record.starttime) return 'stale';
  }
  return 'active';
}

function withOwnedLock(rulesDir, ioFs, fn) {
  const lockPath = path.join(rulesDir, `${OWNED_NAME}.lock`);
  const record = {
    pid: process.pid,
    platform: process.platform,
    hostname: os.hostname(),
    started_at: Date.now(),
    instance_id: crypto.randomUUID(),
    starttime: linuxStarttime(process.pid, ioFs),
  };
  const encoded = JSON.stringify(record) + '\n';
  let fd = null;
  let identity = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      fd = ioFs.openSync(lockPath, 'wx');
      ioFs.writeFileSync(fd, encoded);
      identity = ioFs.fstatSync(fd);
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    let raw;
    try { raw = ioFs.readFileSync(lockPath, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw failure('owned-file-unsafe');
    }
    if (!String(raw).trim()) {
      const claimPath = lockPath + '.empty-' + crypto.randomUUID();
      try { ioFs.renameSync(lockPath, claimPath); } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      try { ioFs.unlinkSync(claimPath); } catch (_) { /* residue */ }
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw failure('owned-file-unsafe'); }
    const state = lockOwnerState(parsed, ioFs);
    if (state === 'active') throw failure('owned-file-unsafe');
    if (state !== 'stale') throw failure('owned-file-unsafe');
    let confirmed;
    try { confirmed = ioFs.readFileSync(lockPath, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw failure('owned-file-unsafe');
    }
    if (confirmed !== raw) continue;
    const claimPath = lockPath + '.stale-' + crypto.randomUUID();
    try { ioFs.renameSync(lockPath, claimPath); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    try {
      if (ioFs.readFileSync(claimPath, 'utf8') !== raw) {
        try { ioFs.linkSync(claimPath, lockPath); } catch (_) { /* keep evidence */ }
        throw failure('owned-file-unsafe');
      }
    } finally {
      try { ioFs.unlinkSync(claimPath); } catch (_) { /* claimed stale lock */ }
    }
  }
  if (fd === null || !identity) throw failure('owned-file-unsafe');
  try { return fn(); } finally {
    try {
      const pathStat = ioFs.statSync(lockPath);
      const current = ioFs.readFileSync(lockPath, 'utf8');
      if (pathStat.dev === identity.dev && pathStat.ino === identity.ino && current === encoded) {
        ioFs.unlinkSync(lockPath);
      }
    } catch (_) { /* ownership already gone */ }
    try { ioFs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function publishNoReplace(tmpPath, ownedPath, ioFs) {
  try {
    ioFs.linkSync(tmpPath, ownedPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw failure('owned-file-modified');
    const fd = ioFs.openSync(ownedPath, 'wx');
    try { ioFs.writeFileSync(fd, ioFs.readFileSync(tmpPath)); }
    catch (writeError) {
      try { ioFs.closeSync(fd); } catch (_) { /* ignore */ }
      try { ioFs.unlinkSync(ownedPath); } catch (_) { /* ignore */ }
      throw writeError;
    }
    ioFs.closeSync(fd);
  }
  try { ioFs.unlinkSync(tmpPath); } catch (_) { /* published */ }
}

function writeTmp(rulesDir, contents, ioFs) {
  const tmpPath = uniqueTmpPath(rulesDir);
  ioFs.writeFileSync(tmpPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const fd = ioFs.openSync(tmpPath, 'r+');
  try { ioFs.fsyncSync(fd); } finally { ioFs.closeSync(fd); }
  return tmpPath;
}

function decideExecpolicy(result) {
  if (!result || typeof result !== 'object') return 'unsupported';
  if (result.decision === 'allow') return 'allow';
  if (result.decision === 'deny' || result.decision === 'ask') return result.decision;
  if (Array.isArray(result.matchedRules) && result.matchedRules.length === 0) return 'deny';
  return 'unsupported';
}

function negativeConnection(name) {
  const candidate = name === 'OtherName' ? 'OtherSeat' : 'OtherName';
  if (candidate.toLowerCase() === String(name).toLowerCase()) return 'AltSeat';
  return candidate;
}

function expectedChecks(spec) {
  const { nodePath, scriptPath, connection, mode } = spec;
  const host = spec.executionHost || 'wsl';
  const [node, script] = verifiedPair(nodePath, scriptPath, host);
  const positives = [historyPattern(node, script, connection)];
  if (mode === 'participate') {
    positives.push(sayPattern(node, script, connection).concat(['message.md']));
  }
  const negatives = [
    ['node', script, 'history', '--connection', connection, '--drain', '--json'],
    [node, 'bin/interlock.js', 'history', '--connection', connection, '--drain', '--json'],
    [node, script, 'history', '--connection', negativeConnection(connection), '--drain', '--json'],
    [node, script, 'leave', '--connection', connection],
    [node, script, 'say', '--connection', connection, '--stdin'],
    [node, script, 'join'],
    historyPattern(node, script, connection).slice().reverse(),
  ];
  if (mode === 'receive') {
    negatives.push(sayPattern(node, script, connection).concat(['message.md']));
  }
  return { positives, negatives };
}

function decideChecker(options, rulesPath, command) {
  if (typeof options.checkExecpolicy === 'function') {
    return decideExecpolicy(options.checkExecpolicy(rulesPath, command));
  }
  const ioFs = options.fs || fs;
  const checkerPath = resolveCodexChecker(options, ioFs);
  const spawnSync = options.spawnSync || require('node:child_process').spawnSync;
  const platform = options.platform || process.platform;
  const args = ['execpolicy', 'check', '--rules', rulesPath, '--', ...command];
  let result;
  if (platform === 'win32' && /\/bin\/wsl\//i.test(String(checkerPath).replace(/\\/g, '/'))) {
    result = spawnSync('wsl.exe', [pathForHost(checkerPath, 'wsl'), ...args], {
      encoding: 'utf8', timeout: 20_000,
    });
  } else {
    const cmd = platform === 'win32' && String(checkerPath).startsWith('/mnt/')
      ? pathForHost(checkerPath, 'windows')
      : (platform !== 'win32' && /^[A-Za-z]:/.test(checkerPath)
        ? pathForHost(checkerPath, 'wsl')
        : checkerPath);
    result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
  }
  if (result.error) throw failure('execpolicy-unavailable');
  if (result.signal) throw failure('execpolicy-unavailable');
  if (result.status !== 0) throw failure('execpolicy-rejected');
  const text = String(result.stdout || '').trim();
  if (!text.startsWith('{')) throw failure('execpolicy-unavailable');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw failure('execpolicy-unavailable'); }
  return decideExecpolicy(parsed);
}

function installPolicy(options) {
  const ioFs = options.fs || fs;
  const connection = options.connection;
  const mode = options.mode;
  if (!validConnectionName(connection)) throw failure('invalid-connection');
  if (!MODES.includes(mode)) throw failure('invalid-mode');
  const rulesDir = resolveRulesDir(options, ioFs, true);
  const nodePath = resolveCodexNode(options, ioFs);
  const scriptPath = resolveInterlockScript(options, ioFs);
  const executionHost = options.executionHost || executionHostOf(options.checkerPath);
  const spec = {
    connection, mode, nodePath, scriptPath, executionHost,
    requestId: options.requestId || null,
    subjectId: options.subjectId || null,
    checkerPath: options.checkerPath || null,
  };
  const contents = generatePolicy(spec);
  return withOwnedLock(rulesDir, ioFs, () => {
    const existing = readOwned(rulesDir, ioFs);
    let replaced = null;
    const predecessor = existing;
    if (existing !== null) {
      const parsed = parseOwned(existing);
      if (!parsed) throw failure('owned-file-modified');
      replaced = parsed.connection;
    }
    const tmpPath = writeTmp(rulesDir, contents, ioFs);
    try {
      const checks = expectedChecks(spec);
      const checkerOptions = Object.assign({}, options, { nodePath, executionHost });
      for (const command of checks.positives) {
        if (decideChecker(checkerOptions, tmpPath, command) !== 'allow') {
          throw failure('execpolicy-rejected', command.join(' '));
        }
      }
      for (const command of checks.negatives) {
        const decision = decideChecker(checkerOptions, tmpPath, command);
        if (decision === 'allow') throw failure('execpolicy-too-broad');
        if (decision === 'unsupported') throw failure('execpolicy-unavailable');
      }
      const claimed = readOwned(rulesDir, ioFs);
      if (claimed !== predecessor) throw failure('owned-file-modified');
      if (predecessor !== null) {
        const claimPath = policyPaths(rulesDir).owned + '.claim-' + crypto.randomUUID();
        ioFs.renameSync(policyPaths(rulesDir).owned, claimPath);
        try {
          if (ioFs.readFileSync(claimPath, 'utf8') !== predecessor) {
            ioFs.renameSync(claimPath, policyPaths(rulesDir).owned);
            throw failure('owned-file-modified');
          }
          publishNoReplace(tmpPath, policyPaths(rulesDir).owned, ioFs);
          try { ioFs.unlinkSync(claimPath); } catch (_) { /* predecessor retired */ }
        } catch (error) {
          throw error;
        }
      } else {
        publishNoReplace(tmpPath, policyPaths(rulesDir).owned, ioFs);
      }
    } catch (error) {
      try { ioFs.unlinkSync(tmpPath); } catch (_) { /* leftover tmp is inactive */ }
      throw error;
    }
    const codexHome = resolvedCodexHome(rulesDir);
    let checkerPath = options.checkerPath || null;
    if (!checkerPath) {
      try { checkerPath = resolveCodexChecker(options, ioFs); } catch (_) { checkerPath = null; }
    }
    return Object.freeze({
      path: policyPaths(rulesDir).owned,
      mode,
      connection,
      nodePath,
      scriptPath,
      codexHome,
      checkerPath,
      historyArgv: displayHistoryArgv(nodePath, scriptPath, connection, executionHost),
      sayArgv: mode === 'participate'
        ? sayPattern(...verifiedPair(nodePath, scriptPath, executionHost), connection)
        : null,
      restartRequired: true,
      active: 'unknown',
      replacedConnection: replaced && replaced !== connection ? replaced : null,
      checkCommand: policyHandoff('check', connection, codexHome, checkerPath),
      removeCommand: policyHandoff('remove', connection, codexHome, checkerPath),
    });
  });
}

function checkPolicy(options) {
  const ioFs = options.fs || fs;
  const connection = options.connection;
  if (!validConnectionName(connection)) throw failure('invalid-connection');
  const rulesDir = resolveRulesDir(options, ioFs, false);
  const existing = readOwned(rulesDir, ioFs);
  if (existing === null) throw failure('not-installed');
  const parsed = parseOwned(existing);
  if (!parsed) throw failure('owned-file-modified');
  if (parsed.connection !== connection) throw failure('connection-mismatch');
  const checks = expectedChecks(parsed);
  const checkerOptions = Object.assign({}, options, { nodePath: parsed.nodePath });
  const owned = policyPaths(rulesDir).owned;
  for (const command of checks.positives) {
    if (decideChecker(checkerOptions, owned, command) !== 'allow') {
      throw failure('execpolicy-rejected');
    }
  }
  for (const command of checks.negatives) {
    const decision = decideChecker(checkerOptions, owned, command);
    if (decision === 'allow') throw failure('execpolicy-too-broad');
    if (decision === 'unsupported') throw failure('execpolicy-unavailable');
  }
  const codexHome = resolvedCodexHome(rulesDir);
  let checkerPath = options.checkerPath || null;
  if (!checkerPath) {
    try { checkerPath = resolveCodexChecker(options, ioFs); } catch (_) { checkerPath = null; }
  }
  return Object.freeze({
    path: owned,
    mode: parsed.mode,
    connection: parsed.connection,
    nodePath: parsed.nodePath,
    scriptPath: parsed.scriptPath,
    codexHome,
    checkerPath,
    restartRequired: null,
    active: 'unknown',
    syntaxOnly: true,
    checkCommand: policyHandoff('check', connection, codexHome, checkerPath),
    removeCommand: policyHandoff('remove', connection, codexHome, checkerPath),
  });
}

function removePolicy(options) {
  const ioFs = options.fs || fs;
  const connection = options.connection;
  if (!validConnectionName(connection)) throw failure('invalid-connection');
  const rulesDir = resolveRulesDir(options, ioFs, false);
  return withOwnedLock(rulesDir, ioFs, () => {
    const existing = readOwned(rulesDir, ioFs);
    if (existing === null) throw failure('not-installed');
    const parsed = parseOwned(existing);
    if (!parsed) throw failure('owned-file-modified');
    if (parsed.connection !== connection) throw failure('not-installed');
    ioFs.unlinkSync(policyPaths(rulesDir).owned);
    const codexHome = resolvedCodexHome(rulesDir);
    return Object.freeze({
      removed: policyPaths(rulesDir).owned,
      connection,
      codexHome,
    });
  });
}

module.exports = {
  OWNED_NAME,
  MARKER,
  MARKER_V1,
  MARKER_V2,
  parseOwned,
  negativeConnection,
  generatePolicy,
  generatePolicyV1,
  generatePolicyV2,
  parseOwned,
  expectedChecks,
  invocationAliases,
  installPolicy,
  checkPolicy,
  removePolicy,
  resolveCodexChecker,
  historyPattern,
  sayPattern,
};
