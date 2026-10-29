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
// `interlock doorbell` alone uses this status, so a ring adapter can tell a
// room it could not reach from a room that refused it.
const EXIT_UNREACHABLE = 3;
const DEFAULT_URL = 'http://localhost:8788';
const WRONG_SETUP_CODE_REPORT_MS = 1_000;
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
  interlock start [--port PORT] [--hosted-origin https://HOST]
  interlock recover [--port PORT]
  interlock backup --to ABSOLUTE_PATH
  interlock restore --from ABSOLUTE_PATH
  interlock join [--product LABEL] [--name NAME] [--url URL]
  interlock history --connection NAME [--drain | --skip-to-current | --before N | --find TEXT] [--json]
  interlock say --connection NAME --file PATH [--json]
  interlock say --connection NAME --stdin [--json]
      [--asks-of NAME [--means-file PATH | --means-stdin] [--deliver later]]
      [--answers N[,N...] [--choice yes|no]] [--status done|ready|stop]
  interlock asks --connection NAME [--json]
  interlock ask withdraw|keep-open N --connection NAME [--json]
  interlock listen --connection NAME [--json]
  interlock doorbell --connection NAME [--after MESSAGE_ID] [--json]
  interlock leave --connection NAME [--json]
  interlock codex-policy install --connection NAME --mode receive|participate
  interlock codex-policy check --connection NAME [--json]
  interlock codex-policy remove --connection NAME
  interlock work brief --connection NAME [--project ID] [--json]
  interlock work list --connection NAME [--project ID] [--needs-me] [--after N] [--limit N] [--json]
  interlock work get ID --connection NAME [--json]
  interlock work changes --connection NAME --after N [--limit N] [--json]
  interlock work create --connection NAME --file PATH [--json]
  interlock work update|evidence|note|share|answer|report-answer|confirm|reopen|withdraw ID --connection NAME --file PATH [--json]
  interlock work ask --connection NAME --file PATH [--json]
  interlock work kill ID --connection NAME --file PATH|--stdin [--json]
  interlock work kill-reply ID --outcome survived|killed --connection NAME --file PATH|--stdin [--json]
  interlock work export --connection NAME --format json|md

Persistent model wake setup:
  interlock-doorbell --help

The owner uses the browser room. An AI runs "interlock join" in its own
conversation, chooses a name, and waits for the owner or an admin to Allow.
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

const ANSWER_LIST = /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/;
const MAX_ANSWER_IDS = 8;

function sayValue(args, index) {
  const value = args[index + 1];
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') ? value : null;
}

function commandOptions(command, args) {
  const options = {
    connection: null, drain: false, skipToCurrent: false, before: null, find: null,
    after: null, json: false, source: null,
    asksOf: null, means: null, deliver: null, answers: null, choice: null, status: null,
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
    if (command === 'doorbell' && flag === '--after') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/.test(args[index + 1])) return null;
      const after = Number(args[index + 1]);
      if (!Number.isSafeInteger(after)) return null;
      seen.add(flag);
      options.after = after;
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
    if (command === 'say' && flag === '--asks-of') {
      if (seen.has(flag) || sayValue(args, index) === null) return null;
      seen.add(flag);
      options.asksOf = args[index + 1];
      index += 1;
      continue;
    }
    // The scope line is text, so like the message it never comes from argv.
    if (command === 'say' && flag === '--means-stdin') {
      if (seen.has('--means')) return null;
      seen.add('--means');
      options.means = { kind: 'stdin' };
      continue;
    }
    if (command === 'say' && flag === '--means-file') {
      if (seen.has('--means') || sayValue(args, index) === null) return null;
      seen.add('--means');
      options.means = { kind: 'file', path: args[index + 1] };
      index += 1;
      continue;
    }
    if (command === 'say' && flag === '--deliver') {
      if (seen.has(flag) || (args[index + 1] !== 'later' && args[index + 1] !== 'now')) return null;
      seen.add(flag);
      options.deliver = args[index + 1];
      index += 1;
      continue;
    }
    if (command === 'say' && flag === '--answers') {
      const value = sayValue(args, index);
      if (seen.has(flag) || value === null || !ANSWER_LIST.test(value)) return null;
      const ids = value.split(',').map(Number);
      if (ids.length > MAX_ANSWER_IDS || !ids.every(Number.isSafeInteger) ||
          new Set(ids).size !== ids.length) return null;
      seen.add(flag);
      options.answers = Object.freeze(ids);
      index += 1;
      continue;
    }
    if (command === 'say' && flag === '--choice') {
      if (seen.has(flag) || (args[index + 1] !== 'yes' && args[index + 1] !== 'no')) return null;
      seen.add(flag);
      options.choice = args[index + 1];
      index += 1;
      continue;
    }
    if (command === 'say' && flag === '--status') {
      if (seen.has(flag) || !['done', 'ready', 'stop'].includes(args[index + 1])) return null;
      seen.add(flag);
      options.status = args[index + 1];
      index += 1;
      continue;
    }
    return null;
  }
  if (options.connection === null || (command === 'say') !== (options.source !== null)) return null;
  if ((options.means !== null || options.deliver !== null) && options.asksOf === null) return null;
  if (options.choice !== null && options.answers === null) return null;
  if (options.means !== null && options.means.kind === 'stdin' && options.source.kind === 'stdin') {
    return null;
  }
  return Object.freeze(options);
}

