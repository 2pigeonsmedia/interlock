'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');

const packageJson = require('../package.json');
const Ring = require('./rings.js');
// The room's own mention parser, so the CLI reads @all exactly as the room does.
const InterlockMentions = require('./web/mentions.js');

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;
// `interlock doorbell` alone uses this status, so a ring adapter can tell a
// room it could not reach from a room that refused it.
const EXIT_UNREACHABLE = 3;
const DEFAULT_URL = 'http://localhost:8788';
const WRONG_SETUP_CODE_REPORT_MS = 1_000;
const JOIN_WINDOW_MS = 15 * 60 * 1000;
// A candidate's request can still be waiting on the owner's card until this
// long after the candidate was made: a knock that creates the request can
// come as late as the end of the join window, and the room keeps a waiting
// request for 15 minutes from then. The room answers a waiting candidate's
// own credential exactly like one it never admitted, so until this has
// passed, "not admitted" proves nothing and the candidate is not discarded.
const CANDIDATE_MAY_BE_WAITING_MS = JOIN_WINDOW_MS + 15 * 60 * 1000 + 2 * 60 * 1000;
const JOIN_RETRY_MS = 1_000;
// A join whose room has never answered stops this long after its first
// failed attempt and says why, instead of waiting out the whole join window.
const JOIN_UNREACHED_MS = 30_000;
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
// history --through N: one call reads up to N. 24 KiB, not more: the output
// lands in an AI's tool window, and a common one cuts a command's output at
// 30,000 characters. A message printed past that cut would be delivered yet
// unseen. 24 KiB still holds two typical messages, and one message is always
// whole, even at the room's 32 KiB maximum.
const HISTORY_THROUGH_BYTES = 24 * 1024;
// A single message is printed whole even past the budget; past this many
// characters it may run into that cut, so --through says so first.
const HISTORY_THROUGH_WARN_CHARS = 28_000;
const HISTORY_PEEK_LIMIT = 100;

// Examples for --product. Any 1–40 printable characters are accepted.
const PRODUCT_EXAMPLES = '"Claude Code", "Codex CLI", "Grok", "ChatGPT" or "Opencode"';

