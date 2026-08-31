'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');

const packageJson = require('../package.json');

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
const DEFAULT_URL = 'http://localhost:8788';
const JOIN_WINDOW_MS = 15 * 60 * 1000;
const JOIN_RETRY_MS = 1_000;
const JOIN_FETCH_TIMEOUT_MS = 25_000;
const JOIN_CONFIRM_TIMEOUT_MS = 5_000;
const COMMAND_FETCH_TIMEOUT_MS = 25_000;
const LISTEN_FETCH_TIMEOUT_MS = 60_000;
// Every server response stays at one message. Ordinary history and listen hand
// off that one message. Deliberate history --drain may repeat those exact
// transactions, but only inside one bounded rendered-output budget. A legal
// single message remains atomic even when it alone exceeds that batch budget.
const HISTORY_LIMIT = 1;
const HISTORY_DRAIN_BYTES = 12 * 1024;
const HISTORY_DRAIN_MESSAGES = 100;
const HISTORY_PEEK_LIMIT = 100;

const HELP = `Interlock ${packageJson.version}

One shared chat room for humans and multiple AI sessions.

Usage:
  interlock --help
  interlock --version
  interlock start [--port PORT]
  interlock recover [--port PORT]
  interlock backup --to ABSOLUTE_PATH
  interlock restore --from ABSOLUTE_PATH
  interlock join
  interlock history --connection NAME [--drain | --skip-to-current | --before N | --find TEXT] [--json]
  interlock say --connection NAME --file PATH [--json]
  interlock say --connection NAME --stdin [--json]
  interlock listen --connection NAME [--json]
  interlock leave --connection NAME [--json]
  interlock codex-policy install --connection NAME --mode receive|participate
  interlock codex-policy check --connection NAME [--json]
  interlock codex-policy remove --connection NAME

The owner uses the browser room. An AI runs "interlock join" in its own
conversation, chooses a name, and waits for the owner's Allow.
Every later AI command names that exact connection explicitly.
`;

function line(stream, message) {
  stream.write(`${message}\n`);
}

function refuseSay(stderr) {
  line(
    stderr,
    'interlock: refusing message text in command arguments; use "interlock say --file PATH" or pipe to "interlock say --stdin".',
  );
  return EXIT_USAGE;
}

function commandOptions(command, args) {
  const options = {
    connection: null, drain: false, skipToCurrent: false, before: null, find: null,
    json: false, source: null,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (seen.has(flag)) return null;
      seen.add(flag);
      options.json = true;
      continue;
    }
    if (command === 'history' && flag === '--drain') {
      if (seen.has(flag) || options.skipToCurrent || options.before !== null ||
          options.find !== null) return null;
      seen.add(flag);
      options.drain = true;
      continue;
    }
    if (command === 'history' && flag === '--skip-to-current') {
      if (seen.has(flag) || options.drain || options.before !== null ||
          options.find !== null) return null;
      seen.add(flag);
      options.skipToCurrent = true;
      continue;
    }
    if (command === 'history' && flag === '--before') {
      if (seen.has(flag) || options.drain || options.skipToCurrent ||
          typeof args[index + 1] !== 'string' || !/^[1-9][0-9]*$/.test(args[index + 1])) {
        return null;
      }
      seen.add(flag);
      options.before = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (command === 'history' && flag === '--find') {
      if (seen.has(flag) || options.drain || options.skipToCurrent ||
          typeof args[index + 1] !== 'string' || args[index + 1].length < 1 ||
          args[index + 1].length > 200 || args[index + 1].startsWith('-')) {
        return null;
      }
      seen.add(flag);
      options.find = args[index + 1];
      index += 1;
      continue;
    }
    if (flag === '--connection') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' ||
          args[index + 1].length === 0 || args[index + 1].startsWith('-')) return null;
      seen.add(flag);
      options.connection = args[index + 1];
      index += 1;
      continue;
    }
    if (command === 'say' && flag === '--stdin') {
      if (seen.has('--source')) return null;
      seen.add('--source');
      options.source = { kind: 'stdin' };
      continue;
    }
    if (command === 'say' && flag === '--file') {
      if (seen.has('--source') || typeof args[index + 1] !== 'string' ||
          args[index + 1].length === 0 || args[index + 1].startsWith('-')) return null;
      seen.add('--source');
      options.source = { kind: 'file', path: args[index + 1] };
      index += 1;
      continue;
    }
    return null;
  }
  if (options.connection === null || (command === 'say') !== (options.source !== null)) return null;
  return Object.freeze(options);
}

function startPort(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--port' || !/^[0-9]{1,5}$/.test(args[1])) return null;
  const port = Number(args[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function storageOptions(command, args) {
  if (command !== 'backup' && command !== 'restore') return null;
  const flag = command === 'backup' ? '--to' : '--from';
  if (args.length !== 2 || args[0] !== flag || typeof args[1] !== 'string' ||
      args[1].length === 0 || args[1].startsWith('-') || !path.isAbsolute(args[1])) return null;
  return Object.freeze({ path: args[1] });
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' &&
    !path.isAbsolute(relative));
}

function storageConfiguration(dependencies) {
  const config = dependencies.config || require('./config.js');
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const homedir = dependencies.homedir;
  return Object.freeze({
    dataDir: config.resolveDataDir({ env, platform, homedir }),
    connectionDir: config.resolveConnectionDir({ env, platform, homedir }),
  });
}

function reportStorageError(stderr, command, error) {
  const code = error && error.code;
  if (code === 'already-running') {
    line(stderr, `interlock: stop Interlock before ${command === 'backup' ? 'backing it up' : 'restoring it'}.`);
  } else if (code === 'owner-unverifiable' || code === 'corrupt-lock') {
    line(stderr, 'interlock: instance ownership cannot be verified safely; no files were copied.');
  } else if (code === 'target-exists') {
    line(stderr, 'interlock: the backup destination already exists; choose a new path.');
  } else if (code === 'data-dir-exists') {
    line(stderr, 'interlock: restore refuses to overwrite an existing Interlock data directory.');
  } else if (code === 'data-dir-missing') {
    line(stderr, 'interlock: there is no Interlock data directory to back up.');
  } else if (code === 'backup-missing') {
    line(stderr, 'interlock: the selected backup directory does not exist.');
  } else if (code === 'invalid-manifest' || code === 'invalid-backup' ||
      code === 'backup-verification-failed') {
    line(stderr, 'interlock: the selected backup is incomplete, changed, or invalid; restore refused.');
  } else if (code === 'overlapping-paths') {
    line(stderr, 'interlock: the backup and live data paths must not contain one another.');
  } else if (code === 'target-parent-missing' || code === 'data-parent-missing') {
    line(stderr, 'interlock: the parent directory for that path does not exist.');
  } else if (code === 'symbolic-link-refused' || code === 'special-file-refused' ||
      code === 'nonportable-entry') {
    line(stderr, 'interlock: the data tree contains an unsupported or non-portable entry; nothing was published.');
  } else {
    line(stderr, `interlock: ${command} could not complete and no existing installation was overwritten.`);
  }
}

function runBackup(args, io, dependencies = {}) {
  const parsed = storageOptions('backup', args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock backup --to ABSOLUTE_PATH');
    return EXIT_USAGE;
  }
  let configured;
  try { configured = storageConfiguration(dependencies); }
  catch (_) {
    line(io.stderr, 'interlock: invalid data or connection directory configuration.');
    return EXIT_USAGE;
  }
  const backup = dependencies.backup || require('./backup.js');
  let result;
  try {
    result = backup.backupInstallation({
      dataDir: configured.dataDir,
      target: parsed.path,
      clock: dependencies.clock || Date.now,
    });
  } catch (error) {
    reportStorageError(io.stderr, 'backup', error);
    return EXIT_RUNTIME;
  }
  line(io.stdout, 'Backup complete.');
  line(io.stdout, `Backup: ${terminalSafe(result.path)}`);
  line(io.stdout, `Verified files: ${result.files}; bytes: ${result.bytes}.`);
  line(io.stdout, 'Contains the stopped Interlock data directory except transient server and connection-profile lock records.');
  line(io.stdout, 'This backup is plaintext and sensitive: it contains transcripts and identity state.');
  if (pathInside(configured.dataDir, configured.connectionDir)) {
    line(io.stdout, 'AI connection profiles under the data directory are included and may contain raw bearer credentials.');
  } else {
    line(io.stdout, `Not included: external AI connection directory ${terminalSafe(configured.connectionDir)}.`);
  }
  return EXIT_OK;
}

function runRestore(args, io, dependencies = {}) {
  const parsed = storageOptions('restore', args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock restore --from ABSOLUTE_PATH');
    return EXIT_USAGE;
  }
  let configured;
  try { configured = storageConfiguration(dependencies); }
  catch (_) {
    line(io.stderr, 'interlock: invalid data or connection directory configuration.');
    return EXIT_USAGE;
  }
  const backup = dependencies.backup || require('./backup.js');
  let result;
  try {
    result = backup.restoreInstallation({ backup: parsed.path, dataDir: configured.dataDir });
  } catch (error) {
    reportStorageError(io.stderr, 'restore', error);
    return EXIT_RUNTIME;
  }
  line(io.stdout, 'Restore complete.');
  line(io.stdout, `Data: ${terminalSafe(result.path)}`);
  line(io.stdout, `Verified files: ${result.files}; bytes: ${result.bytes}.`);
  line(io.stdout, 'Run "interlock start" to open the restored installation.');
  if (!pathInside(configured.dataDir, configured.connectionDir)) {
    line(io.stdout, `External AI connection directory was not restored: ${terminalSafe(configured.connectionDir)}.`);
  }
  return EXIT_OK;
}

function joinOptions(args) {
  const options = { name: null, product: null, url: DEFAULT_URL };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--name', '--product', '--url'].includes(flag) || seen.has(flag) ||
        typeof value !== 'string' || value.length === 0) return null;
    seen.add(flag);
    options[flag.slice(2)] = value;
  }
  return args.length % 2 === 0 ? Object.freeze(options) : null;
}