function startPort(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--port' || !/^[0-9]{1,5}$/.test(args[1])) return null;
  const port = Number(args[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function startOptions(args) {
  const options = { port: undefined, hostedOrigin: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== 'string') return null;
    if (flag === '--port' && options.port === undefined && /^[0-9]{1,5}$/.test(value)) {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
      options.port = port;
    } else if (flag === '--hosted-origin' && options.hostedOrigin === undefined && value.length > 0) {
      options.hostedOrigin = value;
    } else {
      return null;
    }
  }
  return args.length % 2 === 0 ? Object.freeze(options) : null;
}

// Hosted mode only: the server reports every wrong setup code to the host. The
// host may be watched by one person on one terminal, so a flood of wrong codes
// is folded into at most one stderr line per window, carrying the latest count.
// The timer never keeps the process alive; flush() prints what is pending and
// retires the reporter.
function wrongSetupCodeReporter(stderr, timers) {
  let latest = 0;
  let printed = 0;
  let timer = null;
  let retired = false;
  function emit() {
    timer = null;
    if (latest > printed) {
      printed = latest;
      line(stderr, `interlock: wrong setup code (${latest} so far)`);
    }
  }
  return Object.freeze({
    report(count) {
      if (retired) return;
      latest = count;
      if (timer === null) {
        timer = timers.setTimeout(emit, WRONG_SETUP_CODE_REPORT_MS);
        timer.unref();
      }
    },
    flush() {
      retired = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      emit();
    },
  });
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
  if (result && result.error === 'unread-addressed' && Number.isSafeInteger(result.unread_count) &&
      Array.isArray(result.unread_ids) && result.unread_ids.every(Number.isSafeInteger)) {
    error.unread_count = result.unread_count;
    error.unread_ids = result.unread_ids;
  }
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

function validPublicRing(value) {
  const ring = exactObject(value, ['id', 'ts', 'byline', 'kind', 'session']);
  return !!ring && Number.isSafeInteger(ring.id) && ring.id > 0 &&
    Number.isSafeInteger(ring.ts) && ring.ts >= 0 &&
    typeof ring.byline === 'string' && ring.byline.length > 0 &&
    (ring.kind === 'person' || ring.kind === 'seat') &&
    (ring.kind === 'seat'
      ? (ring.session === null || (Number.isSafeInteger(ring.session) && ring.session > 0))
      : ring.session === null);
}

function validRingPage(result, after) {
  const page = exactObject(result, [
    'ok', 'rings', 'cursor', 'timed_out', 'connection_session',
  ]);
  if (!page || page.ok !== true || !Array.isArray(page.rings) ||
      page.rings.length > HISTORY_PEEK_LIMIT ||
      !Number.isSafeInteger(page.cursor) || page.cursor < after ||
      typeof page.timed_out !== 'boolean' ||
      !(page.connection_session === null ||
        (Number.isSafeInteger(page.connection_session) && page.connection_session > 0)) ||
      !page.rings.every(validPublicRing)) return false;
  let prior = after;
  for (const ring of page.rings) {
    if (ring.id <= prior || ring.id > page.cursor) return false;
    prior = ring.id;
  }
  return true;
}

function renderMessages(stdout, messages, notes = null) {
  stdout.write(renderedMessages(messages, notes));
}

function formatMessageTime(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) return '';
  const iso = new Date(ts).toISOString();
  if (!iso.endsWith('Z')) return '';
  return iso.slice(0, 19).replace('T', ' ') + ' UTC';
}

function renderedMessages(messages, notes = null) {
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
    // A body line cannot pass for an annotation: only the room's own notes
    // begin with the arrow.
    output += `${terminalSafe(message.text, true).replace(/^(\s*)↳/gmu, '$1\uFFFD')}\n`;
    for (const note of (notes && notes.get(message.id)) || []) output += `  ↳ ${note}\n`;
  }
  return output;
}

const ANNOTATION_PAGE_LIMIT = 100;
const ANNOTATION_PAGES = 50;

function validAskFields(value) {
  const ask = exactObject(value, ['of', 'of_kind', 'means', 'deliver']);
  return !!ask && typeof ask.of === 'string' && ask.of.length > 0 &&
    (ask.of_kind === 'person' || ask.of_kind === 'seat') &&
    (ask.means === null || typeof ask.means === 'string') &&
    (ask.deliver === 'now' || ask.deliver === 'later');
}

function validAnswerEntry(value) {
  const answer = exactObject(value, ['ask_id', 'choice', 'crossed_by']);
  return !!answer && Number.isSafeInteger(answer.ask_id) && answer.ask_id > 0 &&
    (answer.choice === null || answer.choice === 'yes' || answer.choice === 'no') &&
    (answer.crossed_by === null || (Number.isSafeInteger(answer.crossed_by) && answer.crossed_by > 0));
}

function validPostRow(value) {
  const row = exactObject(value, [
    'seq', 'ts', 'kind', 'by', 'message_id', 'ask', 'answers', 'status', 'read_through',
  ]);
  return !!row && row.kind === 'post' && Number.isSafeInteger(row.message_id) && row.message_id > 0 &&
    (row.ask === null || validAskFields(row.ask)) &&
    Array.isArray(row.answers) && row.answers.every(validAnswerEntry) &&
    (row.status === null || row.status === 'done' || row.status === 'ready' || row.status === 'stop');
}

function askLine(ask) {
  const later = ask.deliver === 'later' ? ' (held for later)' : '';
  return ask.means === null
    ? `asks ${terminalSafe(ask.of)}${later}`
    : `asks ${terminalSafe(ask.of)}${later} — a yes means: ${terminalSafe(ask.means)}`;
}

function postNotes(row) {
  const notes = [];
  if (row.ask !== null) notes.push(`${askLine(row.ask)} [ask ${row.message_id}]`);
  for (const answer of row.answers) {
    const choice = answer.choice === null ? '' : `: ${answer.choice}`;
    const crossed = answer.crossed_by === null ? ''
      : ` (crossed: ask ${answer.crossed_by} to the same person is newer)`;
    notes.push(`answers ask ${answer.ask_id}${choice}${crossed}`);
  }
  if (row.status !== null) notes.push(`status: ${row.status}`);
  return notes;
}

/* The annotations of the messages about to be printed, read from the side-car.
 * A room without asks (an older release) or a malformed page prints the
 * messages without them: an annotation never stops a read. */
async function annotationNotes(fetcher, profile, messages) {
  const notes = new Map();
  if (messages.length === 0) return notes;
  const wanted = new Set(messages.map(message => message.id));
  let after = 0;
  try {
    for (let index = 0; index < ANNOTATION_PAGES; index += 1) {
      const page = await localRequest(fetcher, profile,
        `/api/ai/annotations?after=${after}&limit=${ANNOTATION_PAGE_LIMIT}`,
        { timeoutMs: COMMAND_FETCH_TIMEOUT_MS });
      if (!exactObject(page, ['ok', 'rows', 'cursor', 'first_id']) || !Array.isArray(page.rows) ||
          !Number.isSafeInteger(page.cursor) || page.cursor < after) return new Map();
      for (const row of page.rows) {
        if (!row || row.kind !== 'post') continue;
        if (!validPostRow(row)) return new Map();
        if (!wanted.has(row.message_id)) continue;
        const rowNotes = postNotes(row);
        if (rowNotes.length > 0) notes.set(row.message_id, rowNotes);
      }
      if (page.cursor === after) break;
      after = page.cursor;
    }
  } catch (_) {
    return new Map();
  }
  return notes;
}

async function renderAnnotated(stdout, fetcher, profile, messages) {
  renderMessages(stdout, messages, await annotationNotes(fetcher, profile, messages));
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

const noticedServerVersions = new Set();

function compareVersions(left, right) {
  const parts = value => value.split('-', 1)[0].split('.').map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

// One line per newer server version per process; the CLI keeps working either way.
function noticeServerVersion(response, stderr) {
  if (!stderr || !response || !response.headers || typeof response.headers.get !== 'function') return;
  const version = response.headers.get('x-interlock-version');
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return;
  if (compareVersions(version, packageJson.version) <= 0 || noticedServerVersions.has(version)) return;
  noticedServerVersions.add(version);
  line(stderr, `interlock: the room runs Interlock ${version}; this CLI is ${packageJson.version}. Update the CLI to match.`);
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
    noticeServerVersion(response, options.stderr);
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

// A gateway answering for a room that is down (502-504, and the 52x and 530
// answers of a Cloudflare front) or a transport failure on the way to it means
// the room was not reached. Every other HTTP status is the room's own answer.
const UNREACHABLE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const UNREACHABLE_TRANSPORT = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

function transportCode(error) {
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
    if (typeof cause.code === 'string' && UNREACHABLE_TRANSPORT.has(cause.code)) return cause.code;
    if (Array.isArray(cause.errors) && cause.errors.length > 0 &&
        cause.errors.every(inner => inner && UNREACHABLE_TRANSPORT.has(inner.code))) {
      return cause.errors[0].code;
    }
  }
  return null;
}

function roomUnreachable(error) {
  if (!error) return false;
  if (Number.isSafeInteger(error.status)) return UNREACHABLE_STATUSES.has(error.status);
  return error.name === 'AbortError' || transportCode(error) !== null;
}

function loopbackRoom(profile) {
  try { return new URL(profile.server_url).hostname === 'localhost'; }
  catch (_) { return false; }
}

function roomLabel(profile) {
  return loopbackRoom(profile) ? 'the local Interlock'
    : `the Interlock room at ${terminalSafe(profile.server_url)}`;
}

function reportRequestError(stderr, error, profile) {
  const room = roomLabel(profile);
  if (error && error.status === 401) {
    line(stderr, `interlock: connection ${terminalSafe(profile.name)} was refused; it may be expired or revoked.`);
  } else if (error && error.name === 'AbortError') {
    line(stderr, loopbackRoom(profile)
      ? 'interlock: the local Interlock request timed out; run the command again.'
      : `interlock: the request to ${room} timed out; run the command again.`);
  } else if (error && error.code === 'incompatible-response') {
    line(stderr, `interlock: ${room} answered, but this CLI could not validate the response; run the command again. If it keeps failing, check that this CLI is from the same Interlock release as the running room.`);
  } else if (error && error.exact && UNREACHABLE_STATUSES.has(error.status)) {
    line(stderr, `interlock: ${room} is temporarily unavailable (HTTP ${error.status}); run the command again.`);
  } else if (error && Number.isSafeInteger(error.status) && UNREACHABLE_STATUSES.has(error.status)) {
    line(stderr, `interlock: could not reach ${terminalSafe(profile.server_url)} (HTTP ${error.status}); make sure Interlock is running.`);
  } else if (error && Number.isSafeInteger(error.status)) {
    line(stderr, `interlock: ${room} refused the command.`);
  } else {
    line(stderr, `interlock: could not reach ${terminalSafe(profile.server_url)}; make sure Interlock is running.`);
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
      { timeoutMs: wait ? LISTEN_FETCH_TIMEOUT_MS : COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr });
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
      else await renderAnnotated(io.stdout, fetcher, profile, page.messages);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }
  try {
    profiles.updateCursor(profile.name, profile.request_id, page.cursor);
  } catch (_) {
    if (parsed.json) line(io.stdout, JSON.stringify(page));
    else await renderAnnotated(io.stdout, fetcher, profile, page.messages);
    line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
    return EXIT_RUNTIME;
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(page));
  } else if (page.messages.length > 0) {
    await renderAnnotated(io.stdout, fetcher, profile, page.messages);
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

  async function output(page) {
    if (parsed.json) writeReadOutput(io.stdout, parsed, page);
    else await renderAnnotated(io.stdout, fetcher, profile, page.messages);
  }

  for (let index = 0; index < HISTORY_DRAIN_MESSAGES; index += 1) {
    let page;
    try {
      page = await localRequest(fetcher, profile,
        `/api/ai/messages?after=${cursor}&limit=${HISTORY_LIMIT}&wait=0`,
        { timeoutMs: COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr });
      if (!validPage(page, cursor) ||
          (connectionSession !== undefined &&
            page.connection_session !== connectionSession)) throw incompatibleResponse();
    } catch (error) {
      if (messages.length > 0) await output(batch());
      reportRequestError(io.stderr, error, profile);
      return EXIT_RUNTIME;
    }

    if (page.messages.length === 0) {
      if (page.cursor > cursor) {
        try {
          profiles.updateCursor(profile.name, profile.request_id, page.cursor);
          cursor = page.cursor;
        } catch (_) {
          if (messages.length > 0) await output(batch());
          line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
          return EXIT_RUNTIME;
        }
      }
      const completed = batch([], cursor,
        connectionSession === undefined ? page.connection_session : connectionSession);
      if (completed.messages.length > 0 || parsed.json) await output(completed);
      else line(io.stdout, 'No new messages.');
      return EXIT_OK;
    }

    const candidate = batch(page.messages, page.cursor, page.connection_session);
    const candidateBytes = Buffer.byteLength(readOutput(parsed, candidate), 'utf8');
    if (messages.length > 0 && candidateBytes > HISTORY_DRAIN_BYTES) {
      await output(batch());
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
        await output(candidate);
        line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
        return EXIT_RUNTIME;
      }
    }
    try {
      profiles.updateCursor(profile.name, profile.request_id, page.cursor);
    } catch (_) {
      await output(candidate);
      line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
      return EXIT_RUNTIME;
    }

    messages.push(...page.messages);
    cursor = page.cursor;
    connectionSession = page.connection_session;
    if (candidateBytes >= HISTORY_DRAIN_BYTES) {
      await output(batch());
      return EXIT_OK;
    }
  }

  await output(batch());
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
      else await renderAnnotated(io.stdout, fetcher, profile, page.messages);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(page));
    return EXIT_OK;
  }
  if (page.messages.length > 0) await renderAnnotated(io.stdout, fetcher, profile, page.messages);
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