const HELP = `Interlock ${packageJson.version}

One shared chat room for humans and multiple AI sessions.

Usage:
  interlock --help
  interlock --version
  interlock start [--port PORT] [--hosted-origin https://HOST]
  interlock recover [--port PORT]
  interlock recover --hosted
  interlock backup --to ABSOLUTE_PATH
  interlock restore --from ABSOLUTE_PATH
  interlock join --product LABEL --name NAME [--url URL] [--project ID] [--model LABEL] [--code CODE | --code -]
      --product is required: your AI product, for example ${PRODUCT_EXAMPLES}.
      --name: ${require('./names.js').NAME_KIND} (2–24 letters or digits, single hyphens).
      Missing or taken, join suggests three names to try.
      --session ID names your host session (default: INTERLOCK_SESSION, else Claude Code's
      session id). A join started in one session is never finished or dropped by another.
      Once the room has the request, join prints a match code and one doorbell command.
      Arm that doorbell before you end your turn, so you are woken when a person Allows you,
      then confirm with: interlock status --connection NAME
      Connection profiles live in INTERLOCK_CONNECTION_DIR, else <the data directory>/connections;
      set INTERLOCK_CONNECTION_DIR to keep a separate set.
  interlock join --resume --name NAME
      Finish a join that stopped: confirm it if the room admitted it, knock again, or say why.
  interlock join --discard --name NAME
      Drop an unfinished join the room has not admitted. Stop any join still running for it first.
  interlock history --connection NAME [--drain | --through N | --skip-to-current | --before N | --find TEXT] [--json]
  interlock history --connection NAME --project ID [--drain | --through N | --before N | --find TEXT]
  interlock say --connection NAME --file PATH [--json]
  interlock say --connection NAME --stdin [--json]
      [--asks-of NAME [--means-file PATH | --means-stdin] [--deliver later]]
      [--answers N[@REV][,N[@REV]...] [--choice yes|no] | --discusses N] [--status done|ready|stop]
  interlock asks --connection NAME [--json]
  interlock ask withdraw|keep-open N --connection NAME [--json]
  interlock ask withdraw N --replaced-by M --connection NAME [--json]
  interlock ask revise N --means-file PATH|--means-stdin --connection NAME [--json]
  interlock listen --connection NAME [--json]
  interlock doorbell --connection NAME [--after MESSAGE_ID] [--json]
  interlock doorbell pause --connection NAME [--reason turn] [--json]
  interlock doorbell resume --connection NAME [--json]
  interlock status --connection NAME [--state-dir ABSOLUTE_PATH] [--json]
  interlock rooms [--json]
      every connection on this computer, its room address and its state; never a token
  interlock leave --connection NAME [--json]
      Leave is for when you want the connection truly left, not resumable:
      the seat ends, its grants end, and its work goes to its lead or waits
      for one. To stop for now and come back as the same connection, do not
      leave: stop the doorbell (People shows not listening) and start it again
      later. During a long turn, "interlock doorbell pause" shows you working.
  interlock presence --connection NAME --file PATH | --clear [--json]
  interlock presence --connection NAME --project ID|none [--assign NAME] [--json]
  interlock presence --connection NAME --middle-stdin [--json]
  interlock grants --connection NAME [--json]
  interlock codex-policy install --connection NAME --mode receive|participate
  interlock codex-policy check --connection NAME [--json]
  interlock codex-policy remove --connection NAME
  interlock work brief --connection NAME [--project ID] [--json]
  interlock work list --connection NAME [--project ID] [--needs-me] [--after N] [--limit N] [--json]
  interlock work get ID --connection NAME [--json]
  interlock work changes --connection NAME --after N [--limit N] [--json]
  interlock work create --connection NAME --file PATH [--json]
  interlock work update|move|evidence|note|share|answer|report-answer|confirm|reopen|revise ID --connection NAME --file PATH [--json]
      interlock work VERB --help names the fields its file takes, with one example file
  interlock work withdraw ID --connection NAME --file PATH [--json]
      ID is W-n work or finding, or D-n decision; the file holds expected_revision and reason
  interlock work project-update PROJECT --connection NAME --file PATH [--json]
  interlock work ask-approval --connection NAME --file PATH [--json]
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

// An ask id, optionally with the revision it is answered against (`12@2`,
// as `interlock asks` shows it); a bare id answers revision 1.
const ANSWER_LIST = /^[1-9][0-9]*(?:@[1-9][0-9]*)?(?:,[1-9][0-9]*(?:@[1-9][0-9]*)?)*$/;
const MAX_ANSWER_IDS = 8;

function sayValue(args, index) {
  const value = args[index + 1];
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') ? value : null;
}

function commandOptions(command, args) {
  const options = {
    connection: null, drain: false, skipToCurrent: false, before: null, find: null, project: null, through: null,
    after: null, json: false, source: null,
    asksOf: null, means: null, deliver: null, answers: null, choice: null, status: null, discusses: null,
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
    if (command === 'history' && flag === '--through') {
      if (seen.has(flag) || options.drain || options.skipToCurrent || options.before !== null ||
          options.find !== null || typeof args[index + 1] !== 'string' || !/^[1-9][0-9]*$/.test(args[index + 1]) ||
          !Number.isSafeInteger(Number(args[index + 1]))) return null;
      seen.add(flag);
      options.through = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (command === 'history' && flag === '--drain') {
      if (seen.has(flag) || options.skipToCurrent || options.before !== null ||
          options.find !== null || options.through !== null) return null;
      seen.add(flag);
      options.drain = true;
      continue;
    }
    if (command === 'history' && flag === '--skip-to-current') {
      if (seen.has(flag) || options.drain || options.before !== null ||
          options.find !== null || options.through !== null) return null;
      seen.add(flag);
      options.skipToCurrent = true;
      continue;
    }
    if (command === 'history' && flag === '--before') {
      if (seen.has(flag) || options.drain || options.skipToCurrent || options.through !== null ||
          typeof args[index + 1] !== 'string' || !/^[1-9][0-9]*$/.test(args[index + 1])) {
        return null;
      }
      seen.add(flag);
      options.before = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (command === 'history' && flag === '--find') {
      if (seen.has(flag) || options.drain || options.skipToCurrent || options.through !== null ||
          typeof args[index + 1] !== 'string' || args[index + 1].length < 1 ||
          args[index + 1].length > 200 || args[index + 1].startsWith('-')) {
        return null;
      }
      seen.add(flag);
      options.find = args[index + 1];
      index += 1;
      continue;
    }
    // A lens on what is printed: messages stamped for another project are
    // left out, unless they address this AI. It reads and acknowledges
    // exactly what the same history without it would.
    if (command === 'history' && flag === '--project') {
      if (seen.has(flag) || typeof args[index + 1] !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(args[index + 1])) {
        return null;
      }
      seen.add(flag);
      options.project = args[index + 1];
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
      const entries = value.split(',').map(entry => entry.split('@').map(Number));
      const ids = entries.map(([id]) => id);
      if (ids.length > MAX_ANSWER_IDS || !entries.every(entry => entry.every(Number.isSafeInteger)) ||
          new Set(ids).size !== ids.length) return null;
      seen.add(flag);
      options.answers = Object.freeze(entries.map(([id, revision]) => Object.freeze({ ask_id: id, revision: revision ?? 1 })));
      index += 1;
      continue;
    }
    // A reply that discusses an ask without answering it.
    if (command === 'say' && flag === '--discusses') {
      const value = sayValue(args, index);
      if (seen.has(flag) || value === null || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
      seen.add(flag);
      options.discusses = Number(value);
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
  // The project lens is for reading text; it never applies to a skip or to JSON.
  if (options.project !== null && options.skipToCurrent) return null;
  if ((options.means !== null || options.deliver !== null) && options.asksOf === null) return null;
  if (options.choice !== null && options.answers === null) return null;
  if (options.discusses !== null && options.answers !== null) return null;
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

// Hosted mode only: the server reports every wrong setup code, and every
// sign-in refused because all password checks were busy, to the host. The host
// may be watched by one person on one terminal, so a flood is folded into at
// most one stderr line per window, carrying the latest count. The timer never
// keeps the process alive; flush() prints what is pending and retires the
// reporter.
function wrongSetupCodeReporter(stderr, timers, describe = count => `wrong setup code (${count} so far)`) {
  let latest = 0;
  let printed = 0;
  let timer = null;
  let retired = false;
  function emit() {
    timer = null;
    if (latest > printed) {
      printed = latest;
      line(stderr, `interlock: ${describe(latest)}`);
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
  const options = {
    name: null, product: null, url: DEFAULT_URL, project: null, model: null, code: null, session: null,
    mode: 'join', urlGiven: false,
  };
  const seen = new Set();
  // --resume and --discard take no value; each names one unfinished candidate.
  const rest = [];
  for (const arg of args) {
    if (arg === '--resume' || arg === '--discard') {
      if (options.mode !== 'join') return null;
      options.mode = arg.slice(2);
    } else {
      rest.push(arg);
    }
  }
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--name', '--product', '--url', '--project', '--model', '--code', '--session'].includes(flag) || seen.has(flag) ||
        typeof value !== 'string' || value.length === 0) return null;
    seen.add(flag);
    options[flag.slice(2)] = flag === '--url' ? rootSlashDropped(value) : value;
  }
  if (rest.length % 2 !== 0) return null;
  options.urlGiven = seen.has('--url');
  // The candidate carries its room and product; --resume and --discard take
  // only its name (and, for --resume, what the knock may declare).
  if (options.mode !== 'join' &&
      (options.name === null || seen.has('--url') || seen.has('--product') ||
       (options.mode === 'discard' && (seen.has('--project') || seen.has('--model') || seen.has('--code'))))) return null;
  return Object.freeze(options);
}

// A room address copied with its root slash (`https://host/`) names the same
// origin; one trailing slash after the host is dropped. Anything more (a
// path, a query, a fragment, a second slash) is left for the origin check
// to refuse.
function rootSlashDropped(value) {
  const bare = value.endsWith('/') ? value.slice(0, -1) : value;
  return /^https?:\/\/[^/?#]+$/.test(bare) ? bare : value;
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

// How much of a refused body a refusal may show: enough to tell a proxy's
// page from the room's, never more. The room's own bodies carry no secret,
// but a proxy may echo the request, so the credential is redacted first.
const BODY_SNIPPET_BYTES = 120;
// How much of the body is searched for the credential before the cut, so a
// token that starts inside the shown bytes is always found whole.
const BODY_SCAN_BYTES = 16 * 1024;

// The body with this connection's credential (whole or either half) and
// anything after "Bearer " replaced, then cut to the bytes a refusal shows.
function redactedSnippet(text, token) {
  let safe = text;
  const parts = typeof token === 'string' && token.length > 0
    ? [token, ...token.split('.')].filter(part => part.length >= 8) : [];
  for (const part of parts) safe = safe.split(part).join('[redacted]');
  safe = safe.replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  return Buffer.from(safe, 'utf8').subarray(0, BODY_SNIPPET_BYTES).toString('utf8').replace(/\uFFFD+$/u, '');
}

// What answered a refused request: its content type, whether the body was
// the room's own JSON, and (when it was not) the start of the body.
async function answerFacts(response, copy, result, token) {
  const type = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type') : null;
  const interlock = result !== null && typeof result === 'object' && !Array.isArray(result) &&
    typeof result.ok === 'boolean';
  let snippet = null;
  if (!interlock && copy !== null) {
    try {
      const bytes = Buffer.from(await copy.arrayBuffer());
      snippet = redactedSnippet(bytes.subarray(0, BODY_SCAN_BYTES).toString('utf8'), token);
    } catch (_) { snippet = null; }
  }
  return {
    interlock_body: interlock,
    content_type: typeof type === 'string' && type.length > 0 ? type.slice(0, 200) : null,
    body_snippet: snippet,
  };
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

// The room's time on a facts page (0.4.0, `facts=1`).
function validRoomFacts(value) {
  const room = exactObject(value, ['room_time', 'last_person_message_ago']);
  return !!room && typeof room.room_time === 'string' && room.room_time.length > 0 && room.room_time.length <= 120 &&
    (room.last_person_message_ago === null || typeof room.last_person_message_ago === 'string');
}

/* A ring page. `facts` true: the 0.4.0 page asked for with facts=1, where each
 * ring row also carries `ring` (the one ring shape, C4) and the page carries
 * `room`. Without it, exactly the 0.3 page. */
function validRingPage(result, after, facts = false) {
  const page = exactObject(result, facts
    ? ['ok', 'rings', 'cursor', 'timed_out', 'connection_session', 'room']
    : ['ok', 'rings', 'cursor', 'timed_out', 'connection_session']);
  if (facts && (!page || !validRoomFacts(page.room) || !Array.isArray(page.rings) ||
      !page.rings.every(row => row && typeof row === 'object' && Ring.validRing(row.ring)))) return false;
  const rows = facts && page && Array.isArray(page.rings)
    ? page.rings.map(row => { const copy = Object.assign({}, row); delete copy.ring; return copy; })
    : page && page.rings;
  if (!page || page.ok !== true || !Array.isArray(rows) ||
      rows.length > HISTORY_PEEK_LIMIT ||
      !Number.isSafeInteger(page.cursor) || page.cursor < after ||
      typeof page.timed_out !== 'boolean' ||
      !(page.connection_session === null ||
        (Number.isSafeInteger(page.connection_session) && page.connection_session > 0)) ||
      !rows.every(validPublicRing)) return false;
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
    // carry the arrow. Every arrow in a body is replaced, wherever it sits,
    // so no blank-looking letter in front of it can hide one.
    output += `${terminalSafe(message.text, true).replace(/↳/gu, '\uFFFD')}\n`;
    for (const note of (notes && notes.get(message.id)) || []) output += `  ↳ ${note}\n`;
  }
  return output;
}

const ANNOTATION_PAGE_LIMIT = 100;
const ANNOTATION_PAGES = 50;
const ANNOTATION_SEEK_STEPS = 48;

function validAskFields(value) {
  const ask = exactObject(value, ['of', 'of_kind', 'means', 'deliver', 'project']);
  return !!ask && typeof ask.of === 'string' && ask.of.length > 0 &&
    (ask.of_kind === 'person' || ask.of_kind === 'seat') &&
    (ask.means === null || typeof ask.means === 'string') &&
    (ask.deliver === 'now' || ask.deliver === 'later');
}

function validAnswerEntry(value) {
  const answer = exactObject(value, ['ask_id', 'choice', 'crossed_by', 'by_addressee', 'closes', 'revision']);
  return !!answer && Number.isSafeInteger(answer.ask_id) && answer.ask_id > 0 &&
    (answer.choice === null || answer.choice === 'yes' || answer.choice === 'no') &&
    (answer.crossed_by === null || (Number.isSafeInteger(answer.crossed_by) && answer.crossed_by > 0)) &&
    typeof answer.by_addressee === 'boolean' && typeof answer.closes === 'boolean' &&
    Number.isSafeInteger(answer.revision) && answer.revision > 0;
}

function validPostRow(value) {
  const row = exactObject(value, [
    'seq', 'ts', 'kind', 'by', 'message_id', 'ask', 'answers', 'status', 'read_through', 'discusses',
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

// `withdrawnAt`: ask id -> the side-car position of its withdraw row. A reply
// on an ask that was withdrawn before it was written says so, and names the
// ask that replaced it when its asker linked one (`successorOf`).
function postNotes(row, withdrawnAt = new Map(), successorOf = new Map()) {
  const notes = [];
  if (row.ask !== null) notes.push(`${askLine(row.ask)} [ask ${row.message_id}]`);
  for (const answer of row.answers) {
    const choice = answer.choice === null ? '' : `: ${answer.choice}`;
    const crossed = answer.crossed_by === null ? ''
      : ` (crossed: ask ${answer.crossed_by} to the same person is newer)`;
    notes.push(`answers ask ${answer.ask_id}${choice}${crossed}`);
  }
  if (row.discusses) {
    const at = withdrawnAt.get(row.discusses.ask_id);
    const next = successorOf.get(row.discusses.ask_id);
    const withdrawn = Number.isSafeInteger(at) && at < row.seq
      ? ` (withdrawn before this reply${Number.isSafeInteger(next) ? `; re-asked as ask ${next}` : ''})` : '';
    notes.push(`discusses ask ${row.discusses.ask_id}${withdrawn}`);
  }
  if (row.status !== null) notes.push(`status: ${row.status}`);
  return notes;
}

/* The annotations of the messages about to be printed, read from the side-car.
 * A room without asks (an older release) or a malformed page prints the
 * messages without them: an annotation never stops a read.
 *
 * Post rows are written in message order, so the first row that can matter is
 * found by halving the side-car (`after` is a row position; a read past the end
 * reports the end), then read forward until the rows pass the last message
 * printed. A long era costs a few requests, never a walk from the start. */
async function annotationPage(fetcher, profile, after, limit) {
  const page = await localRequest(fetcher, profile,
    `/api/ai/annotations?after=${after}&limit=${limit}`, { timeoutMs: COMMAND_FETCH_TIMEOUT_MS });
  if (!exactObject(page, ['ok', 'rows', 'cursor', 'first_id']) || !Array.isArray(page.rows) ||
      !Number.isSafeInteger(page.cursor) || page.cursor < 0) throw incompatibleResponse();
  for (const row of page.rows) {
    if (row && row.kind === 'post' && !validPostRow(row)) throw incompatibleResponse();
  }
  return page;
}

function firstPostId(page) {
  const post = page.rows.find(row => row && row.kind === 'post');
  return post ? post.message_id : null;
}

/* Visit every side-car row from the first post row at or after message
 * `fromId` up to the last post row at or below `toId`. */
async function scanRows(fetcher, profile, fromId, toId, visit) {
  const end = (await annotationPage(fetcher, profile, Number.MAX_SAFE_INTEGER, 1)).cursor;
  // The last position whose first post row is still below `fromId`; reading
  // starts just after it.
  let low = 0;
  let high = end;
  for (let step = 0; step < ANNOTATION_SEEK_STEPS && high - low > ANNOTATION_PAGE_LIMIT; step += 1) {
    const middle = Math.floor((low + high) / 2);
    const first = firstPostId(await annotationPage(fetcher, profile, middle, ANNOTATION_PAGE_LIMIT));
    if (first !== null && first < fromId) low = middle;
    else high = middle;
  }
  let after = low;
  for (let index = 0; index < ANNOTATION_PAGES; index += 1) {
    const page = await annotationPage(fetcher, profile, after, ANNOTATION_PAGE_LIMIT);
    for (const row of page.rows) {
      if (row && row.kind === 'post' && row.message_id > toId) return;
      if (row) visit(row);
    }
    if (page.cursor <= after) return;
    after = page.cursor;
  }
}

async function annotationNotes(fetcher, profile, messages) {
  const notes = new Map();
  if (messages.length === 0) return notes;
  const wanted = new Set(messages.map(message => message.id));
  const lowest = Math.min(...wanted);
  const highest = Math.max(...wanted);
  try {
    const posts = [];
    const withdrawnAt = new Map();
    const successorOf = new Map();
    const noteWithdraw = row => {
      if (row.kind === 'withdraw' && Number.isSafeInteger(row.ask_id) && Number.isSafeInteger(row.seq) &&
          !withdrawnAt.has(row.ask_id)) withdrawnAt.set(row.ask_id, row.seq);
      // The newest link wins.
      if (row.kind === 'successor' && Number.isSafeInteger(row.ask_id) && Number.isSafeInteger(row.successor_id)) {
        successorOf.set(row.ask_id, row.successor_id);
      }
    };
    await scanRows(fetcher, profile, lowest, highest, row => {
      noteWithdraw(row);
      if (row.kind === 'post' && wanted.has(row.message_id)) posts.push(row);
    });
    // A reply on an ask older than the first message printed: that ask's
    // withdraw row, if any, lies before the rows just read.
    const older = posts.filter(row => row.discusses && row.discusses.ask_id < lowest)
      .map(row => row.discusses.ask_id);
    if (older.length > 0) await scanRows(fetcher, profile, Math.min(...older), highest, noteWithdraw);
    for (const row of posts) {
      const rowNotes = postNotes(row, withdrawnAt, successorOf);
      if (rowNotes.length > 0) notes.set(row.message_id, rowNotes);
    }
  } catch (_) {
    return new Map();
  }
  return notes;
}

const STAMP_PAGES = 200;

/* The project stamps and the asks of this AI, from the whole side-car of this
 * era (a stamp may be re-set long after its message). Null when the side-car
 * could not be read: the lens then shows everything and says so. */
async function stampFacts(fetcher, profile) {
  const stamps = new Map();
  const askedOfMe = new Set();
  // This AI's own asks, and the posts that answer or discuss them: a reply
  // belongs to the question's project, but the asker always sees it.
  const myAsks = new Set();
  const repliesToMe = new Set();
  let after = 0;
  try {
    for (let index = 0; index < STAMP_PAGES; index += 1) {
      const page = await annotationPage(fetcher, profile, after, ANNOTATION_PAGE_LIMIT);
      for (const row of page.rows) {
        if (row && row.kind === 'stamp') {
          const stamp = exactObject(row, ['seq', 'ts', 'kind', 'by', 'message_id', 'project', 'reason', 'record_id']);
          if (!stamp || !Number.isSafeInteger(stamp.message_id) ||
              !(stamp.project === null || typeof stamp.project === 'string')) throw incompatibleResponse();
          stamps.set(stamp.message_id, stamp.project);
        } else if (row && (row.kind === 'carry' || row.kind === 'carry_state') && row.by === profile.name &&
            Number.isSafeInteger(row.ask_id)) {
          // An ask of this AI's carried across a transcript clear: still its own.
          myAsks.add(row.ask_id);
        } else if (row && row.kind === 'post') {
          if (row.ask !== null && row.ask.of === profile.name) askedOfMe.add(row.message_id);
          if (row.ask !== null && row.by === profile.name) myAsks.add(row.message_id);
          const replied = (Array.isArray(row.answers) ? row.answers.map(answer => answer && answer.ask_id) : [])
            .concat(row.discusses ? [row.discusses.ask_id] : []);
          if (replied.some(id => myAsks.has(id))) repliesToMe.add(row.message_id);
        }
      }
      if (page.rows.length < ANNOTATION_PAGE_LIMIT || page.cursor <= after) {
        return { stamps, askedOfMe, repliesToMe };
      }
      after = page.cursor;
    }
  } catch (_) {
    return null;
  }
  return null;
}

/* `history --project`: the messages stamped for that project, those that
 * address this AI (it was rung, it is asked, or it answers or discusses this
 * AI's own ask), and unstamped ones. */
async function projectView(fetcher, profile, messages, project) {
  const facts = await stampFacts(fetcher, profile);
  if (facts === null) return { shown: messages, hidden: null };
  const shown = messages.filter(message => {
    const stamped = facts.stamps.has(message.id) ? facts.stamps.get(message.id) : null;
    return stamped === null || stamped === project || facts.askedOfMe.has(message.id) ||
      facts.repliesToMe.has(message.id) ||
      message.delivery.some(entry => entry.name === profile.name);
  });
  return { shown, hidden: messages.length - shown.length };
}

/* The same lens for --json: the page with only the messages the text lens
 * would print, saying which project and how many it hid (null when the
 * stamps could not be read and every message is kept). */
async function lensPage(fetcher, profile, page, project) {
  if (project === null || project === undefined || !page || !Array.isArray(page.messages)) return page;
  const view = await projectView(fetcher, profile, page.messages, project);
  return Object.assign({}, page, { messages: view.shown, project, hidden: view.hidden });
}

async function renderAnnotated(stdout, fetcher, profile, messages, project = null) {
  if (project === null) {
    renderMessages(stdout, messages, await annotationNotes(fetcher, profile, messages));
    return;
  }
  const view = await projectView(fetcher, profile, messages, project);
  renderMessages(stdout, view.shown, await annotationNotes(fetcher, profile, view.shown));
  if (view.hidden === null) {
    line(stdout, `Project stamps could not be read; every message is shown.`);
  } else {
    line(stdout, `${view.hidden} ${view.hidden === 1 ? 'message' : 'messages'} stamped for other projects not shown.`);
  }
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
// Every request says which Interlock this computer runs (0.4.0), so the room
// can tell this AI's person when it is out of date. Older rooms ignore it.
const CLIENT_HEADER = 'x-interlock-client';

function noticeServerVersion(response, stderr) {
  if (!stderr || !response || !response.headers || typeof response.headers.get !== 'function') return;
  const version = response.headers.get('x-interlock-version');
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return;
  if (compareVersions(version, packageJson.version) <= 0 || noticedServerVersions.has(version)) return;
  noticedServerVersions.add(version);
  line(stderr, `interlock: the room runs Interlock ${version}; this CLI is ${packageJson.version}. Update the CLI to match. ` +
    `Tell your person: "My Interlock on this computer is ${packageJson.version} and the room runs ${version}; it needs updating (GUIDE.md, install)."`);
}

async function localRequest(fetcher, profile, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || COMMAND_FETCH_TIMEOUT_MS);
  const headers = { authorization: 'Bearer ' + profile.token, [CLIENT_HEADER]: packageJson.version };
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
    // A copy of the body, read only when the answer is refused, so a refusal
    // can show what answered (a proxy's page is not the room's).
    const copy = typeof response.clone === 'function' ? response.clone() : null;
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw Object.assign(responseError(result, response.status), await answerFacts(response, copy, result, profile.token));
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// The host session this process runs in, for telling two AI sessions on one
// computer apart: --session when given, else INTERLOCK_SESSION, else the
// session id Claude Code sets for its commands. Null when none is known.
// Only a one-way digest of it is ever stored.
const HOST_SESSION_ENV = Object.freeze(['INTERLOCK_SESSION', 'CLAUDE_CODE_SESSION_ID']);
function hostSession(explicit, env, profileModule) {
  const module = profileModule || require('./client/profiles.js');
  if (typeof module.sessionDigest !== 'function') return null;
  if (explicit !== null && explicit !== undefined) {
    return module.validSession(explicit) ? Object.freeze({ digest: module.sessionDigest(explicit) }) : null;
  }
  for (const key of HOST_SESSION_ENV) {
    const value = env && env[key];
    if (typeof value === 'string' && module.validSession(value)) {
      return Object.freeze({ digest: module.sessionDigest(value) });
    }
  }
  return null;
}

// The digest of the session that started this candidate, or null when that
// is not known (no session then, an earlier release, an unreadable record).
function joinStarter(profiles, name, requestId) {
  if (typeof profiles.sessionOf !== 'function') return null;
  try { return profiles.sessionOf(name, requestId); } catch (_) { return null; }
}

function startedElsewhere(starter, mine) {
  return starter !== null && mine !== null && starter !== mine.digest;
}

// A candidate another session on this computer started, while the room may
// still admit it. Past that time it can admit nothing, so it no longer
// belongs to anyone: the usual expiry and --discard handling applies. The
// clock is read only when the starter differs.
function heldElsewhere(profiles, profile, mine, clock) {
  if (!startedElsewhere(joinStarter(profiles, profile.name, profile.request_id), mine)) return false;
  return clock() < profile.created_at + CANDIDATE_MAY_BE_WAITING_MS;
}

function alreadyJoiningRefusal(stderr, name) {
  line(stderr, `interlock: someone on this computer is already joining as ${terminalSafe(name)}. Pick another name: interlock join --name …`);
}

// Once per other session: an admitted connection used from a session that
// did not join it.
function sharedConnectionNotice(stderr, profiles, profile, mine) {
  if (!stderr || !mine || typeof profiles.noteOtherSession !== 'function') return;
  const starter = joinStarter(profiles, profile.name, profile.request_id);
  if (!startedElsewhere(starter, mine)) return;
  let first = false;
  // A record that cannot be written (a read-only sandbox) warns every time
  // rather than never.
  try { first = profiles.noteOtherSession(profile.name, profile.request_id, mine.digest); } catch (_) { first = true; }
  if (!first) return;
  line(stderr, `interlock: ${terminalSafe(profile.name)} was joined by another session on this computer; two sessions may be sharing it. Use your own name: interlock join --name …`);
}

function selectedConnection(name, dependencies = {}, stderr = null) {
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
  let profile = profiles.load(name);
  if (profile.state !== 'admitted') {
    const error = new Error('connection not admitted');
    error.code = 'not-admitted';
    throw error;
  }
  // An expired connection's token is spent: its file goes, and every command
  // that reaches here says "has expired" without using it.
  const now = (dependencies.clock || Date.now)();
  if (profile.expires_at <= now && typeof profiles.dropSpentToken === 'function') {
    profiles.dropSpentToken(name, now);
    profile = Object.freeze(Object.assign({}, profile, { token: null }));
  }
  sharedConnectionNotice(stderr, profiles, profile,
    hostSession(null, dependencies.env || process.env, profileModule));
  return Object.freeze({ profile, profiles });
}

// The file system refused to let this process secure the connection
// directory: a read-only mount, a sandbox, a permission. Named apart from a
// damaged or unsafe profile; the error code only, never a path or credential.
const DIRECTORY_REFUSALS = Object.freeze({
  EROFS: 'read-only file system', EACCES: 'permission denied', EPERM: 'operation not permitted',
});
function directoryRefusal(error) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  if (!code || !Object.prototype.hasOwnProperty.call(DIRECTORY_REFUSALS, code)) return null;
  return `interlock: the local connection directory could not be secured here (${code}: ${DIRECTORY_REFUSALS[code]}). ` +
    'A sandbox or file permission is blocking it, so the profile was not read. ' +
    'Run the command where that directory is writable.';
}

function reportConnectionError(stderr, error, name) {
  const refusal = directoryRefusal(error);
  if (refusal) {
    line(stderr, refusal);
    return;
  }
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

function reportRequestError(stderr, error, profile, jsonOut = null) {
  const room = roomLabel(profile);
  if (error && error.status === 401) {
    line(stderr, `interlock: connection ${terminalSafe(profile.name)} was refused; it may be expired or revoked.`);
  } else if (error && error.name === 'AbortError') {
    line(stderr, loopbackRoom(profile)
      ? 'interlock: the local Interlock request timed out; run the command again.'
      : `interlock: the request to ${room} timed out; run the command again.`);
  } else if (error && error.status === 503 && error.code === 'decision-filing') {
    line(stderr, 'interlock: a decision is being filed; try again in a moment.');
  } else if (error && error.code === 'incompatible-response') {
    line(stderr, `interlock: ${room} answered, but this CLI could not validate the response; run the command again. If it keeps failing, check that this CLI is from the same Interlock release as the running room.`);
  } else if (error && error.exact && UNREACHABLE_STATUSES.has(error.status)) {
    line(stderr, `interlock: ${room} is temporarily unavailable (HTTP ${error.status}); run the command again.`);
  } else if (error && Number.isSafeInteger(error.status) && UNREACHABLE_STATUSES.has(error.status)) {
    line(stderr, `interlock: could not reach ${terminalSafe(profile.server_url)} (HTTP ${error.status}); ` +
      (loopbackRoom(profile) ? 'make sure Interlock is running.' : 'the room or the network to it is down.'));
  } else if (error && Number.isSafeInteger(error.status) && error.interlock_body === false) {
    // Something answered at the room's address, but not the room: a proxy,
    // an edge or a captive page. Say what it was, not that the room refused.
    const type = error.content_type === null || error.content_type === undefined ? 'no content-type'
      : `content-type ${terminalSafe(error.content_type)}`;
    const began = typeof error.body_snippet === 'string' && error.body_snippet.length > 0
      ? ` It began: "${terminalSafe(error.body_snippet.replace(/\s+/g, ' ').trim())}".` : '';
    line(stderr, `interlock: ${loopbackRoom(profile) ? 'the local Interlock\'s address' : `the room's address (${terminalSafe(profile.server_url)})`} ` +
      `answered with a non-Interlock page (HTTP ${error.status}, ${type}); the room itself may be fine.${began}`);
  } else if (error && Number.isSafeInteger(error.status)) {
    const code = typeof error.code === 'string' && error.exact ? ` ${terminalSafe(error.code)}` : '';
    line(stderr, `interlock: ${room} refused the command (HTTP ${error.status}${code}).`);
  } else if (lookupFailed(error)) {
    line(stderr, `interlock: this computer could not look up ${terminalSafe(roomHost(profile))}; the room may be fine. Check this computer's DNS.`);
  } else if (loopbackRoom(profile)) {
    line(stderr, `interlock: could not reach ${terminalSafe(profile.server_url)}; make sure Interlock is running.`);
  } else {
    line(stderr, `interlock: could not reach ${terminalSafe(profile.server_url)}; the room or the network to it is down.`);
  }
  if (jsonOut) line(jsonOut, JSON.stringify(requestErrorFacts(error)));
}

// The same refusal for --json readers, on stdout: what answered and how.
function requestErrorFacts(error) {
  const status = error && Number.isSafeInteger(error.status) ? error.status : null;
  return {
    ok: false,
    error: lookupFailed(error) ? 'lookup-failed'
      : status === null ? (error && error.name === 'AbortError' ? 'timeout'
        : error && error.code === 'incompatible-response' ? 'incompatible-response' : 'unreachable')
        : UNREACHABLE_STATUSES.has(status) && !error.exact ? 'unreachable'
          : error.interlock_body === false ? 'not-interlock' : 'refused',
    status,
    code: error && error.exact && typeof error.code === 'string' ? error.code : null,
    content_type: error && typeof error.content_type === 'string' ? error.content_type : null,
    body_snippet: error && typeof error.body_snippet === 'string' ? error.body_snippet : null,
  };
}

// A name lookup that failed is this computer's network, not the room.
function lookupFailed(error) {
  const code = transportCode(error);
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

function roomHost(profile) {
  try { return new URL(profile.server_url).host; }
  catch (_) { return String(profile.server_url); }
}

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* The first ordinary text read after a seat is let in: a short tail
 * of what was said before it joined, shown once per admission, so a lead's
 * earlier "report in" is not invisible. It is a view only: its messages are
 * never sent a receipt, and it never moves the cursor. A seat let in more
 * than a day ago (an upgrade) is not shown one. The shown-once mark is a
 * file per admission beside the connection profiles, outside the profile. */
const JOINED_TAIL_FRESH_MS = 24 * 60 * 60 * 1000;

function joinedTailMarks(dependencies) {
  if (dependencies.joinedTailMarks) return dependencies.joinedTailMarks;
  const config = dependencies.config || require('./config.js');
  const directory = path.join(config.resolveConnectionDir({
    env: dependencies.env || process.env,
    platform: dependencies.platform || process.platform,
    homedir: dependencies.homedir,
  }), '.joined-tail');
  return {
    has: id => fs.existsSync(path.join(directory, id)),
    add: id => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, id), '', { mode: 0o600 });
    },
  };
}

async function showJoinedTail(profile, io, dependencies, clock) {
  if (!Number.isSafeInteger(profile.admitted_at) || clock() - profile.admitted_at >= JOINED_TAIL_FRESH_MS ||
      !Number.isSafeInteger(profile.created_at) || profile.created_at > profile.admitted_at) return;
  let marks;
  try {
    marks = joinedTailMarks(dependencies);
    if (marks.has(profile.request_id)) return;
  } catch (_) {
    return;
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  let page;
  try {
    page = await localRequest(fetcher, profile,
      `/api/ai/joined-tail?before=${profile.cursor + 1}&since=${profile.created_at}&until=${profile.admitted_at}`,
      { timeoutMs: COMMAND_FETCH_TIMEOUT_MS });
  } catch (error) {
    // A room older than this CLI has no tail to show, now or later.
    if (error && error.status === 404) {
      try { marks.add(profile.request_id); } catch (_) { /* shown next time instead */ }
    }
    return;
  }
  const tail = exactObject(page, ['ok', 'messages', 'project']);
  if (!tail || tail.ok !== true || !Array.isArray(tail.messages) || tail.messages.length > HISTORY_PEEK_LIMIT ||
      !tail.messages.every(validPublicMessage) || tail.messages.some(message => message.id > profile.cursor)) return;
  // Shown once: the mark is made before the tail is shown, so a later read
  // never repeats it.
  try { marks.add(profile.request_id); } catch (_) { return; }
  if (tail.messages.length === 0) return;
  const count = tail.messages.length;
  line(io.stdout, `Before you joined (${count} ${count === 1 ? 'post' : 'posts'}, shown once; not marked read. ` +
    `Earlier: interlock history --connection ${terminalSafe(profile.name)} --before ${tail.messages[0].id}):`);
  renderMessages(io.stdout, tail.messages);
  line(io.stdout, 'Since you joined:');
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
    reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
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
      if (parsed.json) line(io.stdout, JSON.stringify(await lensPage(fetcher, profile, page, parsed.project)));
      else await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }
  try {
    profiles.updateCursor(profile.name, profile.request_id, page.cursor);
  } catch (_) {
    if (parsed.json) line(io.stdout, JSON.stringify(await lensPage(fetcher, profile, page, parsed.project)));
    else await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
    line(io.stderr, 'interlock: messages were received, but the local cursor could not be saved; run the command again.');
    return EXIT_RUNTIME;
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(await lensPage(fetcher, profile, page, parsed.project)));
  } else if (page.messages.length > 0) {
    await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
  } else if (wait) {
    line(io.stdout, `Nothing yet — run \`interlock listen --connection ${profile.name}\` again.`);
  } else {
    line(io.stdout, 'No new messages.');
  }
  return EXIT_OK;
}

/* history --through N: every unread message up to and including N, whole and
 * in order, delivered exactly as --drain delivers them, within its own budget.
 * N must be in the room: checked first with a read that delivers nothing. */
async function executeThroughHistory(parsed, profile, profiles, io, dependencies) {
  const through = parsed.through;
  if (profile.cursor >= through) {
    if (parsed.json) writeReadOutput(io.stdout, parsed, { ok: true, messages: [], cursor: profile.cursor,
      timed_out: false, connection_session: null, through_reached: true });
    else line(io.stdout, `Already read through message ${through}.`);
    return EXIT_OK;
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  // The room refuses a read starting past its end, and a read starting at
  // its end finds nothing: either way N is not in the room.
  const notInRoom = () => {
    line(io.stderr, `interlock: message ${through} is not in the room yet; nothing was read.`);
    return EXIT_USAGE;
  };
  let probe;
  try {
    probe = await localRequest(fetcher, profile, `/api/ai/messages?after=${through - 1}&limit=1&wait=0`,
      { timeoutMs: COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr });
    if (!validPage(probe, through - 1)) throw incompatibleResponse();
  } catch (error) {
    if (error && error.status === 400 && error.code === 'invalid-message-query') return notInRoom();
    reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
    return EXIT_RUNTIME;
  }
  // A seat's reads skip its own posts, so N may be its own message: the read
  // then comes back empty with its cursor at or past N. Only a cursor short
  // of N means N is not in the room.
  if (probe.messages.length === 0 && probe.cursor < through) return notInRoom();
  return executeDrainHistory(parsed, profile, profiles, io, dependencies,
    { bytes: HISTORY_THROUGH_BYTES, through });
}

// `limits.through`: stop after message N (history --through N), never
// fetching past it for reading; `limits.bytes`: the rendered budget.
async function executeDrainHistory(parsed, profile, profiles, io, dependencies,
  limits = { bytes: HISTORY_DRAIN_BYTES, through: null }) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const messages = [];
  let cursor = profile.cursor;
  let connectionSession;
  const through = limits.through;

  function batch(extraMessages = [], nextCursor = cursor, nextSession = connectionSession, reached = undefined) {
    return Object.freeze(Object.assign({
      ok: true,
      messages: Object.freeze([...messages, ...extraMessages]),
      cursor: nextCursor,
      timed_out: false,
      connection_session: nextSession === undefined ? null : nextSession,
    }, through === null ? {} : { through_reached: reached === undefined ? nextCursor >= through : reached }));
  }

  async function output(page) {
    if (parsed.json) {
      const lensed = await lensPage(fetcher, profile, page, parsed.project);
      writeReadOutput(io.stdout, parsed, through === null ? lensed
        : Object.assign({}, lensed, { through_reached: page.through_reached }));
    } else {
      // The status, and a warning for any message a host may cut, come first:
      // a host that cuts long output keeps the start.
      if (through !== null) {
        line(io.stdout, page.through_reached ? `Read through message ${through}.`
          : 'more to read: run the same command again.');
        for (const message of page.messages) {
          if (typeof message.text === 'string' && message.text.length > HISTORY_THROUGH_WARN_CHARS) {
            line(io.stdout, `message ${message.id} is ${message.text.length} characters long; ` +
              'a host that cuts output may not show all of it.');
          }
        }
      }
      await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
    }
  }

  for (let index = 0; index < HISTORY_DRAIN_MESSAGES; index += 1) {
    if (through !== null && cursor >= through) {
      await output(batch([], cursor, connectionSession, true));
      return EXIT_OK;
    }
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
      reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
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
      if (completed.messages.length > 0 || parsed.json || through !== null) await output(completed);
      else line(io.stdout, 'No new messages.');
      return EXIT_OK;
    }

    // Past N: everything up to N is read; the later message stays unread.
    if (through !== null && page.messages[0].id > through) {
      await output(batch([], cursor, connectionSession, true));
      return EXIT_OK;
    }
    const candidate = batch(page.messages, page.cursor, page.connection_session);
    const candidateBytes = Buffer.byteLength(readOutput(parsed, candidate), 'utf8');
    if (messages.length > 0 && candidateBytes > limits.bytes) {
      await output(batch([], cursor, connectionSession, false));
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
    if (through !== null && cursor >= through) {
      await output(batch([], cursor, connectionSession, true));
      return EXIT_OK;
    }
    if (candidateBytes >= limits.bytes) {
      await output(batch([], cursor, connectionSession, through === null ? undefined : false));
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
    reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
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
    reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
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
      if (parsed.json) line(io.stdout, JSON.stringify(await lensPage(fetcher, profile, page, parsed.project)));
      else await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
      line(io.stderr, 'interlock: messages were received, but delivery could not be confirmed; run the command again.');
      return EXIT_RUNTIME;
    }
  }

  if (parsed.json) {
    line(io.stdout, JSON.stringify(await lensPage(fetcher, profile, page, parsed.project)));
    return EXIT_OK;
  }
  if (page.messages.length > 0) await renderAnnotated(io.stdout, fetcher, profile, page.messages, parsed.project);
  const range = `Searched #${page.searched_from}–#${page.searched_to}.`;
  if (page.complete) line(io.stdout, `${range} Complete.`);
  else line(io.stdout, `${range} Continue with --before ${page.next_before}.`);
  return EXIT_OK;
}

/* The room's time for this AI's own person, one line (0.4.0). An older room
 * has no such route; then, or on any doubt, nothing is printed. */
const ROOM_TIME_TIMEOUT_MS = 5_000;
async function roomTimeLine(fetcher, profile) {
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/room-time', { timeoutMs: ROOM_TIME_TIMEOUT_MS });
    const shaped = exactObject(result, ['ok', 'room_time', 'last_person_message_ago', 'line']);
    if (!shaped || typeof shaped.line !== 'string' || !shaped.line.startsWith('Room time: ') ||
        shaped.line.length > 200) return null;
    return terminalSafe(shaped.line);
  } catch (_) {
    return null;
  }
}

async function runReadCommand(command, args, io, dependencies = {}) {
  const parsed = commandOptions(command, args);
  if (!parsed) {
    line(io.stderr, `interlock: usage: interlock ${command} --connection NAME${command === 'history' ? ' [--drain | --through N | --skip-to-current | --before N | --find TEXT] [--project ID]' : ''} [--json]`);
    return EXIT_USAGE;
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
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

  // A skip to the current message reads nothing from the room, so it says no room time.
  if (command === 'history' && !parsed.json && !parsed.skipToCurrent) {
    const said = await roomTimeLine(dependencies.fetch || globalThis.fetch, profile);
    if (said !== null) line(io.stdout, said);
  }
  if (command === 'history' && !parsed.json && !parsed.skipToCurrent && parsed.through === null &&
      parsed.before === null && parsed.find === null) {
    await showJoinedTail(profile, io, dependencies, clock);
  }
  let result;
  try {
    result = command === 'history' && parsed.skipToCurrent
      ? await executeSkipToCurrent(parsed, profile, profiles, io, dependencies)
      : command === 'history' && parsed.through !== null
        ? await executeThroughHistory(parsed, profile, profiles, io, dependencies)
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

// ---- The connection's three facts (admitted · last answered mention · doorbell) ----
// Each is its own evidence. None of them claims the model is attending: the
// room records deliveries and posts, and the doorbell records its polls.

const FACTS_TIMEOUT_MS = 10_000;

async function admittedFact(fetcher, profile) {
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/session', { timeoutMs: FACTS_TIMEOUT_MS });
    const connection = exactObject(result, ['ok', 'connection']) ? result.connection : null;
    if (!validConnection(connection, profile) || connection.subject_id !== profile.subject_id) {
      return { state: 'unknown', detail: 'the room answered, but not with this exact connection' };
    }
    return { state: 'yes', detail: `the room accepts this connection until ${new Date(connection.expires_at).toISOString()}` };
  } catch (error) {
    if (error && error.status === 401 && error.code === 'invalid-connection') {
      // The room answers a released seat and a removed one alike, so both are
      // named; only the profile's own end date tells expiry apart.
      if (Number.isSafeInteger(profile.expires_at) && profile.expires_at <= Date.now()) {
        return { state: 'no', detail: `this connection expired at ${new Date(profile.expires_at).toISOString()}; rejoin with \`interlock join\`` };
      }
      return { state: 'no', detail: 'the room released this connection after 24 h without a check-in ' +
        '(its computer may have restarted or its session closed), or the owner removed it in Settings; ' +
        'rejoin with `interlock join`' };
    }
    return { state: 'unknown', detail: roomUnreachable(error) ? 'the room could not be reached' : 'the room did not answer usably' };
  }
}

// The last answered mention: an addressed message the room delivered to this
// seat and a post by the seat after it. A read-and-reply, not proof the
// doorbell rang.
async function lastAnsweredFact(fetcher, profile) {
  const empty = { ring_id: null, reply_id: null, replied_at: null };
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/last-answered', { timeoutMs: FACTS_TIMEOUT_MS });
    if (!exactObject(result, ['ok', 'last_answered'])) throw incompatibleResponse();
    if (result.last_answered === null) {
      return Object.assign({ state: 'none', detail: 'the room has no delivered @mention followed by a post from you' }, empty);
    }
    const found = exactObject(result.last_answered, ['ring_id', 'reply_id', 'replied_at']);
    if (!found || !Number.isSafeInteger(found.ring_id) || !Number.isSafeInteger(found.reply_id) ||
        found.reply_id <= found.ring_id || !Number.isSafeInteger(found.replied_at)) throw incompatibleResponse();
    return {
      state: 'found', ring_id: found.ring_id, reply_id: found.reply_id, replied_at: found.replied_at,
      detail: `#${found.ring_id} → reply #${found.reply_id} (${new Date(found.replied_at).toISOString()})`,
    };
  } catch (error) {
    if (error && error.status === 404) {
      return Object.assign({ state: 'unknown', detail: 'this room does not report it (Interlock 0.3.7 or older)' }, empty);
    }
    return Object.assign({
      state: 'unknown',
      detail: roomUnreachable(error) ? 'the room could not be reached' : 'the room did not answer usably',
    }, empty);
  }
}

// From the doorbell adapter's own evidence on this computer. It says whether
// an adapter is running now; whether something restarts it after a reboot or
// restart is up to the host setup, which the product cannot see.
// `inspect` is the doorbell's inspectStatus; the doorbell passes its own,
// since it is still loading when its status command runs.
function doorbellFact(connection, stateDir, inspect = null) {
  let status;
  try {
    status = (inspect || require('../integrations/doorbell.js').inspectStatus)(
      { adapter: null, connection, session: null, stateDir: stateDir || null });
  } catch (_) {
    return { state: 'unverifiable', label: 'unverifiable', detail: 'the doorbell state on this computer could not be read' };
  }
  const where = typeof status.state_dir === 'string' ? status.state_dir : stateDir || 'the default state directory';
  if (status.state === 'ready') return { state: 'running', label: 'running', detail: status.detail };
  // A live adapter retrying an unreachable room, or a refused credential.
  // (`retrying` from 0.4.0; an older adapter said `mismatch` with this detail.)
  if (status.state === 'retrying' ||
      (status.state === 'mismatch' && /^no successful poll in the last /.test(status.detail))) {
    return { state: 'running', label: 'running, polls failing', detail: status.detail };
  }
  if (status.state === 'absent') {
    // Not proof the seat is deaf: a hook-driven poller records itself only
    // after its first pass, and since 0.4.2 a ring waits for that poll.
    return {
      state: 'none', label: `none yet in ${where}`,
      detail: `no doorbell has run yet for ${connection} on this computer; a hook-driven poller ` +
        "(e.g. Claude Code's Stop hook) appears after its first pass, and until then an @mention is held " +
        'until it next polls. With no hook, arm the doorbell join printed',
    };
  }
  if (status.state === 'stale') {
    return {
      state: 'none', label: `none in ${where}`,
      detail: 'an adapter ran from there and is not running now; whether something restarts it is up to your host setup',
    };
  }
  return { state: 'unverifiable', label: 'unverifiable', detail: status.detail };
}

// Just after a join the room has already said yes; that answer is reused.
function joinedAdmission(profile) {
  return { state: 'yes', detail: `the room accepts this connection until ${new Date(profile.expires_at).toISOString()}` };
}

// What the room itself shows for this seat (0.4.0): the reason it is or is
// not answering, as the room computes it, and what would change it.
const ROOM_KINDS = Object.freeze(['listening', 'working', 'rung', 'pending', 'away', 'left', 'ended', 'unreachable', 'unknown']);
// People's words for them, so status and People say the same thing.
const ROOM_WORDS = Object.freeze({
  listening: 'listening', working: 'working', rung: 'rung by webhook', pending: 'waiting to be let in',
  away: 'not listening', left: 'left', ended: 'ended', unreachable: 'unreachable',
  unknown: 'not known since the room restarted',
});
async function roomShowsFact(fetcher, profile) {
  const blank = { kind: null, since: null, next: null, session: null };
  try {
    const result = await localRequest(fetcher, profile, '/api/ai/presence-kind', { timeoutMs: FACTS_TIMEOUT_MS });
    const kind = exactObject(result, ['ok', 'presence_kind', 'session']) ? exactObject(result.presence_kind, ['kind', 'since', 'next']) : null;
    if (!kind || !ROOM_KINDS.includes(kind.kind) || !(kind.since === null || Number.isSafeInteger(kind.since)) ||
        !(kind.next === null || typeof kind.next === 'string')) throw incompatibleResponse();
    // "unknown" already reads "since the room restarted": its time is when.
    const since = kind.since === null ? ''
      : `${kind.kind === 'unknown' ? ' at' : ' since'} ${new Date(kind.since).toISOString()}`;
    if (!(result.session === null || (Number.isSafeInteger(result.session) && result.session > 0))) throw incompatibleResponse();
    return {
      state: kind.kind, kind: kind.kind, since: kind.since, next: kind.next, session: result.session,
      detail: `${ROOM_WORDS[kind.kind] || kind.kind}${since}${kind.next === null ? '' : ` — ${kind.next}`}`,
    };
  } catch (error) {
    if (error && error.status === 404) {
      return Object.assign({ state: 'unknown', detail: 'this room does not report it (Interlock 0.3.11 or older)' }, blank);
    }
    return Object.assign({
      state: 'unknown', detail: roomUnreachable(error) ? 'the room could not be reached' : 'the room did not answer usably',
    }, blank);
  }
}

// `withRoom`: also ask the room what it shows for this seat (status and the
// doorbell's status do; join's closing summary does not).
async function connectionFacts(fetcher, profile, stateDir, admitted = null, inspect = null, withRoom = false) {
  const facts = {
    admitted: admitted || await admittedFact(fetcher, profile),
    last_answered: await lastAnsweredFact(fetcher, profile),
    doorbell: doorbellFact(profile.name, stateDir, inspect),
  };
  if (withRoom) {
    facts.room_shows = await roomShowsFact(fetcher, profile);
    // Which run answered: this connection's own session, as People labels it.
    if (facts.last_answered.state === 'found' && Number.isSafeInteger(facts.room_shows.session)) {
      facts.last_answered.detail += ` · Session ${facts.room_shows.session}`;
    }
  }
  return facts;
}

// For `interlock-doorbell status`: the three facts for a connection name,
// never throwing. A name with no admitted local profile still gets its
// doorbell fact; the room facts say why they are unknown.
async function connectionFactsFor(name, options = {}) {
  const dependencies = options.dependencies || {};
  const stateDir = options.stateDir || null;
  let selected;
  try { selected = selectedConnection(name, dependencies); }
  catch (error) {
    const why = error && error.code === 'profile-not-found'
      ? 'no local connection with this name on this computer'
      : error && error.code === 'not-admitted'
        ? 'this computer holds only an unfinished join for this name'
        : 'the local connection could not be read';
    return {
      admitted: { state: 'unknown', detail: why },
      last_answered: { state: 'unknown', ring_id: null, reply_id: null, replied_at: null, detail: why },
      doorbell: doorbellFact(name, stateDir, options.inspect),
      room_shows: { state: 'unknown', kind: null, since: null, next: null, session: null, detail: why },
    };
  }
  return await connectionFacts(dependencies.fetch || globalThis.fetch, selected.profile, stateDir,
    null, options.inspect, true);
}

function factLines(facts) {
  return [
    `Admitted: ${facts.admitted.state} — ${facts.admitted.detail}.`,
  ].concat(facts.room_shows ? [`The room shows: ${terminalSafe(facts.room_shows.detail)}.`] : [], [
    facts.last_answered.state === 'found'
      ? `Last answered mention: ${facts.last_answered.detail}.`
      : `Last answered mention: ${facts.last_answered.state} — ${facts.last_answered.detail}.`,
    '  (A read-and-reply, not proof the doorbell rang.)',
    `Doorbell: ${terminalSafe(facts.doorbell.label || facts.doorbell.state)} — ${terminalSafe(facts.doorbell.detail)}.`,
  ]);
}

async function runStatus(args, io, dependencies = {}) {
  let json = false;
  let connection = null;
  let stateDir = null;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) { connection = null; break; }
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) { connection = null; seen.add('bad'); break; }
    index += 1;
    if (flag === '--connection') connection = value;
    else if (flag === '--state-dir' && path.isAbsolute(value)) stateDir = value;
    else { connection = null; seen.add('bad'); break; }
  }
  if (connection === null || seen.has('bad')) {
    line(io.stderr, 'interlock: usage: interlock status --connection NAME [--state-dir ABSOLUTE_PATH] [--json]');
    return EXIT_USAGE;
  }
  let selected;
  try { selected = selectedConnection(connection, dependencies, io.stderr); }
  catch (error) {
    reportConnectionError(io.stderr, error, connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const facts = await connectionFacts(dependencies.fetch || globalThis.fetch, selected.profile,
    stateDir || dependencies.doorbellStateDir || null, null, null, true);
  if (json) line(io.stdout, JSON.stringify({ ok: true, connection: selected.profile.name, facts }));
  else for (const text of factLines(facts)) line(io.stdout, text);
  return facts.admitted.state === 'yes' ? EXIT_OK : EXIT_RUNTIME;
}

const PAUSE_USAGE = 'interlock: usage: interlock doorbell pause --connection NAME [--reason turn] [--json] | ' +
  'interlock doorbell resume --connection NAME [--json]';

/* The seat tells the room it is working a turn (pause) or is back (resume).
 * Called by whatever knows when a turn starts and ends: a host hook or a
 * waiter. A room that predates the pause (0.3.11 and older) refuses the field;
 * that is said once and is not a failure, so a hook carries on. */
async function runDoorbellPause(verb, args, io, dependencies = {}) {
  let connection = null;
  let reason = null;
  let json = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) return usage();
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return usage();
    index += 1;
    if (flag === '--connection') connection = value;
    else if (flag === '--reason' && verb === 'pause' && value === 'turn') reason = value;
    else return usage();
  }
  if (connection === null) return usage();
  function usage() {
    line(io.stderr, PAUSE_USAGE);
    return EXIT_USAGE;
  }
  let selected;
  try { selected = selectedConnection(connection, dependencies, io.stderr); }
  catch (error) {
    reportConnectionError(io.stderr, error, connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const { profile } = selected;
  const pause = verb === 'pause' ? { reason: reason || 'turn' } : null;
  let result;
  try {
    result = await localRequest(dependencies.fetch || globalThis.fetch, profile, '/api/ai/presence', {
      method: 'POST', body: { pause }, stderr: io.stderr,
    });
    const shaped = exactObject(result, ['ok', 'pause']);
    if (!shaped || !(result.pause === null || (exactObject(result.pause, ['reason', 'since', 'expires_at']) &&
        Number.isSafeInteger(result.pause.since) && Number.isSafeInteger(result.pause.expires_at)))) {
      throw incompatibleResponse();
    }
  } catch (error) {
    if (error && error.status === 400 && error.code === 'invalid-request') {
      const said = 'this room does not support pause (Interlock 0.3.11 or older); nothing changed';
      if (json) line(io.stdout, JSON.stringify({ ok: true, connection: profile.name, supported: false, pause: null }));
      else line(io.stdout, said + '.');
      return EXIT_OK;
    }
    reportRequestError(io.stderr, error, profile);
    return roomUnreachable(error) ? EXIT_UNREACHABLE : EXIT_RUNTIME;
  }
  if (json) {
    line(io.stdout, JSON.stringify({ ok: true, connection: profile.name, supported: true, pause: result.pause }));
  } else if (result.pause) {
    line(io.stdout, `Paused for a turn: the room shows ${terminalSafe(profile.name)} as working until it polls ` +
      `again, for up to 3 hours (until ${new Date(result.pause.expires_at).toISOString()}).`);
  } else {
    line(io.stdout, `Resumed: the room no longer shows ${terminalSafe(profile.name)} as working.`);
  }
  return EXIT_OK;
}

async function runDoorbell(args, io, dependencies = {}) {
  if (args[0] === 'pause' || args[0] === 'resume') return runDoorbellPause(args[0], args.slice(1), io, dependencies);
  const parsed = commandOptions('doorbell', args);
  if (!parsed) {
    line(io.stderr,
      'interlock: usage: interlock doorbell --connection NAME [--after MESSAGE_ID] [--json]');
    return EXIT_USAGE;
  }
  let selected;
  try {
    selected = selectedConnection(parsed.connection, dependencies, io.stderr);
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
  let facts = true;
  try {
    const fetcher = dependencies.fetch || globalThis.fetch;
    const ask = withFacts => localRequest(fetcher, profile,
      `/api/ai/rings?after=${after}&limit=${HISTORY_PEEK_LIMIT}&wait=1${withFacts ? '&facts=1' : ''}`,
      { timeoutMs: LISTEN_FETCH_TIMEOUT_MS });
    try {
      page = await ask(true);
    } catch (error) {
      // A room older than 0.4.0 refuses the unknown parameter at once; it is
      // asked again without it, and its rings get the 0.3 line.
      if (!(error && error.status === 400 && error.code === 'invalid-ring-query')) throw error;
      facts = false;
      page = await ask(false);
    }
    // A page is judged by what it is: one that carries `room` is a facts
    // page, whatever was asked; a room that ignores the parameter answers the
    // 0.3 page, which stays valid.
    facts = facts && page !== null && typeof page === 'object' && Object.prototype.hasOwnProperty.call(page, 'room');
    if (!validRingPage(page, after, facts)) throw incompatibleResponse();
  } catch (error) {
    reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
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
      line(io.stdout, ring.ring
        ? `Interlock ring ${ring.id}: ${ring.ring.kind} from ${terminalSafe(ring.byline)}${session} · Room time: ${terminalSafe(ring.ring.room_time)}.`
        : `Interlock ring ${ring.id} from ${terminalSafe(ring.byline)}${session}.`);
    }
    // Name the one command that reads up to the message that rang.
    const last = Math.max(...page.rings.map(ring => ring.id));
    line(io.stdout,
      `Run \`interlock history --connection ${terminalSafe(profile.name)} --through ${last}\`; ` +
      'if it says there is more to read, run the same command again.');
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
  'ask-not-withdrawn': 'only a withdrawn ask can point at the ask that replaces it; that one was answered, not withdrawn.',
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
    annotation.answers = parsed.answers.map(entry => ({ ask_id: entry.ask_id, choice: parsed.choice, revision: entry.revision }));
  }
  if (parsed.discusses !== null) annotation.discusses = parsed.discusses;
  if (parsed.status !== null) {
    annotation.status = parsed.status;
    annotation.read_through = cursor;
  }
  return Object.keys(annotation).length > 0 ? annotation : null;
}

// Whom a sent message rang, from the room's own frozen delivery list: the
// author sees it at once instead of re-reading history.
function rangWords(message) {
  const names = message.delivery.map(entry => terminalSafe(entry.name) +
    (entry.session === null ? '' : ` (Session ${entry.session})`));
  // The list holds AIs only: a person named in the post is still notified.
  if (names.length === 0) return 'Rang no AI.';
  const everyone = InterlockMentions.tokens(message.text).some(token => token.handle === 'all');
  // The tag is named in words: a line an AI may paste must not broadcast.
  return `Rang${everyone ? ` ${names.length} (all-seats tag)` : ''}: ${names.join(', ')}.`;
}

// Every local connection, its room address and its state, read from the
// profiles alone: no token file is opened and no secret is printed. This is
// the way to find a connection's room without opening its profile.
function runRooms(args, io, dependencies = {}) {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length > 0 && !json) {
    line(io.stderr, 'interlock: usage: interlock rooms [--json]');
    return EXIT_USAGE;
  }
  const profileModule = dependencies.profiles || require('./client/profiles.js');
  const config = dependencies.config || require('./config.js');
  let connectionDir;
  let rows;
  try {
    connectionDir = config.resolveConnectionDir({
      env: dependencies.env || process.env,
      platform: dependencies.platform || process.platform,
      homedir: dependencies.homedir,
    });
    rows = profileModule.openProfiles({ connectionDir }).summaries();
  } catch (error) {
    line(io.stderr, `interlock: the connections on this computer could not be read (${terminalSafe(error && error.code || 'unknown')}).`);
    return EXIT_RUNTIME;
  }
  const now = (dependencies.clock || Date.now)();
  const connections = rows.map(row => ({
    name: row.name,
    server_url: row.server_url,
    state: row.state === 'admitted' && row.expires_at <= now ? 'expired' : row.state,
    expires_at: row.expires_at,
  }));
  if (json) {
    line(io.stdout, JSON.stringify({ ok: true, connections }));
    return EXIT_OK;
  }
  if (connections.length === 0) {
    line(io.stdout, `No connections on this computer (${terminalSafe(connectionDir)}). Join a room: interlock join --url URL --name NAME`);
    return EXIT_OK;
  }
  line(io.stdout, `Connections on this computer (${terminalSafe(connectionDir)}):`);
  for (const row of connections) {
    const state = row.state === 'unadmitted' ? 'waiting to be let in'
      : row.state === 'expired' ? `expired at ${new Date(row.expires_at).toISOString()}`
        : `admitted until ${new Date(row.expires_at).toISOString()}`;
    line(io.stdout, `  ${terminalSafe(row.name)} → ${terminalSafe(row.server_url)} → ${state}`);
  }
  return EXIT_OK;
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
      '--choice', '--status', '--discusses'].includes(arg))) {
      line(io.stderr, 'interlock: usage: interlock say --connection NAME --file PATH|--stdin [--asks-of NAME [--means-file PATH | --means-stdin] [--deliver later]] [--answers N[@REV][,N[@REV]...] [--choice yes|no] | --discusses N] [--status done|ready|stop] [--json]');
      return EXIT_USAGE;
    }
    return refuseSay(io.stderr);
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
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
      if (annotation === null) reportRequestError(io.stderr, error, profile, parsed.json ? io.stdout : null);
      else reportAnnotationError(io.stderr, error, profile, parsed.connection);
      return EXIT_RUNTIME;
    }
  }
  if (!exactObject(result, ['ok', 'message']) || !validPublicMessage(result.message)) {
    line(io.stdout, 'Message accepted by the local Interlock, but its receipt does not match this CLI version. Do not retry; use the command from the same Interlock release as the running room.');
    return EXIT_OK;
  }
  if (parsed.json) line(io.stdout, JSON.stringify(result));
  else {
    line(io.stdout, `Sent as ${profile.name} (message ${result.message.id}). ${rangWords(result.message)}`);
  }
  // Words with no choice close a plain ask, but only discuss a decision or a
  // request for approval: say so, so nobody takes them for a decision.
  if (!parsed.json && Array.isArray(parsed.answers) && parsed.answers.length > 0 && parsed.choice === null) {
    const ids = parsed.answers.map(entry => entry.ask_id).join(', ');
    line(io.stdout, `If ask ${ids} is a decision or a request for approval, it stays open: words alone are discussion; add --choice yes|no to decide.`);
  }
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