function waitMs(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function responseError(result, status) {
  const error = new Error(result && typeof result.error === 'string' ? result.error : 'unavailable');
  error.code = result && typeof result.error === 'string' ? result.error : 'unavailable';
  error.status = status;
  error.retry_after = result && result.retry_after;
  error.exact = exactObject(result, ['ok', 'error']) !== null && result.ok === false;
  return error;
}

function incompatibleResponse() {
  const error = new Error('incompatible Interlock response');
  error.code = 'incompatible-response';
  return error;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key)) ? value : null;
}

function terminalSafe(value, multiline = false) {
  let output = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (multiline && (code === 0x0A || code === 0x09)) {
      output += character;
    } else if (multiline && code === 0x0D) {
      output += '\n';
    } else if (code < 0x20 || (code >= 0x7F && code <= 0x9F) ||
        /[\p{Cf}\p{Cs}]/u.test(character)) {
      output += '\uFFFD';
    } else {
      output += character;
    }
  }
  return output;
}

function validPublicMessage(value) {
  const message = exactObject(value, [
    'id', 'ts', 'byline', 'kind', 'session', 'text', 'product',
    'product_provenance', 'delivery',
  ]);
  if (!message || !Number.isSafeInteger(message.id) || message.id < 1 ||
      !Number.isSafeInteger(message.ts) || message.ts < 0 ||
      typeof message.byline !== 'string' || message.byline.length === 0 ||
      (message.kind !== 'person' && message.kind !== 'seat') ||
      (message.kind === 'seat'
        ? !(message.session === null ||
          (Number.isSafeInteger(message.session) && message.session > 0))
        : message.session !== null) ||
      typeof message.text !== 'string' || message.text.length === 0 ||
      !Array.isArray(message.delivery) || message.delivery.length > 32 ||
      (message.kind === 'seat' ? typeof message.product !== 'string' : message.product !== null) ||
      (message.kind === 'seat'
        ? (message.product_provenance !== 'client-reported' &&
          message.product_provenance !== 'adapter-reported')
        : message.product_provenance !== null)) return false;
  return message.delivery.every(row => {
    const delivery = exactObject(row, ['name', 'session', 'acknowledged_at']);
    return delivery && typeof delivery.name === 'string' && delivery.name.length > 0 &&
      (delivery.session === null ||
        (Number.isSafeInteger(delivery.session) && delivery.session > 0)) &&
      (delivery.acknowledged_at === null ||
        (Number.isSafeInteger(delivery.acknowledged_at) && delivery.acknowledged_at >= 0));
  });
}

function validPage(result, after) {
  const page = exactObject(result, [
    'ok', 'messages', 'cursor', 'timed_out', 'connection_session',
  ]);
  if (!page || page.ok !== true || !Array.isArray(page.messages) ||
      page.messages.length > HISTORY_LIMIT ||
      !Number.isSafeInteger(page.cursor) || page.cursor < after ||
      typeof page.timed_out !== 'boolean' ||
      !(page.connection_session === null ||
        (Number.isSafeInteger(page.connection_session) && page.connection_session > 0)) ||
      !page.messages.every(validPublicMessage)) return false;
  let prior = after;
  for (const message of page.messages) {
    if (message.id <= prior || message.id > page.cursor) return false;
    prior = message.id;
  }
  return true;
}

function renderMessages(stdout, messages) {
  stdout.write(renderedMessages(messages));
}

function formatMessageTime(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) return '';
  const iso = new Date(ts).toISOString();
  if (!iso.endsWith('Z')) return '';
  return iso.slice(0, 19).replace('T', ' ') + ' UTC';
}

function renderedMessages(messages) {
  let output = '';
  for (const message of messages) {
    const metadata = [];
    if (message.kind === 'seat' && message.product) {
      metadata.push(`${terminalSafe(message.product)}, ${message.product_provenance}`);
    }
    if (message.session !== null) metadata.push(`Session ${message.session}`);
    const suffix = metadata.length > 0 ? ` (${metadata.join(' · ')})` : '';
    const when = formatMessageTime(message.ts);
    output += `[${message.id}] ${terminalSafe(message.byline)}${suffix}:${when ? ` ${when}` : ''}\n`;
    output += `${terminalSafe(message.text, true)}\n`;
  }
  return output;
}

function validHead(result) {
  const page = exactObject(result, ['ok', 'head', 'connection_session']);
  return page && page.ok === true && Number.isSafeInteger(page.head) && page.head >= 0 &&
    (page.connection_session === null ||
      (Number.isSafeInteger(page.connection_session) && page.connection_session > 0));
}

function readOutput(parsed, page) {
  return parsed.json ? JSON.stringify(page) + '\n' : renderedMessages(page.messages);
}

function writeReadOutput(stdout, parsed, page) {
  stdout.write(readOutput(parsed, page));
}