async function runDoorbell(args, io, dependencies = {}) {
  const parsed = commandOptions('doorbell', args);
  if (!parsed) {
    line(io.stderr,
      'interlock: usage: interlock doorbell --connection NAME [--after MESSAGE_ID] [--json]');
    return EXIT_USAGE;
  }
  let selected;
  try {
    selected = selectedConnection(parsed.connection, dependencies);
  } catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return EXIT_RUNTIME;
  }
  const { profile } = selected;
  const clock = dependencies.clock || Date.now;
  if (profile.expires_at <= clock()) {
    line(io.stderr,
      `interlock: connection ${terminalSafe(profile.name)} has expired; run "interlock join" for a new session.`);
    return EXIT_RUNTIME;
  }
  const after = parsed.after === null ? profile.cursor : parsed.after;
  let page;
  try {
    const fetcher = dependencies.fetch || globalThis.fetch;
    page = await localRequest(fetcher, profile,
      `/api/ai/rings?after=${after}&limit=${HISTORY_PEEK_LIMIT}&wait=1`,
      { timeoutMs: LISTEN_FETCH_TIMEOUT_MS });
    if (!validRingPage(page, after)) throw incompatibleResponse();
  } catch (error) {
    reportRequestError(io.stderr, error, profile);
    return roomUnreachable(error) ? EXIT_UNREACHABLE : EXIT_RUNTIME;
  }
  if (parsed.json) {
    line(io.stdout, JSON.stringify(Object.assign({}, page, {
      connection_request_id: profile.request_id,
    })));
  } else if (page.rings.length === 0) {
    line(io.stdout,
      `No ring yet — re-run \`interlock doorbell --connection ${terminalSafe(profile.name)} --after ${page.cursor}\`.`);
  } else {
    for (const ring of page.rings) {
      const session = ring.session === null ? '' : ` · Session ${ring.session}`;
      line(io.stdout,
        `Interlock ring ${ring.id} from ${terminalSafe(ring.byline)}${session}.`);
    }
    line(io.stdout,
      `Run \`interlock history --connection ${terminalSafe(profile.name)}\` to read and acknowledge the room.`);
  }
  return EXIT_OK;
}