const ASK_BASE_KEYS = Object.freeze([
  'ask_id', 'asked_at', 'by', 'of', 'of_kind', 'means', 'deliver', 'project', 'state', 'kept_open',
  'carried_from', 'answers',
]);
// Later fields an ask may carry: whose turn it is, its latest exchange, and
// its earlier scopes. Each is optional, so an older room still reads.
const ASK_STORY_KEYS = Object.freeze(['revision', 'revisions', 'latest', 'done', 'turn', 'approval']);

function askWithStory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!ASK_BASE_KEYS.every(key => keys.includes(key)) ||
      !keys.every(key => ASK_BASE_KEYS.includes(key) || ASK_STORY_KEYS.includes(key))) return null;
  if (value.turn !== undefined && value.turn !== null &&
      !(typeof value.turn === 'object' && typeof value.turn.phase === 'string')) return null;
  if (value.latest !== undefined && value.latest !== null &&
      !(typeof value.latest === 'object' && typeof value.latest.by === 'string' && typeof value.latest.kind === 'string')) return null;
  if (value.revisions !== undefined && !Array.isArray(value.revisions)) return null;
  if (value.approval !== undefined && typeof value.approval !== 'boolean') return null;
  return value;
}

function validPublicAsk(value) {
  const ask = askWithStory(value);
  return !!ask && Number.isSafeInteger(ask.ask_id) && ask.ask_id > 0 &&
    typeof ask.by === 'string' && validAskFields({
      of: ask.of, of_kind: ask.of_kind, means: ask.means, deliver: ask.deliver, project: ask.project,
    }) && typeof ask.state === 'string' && Array.isArray(ask.answers);
}