async function localRequest(fetcher, profile, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || COMMAND_FETCH_TIMEOUT_MS);
  const headers = { authorization: 'Bearer ' + profile.token };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  try {
    const response = await fetcher(profile.server_url + pathname, {
      method: options.method || 'GET', headers, body, signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) throw responseError(result, response.status);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function selectedConnection(name, dependencies = {}) {
  const profileModule = dependencies.profiles || require('./client/profiles.js');
  if (!profileModule.validName(name)) {
    const error = new Error('invalid connection name');
    error.code = 'invalid-name';
    throw error;
  }
  const config = dependencies.config || require('./config.js');
  const connectionDir = config.resolveConnectionDir({
    env: dependencies.env || process.env,
    platform: dependencies.platform || process.platform,
    homedir: dependencies.homedir,
  });
  const profiles = profileModule.openProfiles({ connectionDir });
  const profile = profiles.load(name);
  if (profile.state !== 'admitted') {
    const error = new Error('connection not admitted');
    error.code = 'not-admitted';
    throw error;
  }
  return Object.freeze({ profile, profiles });
}

function reportConnectionError(stderr, error, name) {
  if (error && error.code === 'profile-not-found') {
    line(stderr, `interlock: no local connection named ${terminalSafe(name)}; run "interlock join" for a new AI session.`);
  } else if (error && error.code === 'not-admitted') {
    line(stderr, `interlock: connection ${terminalSafe(name)} has not been allowed by the owner.`);
  } else if (error && error.code === 'invalid-name') {
    line(stderr, 'interlock: the connection name is invalid.');
  } else {
    line(stderr, 'interlock: the selected connection profile could not be read safely.');
  }
}

function reportRequestError(stderr, error, profile) {
  if (error && error.status === 401) {
    line(stderr, `interlock: connection ${terminalSafe(profile.name)} was refused; it may be expired or revoked.`);
  } else if (error && error.name === 'AbortError') {
    line(stderr, 'interlock: the local Interlock request timed out; run the command again.');
  } else if (error && error.code === 'incompatible-response') {
    line(stderr, 'interlock: the local Interlock answered, but its response does not match this CLI version; use the command from the same Interlock release as the running room.');
  } else if (error && Number.isSafeInteger(error.status)) {
    line(stderr, 'interlock: the local Interlock refused the command.');
  } else {
    line(stderr, `interlock: could not reach ${profile.server_url}; make sure Interlock is running.`);
  }
}

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function executeReadCommand(command, parsed, profile, profiles, io, dependencies) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const wait = command === 'listen';
  let page;
  try {
    page = await localRequest(fetcher, profile,
      `/api/ai/messages?after=${profile.cursor}&limit=${HISTORY_LIMIT}&wait=${wait ? 1 : 0}`,
      { timeoutMs: wait ? LISTEN_FETCH_TIMEOUT_MS : COMMAND_FETCH_TIMEOUT_MS });
    if (!validPage(page, profile.cursor)) throw incompatibleResponse();
  } catch (error) {
    reportRequestError(io.stderr, error, profile);
    return EXIT_RUNTIME;
  }

  const receiptIds = page.messages.filter(message => message.delivery.some(delivery =>
    delivery.name === profile.name && delivery.session === page.connection_session &&
    delivery.acknowledged_at === null)).map(message => message.id);
  if (receiptIds.length > 0) {
    try {
      const receipt = await localRequest(fetcher, profile, '/api/ai/receipts', {
        method: 'POST', body: { message_ids: receiptIds }, timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
      });
      if (!exactObject(receipt, ['ok', 'acknowledged', 'added']) ||
          receipt.acknowledged !== receiptIds.length || !Number.isSafeInteger(receipt.added)) {
        throw new Error('malformed receipt');
      }
    } catch (_) {
      if (parsed.json) line(io.stdout, JSON.stringify(page));
      else renderMessages(io.stdout, page.messages);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }
  try {
    profiles.updateCursor(profile.name, profile.request_id, page.cursor);
  } catch (_) {
    if (parsed.json) line(io.stdout, JSON.stringify(page));
    else renderMessages(io.stdout, page.messages);
    line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
    return EXIT_RUNTIME;
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(page));
  } else if (page.messages.length > 0) {
    renderMessages(io.stdout, page.messages);
  } else if (wait) {
    line(io.stdout, `Nothing yet — run \`interlock listen --connection ${profile.name}\` again.`);
  } else {
    line(io.stdout, 'No new messages.');
  }
  return EXIT_OK;
}

async function executeDrainHistory(parsed, profile, profiles, io, dependencies) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const messages = [];
  let cursor = profile.cursor;
  let connectionSession;

  function batch(extraMessages = [], nextCursor = cursor, nextSession = connectionSession) {
    return Object.freeze({
      ok: true,
      messages: Object.freeze([...messages, ...extraMessages]),
      cursor: nextCursor,
      timed_out: false,
      connection_session: nextSession === undefined ? null : nextSession,
    });
  }

  function output(page) {
    writeReadOutput(io.stdout, parsed, page);
  }

  for (let index = 0; index < HISTORY_DRAIN_MESSAGES; index += 1) {
    let page;
    try {
      page = await localRequest(fetcher, profile,
        `/api/ai/messages?after=${cursor}&limit=${HISTORY_LIMIT}&wait=0`,
        { timeoutMs: COMMAND_FETCH_TIMEOUT_MS });
      if (!validPage(page, cursor) ||
          (connectionSession !== undefined &&
            page.connection_session !== connectionSession)) throw incompatibleResponse();
    } catch (error) {
      if (messages.length > 0) output(batch());
      reportRequestError(io.stderr, error, profile);
      return EXIT_RUNTIME;
    }

    if (page.messages.length === 0) {
      if (page.cursor > cursor) {
        try {
          profiles.updateCursor(profile.name, profile.request_id, page.cursor);
          cursor = page.cursor;
        } catch (_) {
          if (messages.length > 0) output(batch());
          line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
          return EXIT_RUNTIME;
        }
      }
      const completed = batch([], cursor,
        connectionSession === undefined ? page.connection_session : connectionSession);
      if (completed.messages.length > 0 || parsed.json) output(completed);
      else line(io.stdout, 'No new messages.');
      return EXIT_OK;
    }

    const candidate = batch(page.messages, page.cursor, page.connection_session);
    const candidateBytes = Buffer.byteLength(readOutput(parsed, candidate), 'utf8');
    if (messages.length > 0 && candidateBytes > HISTORY_DRAIN_BYTES) {
      output(batch());
      return EXIT_OK;
    }

    const receiptIds = page.messages.filter(message => message.delivery.some(delivery =>
      delivery.name === profile.name && delivery.session === page.connection_session &&
      delivery.acknowledged_at === null)).map(message => message.id);
    if (receiptIds.length > 0) {
      try {
        const receipt = await localRequest(fetcher, profile, '/api/ai/receipts', {
          method: 'POST', body: { message_ids: receiptIds }, timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
        });
        if (!exactObject(receipt, ['ok', 'acknowledged', 'added']) ||
            receipt.acknowledged !== receiptIds.length || !Number.isSafeInteger(receipt.added)) {
          throw new Error('malformed receipt');
        }
      } catch (_) {
        output(candidate);
        line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
        return EXIT_RUNTIME;
      }
    }
    try {
      profiles.updateCursor(profile.name, profile.request_id, page.cursor);
    } catch (_) {
      output(candidate);
      line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
      return EXIT_RUNTIME;
    }

    messages.push(...page.messages);
    cursor = page.cursor;
    connectionSession = page.connection_session;
    if (candidateBytes >= HISTORY_DRAIN_BYTES) {
      output(batch());
      return EXIT_OK;
    }
  }

  output(batch());
  return EXIT_OK;
}

async function executeSkipToCurrent(parsed, profile, profiles, io, dependencies) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const from = profile.cursor;
  let result;
  try {
    result = await localRequest(fetcher, profile, '/api/ai/head', {
      timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
    });
    if (!validHead(result)) throw incompatibleResponse();
  } catch (error) {
    reportRequestError(io.stderr, error, profile);
    return EXIT_RUNTIME;
  }

  let cursor = from;
  if (result.head > from) {
    try {
      profiles.updateCursor(profile.name, profile.request_id, result.head);
      cursor = result.head;
    } catch (_) {
      line(io.stderr, 'interlock: the current tip was read, but the local cursor could not be saved; run the command again.');
      return EXIT_RUNTIME;
    }
  }

  const page = Object.freeze({
    ok: true,
    from,
    head: result.head,
    cursor,
    connection_session: result.connection_session,
  });
  if (parsed.json) {
    line(io.stdout, JSON.stringify(page));
    return EXIT_OK;
  }
  if (result.head < from) {
    line(io.stdout,
      `Current tip is ${result.head}; local cursor ${from} is ahead. Skip does not move backward.`);
  } else if (cursor === from) {
    line(io.stdout, `Already at current (cursor ${from}).`);
  } else {
    line(io.stdout,
      `Skipped to current (cursor ${from} → ${cursor}). The gap was not fetched and was not marked delivered.`);
  }
  return EXIT_OK;
}

function validPeek(result) {
  const page = exactObject(result, [
    'ok', 'messages', 'next_before', 'first_id', 'searched_from', 'searched_to',
    'complete', 'connection_session',
  ]);
  if (!page || page.ok !== true || !Array.isArray(page.messages) ||
      page.messages.length > HISTORY_PEEK_LIMIT ||
      !Number.isSafeInteger(page.first_id) || page.first_id < 1 ||
      !Number.isSafeInteger(page.searched_from) ||
      !Number.isSafeInteger(page.searched_to) ||
      typeof page.complete !== 'boolean' ||
      !(page.next_before === null ||
        (Number.isSafeInteger(page.next_before) && page.next_before >= 1)) ||
      page.complete !== (page.next_before === null) ||
      !(page.connection_session === null ||
        (Number.isSafeInteger(page.connection_session) && page.connection_session > 0)) ||
      !page.messages.every(validPublicMessage)) return false;
  return true;
}

function peekPath(parsed) {
  const params = [];
  if (parsed.find !== null) params.push('find=' + encodeURIComponent(parsed.find));
  if (parsed.before !== null) params.push('before=' + parsed.before);
  params.push('limit=' + HISTORY_PEEK_LIMIT);
  return '/api/ai/peek?' + params.join('&');
}