const ANNOTATION_ERRORS = Object.freeze({
  'ask-target-unknown': 'the --asks-of name is not anyone in the room.',
  'ask-of-self': 'you cannot ask yourself.',
  'means-required': 'an ask of a person needs a one-line scope; pass --means-file PATH or --means-stdin.',
  'ask-not-found': 'there is no such ask in this room; run "interlock asks" for the open ones.',
  'not-asker': 'only the person or AI that made an ask can withdraw it or keep it open.',
  'ask-not-open': 'that ask is no longer open.',
  'ask-not-answered': 'that ask has not been answered yet, so there is nothing to keep open.',
  'invalid-annotation': 'the room refused the ask, answer or status as malformed (the scope line is one line of at most 300 characters).',
});

function reportAnnotationError(stderr, error, profile, connection) {
  const code = error && error.code;
  if (code === 'unread-addressed' && Array.isArray(error.unread_ids)) {
    const more = error.unread_count > error.unread_ids.length
      ? ` (and ${error.unread_count - error.unread_ids.length} more)` : '';
    line(stderr, `interlock: not posted. ${error.unread_count} message(s) addressed to you arrived after what you have read: ${error.unread_ids.join(', ')}${more}.`);
    line(stderr, `interlock: read them with "interlock history --connection ${terminalSafe(connection)}", then post the status again.`);
    return;
  }
  if (error && error.status === 404 && code !== 'ask-not-found') {
    line(stderr, `interlock: ${roomLabel(profile)} does not support asks, answers or status yet; nothing was posted. Use the same Interlock release as the running room.`);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(ANNOTATION_ERRORS, code)) {
    line(stderr, `interlock: ${ANNOTATION_ERRORS[code]}`);
    return;
  }
  reportRequestError(stderr, error, profile);
}

function readScopeLine(raw) {
  return raw.replace(/\r?\n$/, '');
}

function sayAnnotation(parsed, means, cursor) {
  const annotation = {};
  if (parsed.asksOf !== null) {
    annotation.ask = { of: parsed.asksOf };
    if (means !== null) annotation.ask.means = means;
    if (parsed.deliver !== null) annotation.ask.deliver = parsed.deliver;
  }
  if (parsed.answers !== null) {
    annotation.answers = parsed.answers.map(askId => ({ ask_id: askId, choice: parsed.choice }));
  }
  if (parsed.status !== null) {
    annotation.status = parsed.status;
    annotation.read_through = cursor;
  }
  return Object.keys(annotation).length > 0 ? annotation : null;
}

async function runSay(args, io, dependencies = {}) {
  if (args.some(arg => arg === '--means' || arg.startsWith('--means='))) {
    line(io.stderr, 'interlock: refusing an ask\'s scope line in command arguments; use --means-file PATH or --means-stdin.');
    return EXIT_USAGE;
  }
  if (args.includes('--means-stdin') && args.includes('--stdin')) {
    line(io.stderr, 'interlock: --means-stdin and --stdin cannot both read standard input; put one of them in a file.');
    return EXIT_USAGE;
  }
  const parsed = commandOptions('say', args);
  if (!parsed) {
    if (args.some(arg => ['--asks-of', '--means-file', '--means-stdin', '--deliver', '--answers',
      '--choice', '--status'].includes(arg))) {
      line(io.stderr, 'interlock: usage: interlock say --connection NAME --file PATH|--stdin [--asks-of NAME [--means-file PATH | --means-stdin] [--deliver later]] [--answers N[,N...] [--choice yes|no]] [--status done|ready|stop] [--json]');
      return EXIT_USAGE;
    }
    return refuseSay(io.stderr);
  }
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
  let means = null;
  if (parsed.means !== null) {
    try {
      means = readScopeLine(parsed.means.kind === 'file'
        ? (dependencies.readFile || fs.readFileSync)(parsed.means.path, 'utf8')
        : await (dependencies.readStdin || readStdin)(io.stdin || process.stdin));
    } catch (_) {
      line(io.stderr, `interlock: could not read the ${parsed.means.kind === 'file' ? 'scope file' : 'piped scope line'} safely.`);
      return EXIT_RUNTIME;
    }
  }
  const annotation = sayAnnotation(parsed, means, profile.cursor);
  const fetcher = dependencies.fetch || globalThis.fetch;
  const body = { text, client_message_id: crypto.randomUUID() };
  if (annotation !== null) body.annotation = annotation;
  const route = annotation === null ? '/api/ai/messages' : '/api/ai/annotated-messages';
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await localRequest(fetcher, profile, route, {
        method: 'POST', body, timeoutMs: COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr,
      });
      break;
    } catch (error) {
      if (attempt === 0 && !Number.isSafeInteger(error && error.status)) continue;
      if (annotation === null) reportRequestError(io.stderr, error, profile);
      else reportAnnotationError(io.stderr, error, profile, parsed.connection);
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

function askOptions(args) {
  const options = { connection: null, json: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json' && !seen.has(flag)) {
      seen.add(flag);
      options.json = true;
      continue;
    }
    if (flag === '--connection' && !seen.has(flag) && sayValue(args, index) !== null) {
      seen.add(flag);
      options.connection = args[index + 1];
      index += 1;
      continue;
    }
    return null;
  }
  return options.connection === null ? null : options;
}

function validPublicAsk(value) {
  const ask = exactObject(value, [
    'ask_id', 'asked_at', 'by', 'of', 'of_kind', 'means', 'deliver', 'state', 'kept_open',
    'carried_from', 'answers',
  ]);
  return !!ask && Number.isSafeInteger(ask.ask_id) && ask.ask_id > 0 &&
    typeof ask.by === 'string' && validAskFields({
      of: ask.of, of_kind: ask.of_kind, means: ask.means, deliver: ask.deliver,
    }) && typeof ask.state === 'string' && Array.isArray(ask.answers);
}

function renderAsk(ask, mine) {
  const who = mine ? `of ${terminalSafe(ask.of)}` : `by ${terminalSafe(ask.by)}`;
  const later = ask.deliver === 'later' ? ' · held for later' : '';
  const carried = ask.carried_from ? ' · from an archived era' : '';
  const kept = ask.kept_open ? ' · kept open' : '';
  const means = ask.means === null ? '' : ` — a yes means: ${terminalSafe(ask.means)}`;
  return `  ask ${ask.ask_id} ${who}${later}${carried}${kept}${means}`;
}

async function connectedProfile(parsed, io, dependencies) {
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return { code: error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME };
  }
  const clock = dependencies.clock || Date.now;
  if (selected.profile.expires_at <= clock()) {
    line(io.stderr, `interlock: connection ${terminalSafe(selected.profile.name)} has expired; run "interlock join" for a new session.`);
    return { code: EXIT_RUNTIME };
  }
  return { profile: selected.profile };
}