const { turnWords } = require('./web/ask_turn.js');
const LATEST_WORDS = Object.freeze({ ask: 'asked', revise: 'revised', discussion: 'replied', answer: 'answered' });

const STALE_DECISION_WORDS = 'interlock: the decision record did not follow this revision; it keeps the earlier scope and records no answer to the new one.';

function renderAsk(ask, mine, viewer = null) {
  const who = mine ? `of ${terminalSafe(ask.of)}` : `by ${terminalSafe(ask.by)}`;
  const later = ask.deliver === 'later' ? ' · held for later' : '';
  const carried = ask.carried_from ? ' · from an archived era' : '';
  const kept = ask.kept_open ? ' · kept open' : '';
  const means = ask.means === null ? '' : ` — a yes means: ${terminalSafe(ask.means)}`;
  const turn = ask.turn ? ` [${terminalSafe(turnWords(ask.turn, viewer))}]` : '';
  const latest = ask.latest ? `\n      latest: ${terminalSafe(ask.latest.by)} · ${terminalSafe(LATEST_WORDS[ask.latest.kind] || ask.latest.kind)}${
    ask.latest.message_id ? ` #${ask.latest.message_id}` : ''}` : '';
  // A revised ask shows its revision as `--answers` takes it: an answer that
  // names none was given to the first, and the room refuses it.
  const id = Number.isSafeInteger(ask.revision) && ask.revision > 1 ? `${ask.ask_id}@${ask.revision}` : `${ask.ask_id}`;
  return `  ask ${id} ${who}${turn}${later}${carried}${kept}${means}${latest}`;
}

async function connectedProfile(parsed, io, dependencies) {
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
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
    for (const ask of result.addressed) line(io.stdout, renderAsk(ask, false, profile.name));
  }
  if (result.asked.length > 0) {
    line(io.stdout, 'You asked:');
    for (const ask of result.asked) line(io.stdout, renderAsk(ask, true, profile.name));
  }
  return EXIT_OK;
}

const ASK_VERBS = Object.freeze({ withdraw: 'withdraw', 'keep-open': 'keep_open', revise: 'revise' });

// A revision's new scope line is text, so like any message it comes from a
// file or stdin, never argv.
function reviseSource(args) {
  const rest = [];
  let means = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if ((flag === '--means-file' || flag === '--means-stdin') && means !== null) return null;
    if (flag === '--means-file') {
      if (sayValue(args, index) === null) return null;
      means = { kind: 'file', path: args[index + 1] };
      index += 1;
    } else if (flag === '--means-stdin') {
      means = { kind: 'stdin' };
    } else rest.push(flag);
  }
  return { means, rest };
}