async function executePeekHistory(parsed, profile, profiles, io, dependencies) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  let page;
  try {
    page = await localRequest(fetcher, profile, peekPath(parsed), {
      timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
    });
    if (!validPeek(page)) throw incompatibleResponse();
  } catch (error) {
    reportRequestError(io.stderr, error, profile);
    return EXIT_RUNTIME;
  }

  const receiptIds = page.messages.filter(message => message.delivery.some(delivery =>
    delivery.name === profile.name && delivery.session === page.connection_session &&
    delivery.acknowledged_at === null)).map(message => message.id);
  if (receiptIds.length > 0) {
    try {
      const receipt = await localRequest(fetcher, profile, '/api/ai/receipts', {
        method: 'POST', body: { message_ids: receiptIds }, timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
      });
      if (!exactObject(receipt, ['ok', 'acknowledged', 'added']) ||
          receipt.acknowledged !== receiptIds.length || !Number.isSafeInteger(receipt.added)) {
        throw new Error('malformed receipt');
      }
    } catch (_) {
      if (parsed.json) line(io.stdout, JSON.stringify(page));
      else renderMessages(io.stdout, page.messages);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(page));
    return EXIT_OK;
  }
  if (page.messages.length > 0) renderMessages(io.stdout, page.messages);
  const range = `Searched #${page.searched_from}–#${page.searched_to}.`;
  if (page.complete) line(io.stdout, `${range} Complete.`);
  else line(io.stdout, `${range} Continue with --before ${page.next_before}.`);
  return EXIT_OK;
}

async function runReadCommand(command, args, io, dependencies = {}) {
  const parsed = commandOptions(command, args);
  if (!parsed) {
    line(io.stderr, `interlock: usage: interlock ${command} --connection NAME${command === 'history' ? ' [--drain | --skip-to-current | --before N | --find TEXT]' : ''} [--json]`);
    return EXIT_USAGE;
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const { profile, profiles } = selected;
  const clock = dependencies.clock || Date.now;
  if (profile.expires_at <= clock()) {
    line(io.stderr, `interlock: connection ${terminalSafe(profile.name)} has expired; run "interlock join" for a new session.`);
    return EXIT_RUNTIME;
  }
  let readLease;
  try {
    readLease = profiles.acquireReadLease(profile.name);
  } catch (error) {
    if (error && error.code === 'reader-active') {
      line(io.stderr, `interlock: connection ${terminalSafe(profile.name)} is already being read by another history/listen process; stop the previous command before starting another.`);
    } else {
      line(io.stderr, `interlock: could not reserve connection ${terminalSafe(profile.name)} for reading safely.`);
    }
    return EXIT_RUNTIME;
  }

  let result;
  try {
    result = command === 'history' && parsed.skipToCurrent
      ? await executeSkipToCurrent(parsed, profile, profiles, io, dependencies)
      : command === 'history' && parsed.drain
        ? await executeDrainHistory(parsed, profile, profiles, io, dependencies)
        : command === 'history' && (parsed.before !== null || parsed.find !== null)
          ? await executePeekHistory(parsed, profile, profiles, io, dependencies)
          : await executeReadCommand(command, parsed, profile, profiles, io, dependencies);
  } finally {
    try { readLease.release(); }
    catch (_) {
      line(io.stderr, `interlock: connection ${terminalSafe(profile.name)} read lock could not be released safely.`);
      result = EXIT_RUNTIME;
    }
  }
  return result;
}

async function runSay(args, io, dependencies = {}) {
  const parsed = commandOptions('say', args);
  if (!parsed) return refuseSay(io.stderr);
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const { profile } = selected;
  const clock = dependencies.clock || Date.now;
  if (profile.expires_at <= clock()) {
    line(io.stderr, `interlock: connection ${terminalSafe(profile.name)} has expired; run "interlock join" for a new session.`);
    return EXIT_RUNTIME;
  }
  let text;
  try {
    text = parsed.source.kind === 'file'
      ? (dependencies.readFile || fs.readFileSync)(parsed.source.path, 'utf8')
      : await (dependencies.readStdin || readStdin)(io.stdin || process.stdin);
  } catch (_) {
    line(io.stderr, `interlock: could not read the ${parsed.source.kind === 'file' ? 'message file' : 'piped message'} safely.`);
    return EXIT_RUNTIME;
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  const body = { text, client_message_id: crypto.randomUUID() };
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await localRequest(fetcher, profile, '/api/ai/messages', {
        method: 'POST', body, timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
      });
      break;
    } catch (error) {
      if (attempt === 0 && !Number.isSafeInteger(error && error.status)) continue;
      reportRequestError(io.stderr, error, profile);
      return EXIT_RUNTIME;
    }
  }
  if (!exactObject(result, ['ok', 'message']) || !validPublicMessage(result.message)) {
    line(io.stdout, 'Message accepted by the local Interlock, but its receipt does not match this CLI version. Do not retry; use the command from the same Interlock release as the running room.');
    return EXIT_OK;
  }
  if (parsed.json) line(io.stdout, JSON.stringify(result));
  else line(io.stdout, `Sent as ${profile.name} (message ${result.message.id}).`);
  return EXIT_OK;
}

async function runLeave(args, io, dependencies = {}) {
  const parsed = commandOptions('leave', args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock leave --connection NAME [--json]');
    return EXIT_USAGE;
  }
  const policyMod = dependencies.codexPolicy || require('./codex_policy.js');
  try {
    policyMod.removePolicy({
      connection: parsed.connection,
      env: dependencies.env || process.env,
      homedir: dependencies.homedir || os.homedir(),
      fs: dependencies.fs || fs,
      codexHome: dependencies.codexHome,
    });
  } catch (error) {
    if (error && error.code === 'not-installed') {
      /* no owned policy for this name */
    } else {
      return reportCodexPolicyError(io.stderr, error);
    }
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const { profile, profiles } = selected;
  const fetcher = dependencies.fetch || globalThis.fetch;
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/leave', {
      method: 'POST', body: {}, timeoutMs: COMMAND_FETCH_TIMEOUT_MS,
    });
    if (!exactObject(result, ['ok', 'name', 'ended_how']) || result.ok !== true ||
        result.name !== profile.name || result.ended_how !== 'left') {
      throw incompatibleResponse();
    }
  } catch (error) {
    if (!(error && error.status === 401 && error.exact)) {
      reportRequestError(io.stderr, error, profile);
      line(io.stderr, 'The local profile was kept; run leave again after Interlock is reachable.');
      return EXIT_RUNTIME;
    }
  }
  try { profiles.forgetAdmitted(profile.name); }
  catch (_) {
    line(io.stderr, 'interlock: the selected local connection could not be forgotten safely.');
    return EXIT_RUNTIME;
  }
  if (parsed.json) {
    line(io.stdout, JSON.stringify({ ok: true, connection: profile.name, ended_how: 'left' }));
  } else {
    line(io.stdout, `Left the room as ${profile.name}. The name is free for a later knock.`);
    line(io.stdout, 'Stop any listener for this connection.');
  }
  return EXIT_OK;
}

async function knock(fetcher, serverUrl, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOIN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(serverUrl + '/api/ai/admissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'unavailable' }));
    if (!response.ok || result.ok !== true) throw responseError(result, response.status);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectCandidate(fetcher, serverUrl, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOIN_CONFIRM_TIMEOUT_MS);
  try {
    const response = await fetcher(serverUrl + '/api/ai/session', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({ ok: false }));
    if (!response.ok || result.ok !== true) throw responseError(result, response.status);
    return result.connection;
  } finally {
    clearTimeout(timer);
  }
}

async function candidateConfirmation(fetcher, serverUrl, profile) {
  try {
    const connected = await inspectCandidate(fetcher, serverUrl, profile.token);
    return Object.freeze({
      connected: validConnection(connected, profile) ? connected : null,
      exactInvalid: false,
    });
  } catch (error) {
    return Object.freeze({
      connected: null,
      exactInvalid: Boolean(error && error.status === 401 &&
        error.code === 'invalid-connection' && error.exact),
    });
  }
}

function validConnection(value, profile) {
  const connection = exactObject(value, [
    'subject_id', 'name', 'product', 'product_provenance', 'expires_at',
  ]);
  return connection && typeof connection.subject_id === 'string' &&
    connection.subject_id.length > 0 && connection.name === profile.name &&
    connection.product === profile.product &&
    connection.product_provenance === profile.product_provenance &&
    Number.isSafeInteger(connection.expires_at) && connection.expires_at > profile.created_at;
}

async function confirmCandidate(fetcher, serverUrl, profile) {
  return (await candidateConfirmation(fetcher, serverUrl, profile)).connected;
}

function admissionBody(profile) {
  return {
    request_id: profile.request_id,
    name: profile.name,
    product: profile.product,
    product_provenance: profile.product_provenance,
    selector: profile.selector,
    digest: profile.digest,
  };
}

function joinedOutput(stdout, profile, start = 'tip') {
  line(stdout, `Connected as ${profile.name} (${profile.product}).`);
  line(stdout, 'Use this exact connection name for every command in this conversation:');
  line(stdout, `  interlock history --connection ${profile.name} --drain`);
  line(stdout, `  interlock history --connection ${profile.name} --skip-to-current`);
  line(stdout, `  interlock say --connection ${profile.name} --file PATH`);
  line(stdout, `  interlock listen --connection ${profile.name}`);
  line(stdout, 'The contract for staying reachable:');
  line(stdout, '  listen returns after one message or about a minute; run it again every');
  line(stdout, '  time. A listener that is not re-armed is deaf.');
  line(stdout, '  Catch up with history --drain, repeated until it reports no new');
  line(stdout, '  messages. In a script, add --json and loop until "messages" is empty.');
  if (start === 'beginning') {
    line(stdout, '  Could not read the current tip; this seat starts at the beginning of');
    line(stdout, '  the transcript. Catch up with history --drain, or skip later.');
  } else {
    line(stdout, '  Your seat starts at the room\'s current moment. Earlier history exists;');
    line(stdout, '  read what the task needs - the Guide covers it.');
    line(stdout, '  Skip with history --skip-to-current; that is not a read and does not');
    line(stdout, '  mark the gap delivered.');
  }
  line(stdout, '  Run one history or listen at a time for this connection.');
  line(stdout, '  The full shared guide is GUIDE.md, served at /help on the room address.');
}

async function applyAdmissionHead(fetcher, profile, profiles) {
  if (typeof fetcher !== 'function') return 'beginning';
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/head', {
      timeoutMs: JOIN_CONFIRM_TIMEOUT_MS,
    });
    if (!validHead(result)) return 'beginning';
    if (result.head > profile.cursor) {
      profiles.updateCursor(profile.name, profile.request_id, result.head);
    }
    return 'tip';
  } catch (_) {
    return 'beginning';
  }
}