async function runAsks(args, io, dependencies = {}) {
  const parsed = askOptions(args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock asks --connection NAME [--json]');
    return EXIT_USAGE;
  }
  const { profile, code } = await connectedProfile(parsed, io, dependencies);
  if (!profile) return code;
  let result;
  try {
    result = await localRequest(dependencies.fetch || globalThis.fetch, profile, '/api/ai/asks');
    if (!exactObject(result, ['ok', 'addressed', 'asked']) || !Array.isArray(result.addressed) ||
        !Array.isArray(result.asked) || !result.addressed.every(validPublicAsk) ||
        !result.asked.every(validPublicAsk)) throw incompatibleResponse();
  } catch (error) {
    reportAnnotationError(io.stderr, error, profile, parsed.connection);
    return EXIT_RUNTIME;
  }
  if (parsed.json) {
    line(io.stdout, JSON.stringify(result));
    return EXIT_OK;
  }
  if (result.addressed.length === 0 && result.asked.length === 0) {
    line(io.stdout, 'No open asks.');
    return EXIT_OK;
  }
  if (result.addressed.length > 0) {
    line(io.stdout, 'Asked of you:');
    for (const ask of result.addressed) line(io.stdout, renderAsk(ask, false));
  }
  if (result.asked.length > 0) {
    line(io.stdout, 'You asked:');
    for (const ask of result.asked) line(io.stdout, renderAsk(ask, true));
  }
  return EXIT_OK;
}

const ASK_VERBS = Object.freeze({ withdraw: 'withdraw', 'keep-open': 'keep_open' });