// `--replaced-by M` on a withdraw: the asker's own ask M replaces this one.
function replacedBySource(args) {
  const rest = [];
  let replacedBy = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--replaced-by') {
      rest.push(args[index]);
      continue;
    }
    const value = args[index + 1];
    if (replacedBy !== null || typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) ||
        !Number.isSafeInteger(Number(value))) return null;
    replacedBy = Number(value);
    index += 1;
  }
  return { replacedBy, rest };
}

async function runAsk(args, io, dependencies = {}) {
  const verb = args[0];
  const id = args[1];
  const replaced = verb === 'withdraw' ? replacedBySource(args.slice(2)) : { replacedBy: null, rest: args.slice(2) };
  if (!replaced || replaced.replacedBy === Number(id)) {
    line(io.stderr, 'interlock: usage: interlock ask withdraw N [--replaced-by M] --connection NAME [--json] (M is another ask of yours)');
    return EXIT_USAGE;
  }
  if (args.some(arg => arg === '--means' || String(arg).startsWith('--means='))) {
    line(io.stderr, 'interlock: refusing an ask\'s scope line in command arguments; use --means-file PATH or --means-stdin.');
    return EXIT_USAGE;
  }
  const source = verb === 'revise' ? reviseSource(replaced.rest) : { means: null, rest: replaced.rest };
  const parsed = Object.prototype.hasOwnProperty.call(ASK_VERBS, verb) && source &&
    (verb === 'revise') === (source.means !== null) &&
    typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))
    ? askOptions(source.rest) : null;
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock ask withdraw|keep-open N --connection NAME [--json]  ·  interlock ask revise N --means-file PATH|--means-stdin --connection NAME [--json]');
    return EXIT_USAGE;
  }
  const { profile, code } = await connectedProfile(parsed, io, dependencies);
  if (!profile) return code;
  const body = { kind: ASK_VERBS[verb], ask_id: Number(id) };
  if (verb === 'revise') {
    try {
      body.means = readScopeLine(source.means.kind === 'file'
        ? (dependencies.readFile || fs.readFileSync)(source.means.path, 'utf8')
        : await (dependencies.readStdin || readStdin)(io.stdin || process.stdin));
    } catch (_) {
      line(io.stderr, 'interlock: could not read the new scope line safely.');
      return EXIT_RUNTIME;
    }
  }
  let result;
  // Already withdrawn: a --replaced-by still links it.
  let alreadyWithdrawn = false;
  try {
    try {
      result = await localRequest(dependencies.fetch || globalThis.fetch, profile, '/api/ai/annotations', {
        method: 'POST', body,
      });
    } catch (error) {
      if (!(replaced.replacedBy !== null && error && error.code === 'ask-not-open')) throw error;
      alreadyWithdrawn = true;
      result = null;
    }
    // A revise whose decision record could not follow says so.
    if (result !== null && !exactObject(result, ['ok', 'row']) &&
        !(exactObject(result, ['ok', 'row', 'decision']) && result.decision === 'stale')) throw incompatibleResponse();
    if (replaced.replacedBy !== null) {
      const linked = await localRequest(dependencies.fetch || globalThis.fetch, profile, '/api/ai/annotations', {
        method: 'POST', body: { kind: 'successor', ask_id: Number(id), successor_id: replaced.replacedBy },
      });
      if (!exactObject(linked, ['ok', 'row'])) throw incompatibleResponse();
      if (parsed.json) {
        if (result !== null) line(io.stdout, JSON.stringify(result));
        line(io.stdout, JSON.stringify(linked));
      } else {
        line(io.stdout, alreadyWithdrawn
          ? `Ask ${id} was already withdrawn; it now points at ask ${replaced.replacedBy}.`
          : `Withdrew ask ${id}; re-asked as ask ${replaced.replacedBy}.`);
      }
      return EXIT_OK;
    }
  } catch (error) {
    reportAnnotationError(io.stderr, error, profile, parsed.connection);
    // The withdraw stands even when its link was refused.
    if (replaced.replacedBy !== null && result !== null && result !== undefined) {
      line(io.stderr, `interlock: ask ${id} was withdrawn, but it was not linked to ask ${replaced.replacedBy}.`);
    }
    return EXIT_RUNTIME;
  }
  // One line for one act: --json prints the result alone; a revise says it
  // was revised, not that it reopened.
  if (parsed.json) {
    line(io.stdout, JSON.stringify(result));
    return EXIT_OK;
  }
  if (verb === 'revise') line(io.stdout, `Revised ask ${id}: a yes now means: ${terminalSafe(body.means)}. It is their turn again.`);
  if (result.decision === 'stale') line(io.stderr, STALE_DECISION_WORDS);
  else if (verb !== 'revise') line(io.stdout, verb === 'withdraw' ? `Withdrew ask ${id}.` : `Ask ${id} is open again.`);
  return EXIT_OK;
}

// A connection, then one action: a presence line from a JSON file
// ({ middle, waiting_on, need }, the lines never in argv), a clear, or a
// project (this AI's own, or with --assign another seat's, which only the
// project's lead may set).
function presenceOptions(args) {
  const options = { connection: null, file: null, middle: false, clear: false, project: undefined, assign: null, json: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--clear') { options.clear = true; continue; }
    if (flag === '--middle-stdin') { options.middle = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return null;
    index += 1;
    if (flag === '--connection') options.connection = value;
    else if (flag === '--file') options.file = value;
    else if (flag === '--project') options.project = value === 'none' ? null : value;
    else if (flag === '--assign') options.assign = value;
    else return null;
  }
  const actions = [options.file !== null, options.middle, options.clear, options.project !== undefined].filter(Boolean).length;
  if (options.connection === null || actions !== 1) return null;
  if (options.assign !== null && options.project === undefined) return null;
  return Object.freeze(options);
}

async function runPresence(args, io, dependencies = {}) {
  const parsed = presenceOptions(args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock presence --connection NAME --file PATH | --middle-stdin | --clear | --project ID|none [--assign NAME] [--json]');
    return EXIT_USAGE;
  }
  let body;
  let route = '/api/ai/presence';
  if (parsed.project !== undefined) {
    route = '/api/ai/project';
    body = parsed.assign === null ? { project: parsed.project } : { seat_name: parsed.assign, project: parsed.project };
  } else if (parsed.clear) {
    body = { middle: null, waiting_on: null, need: null };
  } else if (parsed.middle) {
    // One command for "in the middle of": one piped line, replacing the
    // presence line; the seat's next post clears it from People.
    let piped;
    try { piped = await (dependencies.readStdin || readStdin)(io.stdin || process.stdin); }
    catch (_) {
      line(io.stderr, 'interlock: could not read the piped line safely.');
      return EXIT_RUNTIME;
    }
    const middle = String(piped).replace(/\r?\n$/, '');
    if (middle.trim() === '' || /[\r\n]/.test(middle)) {
      line(io.stderr, 'interlock: --middle-stdin takes one line: what you are in the middle of.');
      return EXIT_USAGE;
    }
    body = { middle, waiting_on: null, need: null };
  } else {
    let text;
    try { text = (dependencies.readFile || fs.readFileSync)(parsed.file, 'utf8'); }
    catch (_) {
      line(io.stderr, 'interlock: could not read the presence file safely.');
      return EXIT_RUNTIME;
    }
    let input;
    try { input = JSON.parse(text); } catch (_) { input = null; }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['middle', 'waiting_on', 'need'].includes(key))) {
      line(io.stderr, 'interlock: the presence file must be a JSON object with middle, waiting_on and need (each text or null).');
      return EXIT_USAGE;
    }
    body = { middle: input.middle ?? null, waiting_on: input.waiting_on ?? null, need: input.need ?? null };
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  try {
    const result = await localRequest(fetcher, selected.profile, route, {
      method: 'POST', body, timeoutMs: COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr,
    });
    if (parsed.json) line(io.stdout, JSON.stringify(result));
    else if (route === '/api/ai/project') {
      const who = parsed.assign === null ? 'This AI' : terminalSafe(parsed.assign);
      line(io.stdout, parsed.project === null ? `${who} is now not assigned to a project.`
        : `${who} is now on project ${terminalSafe(parsed.project)}.`);
    } else line(io.stdout, parsed.clear ? 'Presence line cleared.' : 'Presence line set.');
    return EXIT_OK;
  } catch (error) {
    reportRequestError(io.stderr, error, selected.profile);
    return EXIT_RUNTIME;
  }
}

function grantsOptions(args) {
  const options = { connection: null, json: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--json') options.json = true;
    else if (flag === '--connection' && typeof args[index + 1] === 'string' && args[index + 1].length > 0 &&
      !args[index + 1].startsWith('--')) {
      options.connection = args[index + 1];
      index += 1;
    } else return null;
  }
  return options.connection === null ? null : Object.freeze(options);
}

async function runGrants(args, io, dependencies = {}) {
  const parsed = grantsOptions(args);
  if (!parsed) {
    line(io.stderr, 'interlock: usage: interlock grants --connection NAME [--json]');
    return EXIT_USAGE;
  }
  let selected;
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
  catch (error) {
    reportConnectionError(io.stderr, error, parsed.connection);
    return error && error.code === 'invalid-name' ? EXIT_USAGE : EXIT_RUNTIME;
  }
  const fetcher = dependencies.fetch || globalThis.fetch;
  try {
    const result = await localRequest(fetcher, selected.profile, '/api/ai/grants', {
      timeoutMs: COMMAND_FETCH_TIMEOUT_MS, stderr: io.stderr,
    });
    if (!Array.isArray(result.grants)) throw incompatibleResponse();
    if (parsed.json) { line(io.stdout, JSON.stringify(result)); return EXIT_OK; }
    if (result.grants.length === 0) line(io.stdout, 'No grants in this room.');
    for (const grant of result.grants) {
      const until = grant.until === null ? 'until revoked' : `until ${new Date(grant.until).toISOString()}`;
      line(io.stdout, `${terminalSafe(grant.grant_id)} · ${terminalSafe(grant.state)} · ${terminalSafe(grant.holder_name)}` +
        ` · ${grant.project === null ? 'whole room' : terminalSafe(grant.project)} · ${terminalSafe(grant.scope)}` +
        ` · by ${terminalSafe(grant.by_name)} · ${until}`);
    }
    return EXIT_OK;
  } catch (error) {
    reportRequestError(io.stderr, error, selected.profile);
    return EXIT_RUNTIME;
  }
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
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
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
  // The room has ended this connection, so its doorbell cursors are spent.
  // Removing them lets a later join under this name start its doorbell
  // without --replace-connection.
  try {
    const doorbell = dependencies.doorbell || require('../integrations/doorbell.js');
    doorbell.forgetConnectionCursors(dependencies.doorbellStateDir || doorbell.defaultStateDir(),
      profile.name, profile.request_id);
  } catch (_) {
    line(io.stderr, 'interlock: the doorbell state for this connection could not be cleared; a later doorbell under this name may need --replace-connection once.');
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
    const valid = validConnection(connected, profile);
    return Object.freeze({
      connected: valid ? connected : null,
      exactInvalid: false,
      why: valid ? null : 'the room answered with a different connection',
    });
  } catch (error) {
    return Object.freeze({
      connected: null,
      exactInvalid: Boolean(error && error.status === 401 &&
        error.code === 'invalid-connection' && error.exact),
      why: confirmationWhy(error),
    });
  }
}

// Why the room did not confirm a candidate, in a few words.
function confirmationWhy(error) {
  if (!error || !Number.isSafeInteger(error.status)) return `the room could not be reached: ${networkCause(error)}`;
  if (error.status === 401 && error.code === 'invalid-connection') return 'the room has not admitted it';
  return `the room answered ${error.status} ${typeof error.code === 'string' ? error.code : 'unavailable'}`;
}

function unconfirmedRefusal(stderr, profile, why) {
  line(stderr, `interlock: the exact unfinished candidate ${terminalSafe(profile.name)} was not confirmed (${why}). It was kept and no new admission was created.`);
  line(stderr, `If this join is yours, resume it: interlock join --resume --name ${terminalSafe(profile.name)}`);
  line(stderr, `Or drop it: interlock join --discard --name ${terminalSafe(profile.name)}`);
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

// Settles the unfinished candidate for one connection name: confirms its own
// credential with the room and, if the room admitted it, records that once.
// It never knocks. `join --resume` and a doorbell waiting on a pending
// profile both call it, possibly at the same moment; the profile store writes
// under its lock, so one caller answers wrote: true and the other reads the
// same record with wrote: false.
//   { outcome: 'admitted', profile, wrote, staged }
//   { outcome: 'not-admitted', candidate, staged, exactInvalid, wrote: false }
//   { outcome: 'none', wrote: false }      no candidate or profile by that name
async function settleCandidate(profiles, name, fetcher, serverUrl, clock = Date.now) {
  let candidate = null;
  let staged = false;
  if (profiles.stagedExists(name)) {
    try {
      candidate = profiles.loadStaged(name);
      staged = true;
    } catch (error) {
      // The other caller finished it between the two reads.
      if (!error || error.code !== 'staged-profile-not-found') throw error;
    }
  }
  if (candidate === null) {
    if (!profiles.exists(name)) return Object.freeze({ outcome: 'none', wrote: false });
    const current = profiles.load(name);
    if (current.state === 'admitted') {
      return Object.freeze({ outcome: 'admitted', profile: current, wrote: false, staged: false });
    }
    candidate = current;
  }
  const confirmation = await candidateConfirmation(fetcher, serverUrl, candidate);
  if (!confirmation.connected) {
    return Object.freeze({
      outcome: 'not-admitted', candidate, staged,
      exactInvalid: confirmation.exactInvalid, why: confirmation.why, wrote: false,
    });
  }
  const recorded = profiles.admitCandidate(candidate.name, Object.assign(
    { request_id: candidate.request_id, admitted_at: clock() }, confirmation.connected));
  return Object.freeze({ outcome: 'admitted', profile: recorded.profile, wrote: recorded.wrote, staged });
}

// The unfinished candidate by this name, in either form, or null. An
// admitted profile with no staged replacement is not a candidate.
function unfinishedCandidate(profiles, name) {
  if (profiles.stagedExists(name)) {
    try { return { profile: profiles.loadStaged(name), staged: true }; }
    catch (error) { if (!error || error.code !== 'staged-profile-not-found') throw error; }
  }
  if (!profiles.exists(name)) return null;
  const profile = profiles.load(name);
  return profile.state === 'admitted' ? null : { profile, staged: false };
}

// join --discard: removes an unfinished candidate only once the room has
// said it does not hold it as admitted. If the room did admit it, that is
// recorded and kept, and the way to end it is leave.
async function runDiscard(profiles, name, fetcher, clock, io) {
  const found = unfinishedCandidate(profiles, name);
  if (!found) {
    line(io.stderr, profiles.exists(name)
      ? `interlock: ${terminalSafe(name)} is admitted, not an unfinished candidate. To end it: interlock leave --connection ${terminalSafe(name)}`
      : `interlock: there is no unfinished candidate named ${terminalSafe(name)} in this connection directory.`);
    return EXIT_RUNTIME;
  }
  const { profile, staged } = found;
  const settled = await settleCandidate(profiles, name, fetcher, profile.server_url, clock);
  if (settled.outcome === 'admitted') {
    line(io.stderr, `interlock: the room had admitted ${terminalSafe(name)}, so it was kept and is now saved as connected. To end it: interlock leave --connection ${terminalSafe(name)}`);
    return EXIT_RUNTIME;
  }
  const waitingUntil = profile.created_at + CANDIDATE_MAY_BE_WAITING_MS;
  if (settled.outcome === 'not-admitted' && clock() < waitingUntil) {
    line(io.stderr, `interlock: ${terminalSafe(name)}'s request may still be waiting on the owner's card until ${new Date(waitingUntil).toISOString()}, and an Allow before then would admit it. The candidate was kept.`);
    line(io.stderr, 'The room answers a waiting request exactly like one it never admitted, so that answer cannot show it is safe to drop.');
    line(io.stderr, `Run --discard again after that time. The owner can Decline it in People meanwhile, so it cannot be allowed.`);
    return EXIT_RUNTIME;
  }
  if (settled.outcome !== 'not-admitted' || !settled.exactInvalid) {
    line(io.stderr, `interlock: could not confirm that ${terminalSafe(profile.server_url)} never admitted ${terminalSafe(name)} (${settled.why || 'no answer'}). The candidate was kept.`);
    line(io.stderr, 'Run --discard again once the room is reachable, or join under another name.');
    return EXIT_RUNTIME;
  }
  try {
    removeJoinCandidate(profiles, profile, staged);
  } catch (error) {
    if (error && error.code === 'profile-collision') {
      line(io.stderr, `interlock: ${terminalSafe(name)} changed while discarding (another join or doorbell may have finished it). Nothing was removed; run interlock status --connection ${terminalSafe(name)}.`);
      return EXIT_RUNTIME;
    }
    throw error;
  }
  line(io.stdout, `Discarded the unfinished candidate ${terminalSafe(name)}. The room had not admitted it${staged ? '; the admitted connection it would have replaced is unchanged' : ''}.`);
  return EXIT_OK;
}

// The project and model a seat declares travel on the knock only when given,
// so a knock to an older room is exactly what it was.
function admissionBody(profile, declared = {}) {
  return Object.assign({
    request_id: profile.request_id,
    name: profile.name,
    product: profile.product,
    product_provenance: profile.product_provenance,
    selector: profile.selector,
    digest: profile.digest,
  }, declared.project ? { project: declared.project } : {}, declared.model ? { model: declared.model } : {},
  declared.joinCode ? { join_code: declared.joinCode } : {});
}

/* A member's one-time AI join code: `--code CODE`, `--code -` (read
 * from stdin), or INTERLOCK_JOIN_CODE, so the code need not sit in shell
 * history or the process list. Null when none is given. */
async function joinCodeOf(parsed, io, dependencies) {
  let code = parsed.code;
  if (code === '-') {
    const text = await (dependencies.readStdin || readStdin)(io.stdin || process.stdin);
    code = String(text).split(/\r?\n/)[0];
  } else if (code === null) {
    const env = dependencies.env || process.env;
    code = typeof env.INTERLOCK_JOIN_CODE === 'string' ? env.INTERLOCK_JOIN_CODE : null;
  }
  code = typeof code === 'string' ? code.trim() : null;
  return code ? code : null;
}

// The one knock for a candidate: the exact body join sends, to the
// candidate's own room. A doorbell holding a pending profile re-posts with
// this, so its knock is identical to join's (same request, selector and
// digest; never the token). Answers the room's result or throws as knock.
function knockCandidate(fetcher, profile, declared = {}) {
  return knock(fetcher, profile.server_url, admissionBody(profile, declared));
}

function joinedOutput(stdout, profile, start = 'tip', facts = null) {
  line(stdout, `Connected as ${profile.name} (${profile.product}).`);
  if (facts) {
    line(stdout, 'Your connection, as three separate facts (none says the model is attending):');
    for (const text of factLines(facts)) line(stdout, '  ' + text);
  }
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
  // Admission and the doorbell are two steps: the join ends with the second.
  line(stdout, 'Next, before you say hello: start your doorbell, keep it running, and check it.');
  line(stdout, `  interlock-doorbell run --adapter codex|stdout --connection ${profile.name} --session HOST_SESSION`);
  line(stdout, `  interlock-doorbell status --connection ${profile.name}`);
  line(stdout, '  run warns if this host session already has one under another name in the same state dir.');
  line(stdout, '  codex for a Codex session (HOST_SESSION is its session id); stdout under a Monitor-class host.');
  line(stdout, '  Run it as a managed long-running command; see `interlock-doorbell guide`.');
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

async function completeJoin(profiles, profile, enrollment, clock, stdout, staged, fetcher, doorbellStateDir = null) {
  // One write for either form; a caller that lost a race reads the record.
  const admitted = profiles.admitCandidate(profile.name, Object.assign(
    { request_id: profile.request_id, admitted_at: clock() },
    enrollment,
  )).profile;
  const start = await applyAdmissionHead(fetcher, admitted, profiles);
  const current = start === 'tip' ? profiles.load(profile.name) : admitted;
  const facts = typeof fetcher === 'function'
    ? await connectionFacts(fetcher, current, doorbellStateDir, joinedAdmission(current)) : null;
  joinedOutput(stdout, current, start, facts);
}

function completedJoinDecision(code) {
  return Object.freeze({ action: 'done', code });
}

// A profile's standing, in words: never admitted, admitted until, expired.
function profileStanding(profile, now) {
  if (profile.state !== 'admitted') return 'It was never admitted.';
  const at = new Date(profile.expires_at).toISOString();
  return profile.expires_at <= now ? `It expired at ${at}.` : `It is admitted there until ${at}.`;
}

// Connection directories beside this one that hold a profile for this room
// and name, read without opening or changing them. The default directory
// and its siblings named connections-* are the known places.
function otherProfilesFor(connectionDir, name, serverUrl, now, dependencies = {}) {
  const found = [];
  let candidates = [];
  try {
    const config = dependencies.config || require('./config.js');
    const env = dependencies.env || process.env;
    const dataDir = typeof config.resolveDataDir === 'function'
      ? config.resolveDataDir({ env, platform: dependencies.platform || process.platform, homedir: dependencies.homedir })
      : path.dirname(connectionDir);
    const parents = [...new Set([dataDir, path.dirname(connectionDir)])];
    for (const parent of parents) {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && /^connections(-[A-Za-z0-9._-]+)?$/.test(entry.name)) {
          candidates.push(path.join(parent, entry.name));
        }
      }
    }
  } catch (_) { return found; }
  candidates = [...new Set(candidates)].filter(dir => path.resolve(dir) !== path.resolve(connectionDir));
  for (const dir of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name.toLowerCase() + '.json'), 'utf8'));
      if (raw && raw.server_url === serverUrl && typeof raw.name === 'string' &&
          raw.name.toLowerCase() === name.toLowerCase()) {
        found.push({ dir, standing: profileStanding(raw, now) });
      }
    } catch (_) { /* nothing there, or not a profile */ }
  }
  return found;
}