async function completeJoin(profiles, profile, enrollment, clock, stdout, staged, fetcher) {
  const admit = staged ? profiles.markStagedAdmitted : profiles.markAdmitted;
  const admitted = admit(profile.name, Object.assign(
    { request_id: profile.request_id, admitted_at: clock() },
    enrollment,
  ));
  const start = await applyAdmissionHead(fetcher, admitted, profiles);
  joinedOutput(stdout, start === 'tip' ? profiles.load(profile.name) : admitted, start);
}

function completedJoinDecision(code) {
  return Object.freeze({ action: 'done', code });
}

async function reconnectStaged(profiles, profile, product, serverUrl, fetcher, clock, io) {
  if (profile.product !== product || profile.product_provenance !== 'client-reported') {
    line(io.stderr, `interlock: the unfinished candidate ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.product)}, not ${terminalSafe(product)}. It was kept and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.server_url !== serverUrl) {
    line(io.stderr, `interlock: the unfinished candidate ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.server_url)}, not this Interlock. It was kept and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  const confirmation = await candidateConfirmation(fetcher, serverUrl, profile);
  if (confirmation.connected) {
    await completeJoin(profiles, profile, confirmation.connected, clock, io.stdout, true, fetcher);
    return completedJoinDecision(EXIT_OK);
  }
  if (!confirmation.exactInvalid) {
    line(io.stderr, `interlock: the exact unfinished candidate ${terminalSafe(profile.name)} was not confirmed. It was kept and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  return Object.freeze({ action: 'resume', profile, staged: true });
}

async function reconnectExisting(profiles, profile, product, serverUrl, fetcher, clock, io) {
  if (profile.product !== product || profile.product_provenance !== 'client-reported') {
    line(io.stderr, `interlock: local connection ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.product)}, not ${terminalSafe(product)}. No new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.server_url !== serverUrl) {
    line(io.stderr, `interlock: local connection ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.server_url)}, not this Interlock. No new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.state !== 'admitted') {
    const confirmation = await candidateConfirmation(fetcher, serverUrl, profile);
    if (confirmation.connected) {
      await completeJoin(profiles, profile, confirmation.connected, clock, io.stdout, false, fetcher);
      return completedJoinDecision(EXIT_OK);
    }
    if (confirmation.exactInvalid) {
      return Object.freeze({ action: 'resume', profile, staged: false });
    }
    line(io.stderr, `interlock: the exact unfinished candidate ${terminalSafe(profile.name)} was not confirmed. It was kept and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.expires_at <= clock()) {
    return Object.freeze({ action: 'stage' });
  }

  let result;
  try {
    result = await localRequest(fetcher, profile, '/api/ai/session');
  } catch (error) {
    if (error && error.status === 401 && error.code === 'invalid-connection' && error.exact) {
      return Object.freeze({ action: 'stage' });
    }
    reportRequestError(io.stderr, error, profile);
    line(io.stderr, 'The local profile was kept, and no new admission was created.');
    return completedJoinDecision(EXIT_RUNTIME);
  }
  const connection = exactObject(result, ['ok', 'connection']) ? result.connection : null;
  if (!validConnection(connection, profile) ||
      connection.subject_id !== profile.subject_id ||
      connection.expires_at !== profile.expires_at) {
    line(io.stderr, `interlock: the server did not confirm the exact local connection ${terminalSafe(profile.name)}. The profile was kept, and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  joinedOutput(io.stdout, profile);
  return completedJoinDecision(EXIT_OK);
}

function removeJoinCandidate(profiles, profile, staged) {
  if (staged) profiles.removeStaged(profile.name, profile.request_id);
  else profiles.removeUnadmitted(profile.name, profile.request_id);
}

async function runJoin(args, io, dependencies = {}) {
  const { stdout, stderr } = io;
  const parsed = joinOptions(args);
  if (!parsed) {
    line(stderr, 'interlock: usage: interlock join [--product LABEL] [--name NAME] [--url LOOPBACK_URL]');
    return EXIT_USAGE;
  }
  const profileModule = dependencies.profiles || require('./client/profiles.js');
  if (!profileModule.validUrl(parsed.url)) {
    line(stderr, 'interlock: join accepts only a canonical http://localhost loopback URL.');
    return EXIT_USAGE;
  }
  const config = dependencies.config || require('./config.js');
  const identity = dependencies.identity || require('identity');
  const fetcher = dependencies.fetch || globalThis.fetch;
  const clock = dependencies.clock || Date.now;
  const sleep = dependencies.sleep || waitMs;
  if (typeof fetcher !== 'function') {
    line(stderr, 'interlock: this Node runtime does not provide the required local HTTP client.');
    return EXIT_RUNTIME;
  }
  let connectionDir;
  try {
    connectionDir = config.resolveConnectionDir({
      env: dependencies.env || process.env,
      platform: dependencies.platform || process.platform,
      homedir: dependencies.homedir,
    });
  } catch (_) {
    line(stderr, 'interlock: invalid connection directory; INTERLOCK_CONNECTION_DIR must be absolute.');
    return EXIT_USAGE;
  }
  let profiles;
  try { profiles = profileModule.openProfiles({ connectionDir }); }
  catch (_) {
    line(stderr, 'interlock: could not open the protected local connection directory.');
    return EXIT_RUNTIME;
  }

  let promptInterface = null;
  const ask = dependencies.ask || (async question => {
    if (!promptInterface) {
      promptInterface = readline.createInterface({
        input: io.stdin || process.stdin,
        output: io.stdout || process.stdout,
      });
    }
    return await promptInterface.question(question);
  });

  let product = parsed.product === null ? null : parsed.product.trim();
  let name = parsed.name === null ? null : parsed.name.trim();
  try {
    while (!profileModule.validProduct(product)) {
      if (parsed.product !== null) {
        line(stderr, 'interlock: product must be 1–40 printable characters.');
        return EXIT_USAGE;
      }
      product = String(await ask('AI product (for example Claude Code, Codex CLI, or Grok CLI): ')).trim();
    }

    if (name === null) {
      const local = profiles.summaries().filter(profile =>
        profile.product === product && profile.server_url === parsed.url);
      if (local.length > 0) {
        const now = clock();
        line(stdout, `Local connection names for ${terminalSafe(product)} on this computer:`);
        for (const profile of local) {
          const state = profile.state === 'admitted'
            ? (profile.expires_at <= now ? 'expired locally' : 'admitted locally')
            : 'not yet admitted';
          line(stdout, `  ${terminalSafe(profile.name)} (${state})`);
        }
        line(stdout, 'Choose one of those names to reconnect, or a new name for a separate AI session.');
      }
    }

    joinNameLoop: while (true) {
      while (!profileModule.validName(name)) {
        if (parsed.name !== null) {
          line(stderr, 'interlock: use 2–24 letters or digits, with single hyphens if needed.');
          return EXIT_USAGE;
        }
        if (name) {
          line(stderr, 'interlock: use 2–24 letters or digits, with single hyphens if needed.');
        }
        name = String(await ask('AI name for this room: ')).trim();
      }

      let profile = null;
      let staged = false;
      let resumed = false;
      if (profiles.stagedExists(name)) {
        const decision = await reconnectStaged(
          profiles, profiles.loadStaged(name), product, parsed.url, fetcher, clock, io);
        if (decision.action === 'done') return decision.code;
        profile = decision.profile;
        staged = decision.staged;
        resumed = true;
      }

      if (profile === null && profiles.exists(name)) {
        const decision = await reconnectExisting(
          profiles, profiles.load(name), product, parsed.url, fetcher, clock, io);
        if (decision.action === 'done') return decision.code;
        if (decision.action === 'resume') {
          profile = decision.profile;
          staged = decision.staged;
          resumed = true;
        } else {
          staged = true;
        }
      }

      if (profile === null) {
        const credential = identity.newAiCredential();
        const createdAt = clock();
        const candidateBody = {
          name,
          product,
          product_provenance: 'client-reported',
          server_url: parsed.url,
          request_id: crypto.randomUUID(),
          token: credential.token,
          selector: credential.selector,
          digest: credential.digest,
          created_at: createdAt,
        };
        profile = staged
          ? profiles.createStaged(candidateBody)
          : profiles.createUnadmitted(candidateBody);
      }
      let deadline = profile.created_at + JOIN_WINDOW_MS;
      let statedWaiting = false;
      let lastNetworkFailure = false;
      let honoredCooldown = false;
      let firstAttempt = resumed;

      while (firstAttempt || clock() < deadline) {
        firstAttempt = false;
        try {
          const result = await knock(fetcher, parsed.url, admissionBody(profile));
          lastNetworkFailure = false;
          if (result.state === 'waiting') {
            if (Number.isSafeInteger(result.expires_at) && result.expires_at > deadline) {
              deadline = result.expires_at;
            }
            const connected = await confirmCandidate(fetcher, parsed.url, profile);
            if (connected) {
              await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher);
              return EXIT_OK;
            }
            if (!statedWaiting) {
              line(stdout, `Waiting for the owner to allow ${profile.name}…`);
              statedWaiting = true;
            }
            continue;
          }
          if (result.state === 'allowed' && validConnection(result.enrollment, profile)) {
            await completeJoin(profiles, profile, result.enrollment, clock, stdout, staged, fetcher);
            return EXIT_OK;
          }
          if (result.state === 'declined' || result.state === 'expired') {
            removeJoinCandidate(profiles, profile, staged);
            if (resumed && result.state === 'expired') {
              line(stdout, 'The earlier join request is no longer waiting; starting a fresh knock.');
              continue joinNameLoop;
            }
            line(stderr, result.state === 'declined'
              ? 'interlock: the owner declined this connection.'
              : 'interlock: this join request expired before it was allowed.');
            return EXIT_RUNTIME;
          }
          throw responseError({ error: 'malformed-response' }, 200);
        } catch (error) {
          if (error.code === 'cooldown' && !honoredCooldown) {
            const retryAt = error.retry_after;
            const at = clock();
            if (Number.isSafeInteger(retryAt) && retryAt >= 0 && retryAt < deadline) {
              honoredCooldown = true;
              if (!statedWaiting) {
                line(stdout, 'Interlock is briefly cooling down this name; the fresh knock will retry automatically…');
                statedWaiting = true;
              }
              await sleep(Math.max(0, retryAt - at));
              statedWaiting = false;
              continue;
            }
          }
          if (resumed && ['name-taken', 'name-pending', 'cooldown', 'pending-cap',
            'request-id-collision', 'invalid-request', 'invalid-name'].includes(error.code)) {
            line(stderr, `interlock: the exact unfinished candidate ${terminalSafe(profile.name)} was not safely retired by Interlock. It was kept and no new admission was created.`);
            return EXIT_RUNTIME;
          }
          if (error.code === 'name-taken' || error.code === 'name-pending') {
            removeJoinCandidate(profiles, profile, staged);
            if (parsed.name !== null) {
              line(stderr, 'interlock: that name is already used or waiting in this Interlock.');
              return EXIT_RUNTIME;
            }
            line(stderr, 'interlock: that name is already used or waiting in this Interlock. Choose another.');
            name = null;
            break;
          }
          if (['cooldown', 'pending-cap', 'request-id-collision', 'invalid-request',
            'invalid-name'].includes(error.code)) {
            removeJoinCandidate(profiles, profile, staged);
            line(stderr, 'interlock: the server refused this join request; no connection was created.');
            return error.code === 'invalid-request' || error.code === 'invalid-name'
              ? EXIT_USAGE : EXIT_RUNTIME;
          }
          lastNetworkFailure = true;
          // The Allow commit can succeed even when its retained response is
          // disrupted. The candidate bearer is already local, so confirm only
          // that exact credential before waiting or knocking again.
          const connected = await confirmCandidate(fetcher, parsed.url, profile);
          if (connected) {
            await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher);
            return EXIT_OK;
          }
          if (!statedWaiting) {
            line(stdout, 'Waiting for Interlock and the owner…');
            statedWaiting = true;
          }
          await sleep(JOIN_RETRY_MS);
        }
      }

      if (name === null) continue;
      if (lastNetworkFailure) {
        const connected = await confirmCandidate(fetcher, parsed.url, profile);
        if (connected) {
          await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher);
          return EXIT_OK;
        }
        line(stderr, 'interlock: the join result could not be confirmed. The unadmitted candidate was kept for diagnosis, not adopted by another join.');
        return EXIT_RUNTIME;
      }
      removeJoinCandidate(profiles, profile, staged);
      line(stderr, 'interlock: this join request expired before it was allowed.');
      return EXIT_RUNTIME;
    }
  } catch (error) {
    if (error && error.code === 'profile-exists') {
      line(stderr, 'interlock: that connection profile appeared while joining; run join again and choose another name.');
      return EXIT_RUNTIME;
    }
    if (error && error.code === 'staged-profile-exists') {
      line(stderr, 'interlock: an unfinished candidate for that connection already exists; run join again and select that exact name to confirm it.');
      return EXIT_RUNTIME;
    }
    line(stderr, 'interlock: the AI connection could not be prepared safely.');
    return EXIT_RUNTIME;
  } finally {
    if (promptInterface) promptInterface.close();
  }
}

function waitForShutdown(options = {}) {
  const abortSignal = options.signal;
  return new Promise(resolve => {
    function cleanup() {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    }
    function finish(signal) {
      cleanup();
      resolve(signal);
    }
    function onInterrupt() { finish('SIGINT'); }
    function onTerminate() { finish('SIGTERM'); }
    function onAbort() { finish('runtime-error'); }
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function runStart(args, io, dependencies = {}) {
  const { stdout, stderr } = io;
  const requestedPort = startPort(args);
  if (requestedPort === null) {
    line(stderr, 'interlock: usage: interlock start [--port PORT]');
    return EXIT_USAGE;
  }
  const { resolveDataDir } = dependencies.config || require('./config.js');
  const { DEFAULT_PORT, startInterlockServer } = dependencies.server || require('./server.js');
  const wait = dependencies.waitForShutdown || waitForShutdown;
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const homedir = dependencies.homedir;
  const port = requestedPort === undefined ? DEFAULT_PORT : requestedPort;

  let dataDir;
  try {
    dataDir = resolveDataDir({ env, platform, homedir });
  } catch (_) {
    line(stderr, 'interlock: invalid data directory; INTERLOCK_DATA_DIR must be an absolute path.');
    return EXIT_USAGE;
  }

  let runtime;
  try {
    runtime = await startInterlockServer({ dataDir, port });
  } catch (error) {
    if (error && error.code === 'already-running') {
      line(stderr, 'interlock: this installation is already running.');
      line(stderr, 'Use the existing Interlock window or stop that process before starting another.');
      return EXIT_RUNTIME;
    }
    if (error && (error.code === 'owner-unverifiable' || error.code === 'corrupt-lock')) {
      line(stderr, 'interlock: instance ownership cannot be verified safely.');
      line(stderr, 'Do not delete the lock while another Interlock process may still be using this data.');
      return EXIT_RUNTIME;
    }
    line(stderr, `interlock: could not start safely on loopback port ${port}.`);
    line(stderr, 'Check whether the port is in use and whether the data directory needs attention.');
    return EXIT_RUNTIME;
  }

  line(stdout, 'Interlock is running.');
  if (runtime.recoveredStaleLock === true) {
    line(stdout, 'Recovered the ownership record left by a stopped Interlock process.');
  }
  line(stdout, `Open: ${runtime.url}`);
  line(stdout, `Data: ${runtime.dataDir}`);
  line(stdout, 'Press Ctrl+C to stop.');

  const controller = new AbortController();
  const stopped = Promise.resolve().then(() => wait({ signal: controller.signal }))
    .then(signal => ({ kind: 'signal', signal }), error => ({ kind: 'wait-error', error }));
  const failed = runtime.failure && typeof runtime.failure.then === 'function'
    ? runtime.failure.then(error => ({ kind: 'server-error', error }))
    : new Promise(() => {});
  const outcome = await Promise.race([stopped, failed]);
  controller.abort();
  let runtimeHealthy = true;
  if (outcome.kind === 'server-error') {
    runtimeHealthy = false;
    line(stderr, 'interlock: the loopback server stopped unexpectedly.');
  } else if (outcome.kind === 'wait-error') {
    runtimeHealthy = false;
    line(stderr, 'interlock: could not monitor the shutdown signal safely.');
  }
  let closedCleanly = true;
  try { await runtime.close(); } catch (_) { closedCleanly = false; }
  if (!closedCleanly) {
    line(stderr, 'interlock: shutdown did not complete cleanly.');
  }
  if (!runtimeHealthy || !closedCleanly) return EXIT_RUNTIME;
  line(stdout, 'Interlock stopped.');
  return EXIT_OK;
}

async function runRecover(args, io, dependencies = {}) {
  const { stdout, stderr } = io;
  const requestedPort = startPort(args);
  if (requestedPort === null) {
    line(stderr, 'interlock: usage: interlock recover [--port PORT]');
    return EXIT_USAGE;
  }
  const { resolveDataDir } = dependencies.config || require('./config.js');
  const { DEFAULT_PORT, startRecoveryServer } = dependencies.recovery || require('./recovery.js');
  const wait = dependencies.waitForShutdown || waitForShutdown;
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const homedir = dependencies.homedir;
  const port = requestedPort === undefined ? DEFAULT_PORT : requestedPort;

  let dataDir;
  try {
    dataDir = resolveDataDir({ env, platform, homedir });
  } catch (_) {
    line(stderr, 'interlock: invalid data directory; INTERLOCK_DATA_DIR must be an absolute path.');
    return EXIT_USAGE;
  }

  let runtime;
  try {
    runtime = await startRecoveryServer({ dataDir, port });
  } catch (error) {
    if (error && error.code === 'already-running') {
      line(stderr, 'interlock: stop Interlock before recovering the owner sign-in.');
      return EXIT_RUNTIME;
    }
    if (error && (error.code === 'owner-unverifiable' || error.code === 'corrupt-lock')) {
      line(stderr, 'interlock: instance ownership cannot be verified safely; recovery did not start.');
      return EXIT_RUNTIME;
    }
    if (error && (error.code === 'data-dir-missing' || error.code === 'installation-missing' ||
        error.code === 'installation-invalid')) {
      line(stderr, 'interlock: no completed Interlock installation was found at the configured data directory.');
      return EXIT_RUNTIME;
    }
    line(stderr, `interlock: owner recovery could not start safely on loopback port ${port}.`);
    line(stderr, 'Check whether the port is in use and whether the Interlock data directory is intact.');
    return EXIT_RUNTIME;
  }

  line(stdout, 'Interlock owner recovery is running.');
  if (runtime.recoveredStaleLock === true) {
    line(stdout, 'Recovered the ownership record left by a stopped Interlock process.');
  }
  line(stdout, `Open: ${runtime.url}`);
  line(stdout, 'This replaces the owner password and passkey and revokes every old owner session.');
  line(stdout, 'Press Ctrl+C to cancel.');

  const controller = new AbortController();
  const stopped = Promise.resolve().then(() => wait({ signal: controller.signal }))
    .then(signal => ({ kind: 'signal', signal }), error => ({ kind: 'wait-error', error }));
  const completed = runtime.completed && typeof runtime.completed.then === 'function'
    ? runtime.completed.then(result => ({ kind: 'complete', result }))
    : new Promise(() => {});
  const failed = runtime.failure && typeof runtime.failure.then === 'function'
    ? runtime.failure.then(error => ({ kind: 'server-error', error }))
    : new Promise(() => {});
  const outcome = await Promise.race([stopped, completed, failed]);
  controller.abort();

  let closedCleanly = true;
  try { await runtime.close(); } catch (_) { closedCleanly = false; }
  // close() drains an in-flight recovery request. Read status afterwards so a
  // Ctrl+C that narrowly wins Promise.race cannot make the CLI deny a durable
  // credential transaction that finished while the listeners were closing.
  let status = null;
  try { status = typeof runtime.status === 'function' ? runtime.status() : null; }
  catch (_) { status = null; }
  const replacementDurable = outcome.kind === 'complete' ||
    Boolean(status && status.completed === true);
  const auditReady = outcome.kind === 'complete' && outcome.result
    ? outcome.result.audit_ready
    : status && status.audit_ready;

  if (replacementDurable) {
    if (outcome.kind === 'complete' && auditReady === true && closedCleanly) {
      line(stdout, 'Owner recovery complete.');
      line(stdout, 'Starting normal Interlock on the same address.');
      line(stdout, 'The browser will show "Sign in to Interlock" when it is ready.');
      const startAfterRecovery = dependencies.startAfterRecovery || runStart;
      return await startAfterRecovery(['--port', String(port)], io, dependencies);
    }
    if (!closedCleanly) {
      line(stderr, 'interlock: the owner password and passkey were replaced, but recovery shutdown did not complete cleanly.');
    } else if (auditReady === false) {
      line(stderr, 'interlock: the owner password and passkey were replaced, but audit delivery did not finish.');
    } else if (auditReady === true) {
      line(stderr, 'interlock: the owner password and passkey were replaced, but the completion handoff was interrupted.');
    } else {
      line(stderr, 'interlock: the owner password and passkey were replaced, but final audit delivery could not be confirmed.');
    }
    line(stderr, 'Do not repeat recovery. Run "interlock start" and inspect any startup error.');
    return EXIT_RUNTIME;
  }
  if (!closedCleanly) {
    line(stderr, 'interlock: recovery shutdown did not complete cleanly.');
    return EXIT_RUNTIME;
  }
  if (outcome.kind === 'server-error') {
    line(stderr, 'interlock: the recovery-only loopback server stopped unexpectedly.');
    return EXIT_RUNTIME;
  }
  if (outcome.kind === 'wait-error') {
    line(stderr, 'interlock: could not monitor the recovery shutdown signal safely.');
    return EXIT_RUNTIME;
  }
  line(stdout, 'Owner recovery stopped without replacing the sign-in.');
  if (status && Number.isSafeInteger(status.capability_expires_at) &&
      status.capability_expires_at > Date.now()) {
    line(stdout, 'A started recovery window remains reserved until it expires (at most 15 minutes).');
  }
  return EXIT_OK;
}

function parseCodexPolicyArgs(args) {
  if (args.length === 0) return null;
  const action = args[0];
  if (action !== 'install' && action !== 'check' && action !== 'remove') return null;
  const options = { action, connection: null, mode: null, json: false, codexHome: null, checkerPath: null };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      if (action !== 'check' || seen.has(flag)) return null;
      seen.add(flag);
      options.json = true;
      continue;
    }
    if (flag === '--connection') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' ||
          args[index + 1].length === 0 || args[index + 1].startsWith('-')) return null;
      seen.add(flag);
      options.connection = args[index + 1];
      index += 1;
      continue;
    }
    if (flag === '--mode') {
      if (action !== 'install' || seen.has(flag) ||
          (args[index + 1] !== 'receive' && args[index + 1] !== 'participate')) {
        return null;
      }
      seen.add(flag);
      options.mode = args[index + 1];
      index += 1;
      continue;
    }
    if (flag === '--codex-home') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' ||
          args[index + 1].length === 0 || args[index + 1].startsWith('-') ||
          !path.isAbsolute(args[index + 1])) return null;
      seen.add(flag);
      options.codexHome = args[index + 1];
      index += 1;
      continue;
    }
    if (flag === '--codex-checker') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' ||
          args[index + 1].length === 0 || args[index + 1].startsWith('-') ||
          !path.isAbsolute(args[index + 1])) return null;
      seen.add(flag);
      options.checkerPath = args[index + 1];
      index += 1;
      continue;
    }
    return null;
  }
  if (options.connection === null) return null;
  if (action === 'install' && options.mode === null) return null;
  return Object.freeze(options);
}

async function confirmParticipate(name, io, dependencies) {
  if (typeof dependencies.confirmParticipate === 'function') {
    return dependencies.confirmParticipate(name);
  }
  line(io.stdout, `This lets Codex send any readable file through ${terminalSafe(name)} without per-message Auto-review, with no payload inspection, classification, redaction, or restriction.`);
  line(io.stdout, 'Type PARTICIPATE to confirm.');
  const rl = readline.createInterface({
    input: io.stdin || process.stdin,
    output: io.stdout,
  });
  try {
    const answer = String(await rl.question('> ')).trim();
    return answer === 'PARTICIPATE';
  } finally {
    rl.close();
  }
}

function reportCodexPolicyError(stderr, error) {
  const code = error && error.code;
  if (code === 'ambiguous-codex-home' || code === 'invalid-codex-home') {
    line(stderr, 'interlock: Codex home is not certain; pass --codex-home ABSOLUTE_PATH on the same OS as Codex Desktop.');
    return EXIT_USAGE;
  }
  if (code === 'ambiguous-codex-checker') {
    line(stderr, 'interlock: multiple Codex checkers found; pass --codex-checker ABSOLUTE_PATH for the active engine.');
    return EXIT_USAGE;
  }
  if (code === 'ambiguous-codex-node' || code === 'invalid-node' || code === 'invalid-script') {
    line(stderr, 'interlock: cannot pin the Codex Node executable and Interlock script as absolute files.');
    return EXIT_RUNTIME;
  }
  if (code === 'owned-file-modified') {
    line(stderr, 'interlock: the Interlock-owned Codex policy file was edited; refusing to overwrite or remove it.');
    return EXIT_RUNTIME;
  }
  if (code === 'execpolicy-unavailable') {
    line(stderr, 'interlock: Codex execpolicy is unavailable or unsupported. The policy is not active.');
    line(stderr, 'Install a Codex release that provides `codex execpolicy check`, then rerun. Until then, add the printed rules by hand only as a last resort.');
    return EXIT_RUNTIME;
  }
  if (code === 'execpolicy-rejected' || code === 'execpolicy-too-broad') {
    line(stderr, 'interlock: Codex execpolicy did not accept the generated rules. The policy is not active.');
    return EXIT_RUNTIME;
  }
  if (code === 'not-installed') {
    line(stderr, 'interlock: no Interlock-owned Codex policy is installed.');
    return EXIT_RUNTIME;
  }
  if (code === 'connection-mismatch') {
    line(stderr, 'interlock: the installed policy is for a different connection name.');
    return EXIT_RUNTIME;
  }
  if (code === 'invalid-connection' || code === 'invalid-mode') {
    line(stderr, 'interlock: usage: interlock codex-policy install --connection NAME --mode receive|participate');
    return EXIT_USAGE;
  }
  line(stderr, 'interlock: Codex policy could not be applied safely.');
  if (error && error.code) line(stderr, `interlock: ${error.code}`);
  return EXIT_RUNTIME;
}

function printPolicyReceipt(stdout, receipt) {
  line(stdout, `Policy file: ${receipt.path}`);
  line(stdout, `Mode: ${receipt.mode}`);
  line(stdout, `Connection: ${receipt.connection}`);
  if (receipt.replacedConnection) {
    line(stdout, `Replaced Interlock policy for ${receipt.replacedConnection}. Only one connection is trusted at a time.`);
  }
  line(stdout, `Argv: ${JSON.stringify(receipt.historyArgv)}`);
  if (receipt.sayArgv) line(stdout, `Argv: ${JSON.stringify(receipt.sayArgv)}`);
  line(stdout, 'Syntax check only. Codex loads every rules layer and the most restrictive match wins; this does not prove the command will run without review.');
  line(stdout, 'Restart Codex Desktop. Activation stays unknown until you observe an unreviewed canonical command after that restart.');
  line(stdout, `Check argv: ${JSON.stringify(receipt.checkCommand)}`);
  line(stdout, `Remove argv: ${JSON.stringify(receipt.removeCommand)}`);
}

async function runCodexPolicy(args, io, dependencies = {}) {
  const parsed = parseCodexPolicyArgs(args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock codex-policy install --connection NAME --mode receive|participate');
    line(io.stderr, '       interlock codex-policy check --connection NAME [--json]');
    line(io.stderr, '       interlock codex-policy remove --connection NAME');
    return EXIT_USAGE;
  }
  if (parsed.action === 'install') {
    try { selectedConnection(parsed.connection, dependencies); } catch (error) {
      reportConnectionError(io.stderr, error, parsed.connection);
      return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
    }
  } else if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(parsed.connection) ||
      parsed.connection.length < 2 || parsed.connection.length > 24 ||
      parsed.connection.toLowerCase() === 'all') {
    line(io.stderr, 'interlock: usage: interlock codex-policy check --connection NAME [--json]');
    return EXIT_USAGE;
  }
  if (parsed.action === 'install' && parsed.mode === 'participate') {
    const confirmed = await confirmParticipate(parsed.connection, io, dependencies);
    if (!confirmed) {
      line(io.stderr, 'interlock: participate mode was not confirmed; no policy was written.');
      return EXIT_USAGE;
    }
  }
  const policy = dependencies.codexPolicy || require('./codex_policy.js');
  const shared = {
    connection: parsed.connection,
    mode: parsed.mode,
    codexHome: parsed.codexHome,
    env: dependencies.env || process.env,
    platform: dependencies.platform || process.platform,
    homedir: dependencies.homedir || os.homedir(),
    execPath: dependencies.execPath || process.execPath,
    fs: dependencies.fs || fs,
    nodePath: dependencies.codexNodePath,
    scriptPath: dependencies.interlockScriptPath,
    checkerPath: parsed.checkerPath || dependencies.codexCheckerPath,
    spawnSync: dependencies.spawnSync,
    checkExecpolicy: dependencies.checkExecpolicy,
    executionHost: dependencies.executionHost,
    requestId: null,
    subjectId: null,
  };
  if (parsed.action === 'install') {
    const selected = selectedConnection(parsed.connection, dependencies);
    shared.requestId = selected.profile.request_id;
    shared.subjectId = selected.profile.subject_id;
  }
  try {
    if (parsed.action === 'install') {
      const receipt = policy.installPolicy(shared);
      printPolicyReceipt(io.stdout, receipt);
      return EXIT_OK;
    }
    if (parsed.action === 'check') {
      const receipt = policy.checkPolicy(shared);
      if (parsed.json) {
        line(io.stdout, JSON.stringify({
          ok: true,
          path: receipt.path,
          mode: receipt.mode,
          connection: receipt.connection,
          restart_required: receipt.restartRequired,
          active: 'unknown',
          syntax_only: true,
          codex_home: receipt.codexHome,
          check_command: receipt.checkCommand,
          remove_command: receipt.removeCommand,
        }));
        return EXIT_OK;
      }
      line(io.stdout, `Policy file: ${receipt.path}`);
      line(io.stdout, `Mode: ${receipt.mode}`);
      line(io.stdout, 'Syntax check only. Activation is unknown until Codex restarts and a canonical command runs without review.');
      return EXIT_OK;
    }
    const removed = policy.removePolicy(shared);
    line(io.stdout, `Removed ${removed.removed}.`);
    line(io.stdout, 'Restart Codex Desktop to restore the previous Auto-review baseline.');
    return EXIT_OK;
  } catch (error) {
    return reportCodexPolicyError(io.stderr, error);
  }
}

function run(argv, io, dependencies = {}) {
  const { stdout, stderr } = io;

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(HELP);
    return EXIT_OK;
  }

  if (argv[0] === '--version' || argv[0] === '-V') {
    line(stdout, packageJson.version);
    return EXIT_OK;
  }

  if (argv[0] === 'backup') return runBackup(argv.slice(1), io, dependencies);

  if (argv[0] === 'restore') return runRestore(argv.slice(1), io, dependencies);

  if (argv[0] === 'join') return runJoin(argv.slice(1), io, dependencies);

  if (argv[0] === 'history' || argv[0] === 'listen') {
    return runReadCommand(argv[0], argv.slice(1), io, dependencies);
  }

  if (argv[0] === 'say') return runSay(argv.slice(1), io, dependencies);

  if (argv[0] === 'leave') return runLeave(argv.slice(1), io, dependencies);

  if (argv[0] === 'codex-policy') return runCodexPolicy(argv.slice(1), io, dependencies);

  line(stderr, 'interlock: unknown command; run "interlock --help".');
  return EXIT_USAGE;
}

module.exports = {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  HISTORY_DRAIN_BYTES,
  HISTORY_DRAIN_MESSAGES,
  run,
  runBackup,
  runJoin,
  runLeave,
  runReadCommand,
  runRecover,
  runSay,
  runStart,
  runRestore,
  runCodexPolicy,
  commandOptions,
  joinOptions,
  storageOptions,
  startPort,
};