async function runAsk(args, io, dependencies = {}) {
  const verb = args[0];
  const id = args[1];
  const parsed = Object.prototype.hasOwnProperty.call(ASK_VERBS, verb) &&
    typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
    ? askOptions(args.slice(2)) : null;
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock ask withdraw|keep-open N --connection NAME [--json]');
    return EXIT_USAGE;
  }
  const { profile, code } = await connectedProfile(parsed, io, dependencies);
  if (!profile) return code;
  let result;
  try {
    result = await localRequest(dependencies.fetch || globalThis.fetch, profile, '/api/ai/annotations', {
      method: 'POST', body: { kind: ASK_VERBS[verb], ask_id: Number(id) },
    });
    if (!exactObject(result, ['ok', 'row'])) throw incompatibleResponse();
  } catch (error) {
    reportAnnotationError(io.stderr, error, profile, parsed.connection);
    return EXIT_RUNTIME;
  }
  if (parsed.json) line(io.stdout, JSON.stringify(result));
  else line(io.stdout, verb === 'withdraw' ? `Withdrew ask ${id}.` : `Ask ${id} is open again.`);
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
  if (start === 'beginning') {
    line(stdout, 'Interlock could not read the current tip, so this seat starts at the');
    line(stdout, 'beginning. Read earlier history if the task needs it, or skip to current.');
  } else {
    line(stdout, 'Your seat starts now, at the room\'s current moment. Earlier history');
    line(stdout, 'exists and is read on demand only when the assigned task needs it.');
  }
  line(stdout, 'Use this exact connection name for every command in this conversation:');
  line(stdout, `  interlock history --connection ${profile.name} --skip-to-current`);
  line(stdout, `  interlock history --connection ${profile.name} --drain`);
  line(stdout, `  interlock say --connection ${profile.name} --file PATH`);
  line(stdout, `  interlock listen --connection ${profile.name}`);
  line(stdout, `  interlock doorbell --connection ${profile.name}`);
  line(stdout, 'The contract for staying reachable:');
  line(stdout, '  Establish one model wake path before saying hello. A background listen');
  line(stdout, '  is a reader, not a doorbell: it may mark Delivered without waking the');
  line(stdout, '  model. Use the installed adapter only through a verified queue or');
  line(stdout, '  Monitor-class host; redirected logs do not count. Never run listen as');
  line(stdout, '  a competing background wake path.');
  line(stdout, '  listen is one read inside an active model turn. Read its result before');
  line(stdout, '  listening again.');
  line(stdout, '  history --drain is deliberate catch-up, not a join step. In scripts,');
  line(stdout, '  use --json and stop only when the messages array is empty.');
  line(stdout, '  history --skip-to-current is not a read and marks nothing delivered.');
  line(stdout, '  Run one history or listen at a time for this connection.');
  line(stdout, '  Run `interlock-doorbell guide` for persistent wake setup. Your');
  line(stdout, '  reported product name does not prove the exact host surface; use a');
  line(stdout, '  recipe only when its tested CLI/TUI surface matches this session.');
  line(stdout, '  The shared GUIDE.md is served at /help; host recipes are in');
  line(stdout, '  docs/DOORBELL.md in this installed release.');
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
    line(stderr, 'interlock: usage: interlock join [--product LABEL] [--name NAME] [--url URL]');
    return EXIT_USAGE;
  }
  const promptInput = io.stdin || process.stdin;
  if (!dependencies.ask && (parsed.product === null || parsed.name === null) &&
      (!promptInput || promptInput.isTTY !== true)) {
    line(stderr, 'interlock: join cannot prompt without an interactive terminal.');
    line(stderr, 'Use: interlock join --product "PRODUCT" --name NAME');
    return EXIT_USAGE;
  }
  const profileModule = dependencies.profiles || require('./client/profiles.js');
  if (!profileModule.validUrl(parsed.url)) {
    line(stderr, 'interlock: join accepts only http://localhost or a canonical https origin.');
    return EXIT_USAGE;
  }
  line(stdout, `Interlock target: ${terminalSafe(parsed.url)}`);
  const config = dependencies.config || require('./config.js');
  const identity = dependencies.identity || require('identity');
  const { matchCode } = require('./admission/match_code.js');
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
      line(stdout, `Requesting admission as ${terminalSafe(profile.name)}. Match code: ${matchCode(profile.selector)}`);

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
              line(stdout, `Waiting for the owner or an admin to allow ${profile.name}. Match code: ${matchCode(profile.selector)}`);
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
  const parsed = startOptions(args);
  if (parsed === null) {
    line(stderr, 'interlock: usage: interlock start [--port PORT] [--hosted-origin https://HOST]');
    return EXIT_USAGE;
  }
  if (parsed.hostedOrigin !== undefined) {
    try { require('./hosted.js').parseHostedOrigin(parsed.hostedOrigin); }
    catch (error) {
      line(stderr, terminalSafe(error && error.message));
      return EXIT_USAGE;
    }
  }
  const requestedPort = parsed.port;
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

  const serverOptions = { dataDir, port };
  let wrongCodes = null;
  if (parsed.hostedOrigin !== undefined) {
    wrongCodes = wrongSetupCodeReporter(stderr, dependencies.timers || { setTimeout, clearTimeout });
    serverOptions.hostedOrigin = parsed.hostedOrigin;
    serverOptions.onWrongSetupCode = wrongCodes.report;
  }

  let runtime;
  try {
    runtime = await startInterlockServer(serverOptions);
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
    if (error && error.code === 'origin-mismatch') {
      line(stderr, terminalSafe(error.message));
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
  line(stdout, `AI join: interlock join --url ${runtime.url}`);
  if (runtime.hosted) {
    line(stdout, `Your front on this machine must forward ${runtime.url} to http://localhost:${runtime.port} and preserve the Host header.`);
    if (typeof runtime.setupCode === 'string') {
      line(stdout, '');
      line(stdout, `Setup code (first owner only, shown once): ${runtime.setupCode}`);
      line(stdout, 'Open the room in a browser, create the owner account, and type this code when asked. It is printed only here, on this process\'s output (under systemd, that is the journal). Interlock does not save it to disk; the journal may.');
    }
  }
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
  if (wrongCodes !== null) wrongCodes.flush();
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
    if (error && error.code === 'not-loopback') {
      const served = /^https?:\/\//.test(error.recordedOrigin)
        ? `serves ${error.recordedOrigin}` : 'has an origin record that cannot be read';
      line(stderr, `interlock: this data directory ${served}; owner recovery works only for a room served at http://localhost.`);
      line(stderr, 'Recovery would replace the owner passkey with one bound to localhost, which this room cannot use. See HOSTING.md.');
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

// ── the Work record ───────────────────────────────────────────────────────────
// A deliberate read or write against the shared Work record over the admitted
// connection. Bodies travel in a JSON file, never in argv. Every write carries
// an operation id so a retry replays instead of duplicating.

const WORK_ITEM_ID = /^[WD]-[1-9][0-9]*$/;
const WORK_VERBS = Object.freeze({
  brief: Object.freeze({ path: '/api/ai/work/brief', method: 'GET', id: false, flags: ['project'] }),
  list: Object.freeze({ path: '/api/ai/work/list', method: 'GET', id: false, flags: ['project', 'needs-me', 'after', 'limit'] }),
  get: Object.freeze({ path: '/api/ai/work/items/', method: 'GET', id: true, flags: [] }),
  changes: Object.freeze({ path: '/api/ai/work/changes', method: 'GET', id: false, flags: ['after', 'limit'], required: ['after'] }),
  export: Object.freeze({ path: '/api/ai/work/export', method: 'GET', id: false, flags: ['format'], required: ['format'], raw: true }),
  create: Object.freeze({ path: '/api/ai/work/items/create', method: 'POST', id: false }),
  update: Object.freeze({ path: '/api/ai/work/items/update', method: 'POST', id: true }),
  evidence: Object.freeze({ path: '/api/ai/work/items/evidence', method: 'POST', id: true }),
  note: Object.freeze({ path: '/api/ai/work/items/note', method: 'POST', id: true }),
  share: Object.freeze({ path: '/api/ai/work/items/share', method: 'POST', id: true }),
  answer: Object.freeze({ path: '/api/ai/work/decisions/answer', method: 'POST', id: true }),
  'report-answer': Object.freeze({ path: '/api/ai/work/decisions/report', method: 'POST', id: true }),
  confirm: Object.freeze({ path: '/api/ai/work/decisions/confirm', method: 'POST', id: true }),
  reopen: Object.freeze({ path: '/api/ai/work/decisions/reopen', method: 'POST', id: true }),
  withdraw: Object.freeze({ path: '/api/ai/work/decisions/withdraw', method: 'POST', id: true }),
  ask: Object.freeze({ path: '/api/ai/work/decisions/ask', method: 'POST', id: false }),
  // The kill slot's words are text, not a JSON body: from a file or stdin,
  // never argv. The CLI reads the decision's current revision itself.
  kill: Object.freeze({ path: '/api/ai/work/decisions/kill', method: 'POST', id: true, words: 'question' }),
  'kill-reply': Object.freeze({ path: '/api/ai/work/decisions/kill-reply', method: 'POST', id: true, words: 'words', outcome: true }),
});
const WORK_QUERY_ORDER = Object.freeze(['project', 'needs_me', 'after', 'limit', 'format']);

function refuseWork(stderr, message) {
  line(stderr, `interlock work: ${message}; run "interlock --help" for the work commands.`);
  return EXIT_USAGE;
}

function workOptions(args) {
  const verb = args[0];
  const spec = WORK_VERBS[verb];
  if (!spec) return { error: 'unknown verb' };
  const options = { verb, spec, id: null, connection: null, file: null, stdin: false, outcome: null, json: false, query: {} };
  let index = 1;
  if (spec.id) {
    if (typeof args[1] !== 'string' || !WORK_ITEM_ID.test(args[1])) return { error: 'a record id like W-12 or D-7 comes right after the verb' };
    options.id = args[1];
    index = 2;
  }
  const seen = new Set();
  const flags = spec.flags || [];
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) return { error: `${flag} was given twice` };
    if (flag === '--connection' || flag === '--file' || flag === '--project' || flag === '--after' ||
        flag === '--limit' || flag === '--format') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value.startsWith('-')) return { error: `${flag} needs a value` };
      seen.add(flag);
      index += 1;
      if (flag === '--connection') { options.connection = value; continue; }
      if (flag === '--file') {
        if (spec.method !== 'POST') return { error: `${verb} takes no --file` };
        options.file = value;
        continue;
      }
      const name = flag.slice(2);
      if (!flags.includes(name)) return { error: `${verb} takes no ${flag}` };
      if ((name === 'after' || name === 'limit') && !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return { error: `${flag} needs a whole number` };
      if (name === 'format' && value !== 'json' && value !== 'md') return { error: '--format is json or md' };
      options.query[name] = value;
      continue;
    }
    if (flag === '--stdin') {
      if (!spec.words) return { error: `${verb} takes no --stdin` };
      seen.add(flag);
      options.stdin = true;
      continue;
    }
    if (flag === '--outcome') {
      const value = args[index + 1];
      if (!spec.outcome) return { error: `${verb} takes no --outcome` };
      if (value !== 'survived' && value !== 'killed') return { error: '--outcome is survived or killed' };
      seen.add(flag);
      options.outcome = value;
      index += 1;
      continue;
    }
    if (flag === '--needs-me') {
      if (!flags.includes('needs-me')) return { error: `${verb} takes no --needs-me` };
      seen.add(flag);
      options.query.needs_me = '1';
      continue;
    }
    if (flag === '--json') {
      if (spec.raw) return { error: 'export writes the document itself; --json does not apply' };
      seen.add(flag);
      options.json = true;
      continue;
    }
    return { error: 'refusing extra arguments; a request body travels in --file PATH' };
  }
  if (options.connection === null) return { error: '--connection NAME is required' };
  if (spec.words) {
    if ((options.file === null) === !options.stdin) return { error: `${verb} reads its words from --file PATH or --stdin, one of them` };
    if (spec.outcome && options.outcome === null) return { error: `${verb} needs --outcome survived|killed` };
  } else if (spec.method === 'POST' && options.file === null) {
    return { error: `${verb} needs --file PATH holding a JSON object` };
  }
  for (const required of spec.required || []) {
    if (options.query[required] === undefined) return { error: `${verb} needs --${required}` };
  }
  return options;
}

async function workRequest(fetcher, profile, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_FETCH_TIMEOUT_MS);
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
    if (options.raw && response.ok) return { raw: await response.text() };
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      const error = new Error('work request refused');
      error.status = response.status;
      error.code = result && typeof result.error === 'string' ? result.error : 'unavailable';
      if (result && Number.isSafeInteger(result.revision)) error.revision = result.revision;
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function reportWorkError(stderr, error, profile) {
  if (error && Number.isSafeInteger(error.status) && error.status !== 401 && typeof error.code === 'string') {
    const revision = Number.isSafeInteger(error.revision) ? ` (current revision ${error.revision})` : '';
    line(stderr, `interlock: the local Interlock refused the command: ${terminalSafe(error.code)}${revision}.`);
    return;
  }
  reportRequestError(stderr, error, profile);
}