function otherProfileNotes(stderr, others) {
  for (const other of others) {
    line(stderr, `Another connection directory holds this name for this room: ${terminalSafe(other.dir)}. ${other.standing}`);
    line(stderr, `  Use it: INTERLOCK_CONNECTION_DIR=${terminalSafe(other.dir)} interlock join …`);
  }
}

function otherRoomRefusal(stderr, profile, serverUrl, now, dependencies, connectionDir, kind) {
  line(stderr, `interlock: ${kind} ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.server_url)}, not this Interlock. ${profileStanding(profile, now)} No new admission was created.`);
  line(stderr, 'Ways forward:');
  line(stderr, '  - join this room under another name (--name);');
  line(stderr, '  - keep a separate set of connections for this room: INTERLOCK_CONNECTION_DIR=/another/dir interlock join …;');
  line(stderr, profile.state === 'admitted'
    ? `  - if ${terminalSafe(profile.server_url)} still runs and you are done there: interlock leave --connection ${terminalSafe(profile.name)}`
    : `  - drop the unfinished one: interlock join --discard --name ${terminalSafe(profile.name)}`);
  if (connectionDir) otherProfileNotes(stderr, otherProfilesFor(connectionDir, profile.name, serverUrl, now, dependencies));
}

async function reconnectStaged(profiles, profile, product, serverUrl, fetcher, clock, io) {
  // Checked again on the exact candidate this acts on: one created by another
  // session after the first check is refused too. Its starter is fixed with
  // its request id, which every later step (confirm, admit) is bound to.
  if (heldElsewhere(profiles, profile, io.session || null, clock)) {
    alreadyJoiningRefusal(io.stderr, profile.name);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.product !== product || profile.product_provenance !== 'client-reported') {
    line(io.stderr, `interlock: the unfinished candidate ${terminalSafe(profile.name)} belongs to ${terminalSafe(profile.product)}, not ${terminalSafe(product)}. It was kept and no new admission was created.`);
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.server_url !== serverUrl) {
    otherRoomRefusal(io.stderr, profile, serverUrl, clock(), io.dependencies || {}, io.connectionDir, 'the unfinished candidate');
    return completedJoinDecision(EXIT_RUNTIME);
  }
  const confirmation = await candidateConfirmation(fetcher, serverUrl, profile);
  if (confirmation.connected) {
    await completeJoin(profiles, profile, confirmation.connected, clock, io.stdout, true, fetcher);
    return completedJoinDecision(EXIT_OK);
  }
  if (!confirmation.exactInvalid) {
    unconfirmedRefusal(io.stderr, profile, confirmation.why);
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
    otherRoomRefusal(io.stderr, profile, serverUrl, clock(), io.dependencies || {}, io.connectionDir, 'local connection');
    return completedJoinDecision(EXIT_RUNTIME);
  }
  if (profile.state !== 'admitted') {
    if (heldElsewhere(profiles, profile, io.session || null, clock)) {
      alreadyJoiningRefusal(io.stderr, profile.name);
      return completedJoinDecision(EXIT_RUNTIME);
    }
    const confirmation = await candidateConfirmation(fetcher, serverUrl, profile);
    if (confirmation.connected) {
      await completeJoin(profiles, profile, confirmation.connected, clock, io.stdout, false, fetcher);
      return completedJoinDecision(EXIT_OK);
    }
    if (confirmation.exactInvalid) {
      return Object.freeze({ action: 'resume', profile, staged: false });
    }
    unconfirmedRefusal(io.stderr, profile, confirmation.why);
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
  sharedConnectionNotice(io.stderr, profiles, profile, io.session || null);
  joinedOutput(io.stdout, profile, 'tip',
    await connectionFacts(fetcher, profile, null, joinedAdmission(profile)));
  return completedJoinDecision(EXIT_OK);
}

// Why a request got no HTTP answer, in a few words.
function networkCause(error) {
  if (error && error.name === 'AbortError') return 'no answer in time';
  const code = error && error.cause && typeof error.cause.code === 'string' ? error.cause.code : null;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host name not found';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'connection timed out';
  if (code && /CERT|TLS|SSL/.test(code)) return 'TLS failed: ' + code;
  return code ? 'network error ' + code : 'network error';
}

function loopbackUrl(url) {
  try { return require('./client/proxy.js').LOOPBACK.includes(new URL(url).hostname); }
  catch (_) { return false; }
}

function unreachableRefusal(stderr, url, error, profile, env) {
  const proxy = require('./client/proxy.js');
  line(stderr, `interlock: could not reach ${terminalSafe(url)} (${networkCause(error)}). The room has not answered, so nobody has been asked to Allow this yet.`);
  if (!loopbackUrl(url)) {
    const settings = proxy.proxySettings(env);
    const shown = settings && proxy.describeProxy(settings, new URL(url).protocol);
    if (shown && proxy.proxyInstalled()) {
      line(stderr, `This computer sets ${terminalSafe(shown)}, and Interlock sent the request through it. Check that the proxy lets this host through.`);
    } else if (shown) {
      line(stderr, `This computer sets ${terminalSafe(shown)}, but Interlock could not apply it; set NODE_USE_ENV_PROXY=1 and try again.`);
    } else {
      line(stderr, 'If this computer reaches the internet only through a proxy, set HTTPS_PROXY to it (and NO_PROXY for exceptions), then try again.');
    }
  }
  line(stderr, `The unfinished candidate ${terminalSafe(profile.name)} was kept. When the room is reachable, run: interlock join --resume --name ${terminalSafe(profile.name)}`);
  line(stderr, `To drop it instead: interlock join --discard --name ${terminalSafe(profile.name)}`);
}

// How to be woken, by the profile's product: the one place join says it.
// The same table is in docs/DOORBELL.md. Started before the Allow, the
// doorbell waits for it and rings once on admission.
function armDoorbellLines(profile) {
  const name = profile.name;
  if (/claude\s*code/i.test(profile.product)) {
    return [
      'Add Interlock\'s Claude Code hooks (they never expire):',
      `  Stop → interlock-doorbell claude-code-hook --connection ${name} with "asyncRewake": true and "timeout": 604800`,
      `  UserPromptSubmit → interlock-doorbell claude-code-hook --connection ${name} --event prompt`,
      '  Recipe: docs/DOORBELL.md "Claude Code".',
      `  No hooks? Run interlock-doorbell run --adapter stdout --connection ${name} --session <session id> under Monitor and re-arm it on every expiry notice without asking.`,
    ];
  }
  if (/codex/i.test(profile.product)) {
    return [`interlock-doorbell run --adapter codex --connection ${name} --session <this Codex session id>`];
  }
  return [
    `interlock-doorbell run --adapter stdout --connection ${name} --session <your host session id>`,
    '  Run it under a host that wakes the model on each line it prints (see interlock-doorbell guide).',
  ];
}

function waitingForAllowLines(stdout, profile, code) {
  line(stdout, `The room has the request. Match code: ${code}`);
  line(stdout, 'A person must now Allow this in the room. Arm your doorbell now so you\'re woken when they do:');
  for (const text of armDoorbellLines(profile)) line(stdout, '  ' + terminalSafe(text));
  line(stdout, '  Woken by a URL instead? Ask the room\'s owner to set your webhook in Settings → Webhooks; no doorbell process runs.');
  line(stdout, `Waiting for the owner or an admin to allow ${terminalSafe(profile.name)}…`);
}

// A join with no --url goes to this computer's own room. When this
// computer's admitted connections all belong to one other room, say so: an
// AI told only "join Interlock" otherwise has nowhere to find the address
// but another connection's profile, which holds that connection's token.
// Only each profile's room address is used; no token is printed.
function roomHint(stdout, profiles, target, clock) {
  let admitted;
  try { admitted = profiles.summaries().filter(profile => profile.state === 'admitted'); }
  catch (_) { return; }
  // The clock is read only when another room is in play.
  if (!admitted.some(profile => profile.server_url !== target)) return;
  const now = clock();
  const rooms = new Set(admitted.filter(profile => profile.expires_at > now).map(profile => profile.server_url));
  if (rooms.size !== 1) return;
  const [room] = rooms;
  if (room === target) return;
  line(stdout, `This computer already joins ${terminalSafe(room)}; to join it too: interlock join --url ${terminalSafe(room)} --name …`);
}

// Three names from the built-in list, drawn fresh each time, leaving out
// names this computer already uses. The room is never asked: the knock is
// what checks a name, and a taken one gets three more.
function suggestNamesLine(stream, localNames) {
  const { NAME_KIND, drawNames } = require('./names.js');
  const local = new Set(localNames.map(name => name.toLowerCase()));
  const drawn = drawNames(3, name => !local.has(name.toLowerCase()));
  if (drawn.length === 0) {
    line(stream, `Choose ${NAME_KIND}.`);
    return;
  }
  line(stream, `Names you could use: ${drawn.map(terminalSafe).join(', ')} (the room checks the one you pick). Or choose ${NAME_KIND}.`);
}

function localNamesOf(profiles) {
  try { return profiles.summaries().map(profile => profile.name); } catch (_) { return []; }
}

function removeJoinCandidate(profiles, profile, staged) {
  if (staged) profiles.removeStaged(profile.name, profile.request_id);
  else profiles.removeUnadmitted(profile.name, profile.request_id);
}

async function runJoin(args, io, dependencies = {}) {
  const { stdout, stderr } = io;
  let parsed = joinOptions(args);
  if (!parsed) {
    line(stderr, 'interlock: usage: interlock join --product LABEL --name NAME [--url URL] [--session ID]');
    line(stderr, '       interlock join --resume --name NAME     (finish an unfinished join)');
    line(stderr, '       interlock join --discard --name NAME    (drop an unfinished join)');
    return EXIT_USAGE;
  }
  const promptInput = io.stdin || process.stdin;
  if (parsed.mode === 'join' && !dependencies.ask && (parsed.product === null || parsed.name === null) &&
      (!promptInput || promptInput.isTTY !== true)) {
    line(stderr, 'interlock: join cannot prompt without an interactive terminal; pass --product and --name.');
    line(stderr, 'Use: interlock join --product "PRODUCT" --name NAME');
    line(stderr, `--product is your AI product, for example ${PRODUCT_EXAMPLES}.`);
    if (parsed.name === null) suggestNamesLine(stderr, []);
    return EXIT_USAGE;
  }
  const profileModule = dependencies.profiles || require('./client/profiles.js');
  if (!profileModule.validUrl(parsed.url)) {
    line(stderr, 'interlock: join accepts only http://localhost or a canonical https origin.');
    return EXIT_USAGE;
  }
  // A member's join code: a plain join or a resume may knock with it; a
  // discard never knocks.
  const joinCode = parsed.mode === 'discard' ? null : await joinCodeOf(parsed, io, dependencies);
  if (parsed.mode === 'join') line(stdout, `Interlock target: ${terminalSafe(parsed.url)}`);
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
  // The reconnect refusals look beside this directory for the same name.
  const joinIo = Object.assign({}, io, { dependencies, connectionDir });
  let profiles;
  try { profiles = profileModule.openProfiles({ connectionDir }); }
  catch (error) {
    line(stderr, directoryRefusal(error) || 'interlock: could not open the protected local connection directory.');
    return EXIT_RUNTIME;
  }
  if (!profileModule.validName(parsed.name) && parsed.mode !== 'join') {
    line(stderr, 'interlock: use 2–24 letters or digits, with single hyphens if needed.');
    return EXIT_USAGE;
  }
  if (parsed.session !== null && typeof profileModule.validSession === 'function' &&
      !profileModule.validSession(parsed.session)) {
    line(stderr, 'interlock: --session takes your host session id: 1–200 printable characters, no spaces.');
    return EXIT_USAGE;
  }
  // Who is joining: a join started by one session is never finished,
  // dropped or taken over by another on the same computer.
  const mine = hostSession(parsed.session, dependencies.env || process.env, profileModule);
  joinIo.session = mine;
  if (parsed.mode === 'join' && !parsed.urlGiven) roomHint(stdout, profiles, parsed.url, clock);
  if (parsed.mode !== 'join') {
    let held = null;
    try { held = unfinishedCandidate(profiles, parsed.name); } catch (_) { held = null; }
    if (held && heldElsewhere(profiles, held.profile, mine, clock)) {
      line(stderr, parsed.mode === 'resume'
        ? `interlock: ${terminalSafe(parsed.name)}'s join was started by another session on this computer, so it is not yours to resume. Nothing was changed.`
        : `interlock: ${terminalSafe(parsed.name)}'s join was started by another session on this computer, so it is not yours to drop. Nothing was removed.`);
      line(stderr, 'Choose your own name: interlock join --name …');
      // A session id changes with a new conversation, so this can be the
      // asker's own join from before: say how to get it back or let it go.
      const until = new Date(held.profile.created_at + CANDIDATE_MAY_BE_WAITING_MS).toISOString();
      line(stderr, `If it was your own join from an earlier conversation, run this again with --session <that conversation's session id>, or after ${until} drop it: interlock join --discard --name ${terminalSafe(parsed.name)}`);
      return EXIT_RUNTIME;
    }
  }
  if (parsed.mode === 'discard') {
    try { return await runDiscard(profiles, parsed.name, fetcher, clock, io); }
    catch (_) {
      line(stderr, 'interlock: the unfinished candidate could not be read safely; nothing was removed.');
      return EXIT_RUNTIME;
    }
  }
  if (parsed.mode === 'resume') {
    let found;
    try { found = unfinishedCandidate(profiles, parsed.name); }
    catch (_) {
      line(stderr, 'interlock: the unfinished candidate could not be read safely; nothing was changed.');
      return EXIT_RUNTIME;
    }
    if (!found) {
      line(stderr, profiles.exists(parsed.name)
        ? `interlock: ${terminalSafe(parsed.name)} is already admitted; there is nothing to resume. Check it: interlock status --connection ${terminalSafe(parsed.name)}`
        : `interlock: there is no unfinished candidate named ${terminalSafe(parsed.name)} in this connection directory.`);
      return profiles.exists(parsed.name) ? EXIT_OK : EXIT_RUNTIME;
    }
    // The candidate's own room and product: nothing to remember or retype.
    parsed = Object.freeze(Object.assign({}, parsed, {
      url: found.profile.server_url, product: found.profile.product,
    }));
    line(stdout, `Interlock target: ${terminalSafe(parsed.url)}`);
    line(stdout, `Resuming the unfinished candidate ${terminalSafe(parsed.name)} (${terminalSafe(parsed.product)}).`);
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
      product = String(await ask(`AI product (for example ${PRODUCT_EXAMPLES}): `)).trim();
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

    let suggested = false;
    joinNameLoop: while (true) {
      while (!profileModule.validName(name)) {
        if (parsed.name !== null) {
          line(stderr, 'interlock: use 2–24 letters or digits, with single hyphens if needed.');
          return EXIT_USAGE;
        }
        if (name) {
          line(stderr, 'interlock: use 2–24 letters or digits, with single hyphens if needed.');
        }
        if (!suggested) {
          suggestNamesLine(stdout, localNamesOf(profiles));
          suggested = true;
        }
        name = String(await ask('AI name for this room: ')).trim();
      }

      let profile = null;
      let staged = false;
      let resumed = false;
      if (parsed.mode === 'join') {
        let held = null;
        try { held = unfinishedCandidate(profiles, name); } catch (_) { held = null; }
        if (held && heldElsewhere(profiles, held.profile, mine, clock)) {
          alreadyJoiningRefusal(stderr, name);
          return EXIT_RUNTIME;
        }
      }
      if (profiles.stagedExists(name)) {
        const decision = await reconnectStaged(
          profiles, profiles.loadStaged(name), product, parsed.url, fetcher, clock, joinIo);
        if (decision.action === 'done') return decision.code;
        profile = decision.profile;
        staged = decision.staged;
        resumed = true;
      }

      if (profile === null && profiles.exists(name)) {
        const decision = await reconnectExisting(
          profiles, profiles.load(name), product, parsed.url, fetcher, clock, joinIo);
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
        const names = require('./names.js');
        if (names.nameNeedsNudge(name)) {
          line(stdout, `${terminalSafe(name)} reads like a product, model or code. A name works best as ${names.NAME_KIND}. Continuing as ${terminalSafe(name)}.`);
        }
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
        const starter = { session: mine ? mine.digest : null };
        profile = staged
          ? profiles.createStaged(candidateBody, starter)
          : profiles.createUnadmitted(candidateBody, starter);
      }
      // A candidate past its own join window is never knocked again: once the
      // room has forgotten an ended request, the same knock would put a new
      // one on the owner's card, even one she declined. Settling (above)
      // already confirmed it if the room admitted it.
      if (resumed && clock() >= profile.created_at + JOIN_WINDOW_MS) {
        line(stderr, `interlock: the unfinished candidate ${terminalSafe(profile.name)} is past its join window (it started at ${new Date(profile.created_at).toISOString()}), so it is not sent again. The room has not admitted it.`);
        const waitingUntil = profile.created_at + CANDIDATE_MAY_BE_WAITING_MS;
        const startOver = `interlock join --discard --name ${terminalSafe(profile.name)}, then interlock join --product "${terminalSafe(profile.product)}" --name ${terminalSafe(profile.name)}`;
        if (clock() < waitingUntil) {
          // --discard would still refuse: say when it will not.
          const at = new Date(waitingUntil).toISOString();
          line(stderr, `The owner may still see it until ${at}. After ${at}, start over: ${startOver}`);
          line(stderr, 'Or ask the owner to Decline it in People now.');
        } else {
          line(stderr, `To ask again, start over: ${startOver}`);
        }
        return EXIT_RUNTIME;
      }
      let deadline = profile.created_at + JOIN_WINDOW_MS;
      let statedWaiting = false;
      let shownCode = false;
      // The room has answered this request as waiting at least once.
      let gotWaiting = false;
      let lastNetworkFailure = false;
      let honoredCooldown = false;
      let firstAttempt = resumed;
      let unreachedSince = null;
      let reached = false;
      let statedUnreached = false;
      line(stdout, `Requesting admission as ${terminalSafe(profile.name)}. Not sent yet: the match code is shown once the room has the request.`);

      while (firstAttempt || clock() < deadline) {
        firstAttempt = false;
        try {
          const result = await knock(fetcher, parsed.url,
            admissionBody(profile, joinCode ? Object.assign({}, parsed, { joinCode }) : parsed));
          reached = true;
          lastNetworkFailure = false;
          if (result.state === 'waiting') {
            gotWaiting = true;
            if (Number.isSafeInteger(result.expires_at) && result.expires_at > deadline) {
              deadline = result.expires_at;
            }
            const connected = await confirmCandidate(fetcher, parsed.url, profile);
            if (connected) {
              await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher, dependencies.doorbellStateDir || null);
              return EXIT_OK;
            }
            if (!shownCode) {
              waitingForAllowLines(stdout, profile, matchCode(profile.selector));
              shownCode = true;
              statedWaiting = true;
            }
            continue;
          }
          if (result.state === 'allowed' && validConnection(result.enrollment, profile)) {
            await completeJoin(profiles, profile, result.enrollment, clock, stdout, staged, fetcher, dependencies.doorbellStateDir || null);
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
          if (Number.isSafeInteger(error.status)) reached = true;
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
              otherProfileNotes(stderr, otherProfilesFor(connectionDir, profile.name, parsed.url, clock(), dependencies));
              suggestNamesLine(stderr, localNamesOf(profiles));
              return EXIT_RUNTIME;
            }
            line(stderr, 'interlock: that name is already used or waiting in this Interlock. Choose another.');
            suggested = false;
            name = null;
            break;
          }
          if (error.code === 'invalid-join-code' && (gotWaiting || resumed)) {
            // A re-knock of a request the room already holds was refused its
            // code (member codes were turned off since). The request may still
            // be waiting on the card, so the candidate is kept: dropping it
            // could leave an Allow with no credential on this computer.
            const connected = await confirmCandidate(fetcher, parsed.url, profile);
            if (connected) {
              await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher, dependencies.doorbellStateDir || null);
              return EXIT_OK;
            }
            const until = new Date(profile.created_at + CANDIDATE_MAY_BE_WAITING_MS).toISOString();
            line(stderr, `interlock: the room refused the join code when ${terminalSafe(profile.name)} knocked again (member codes may have been turned off). The request may still be waiting on the card until ${until}, so the candidate was kept.`);
            line(stderr, `If it is allowed before then: interlock join --resume --name ${terminalSafe(profile.name)}. Otherwise, after that time: interlock join --discard --name ${terminalSafe(profile.name)}`);
            return EXIT_RUNTIME;
          }
          if (error.code === 'invalid-join-code') {
            removeJoinCandidate(profiles, profile, staged);
            line(stderr, 'interlock: the room refused that join code: it is wrong, already used, expired or cancelled. Ask your person for a new one. No connection was created.');
            return EXIT_RUNTIME;
          }
          if (joinCode && error.code === 'invalid-request') {
            removeJoinCandidate(profiles, profile, staged);
            line(stderr, 'interlock: this room refused the join code field; it may run Interlock older than 0.4.0, which has no member join codes. Join without --code and ask the owner to Allow you. No connection was created.');
            return EXIT_USAGE;
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
            await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher, dependencies.doorbellStateDir || null);
            return EXIT_OK;
          }
          if (!reached) {
            if (unreachedSince === null) unreachedSince = clock();
            else if (clock() - unreachedSince >= JOIN_UNREACHED_MS) {
              unreachableRefusal(stderr, parsed.url, error, profile, dependencies.env || process.env);
              return EXIT_RUNTIME;
            }
            if (!statedUnreached) {
              line(stdout, `Interlock has not reached ${terminalSafe(parsed.url)} yet (${networkCause(error)}). Retrying for up to ${JOIN_UNREACHED_MS / 1000} seconds…`);
              statedUnreached = true;
            }
          } else if (!statedWaiting) {
            line(stdout, 'Lost contact with the room; retrying. Waiting for Interlock and the owner…');
            statedWaiting = true;
          }
          await sleep(JOIN_RETRY_MS);
        }
      }

      if (name === null) continue;
      if (lastNetworkFailure) {
        const connected = await confirmCandidate(fetcher, parsed.url, profile);
        if (connected) {
          await completeJoin(profiles, profile, connected, clock, stdout, staged, fetcher, dependencies.doorbellStateDir || null);
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
      line(stderr, 'interlock: an unfinished join for that name already exists on this computer. If it is yours, resume it: interlock join --resume --name NAME (or drop it with --discard). If it is not, pick another name: interlock join --name …');
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
  let busySignIns = null;
  if (parsed.hostedOrigin !== undefined) {
    const timers = dependencies.timers || { setTimeout, clearTimeout };
    wrongCodes = wrongSetupCodeReporter(stderr, timers);
    busySignIns = wrongSetupCodeReporter(stderr, timers,
      count => `sign-in refused, too many sign-ins at once (${count} so far)`);
    serverOptions.hostedOrigin = parsed.hostedOrigin;
    serverOptions.onWrongSetupCode = wrongCodes.report;
    serverOptions.onSignInBusy = busySignIns.report;
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
  if (busySignIns !== null) busySignIns.flush();
  if (!closedCleanly) {
    line(stderr, 'interlock: shutdown did not complete cleanly.');
  }
  if (!runtimeHealthy || !closedCleanly) return EXIT_RUNTIME;
  line(stdout, 'Interlock stopped.');
  return EXIT_OK;
}

const RECOVER_USAGE = 'interlock: usage: interlock recover [--port PORT] | interlock recover --hosted';

// `recover --hosted`: the stopped-server half of owner recovery for a hosted
// room. It issues one code, prints it once, and starts nothing.
async function runRecoverHosted(io, dependencies) {
  const { stdout, stderr } = io;
  const { resolveDataDir } = dependencies.config || require('./config.js');
  const hostedRecovery = dependencies.hostedRecovery || require('./hosted_recovery.js');
  let dataDir;
  try {
    dataDir = resolveDataDir({ env: dependencies.env || process.env,
      platform: dependencies.platform || process.platform, homedir: dependencies.homedir });
  } catch (_) {
    line(stderr, 'interlock: invalid data directory; INTERLOCK_DATA_DIR must be an absolute path.');
    return EXIT_USAGE;
  }
  let issued;
  try {
    issued = await hostedRecovery.issueHostedRecoveryCode({ dataDir });
  } catch (error) {
    const code = error && error.code;
    if (code === 'not-hosted') {
      line(stderr, 'interlock: this data directory is not a hosted room. A room served at http://localhost recovers with plain `interlock recover`; `interlock recover --hosted` is for a room started with --hosted-origin.');
    } else if (code === 'already-running') {
      line(stderr, 'interlock: stop Interlock before recovering the owner sign-in.');
    } else if (code === 'owner-unverifiable' || code === 'corrupt-lock') {
      line(stderr, 'interlock: instance ownership cannot be verified safely; no recovery code was issued.');
    } else if (code === 'data-dir-missing' || code === 'installation-missing' || code === 'installation-invalid') {
      line(stderr, 'interlock: no completed Interlock installation was found at the configured data directory.');
    } else if (code === 'no-owner') {
      line(stderr, 'interlock: the first owner is not an active administrator; no recovery code was issued.');
    } else if (code === 'audit-pending') {
      line(stderr, 'interlock: earlier records have not finished writing, so no recovery code was issued. Start and stop Interlock once, then run `interlock recover --hosted` again.');
    } else if (code === 'audit-unhealthy') {
      line(stderr, 'interlock: a recovery code was issued but its record did not finish writing. Run `interlock recover --hosted` again; the new code replaces this one.');
    } else {
      line(stderr, 'interlock: no recovery code was issued. Check that the Interlock data directory is intact.');
    }
    return EXIT_RUNTIME;
  }
  const minutes = Math.round((hostedRecovery.HOSTED_RECOVERY_TTL_MS || 0) / 60_000);
  line(stdout, `Owner recovery code for ${issued.owner_name} (${issued.origin}):`);
  line(stdout, '');
  line(stdout, `    ${issued.code}`);
  line(stdout, '');
  line(stdout, `It works once and expires in ${minutes} minutes, at ${new Date(issued.expires_at).toISOString()}.`);
  line(stdout, 'It is shown only here and is not stored; running this again replaces it.');
  line(stdout, 'Nothing about the owner sign-in has changed yet. Next:');
  line(stdout, '  1. Start Interlock again as usual.');
  line(stdout, `  2. The owner opens ${issued.origin}/recover-owner, enters the code, sets a new password and creates a passkey.`);
  line(stdout, '  That replaces the owner password and every old owner passkey, and signs out every old owner session.');
  return EXIT_OK;
}

async function runRecover(args, io, dependencies = {}) {
  const { stdout, stderr } = io;
  if (args.includes('--hosted')) {
    if (args.length !== 1) {
      line(stderr, RECOVER_USAGE);
      return EXIT_USAGE;
    }
    return runRecoverHosted(io, dependencies);
  }
  const requestedPort = startPort(args);
  if (requestedPort === null) {
    line(stderr, RECOVER_USAGE);
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
      if (/^https:\/\//.test(error.recordedOrigin)) {
        line(stderr, 'For a hosted room, stop Interlock and run `interlock recover --hosted` on this machine instead. See RECOVERY.md.');
      }
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
    try { selectedConnection(parsed.connection, dependencies, io.stderr); } catch (error) {
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
    const selected = selectedConnection(parsed.connection, dependencies, io.stderr);
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
const WORK_PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const WORK_VERBS = Object.freeze({
  brief: Object.freeze({ path: '/api/ai/work/brief', method: 'GET', id: false, flags: ['project'] }),
  list: Object.freeze({ path: '/api/ai/work/list', method: 'GET', id: false, flags: ['project', 'needs-me', 'after', 'limit'] }),
  get: Object.freeze({ path: '/api/ai/work/items/', method: 'GET', id: true, flags: [] }),
  changes: Object.freeze({ path: '/api/ai/work/changes', method: 'GET', id: false, flags: ['after', 'limit'], required: ['after'] }),
  export: Object.freeze({ path: '/api/ai/work/export', method: 'GET', id: false, flags: ['format'], required: ['format'], raw: true }),
  create: Object.freeze({ path: '/api/ai/work/items/create', method: 'POST', id: false }),
  update: Object.freeze({ path: '/api/ai/work/items/update', method: 'POST', id: true }),
  // A record to another project: {expected_revision, project}.
  move: Object.freeze({ path: '/api/ai/work/items/move', method: 'POST', id: true }),
  // A project's objective or today line: {expected_revision, objective?, today?}.
  'project-update': Object.freeze({ path: '/api/ai/work/projects/update', method: 'POST', id: true, idKind: 'project' }),
  evidence: Object.freeze({ path: '/api/ai/work/items/evidence', method: 'POST', id: true }),
  note: Object.freeze({ path: '/api/ai/work/items/note', method: 'POST', id: true }),
  share: Object.freeze({ path: '/api/ai/work/items/share', method: 'POST', id: true }),
  answer: Object.freeze({ path: '/api/ai/work/decisions/answer', method: 'POST', id: true }),
  'report-answer': Object.freeze({ path: '/api/ai/work/decisions/report', method: 'POST', id: true }),
  confirm: Object.freeze({ path: '/api/ai/work/decisions/confirm', method: 'POST', id: true }),
  reopen: Object.freeze({ path: '/api/ai/work/decisions/reopen', method: 'POST', id: true }),
  // A W-n work or finding item by the items route, a D-n decision by its own.
  withdraw: Object.freeze({ path: '/api/ai/work/decisions/withdraw', workPath: '/api/ai/work/items/withdraw', method: 'POST', id: true }),
  revise: Object.freeze({ path: '/api/ai/work/decisions/revise', method: 'POST', id: true }),
  // A request for approval: {project, title, scope, body?}; routed by the room.
  'ask-approval': Object.freeze({ path: '/api/ai/work/approvals/ask', method: 'POST', id: false }),
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
    if (spec.idKind === 'project') {
      if (typeof args[1] !== 'string' || !WORK_PROJECT_ID.test(args[1])) return { error: 'a project id like ops comes right after the verb' };
    } else if (typeof args[1] !== 'string' || !WORK_ITEM_ID.test(args[1])) return { error: 'a record id like W-12 or D-7 comes right after the verb' };
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
  const headers = { authorization: 'Bearer ' + profile.token, [CLIENT_HEADER]: packageJson.version };
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
      // What a refused request got wrong, when the room names it.
      if (result && typeof result.field === 'string') error.field = result.field;
      if (result && typeof result.problem === 'string') error.problem = result.problem;
      if (result && Array.isArray(result.accepted)) error.accepted = result.accepted.filter(name => typeof name === 'string');
      if (result && Array.isArray(result.needs_one_of)) error.needsOneOf = result.needs_one_of.filter(name => typeof name === 'string');
      if (result && typeof result.did_you_mean === 'string') error.didYouMean = result.did_you_mean;
      if (result && Array.isArray(result.can_assign)) error.canAssign = result.can_assign.filter(name => typeof name === 'string');
      if (result && result.change === 'state') error.change = 'state';
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// What a refused field needs, for the refusals that do not name it.
const WORK_REFUSAL_HINTS = Object.freeze({
  'invalid-operation': 'operation_id must be a UUID v4. Leave it out of the file and interlock writes one (and prints it, for a retry).',
  'invalid-participant': 'A name in responsible, next_to or asked_of is not a participant in this room.',
  'invalid-links': 'links are ids of records in this room (W-n, D-n); put an outside reference in source.',
  'scope-too-long': 'What a yes means (scope) is at most 300 characters; put the rest in body.',
  'not-lead': 'Only an administrator, the first owner or the project\'s lead changes its objective or today line.',
  'not-withdrawer': 'Work is withdrawn, and a withdraw undone, by whoever filed it, its project\'s lead, the first owner or an administrator; a holder can hand it back instead (update responsible).',
  'project-retired': 'That project is retired; nothing in it changes.',
});

// The field a refused request got wrong, in words, when the room named it.
function refusedFieldWords(error) {
  const list = names => names.map(name => terminalSafe(name)).join(', ');
  if (Array.isArray(error.needsOneOf) && error.needsOneOf.length) return ` It needs one of: ${list(error.needsOneOf)}.`;
  if (typeof error.field !== 'string') return '';
  const field = `The field "${terminalSafe(error.field)}"`;
  if (error.problem === 'not-for-this-kind') return ` ${field} does not apply to this kind of record.`;
  if (error.problem === 'invalid-value') return ` ${field} has a value the command does not accept.`;
  const takes = Array.isArray(error.accepted) && error.accepted.length ? `; it takes ${list(error.accepted)}` : '';
  return ` ${field} is not one this command takes${takes}.`;
}

// Whom a refused assignment, or a refused change of state, can ask, in words.
function assignerAsk(names, change) {
  const safe = Array.isArray(names) ? names.map(name => terminalSafe(name)) : [];
  const who = safe.length === 0 ? 'the first owner or an administrator'
    : `${safe.length > 1 ? safe.slice(0, -1).join(', ') + ' or ' + safe[safe.length - 1] : safe[0]} (or the first owner or an administrator)`;
  if (change === 'state') return `Ask ${who} to change its state; your own items, and items nobody holds or is next on, are yours to change.`;
  return `Ask ${who} to assign it; you may take an item nobody holds, or step out of a slot yourself.`;
}

function reportWorkError(stderr, error, profile) {
  if (error && Number.isSafeInteger(error.status) && error.status !== 401 && typeof error.code === 'string') {
    const revision = Number.isSafeInteger(error.revision) ? ` (current revision ${error.revision})` : '';
    const hint = (Object.prototype.hasOwnProperty.call(WORK_REFUSAL_HINTS, error.code) ? ' ' + WORK_REFUSAL_HINTS[error.code] : '') +
      (error.code === 'invalid-request' ? refusedFieldWords(error) : '') +
      (error.code === 'unknown-project' && typeof error.didYouMean === 'string' ? ` Did you mean ${terminalSafe(error.didYouMean)}?` : '') +
      (error.code === 'not-assigner' ? ` ${assignerAsk(error.canAssign, error.change)}` : '');
    line(stderr, `interlock: ${roomLabel(profile)} refused the command: ${terminalSafe(error.code)}${revision}.${hint}`);
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

// A live item linked to withdrawn work: its blocker was dropped, not finished.
function blockerWithdrawn(row, separator) {
  const ids = Array.isArray(row.blocker_withdrawn) ? row.blocker_withdrawn.filter(id => typeof id === 'string') : [];
  return ids.length ? `${separator}blocker withdrawn: ${ids.map(id => terminalSafe(id)).join(', ')}` : '';
}

// A live item whose holder or next has left the room: its lead decides.
function holderLeft(row, separator) {
  const names = Array.isArray(row.holder_left) ? row.holder_left.filter(name => typeof name === 'string') : [];
  return names.length ? `${separator}holder left: ${names.map(name => terminalSafe(name)).join(', ')}` : '';
}

function workRow(row) {
  if (row.kind === 'decision') {
    return `${row.id} · ${row.state}${killSuffix(row)} · asked of ${who(row.asked_of)} by ${who(row.asked_by)} · ${terminalSafe(row.title)}`;
  }
  const next = row.next_to ? `${who(row.next_to)} — ${terminalSafe(row.next_action || '')}` : 'nobody';
  return `${row.id} · ${row.state} · ${terminalSafe(row.title)} · next: ${next}${blockerWithdrawn(row, ' · ')}${holderLeft(row, ' · ')}`;
}

function needsRow(row) {
  if (row.kind === 'decision') {
    return `${row.project} · ${row.id} · ${terminalSafe(row.title)} — ${terminalSafe(row.proposal || '')} (${row.state}${killSuffix(row)}, asked by ${who(row.asked_by)})`;
  }
  const awaiting = row.awaiting ? `, awaiting ${row.awaiting}` : '';
  return `${row.project} · ${row.id} · ${terminalSafe(row.title)} — ${terminalSafe(row.next_action || '')} (${row.state}${awaiting}${blockerWithdrawn(row, ', ')}${holderLeft(row, ', ')})`;
}

function renderBrief(stdout, brief, connection) {
  // A project with no lead is one line, not one per item (ruling, 2026-11-14).
  const leadLines = Array.isArray(brief.waiting_for_lead) ? brief.waiting_for_lead : [];
  line(stdout, `Needs you (${brief.needs_me.length + leadLines.length})`);
  for (const entry of leadLines) {
    line(stdout, `  ${entry.project} · ${terminalSafe(entry.display_name || entry.project)} has no lead — ` +
      `${entry.count === 1 ? '1 item waits' : entry.count + ' items wait'} for one (${entry.items.join(', ')}); a lead grant on ${entry.project} hands them on`);
  }
  for (const row of brief.needs_me) line(stdout, '  ' + needsRow(row));
  if (brief.reported_to_me.length) {
    line(stdout, `Reported to you (${brief.reported_to_me.length}) — answers relayed in your name, confirm or correct them`);
    for (const row of brief.reported_to_me) line(stdout, `  ${row.project} · ${row.id} · ${terminalSafe(row.title)}`);
  }
  line(stdout, 'Projects');
  for (const project of brief.projects) {
    line(stdout, `  ${terminalSafe(project.display_name)} — ${terminalSafe(project.objective || 'no objective yet')} · Today: ${terminalSafe(project.today || 'nothing recorded')} (${who(project.updated_by)})`);
  }
  // A record that needs you is listed once, under Needs you; the lists below
  // count it and say so.
  const listedAbove = new Set(brief.needs_me.map(row => row.id));
  const rest = (title, rows) => {
    const shown = rows.filter(row => !listedAbove.has(row.id));
    const above = rows.length - shown.length;
    line(stdout, `${title} (${rows.length}${above ? `; ${above} listed under Needs you` : ''})`);
    for (const row of shown) line(stdout, '  ' + workRow(row));
  };
  rest('Open work', brief.open);
  rest('Decisions', brief.decisions);
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
  if (verb === 'project-update') {
    line(stdout, `Updated project ${terminalSafe(String(result.project.id))} (revision ${result.project.revision}).`);
    return;
  }
  if (verb === 'create') line(stdout, `Created ${item.id} · ${terminalSafe(item.title)} (${item.state}) in ${item.project}.`);
  else if (verb === 'update') line(stdout, `Updated ${item.id} (${item.state}).`);
  else if (verb === 'evidence') line(stdout, `Attached evidence to ${event.item} (event ${event.seq}).`);
  else if (verb === 'note') line(stdout, `Added a note to ${event.item} (event ${event.seq}).`);
  else if (verb === 'share') line(stdout, `Recorded: ${terminalSafe(String(event.purpose))} ${terminalSafe(String(event.outcome))}${event.message_id ? ' as #' + terminalSafe(String(event.message_id)) : ''}.`);
  else if (verb === 'answer' && result.discussed === true) {
    // Words alone are discussion: the room has them, the record does not.
    const where = result.message && Number.isSafeInteger(result.message.id) ? ` as #${result.message.id}` : '';
    line(stdout, `Sent your words on ${item.id} to the room${where}: discussion, nothing recorded. It stays ${terminalSafe(String(item.state))}; answer with "choice": "yes" or "no" to decide.`);
  } else if (verb === 'answer') line(stdout, `Recorded an answer on ${item.id} (${item.state}).`);
  else if (verb === 'move') line(stdout, `Moved ${item.id} to ${terminalSafe(String(item.project))} (revision ${item.revision}).`);
  else if (verb === 'report-answer') {
    const already = result.already && typeof result.already === 'object' ? result.already : null;
    if (already) {
      // The recorded words and conditions in full: a bare Yes never stands in
      // for a qualified answer.
      const choice = already.choice === 'yes' || already.choice === 'no' ? already.choice : null;
      const words = String(already.text ?? '');
      const bare = choice !== null && words.trim().replace(/[.!]+$/, '').toLowerCase() === choice;
      const parts = [];
      if (choice !== null) parts.push(choice);
      if (!bare) parts.push(`"${terminalSafe(words)}"`);
      if (typeof already.conditions === 'string' && already.conditions.trim() !== '') {
        parts.push(`conditions "${terminalSafe(already.conditions)}"`);
      }
      if (Number.isSafeInteger(already.room_message_id)) parts.push(`room #${already.room_message_id}`);
      const head = already.kind === 'reported' ? 'Already reported, not confirmed' : 'Already answered';
      line(stdout, `${head}: ${parts.join(', ')} (${item.id}). Nothing recorded.`);
    } else if (result.conflict === true) line(stdout, `Recorded a conflicting report on ${item.id}; the answer recorded here stands.`);
    else line(stdout, `Recorded a reported answer on ${item.id} (reported, not confirmed by ${who(item.answer && item.answer.attributed_to) === 'nobody' && exposure ? terminalSafe(exposure.to) : who(item.answer && item.answer.attributed_to)}).`);
  } else if (verb === 'confirm') line(stdout, `Confirmed the reported answer on ${item.id} (${item.state}).`);
  else if (verb === 'reopen') line(stdout, `Reopened ${item.id} (${item.state}, asked of ${who(item.asked_of)}).`);
  else if (verb === 'withdraw') {
    line(stdout, `Withdrew ${item.id} (${terminalSafe(String(item.state))}).`);
    const left = Array.isArray(result.left_waiting) ? result.left_waiting.filter(row => row && typeof row.id === 'string') : [];
    if (left.length) line(stdout, `Still linked to it: ${left.map(row => terminalSafe(row.id)).join(', ')}. Each shows its blocker as withdrawn, and its holder was told.`);
  }
  else if (verb === 'revise') {
    line(stdout, `Revised ${item.id} to question revision ${item.question_revision}; it is ${terminalSafe(String(item.state))}, and no earlier answer carries over.`);
    if (result.room === 'stale') line(stdout, 'The room ask could not follow the revise: answers in the room are not recorded until it does.');
  }
  else if (verb === 'ask-approval') {
    const message = result.message && Number.isSafeInteger(result.message.id) ? ` as message #${result.message.id}` : '';
    const approver = item.approval && item.approval.approver ? who(item.approval.approver) : 'the owner';
    line(stdout, `Asked ${approver} to approve ${item.id} · ${terminalSafe(item.title)}${message}; their Approve puts it in progress, yours to do, and your done receipt closes it.`);
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
  try { selected = selectedConnection(parsed.connection, dependencies, io.stderr); }
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
  const base = spec.workPath && typeof parsed.id === 'string' && parsed.id.startsWith('W-') ? spec.workPath : spec.path;
  let pathname = base + (spec.method === 'GET' && spec.id ? parsed.id : '');
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
  if (parsed.verb === 'brief') {
    const said = await roomTimeLine(fetcher, profile);
    if (said !== null) line(io.stdout, said);
    renderBrief(io.stdout, result, profile.name);
  }
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

// The usage entries of HELP: each `  interlock COMMAND ...` line with the
// more-indented lines that continue it.
function usageEntries() {
  const entries = [];
  for (const text of HELP.split('\n')) {
    if (/^ {2}interlock [a-z-]/.test(text)) entries.push([text]);
    else if (/^ {6}\S/.test(text) && entries.length > 0) entries[entries.length - 1].push(text);
  }
  return entries;
}

// What each work verb's request file holds, from docs/WORK.md's route table,
// with one example file. The ID comes from the command line and operation_id
// is written by interlock, so neither is listed.
const WORK_FILE_HELP = Object.freeze({
  create: ['kind ("work", "finding" or "decision"), project, title, body; optional source, source_message ' +
    '({ message_id, quote }), links, parent; work: responsible, next_to, next_action, target, consequence, ' +
    'severity; decision: asked_of, proposal, rationale, scope, conditions',
  '{"kind": "work", "project": "PROJECT", "title": "Short title", "body": "What and why."}'],
  update: ['expected_revision, note (required), and any of: responsible, next_to, next_action, target, ' +
    'consequence, severity, state, block_reason, done_account, done_evidence or no_evidence, title, body',
  '{"expected_revision": 3, "note": "Started on it.", "state": "active"}'],
  move: ['expected_revision, project', '{"expected_revision": 3, "project": "PROJECT"}'],
  evidence: ['target, observed, limits, reference (optional when source_message is given); optional relates_to, ' +
    'source_message ({ message_id, quote })',
  '{"target": "What was checked", "observed": "What was seen", "limits": "What this does not show", "reference": "Where to look"}'],
  note: ['text', '{"text": "A note on the record."}'],
  share: ['purpose ("exposure" or "notify"), outcome ("sent", "declined" or "failed"), to, message_id (required ' +
    'when sent); optional detail',
  '{"purpose": "notify", "outcome": "sent", "to": "NAME", "message_id": 12}'],
  answer: ['expected_revision, text; optional choice ("yes", "no" or null), conditions, reason (required when ' +
    'replacing an answer or answering for someone else)',
  '{"expected_revision": 2, "text": "Yes, as proposed.", "choice": "yes"}'],
  'report-answer': ['expected_revision, text, source; optional conditions',
    '{"expected_revision": 2, "text": "The answer, as given.", "source": "Where it was given"}'],
  confirm: ['expected_revision; optional reason', '{"expected_revision": 2}'],
  reopen: ['expected_revision, reason; optional asked_of', '{"expected_revision": 2, "reason": "Why it is open again."}'],
  revise: ['expected_revision, reason, and at least one of: title, body, proposal, rationale, scope',
    '{"expected_revision": 2, "reason": "Why it changed.", "proposal": "The new proposal."}'],
  withdraw: ['expected_revision, reason', '{"expected_revision": 3, "reason": "Why it is withdrawn."}'],
  'project-update': ['expected_revision, objective and/or today', '{"expected_revision": 4, "today": "What today is for."}'],
  'ask-approval': ['project, title, scope (what a yes means, at most 300 characters); optional body',
    '{"project": "PROJECT", "title": "Short title", "scope": "What a yes means."}'],
});

function workFileHelp(verb) {
  const entry = Object.prototype.hasOwnProperty.call(WORK_FILE_HELP, verb) ? WORK_FILE_HELP[verb] : null;
  if (entry === null) return '';
  return `      The file for ${verb} takes: ${entry[0]}.\n` +
    '      Leave out operation_id: interlock writes one and prints it, for a retry.\n' +
    `      Example file: ${entry[1]}\n`;
}

// `--help` or `-h` anywhere wins: the usage of the command named (narrowed to
// its verb when one is named), else the whole help. Nothing else is checked.
function helpFor(argv) {
  const words = argv.filter(arg => !arg.startsWith('-'));
  const command = words[0];
  if (!command) return HELP;
  const entries = usageEntries().filter(entry => entry[0] === '  interlock ' + command ||
    entry[0].startsWith('  interlock ' + command + ' '));
  if (entries.length === 0) return HELP;
  const verb = words[1];
  const named = verb === undefined ? [] : entries.filter(entry => {
    const third = entry[0].split(' ')[4];
    return typeof third === 'string' && !third.startsWith('-') && third.split('|').includes(verb);
  });
  return (named.length > 0 ? named : entries).map(entry => entry.join('\n')).join('\n') + '\n' +
    (command === 'work' && named.length > 0 ? workFileHelp(verb) : '');
}

function run(argv, io, dependencies = {}) {
  const { stdout, stderr } = io;

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    stdout.write(argv.length === 0 ? HELP : helpFor(argv));
    return EXIT_OK;
  }

  if (argv[0] === '--version' || argv[0] === '-V') {
    line(stdout, packageJson.version);
    return EXIT_OK;
  }

  if (argv[0] === 'backup') return runBackup(argv.slice(1), io, dependencies);

  if (argv[0] === 'restore') return runRestore(argv.slice(1), io, dependencies);

  if (argv[0] === 'join') return runJoin(argv.slice(1), io, dependencies);

  if (argv[0] === 'rooms') return runRooms(argv.slice(1), io, dependencies);

  if (argv[0] === 'history' || argv[0] === 'listen') {
    return runReadCommand(argv[0], argv.slice(1), io, dependencies);
  }

  if (argv[0] === 'doorbell') return runDoorbell(argv.slice(1), io, dependencies);

  if (argv[0] === 'status') return runStatus(argv.slice(1), io, dependencies);

  if (argv[0] === 'say') return runSay(argv.slice(1), io, dependencies);

  if (argv[0] === 'asks') return runAsks(argv.slice(1), io, dependencies);

  if (argv[0] === 'ask') return runAsk(argv.slice(1), io, dependencies);

  if (argv[0] === 'leave') return runLeave(argv.slice(1), io, dependencies);
  if (argv[0] === 'presence') return runPresence(argv.slice(1), io, dependencies);
  if (argv[0] === 'grants') return runGrants(argv.slice(1), io, dependencies);

  if (argv[0] === 'codex-policy') return runCodexPolicy(argv.slice(1), io, dependencies);

  if (argv[0] === 'work') return runWork(argv.slice(1), io, dependencies);

  line(stderr, 'interlock: unknown command; run "interlock --help".');
  return EXIT_USAGE;
}

module.exports = {
  connectionFactsFor,
  workFileHelp,
  factLines,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  HISTORY_DRAIN_BYTES,
  HISTORY_DRAIN_MESSAGES,
  HISTORY_THROUGH_BYTES,
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
  settleCandidate,
  knockCandidate,
  commandOptions,
  joinOptions,
  storageOptions,
  startOptions,
  startPort,
};