function who(value) {
  if (!value || typeof value.name !== 'string') return 'nobody';
  const session = value.session === null || value.session === undefined ? '' : ` (session ${terminalSafe(String(value.session))})`;
  return terminalSafe(value.name) + session;
}

function workDetail(event) {
  for (const key of ['text', 'note', 'observed', 'title', 'reason', 'display_name']) {
    if (typeof event[key] === 'string' && event[key] !== '') return terminalSafe(event[key]);
  }
  if (event.from !== undefined && event.to !== undefined) return `${terminalSafe(String(event.from))} → ${terminalSafe(String(event.to))}`;
  return '';
}

const KILL_WORDS = Object.freeze({
  unattacked: 'unattacked', attacked: 'attacked', survived: 'attacked, survived', killed: 'killed',
});

// The kill slot's state in words; a record from before the kill slot has none.
function killWord(row) {
  return Object.prototype.hasOwnProperty.call(KILL_WORDS, row && row.kill_state) ? KILL_WORDS[row.kill_state] : null;
}

function killSuffix(row) {
  const word = killWord(row);
  return word === null ? '' : ` · ${word}`;
}

function workRow(row) {
  if (row.kind === 'decision') {
    return `${row.id} · ${row.state}${killSuffix(row)} · asked of ${who(row.asked_of)} by ${who(row.asked_by)} · ${terminalSafe(row.title)}`;
  }
  const next = row.next_to ? `${who(row.next_to)} — ${terminalSafe(row.next_action || '')}` : 'nobody';
  return `${row.id} · ${row.state} · ${terminalSafe(row.title)} · next: ${next}`;
}

function needsRow(row) {
  if (row.kind === 'decision') {
    return `${row.project} · ${row.id} · ${terminalSafe(row.title)} — ${terminalSafe(row.proposal || '')} (${row.state}${killSuffix(row)}, asked by ${who(row.asked_by)})`;
  }
  const awaiting = row.awaiting ? `, awaiting ${row.awaiting}` : '';
  return `${row.project} · ${row.id} · ${terminalSafe(row.title)} — ${terminalSafe(row.next_action || '')} (${row.state}${awaiting})`;
}

function renderBrief(stdout, brief, connection) {
  line(stdout, `Needs you (${brief.needs_me.length})`);
  for (const row of brief.needs_me) line(stdout, '  ' + needsRow(row));
  if (brief.reported_to_me.length) {
    line(stdout, `Reported to you (${brief.reported_to_me.length}) — answers relayed in your name, confirm or correct them`);
    for (const row of brief.reported_to_me) line(stdout, `  ${row.project} · ${row.id} · ${terminalSafe(row.title)}`);
  }
  line(stdout, 'Projects');
  for (const project of brief.projects) {
    line(stdout, `  ${terminalSafe(project.display_name)} — ${terminalSafe(project.objective || 'no objective yet')} · Today: ${terminalSafe(project.today || 'nothing recorded')} (${who(project.updated_by)})`);
  }
  line(stdout, `Open work (${brief.open.length})`);
  for (const row of brief.open) line(stdout, '  ' + workRow(row));
  line(stdout, `Decisions (${brief.decisions.length})`);
  for (const row of brief.decisions) line(stdout, '  ' + workRow(row));
  line(stdout, `Cursor ${brief.cursor} · continue with: interlock work changes --connection ${terminalSafe(connection)} --after ${brief.cursor}`);
}

function renderEvents(stdout, events) {
  for (const event of events) {
    const conditions = typeof event.conditions === 'string' && event.conditions !== '' ? ` · conditions: ${terminalSafe(event.conditions)}` : '';
    line(stdout, `${event.seq} · ${who(event.by)} · ${event.kind} · ${event.item || event.project || '-'} · ${workDetail(event)}${conditions}`);
  }
}

function renderGet(stdout, result) {
  const item = result.item;
  line(stdout, `${item.id} · ${terminalSafe(item.title)} (${item.kind} · ${item.project} · ${item.state})`);
  line(stdout, `  ${terminalSafe(item.body || '', true)}`);
  if (item.kind === 'decision') {
    line(stdout, `  asked of ${who(item.asked_of)} by ${who(item.asked_by)} · scope: ${terminalSafe(item.scope || 'not stated')}`);
    if (item.proposal) line(stdout, `  proposal: ${terminalSafe(item.proposal)}`);
    if (item.conditions) line(stdout, `  asked with conditions: ${terminalSafe(item.conditions)}`);
    if (item.answer) {
      const a = item.answer;
      const relay = a.kind === 'reported' ? ` · attributed to ${who(a.attributed_to)}, reported by ${who(a.by)}, not confirmed here` : '';
      const conditions = a.conditions ? ` · conditions: ${terminalSafe(a.conditions)}` : '';
      line(stdout, `  answer (${a.kind}): ${terminalSafe(a.text)}${conditions} · by ${who(a.by)}${relay} · source: ${terminalSafe(a.source || '')}`);
    }
    if (killWord(item) !== null) {
      const kill = item.kill;
      line(stdout, `  kill slot: ${killWord(item)}${kill ? ` · asked by ${who(kill.by)}: ${terminalSafe(kill.question)}` : ''}`);
      if (kill && kill.reply) {
        line(stdout, `  kill reply (${terminalSafe(kill.reply.outcome)}) by ${who(kill.reply.by)}: ${terminalSafe(kill.reply.words)}`);
      }
    }
  } else {
    const next = item.next_to ? `${who(item.next_to)} — ${terminalSafe(item.next_action || '')}` : 'nobody';
    line(stdout, `  responsible: ${who(item.responsible)} · next: ${next} · target: ${terminalSafe(item.target || 'none')} · revision ${item.revision}`);
  }
  line(stdout, `Evidence (${result.evidence.length})`);
  for (const e of result.evidence) {
    line(stdout, `  ${e.seq} · ${who(e.by)} · target ${terminalSafe(e.target)} (${e.target_matches ? 'current' : 'not the current target'}) · ${terminalSafe(e.observed)} · ${terminalSafe(e.reference)} · limits: ${terminalSafe(e.limits)}`);
  }
  line(stdout, `History (${result.history.length})`);
  renderEvents(stdout, result.history);
}

function renderWrite(stdout, verb, result, connection) {
  const item = result.item;
  const event = result.event;
  const exposure = result.exposure;
  if (verb === 'create') line(stdout, `Created ${item.id} · ${terminalSafe(item.title)} (${item.state}) in ${item.project}.`);
  else if (verb === 'update') line(stdout, `Updated ${item.id} (${item.state}).`);
  else if (verb === 'evidence') line(stdout, `Attached evidence to ${event.item} (event ${event.seq}).`);
  else if (verb === 'note') line(stdout, `Added a note to ${event.item} (event ${event.seq}).`);
  else if (verb === 'share') line(stdout, `Recorded: ${terminalSafe(String(event.purpose))} ${terminalSafe(String(event.outcome))}${event.message_id ? ' as #' + terminalSafe(String(event.message_id)) : ''}.`);
  else if (verb === 'answer') line(stdout, `Recorded an answer on ${item.id} (${item.state}).`);
  else if (verb === 'report-answer') {
    if (result.conflict === true) line(stdout, `Recorded a conflicting report on ${item.id}; the answer recorded here stands.`);
    else line(stdout, `Recorded a reported answer on ${item.id} (reported, not confirmed by ${who(item.answer && item.answer.attributed_to) === 'nobody' && exposure ? terminalSafe(exposure.to) : who(item.answer && item.answer.attributed_to)}).`);
  } else if (verb === 'confirm') line(stdout, `Confirmed the reported answer on ${item.id} (${item.state}).`);
  else if (verb === 'reopen') line(stdout, `Reopened ${item.id} (${item.state}, asked of ${who(item.asked_of)}).`);
  else if (verb === 'withdraw') line(stdout, `Withdrew ${item.id} (${item.state}).`);
  else if (verb === 'ask') {
    const message = result.message && Number.isSafeInteger(result.message.id) ? ` as message #${result.message.id}` : '';
    line(stdout, `Asked ${item.id} · ${terminalSafe(item.title)} of ${who(item.asked_of)}${message}; a yes in the room answers it.`);
  } else if (verb === 'kill') line(stdout, `Asked the kill question on ${item.id} (${killWord(item)}).`);
  else if (verb === 'kill-reply') line(stdout, `Replied to the kill question on ${item.id} (${killWord(item)}).`);
  if (result.replayed === true) line(stdout, 'This operation id was already applied; the original result is shown.');
  if (exposure && typeof exposure.text === 'string') {
    line(stdout, '');
    line(stdout, `Exposure draft for ${terminalSafe(exposure.to)}:`);
    line(stdout, terminalSafe(exposure.text, true));
    line(stdout, '');
    line(stdout, `Send it with: interlock say --connection ${terminalSafe(connection)} --file <the file you save it to>`);
  }
}

async function runWork(args, io, dependencies = {}) {
  const parsed = workOptions(args);
  if (parsed.error) return refuseWork(io.stderr, parsed.error);
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
  const fetcher = dependencies.fetch || globalThis.fetch;
  const { spec } = parsed;
  let pathname = spec.path + (spec.method === 'GET' && spec.id ? parsed.id : '');
  let requestOptions = { method: spec.method, raw: spec.raw === true };
  if (spec.method === 'POST' && spec.words) {
    let words;
    try {
      words = (parsed.stdin
        ? await (dependencies.readStdin || readStdin)(io.stdin || process.stdin)
        : (dependencies.readFile || fs.readFileSync)(parsed.file, 'utf8')).replace(/\r?\n$/, '');
    } catch (_) {
      line(io.stderr, `interlock work: could not read the ${parsed.stdin ? 'piped words' : 'words file'} safely.`);
      return EXIT_RUNTIME;
    }
    let current;
    try {
      current = await workRequest(fetcher, profile, WORK_VERBS.get.path + parsed.id);
      if (!current || !current.item || !Number.isSafeInteger(current.item.revision)) throw incompatibleResponse();
    } catch (error) {
      reportWorkError(io.stderr, error, profile);
      return EXIT_RUNTIME;
    }
    const body = { operation_id: crypto.randomUUID(), id: parsed.id, expected_revision: current.item.revision };
    body[spec.words] = words;
    if (spec.outcome) body.outcome = parsed.outcome;
    line(io.stdout, `Operation ${body.operation_id} · against ${parsed.id} revision ${current.item.revision}.`);
    requestOptions.body = body;
  } else if (spec.method === 'POST') {
    let body;
    try {
      body = JSON.parse((dependencies.readFile || fs.readFileSync)(parsed.file, 'utf8'));
    } catch (_) {
      line(io.stderr, 'interlock work: could not read the request file as JSON.');
      return EXIT_RUNTIME;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      line(io.stderr, 'interlock work: the request file must hold one JSON object.');
      return EXIT_RUNTIME;
    }
    body = Object.assign({}, body);
    if (spec.id) body.id = parsed.id;
    const fromFile = typeof body.operation_id === 'string';
    if (!fromFile) body.operation_id = crypto.randomUUID();
    // Printed before the request leaves, so a timed-out send still leaves the
    // id a retry must reuse.
    line(io.stdout, fromFile
      ? `Operation ${terminalSafe(body.operation_id)} · from the file.`
      : `Operation ${body.operation_id} · to retry this exact request, put "operation_id": "${body.operation_id}" in the file.`);
    requestOptions.body = body;
  } else {
    const query = WORK_QUERY_ORDER.filter(key => parsed.query[key] !== undefined)
      .map(key => `${key}=${encodeURIComponent(parsed.query[key])}`).join('&');
    if (query) pathname += '?' + query;
  }
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await workRequest(fetcher, profile, pathname, requestOptions);
      break;
    } catch (error) {
      if (attempt === 0 && !Number.isSafeInteger(error && error.status)) continue;
      reportWorkError(io.stderr, error, profile);
      return EXIT_RUNTIME;
    }
  }
  if (spec.raw) {
    io.stdout.write(result.raw);
    return EXIT_OK;
  }
  if (parsed.json) {
    line(io.stdout, JSON.stringify(result));
    return EXIT_OK;
  }
  if (parsed.verb === 'brief') renderBrief(io.stdout, result, profile.name);
  else if (parsed.verb === 'list') {
    for (const row of result.items) line(io.stdout, workRow(row));
    line(io.stdout, `${result.items.length} of ${result.total} · ${result.next === null ? 'no more' : `continue with --after ${result.next}`}`);
  } else if (parsed.verb === 'changes') {
    renderEvents(io.stdout, result.events);
    line(io.stdout, `Cursor ${result.cursor} · ${result.total} event${result.total === 1 ? '' : 's'} after ${parsed.query.after}`);
  } else if (parsed.verb === 'get') renderGet(io.stdout, result);
  else renderWrite(io.stdout, parsed.verb, result, profile.name);
  return EXIT_OK;
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

  if (argv[0] === 'doorbell') return runDoorbell(argv.slice(1), io, dependencies);

  if (argv[0] === 'say') return runSay(argv.slice(1), io, dependencies);

  if (argv[0] === 'asks') return runAsks(argv.slice(1), io, dependencies);

  if (argv[0] === 'ask') return runAsk(argv.slice(1), io, dependencies);

  if (argv[0] === 'leave') return runLeave(argv.slice(1), io, dependencies);

  if (argv[0] === 'codex-policy') return runCodexPolicy(argv.slice(1), io, dependencies);

  if (argv[0] === 'work') return runWork(argv.slice(1), io, dependencies);

  line(stderr, 'interlock: unknown command; run "interlock --help".');
  return EXIT_USAGE;
}

module.exports = {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  HISTORY_DRAIN_BYTES,
  HISTORY_DRAIN_MESSAGES,
  run,
  runBackup,
  runJoin,
  runLeave,
  runDoorbell,
  runReadCommand,
  runRecover,
  runSay,
  runAsks,
  runAsk,
  runStart,
  runRestore,
  runCodexPolicy,
  commandOptions,
  joinOptions,
  storageOptions,
  startOptions,
  startPort,
};
