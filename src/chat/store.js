'use strict';

// One-room durable transcript. No room id, no registry, no clear/export.
// Untrusted caller input is `{ text }` only. Server assigns id, timestamp,
// and the authenticated byline/kind from a separate trusted argument.
//
// Text contract (narrow, no silent normalize/truncate):
//   accept non-empty Unicode including line breaks (\n \r \t) and ordinary
//   markup-as-text; reject empty, oversize, NUL, other C0/DEL, C1, ESC, and
//   lone surrogates. Rendering/export escaping is not this module.
//
// Recovery (bounded, not a general repair):
//   A fully formed extra log row whose id equals meta.next_id is uncommitted
//   metadata from a crash after log fsync; reopen finishes that commit.
//   A torn tail after an exact committed range is uncommitted write residue
//   and is truncated. Lost, gapped, or truncated committed history refuses.
//
// Annotations (the side-car, see annotations.js) share this store's lock, so
// an ask is written with its message and a clear takes both or neither. A
// missing side-car is an empty one: dropping it is the rollback.

const fs = require('node:fs');
const path = require('node:path');

const {
  commitVerifiedClear,
  documentFromSnapshot,
  recoverPendingClear,
  verifyArchiveSet,
  archivePaths,
} = require('./archive.js');
const Annotations = require('./annotations.js');

const SCHEMA = 2;
const LEGACY_SCHEMA = 1;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_BYLINE_BYTES = 256;
const MAX_READ_LIMIT = 100;
const PEEK_SCAN_LIMIT = 500;
const PEEK_FIND_MAX = 200;
const KINDS = Object.freeze(['person', 'seat']);
const META_KEYS = Object.freeze(['schema', 'first_id', 'next_id']);
const LEGACY_MESSAGE_KEYS = Object.freeze(['id', 'ts', 'subject_id', 'byline', 'kind', 'text']);
const MESSAGE_KEYS = Object.freeze([
  ...LEGACY_MESSAGE_KEYS,
  'product', 'product_provenance', 'recipients', 'client_message_id',
]);
const RECIPIENT_KEYS = Object.freeze(['subject_id', 'name']);
const RECEIPT_KEYS = Object.freeze(['message_id', 'subject_id', 'acknowledged_at']);
const ACTIVITY_KEYS = Object.freeze(['schema', 'entries']);
const ACTIVITY_ENTRY_KEYS = Object.freeze(['subject_id', 'last_heard']);
const ACTIVITY_SCHEMA = 1;
const UNTRUSTED_KEYS = Object.freeze(['text']);
const TRUSTED_KEYS = Object.freeze([
  'subject_id', 'name', 'kind', 'product', 'product_provenance',
  'recipients', 'client_message_id',
]);
const CLEAR_KEYS = Object.freeze([
  'archive_id', 'exported_at', 'json_sha256', 'markdown_sha256', 'annotations_sha256',
]);
const ANNOTATIONS_MARKER_KEYS = Object.freeze([
  'schema', 'archive_id', 'source_next_id', 'staged_sha256', 'archive_sha256',
]);
const LIFECYCLE_INPUT_KEYS = Object.freeze(['subject_id', 'name', 'kind', 'ask_id', 'means']);
const STAMP_INPUT_KEYS = Object.freeze(['subject_id', 'name', 'message_id', 'project', 'reason', 'record_id']);
const {
  DIRECTORY_SYNC_SUPPORTED, atomicWriteJson, fsyncDirectory, fsyncFile,
} = require('../atomic_json.js');
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWN_CODES = Object.freeze([
  'invalid-options', 'invalid-data-dir', 'data-dir-missing', 'invalid-text',
  'invalid-actor', 'invalid-read', 'store-closed', 'store-fatal', 'log-missing',
  'log-changed', 'invalid-ack', 'invalid-activity', 'message-id-collision',
  'unknown-schema', 'corrupt-meta', 'corrupt-messages', 'corrupt-receipts',
  'corrupt-activity', 'torn-write', 'inconsistent-state', 'missing-history',
  'invalid-clear', 'archive-invalid', 'archive-stale',
  'invalid-session-discriminator',
  'corrupt-annotations', 'invalid-annotation', 'ask-of-self', 'ask-not-found', 'ask-not-open',
  'ask-not-answered', 'not-asker', 'unread-addressed', 'already-posted', 'ask-revised',
  'not-author', 'message-not-found',
]);

function fail(code) {
  const error = new Error('chat.store: ' + code);
  error.code = code;
  throw error;
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      return null;
    }
  }
  return value;
}

function boundedString(value, maxBytes) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isAllowedText(text) {
  if (!boundedString(text, MAX_TEXT_BYTES)) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      i += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
    if (code === 0x7F) return false;
    if (code >= 0x80 && code <= 0x9F) return false;
  }
  return true;
}

function validProduct(value) {
  return typeof value === 'string' && Array.from(value).length >= 1 &&
    Array.from(value).length <= 40 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const n = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(n) || n <= 0) fail('store-fatal');
    offset += n;
  }
}

function appendLineExisting(filePath, line) {
  const buffer = Buffer.from(line, 'utf8');
  const fd = fs.openSync(filePath, APPEND_FLAGS);
  try {
    writeAllSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.length;
}

function fileIdentity(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, ino: st.ino, dev: st.dev };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(a, b) {
  return !!a && !!b && a.size === b.size && a.ino === b.ino && a.dev === b.dev;
}

function parseMeta(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { fail('corrupt-meta'); }
  const meta = closedObject(value, META_KEYS);
  if (!meta) fail('corrupt-meta');
  if (meta.schema !== LEGACY_SCHEMA && meta.schema !== SCHEMA) fail('unknown-schema');
  if (!Number.isSafeInteger(meta.first_id) || meta.first_id < 1) fail('corrupt-meta');
  if (!Number.isSafeInteger(meta.next_id) || meta.next_id < meta.first_id) fail('corrupt-meta');
  return { schema: meta.schema, first_id: meta.first_id, next_id: meta.next_id };
}

function parseStoredMessage(value) {
  const legacy = closedObject(value, LEGACY_MESSAGE_KEYS);
  const row = legacy || closedObject(value, MESSAGE_KEYS);
  if (!row) return null;
  if (!Number.isSafeInteger(row.id) || row.id < 1) return null;
  if (!Number.isSafeInteger(row.ts) || row.ts < 0) return null;
  if (!boundedString(row.subject_id, 64)) return null;
  if (!boundedString(row.byline, MAX_BYLINE_BYTES)) return null;
  if (!KINDS.includes(row.kind)) return null;
  if (!isAllowedText(row.text)) return null;
  let product = null;
  let productProvenance = null;
  let recipients = [];
  let clientMessageId = null;
  if (!legacy) {
    if (row.kind === 'person') {
      if (row.product !== null || row.product_provenance !== null ||
          row.client_message_id !== null) return null;
    } else if (!validProduct(row.product) ||
        (row.product_provenance !== 'client-reported' &&
          row.product_provenance !== 'adapter-reported') ||
        !UUID_V4.test(row.client_message_id)) {
      return null;
    }
    if (!Array.isArray(row.recipients) || row.recipients.length > 32) return null;
    const seen = new Set();
    recipients = [];
    for (const candidate of row.recipients) {
      const recipient = closedObject(candidate, RECIPIENT_KEYS);
      if (!recipient || !boundedString(recipient.subject_id, 64) ||
          !boundedString(recipient.name, MAX_BYLINE_BYTES) ||
          seen.has(recipient.subject_id) || recipient.subject_id === row.subject_id) return null;
      seen.add(recipient.subject_id);
      recipients.push(Object.freeze({ subject_id: recipient.subject_id, name: recipient.name }));
    }
    product = row.product;
    productProvenance = row.product_provenance;
    clientMessageId = row.client_message_id;
  }
  return Object.freeze({
    id: row.id,
    ts: row.ts,
    subject_id: row.subject_id,
    byline: row.byline,
    kind: row.kind,
    text: row.text,
    product,
    product_provenance: productProvenance,
    recipients: Object.freeze(recipients),
    client_message_id: clientMessageId,
  });
}

function parseReceipt(value) {
  const row = closedObject(value, RECEIPT_KEYS);
  if (!row || !Number.isSafeInteger(row.message_id) || row.message_id < 1 ||
      !boundedString(row.subject_id, 64) ||
      !Number.isSafeInteger(row.acknowledged_at) || row.acknowledged_at < 0) return null;
  return Object.freeze({
    message_id: row.message_id,
    subject_id: row.subject_id,
    acknowledged_at: row.acknowledged_at,
  });
}

function parseActivity(raw) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { fail('corrupt-activity'); }
  const document = closedObject(value, ACTIVITY_KEYS);
  if (!document || document.schema !== ACTIVITY_SCHEMA || !Array.isArray(document.entries)) {
    fail('corrupt-activity');
  }
  const activity = new Map();
  for (const candidate of document.entries) {
    const entry = closedObject(candidate, ACTIVITY_ENTRY_KEYS);
    if (!entry || !boundedString(entry.subject_id, 64) ||
        !Number.isSafeInteger(entry.last_heard) || entry.last_heard < 0 ||
        activity.has(entry.subject_id)) fail('corrupt-activity');
    activity.set(entry.subject_id, entry.last_heard);
  }
  return activity;
}

function isContiguous(messages, firstId, nextId) {
  if (messages.length !== nextId - firstId) return false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].id !== firstId + i) return false;
  }
  return true;
}

function readLog(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const torn = raw.length > 0 && !raw.endsWith('\n');
  const body = torn ? raw : (raw.endsWith('\n') ? raw.slice(0, -1) : raw);
  const lines = body === '' ? [] : body.split('\n');
  const completeLines = torn ? lines.slice(0, -1) : lines;
  const messages = [];
  let previousId = 0;
  for (const line of completeLines) {
    let value;
    try { value = JSON.parse(line); } catch (_) { fail('corrupt-messages'); }
    const message = parseStoredMessage(value);
    if (!message) fail('corrupt-messages');
    if (message.id <= previousId) fail('inconsistent-state');
    previousId = message.id;
    messages.push(message);
  }
  return { messages, torn, raw };
}

function readReceipts(filePath, messages) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const torn = raw.length > 0 && !raw.endsWith('\n');
  const kept = torn ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
  const lines = kept === '' ? [] : kept.trimEnd().split('\n');
  const receipts = new Map();
  const rows = [];
  const byId = new Map(messages.map(message => [message.id, message]));
  for (const line of lines) {
    if (line === '') continue;
    let value;
    try { value = JSON.parse(line); } catch (_) { fail('corrupt-receipts'); }
    const receipt = parseReceipt(value);
    const message = receipt && byId.get(receipt.message_id);
    if (!receipt || !message ||
        !message.recipients.some(recipient => recipient.subject_id === receipt.subject_id)) {
      fail('corrupt-receipts');
    }
    const key = receipt.message_id + '\0' + receipt.subject_id;
    if (receipts.has(key)) fail('corrupt-receipts');
    receipts.set(key, receipt.acknowledged_at);
    rows.push(receipt);
  }
  return { raw, kept, torn, receipts, rows };
}

function sessionFor(subjectId, discriminator) {
  const result = discriminator(subjectId);
  const row = closedObject(result, ['session']);
  if (!row || !(row.session === null ||
      (Number.isSafeInteger(row.session) && row.session > 0))) {
    fail('invalid-session-discriminator');
  }
  return row.session;
}

function publicMessage(message, receiptMap, discriminator) {
  return Object.freeze({
    id: message.id,
    ts: message.ts,
    subject_id: message.subject_id,
    byline: message.byline,
    kind: message.kind,
    session: message.kind === 'seat' ? sessionFor(message.subject_id, discriminator) : null,
    text: message.text,
    product: message.product,
    product_provenance: message.product_provenance,
    recipients: Object.freeze(message.recipients.map(recipient => Object.freeze({
      subject_id: recipient.subject_id,
      name: recipient.name,
      session: sessionFor(recipient.subject_id, discriminator),
      acknowledged_at: receiptMap.has(message.id + '\0' + recipient.subject_id)
        ? receiptMap.get(message.id + '\0' + recipient.subject_id) : null,
    }))),
    client_message_id: message.client_message_id,
  });
}

function refuseUnread(ids, count) {
  const error = new Error('chat.store: unread-addressed');
  error.code = 'unread-addressed';
  error.unread_ids = Object.freeze(ids);
  error.unread_count = count;
  throw error;
}

/* Finish or abandon a side-car clear, decided by whether the transcript clear
 * landed. The transcript's own marker (archive.js) is recovered first, so
 * `firstId` is final here. An era moved to `source_next_id` means the clear
 * happened and the staged next side-car (the carried asks) is installed; any
 * other floor means it never did, and the live side-car stands. */
function recoverAnnotationsClear(dataDir, root, firstId) {
  const livePath = path.join(root, 'annotations.jsonl');
  const nextPath = path.join(root, 'annotations.next.jsonl');
  const markerPath = path.join(root, 'annotations.clear.pending.json');
  if (!fs.existsSync(markerPath)) {
    if (fs.existsSync(nextPath)) {
      fs.unlinkSync(nextPath);
      fsyncDirectory(root);
    }
    return;
  }
  let marker;
  try { marker = closedObject(JSON.parse(fs.readFileSync(markerPath, 'utf8')), ANNOTATIONS_MARKER_KEYS); }
  catch (_) { marker = null; }
  if (!marker || marker.schema !== 1 || typeof marker.archive_id !== 'string' ||
      !Number.isSafeInteger(marker.source_next_id) || marker.source_next_id < 1 ||
      !/^[0-9a-f]{64}$/.test(marker.staged_sha256) ||
      !/^[0-9a-f]{64}$/.test(marker.archive_sha256)) fail('inconsistent-state');
  if (firstId === marker.source_next_id) {
    if (fs.existsSync(nextPath)) {
      // The era's live rows are replaced only while their archive is intact,
      // as the transcript is truncated only after its own archive verifies.
      let archived;
      try { archived = fs.readFileSync(archivePaths(dataDir, marker.archive_id).annotations); }
      catch (_) { fail('inconsistent-state'); }
      if (Annotations.sha256(archived) !== marker.archive_sha256 ||
          Annotations.sha256(fs.readFileSync(nextPath)) !== marker.staged_sha256) {
        fail('inconsistent-state');
      }
      fs.renameSync(nextPath, livePath);
    } else if (fs.existsSync(livePath) &&
        Annotations.sha256(fs.readFileSync(livePath)) !== marker.staged_sha256) {
      fail('inconsistent-state');
    }
    // No staged and no live file: the side-car was dropped, and missing
    // means empty. The marker goes with it.
  } else if (fs.existsSync(nextPath)) {
    fs.unlinkSync(nextPath);
  }
  fs.unlinkSync(markerPath);
  fsyncDirectory(root);
}

function readAnnotations(filePath, messages, firstId) {
  const bytes = fs.readFileSync(filePath);
  const torn = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  const keptBytes = torn ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
  const kept = bytes.subarray(0, keptBytes).toString('utf8');
  const lines = kept === '' ? [] : kept.slice(0, -1).split('\n');
  const byId = new Map(messages.map(message => [message.id, message]));
  const index = Annotations.createAskIndex(firstId);
  lines.forEach((line, i) => {
    let value;
    try { value = JSON.parse(line); } catch (_) { fail('corrupt-annotations'); }
    const row = Annotations.parseRow(value, i + 1) || Annotations.laterRow(value, i + 1);
    if (!row) fail('corrupt-annotations');
    index.replay(row, row.kind === 'post' || row.kind === 'stamp' ? byId.get(row.message_id) : undefined);
  });
  return { index, torn, keptBytes };
}

function sameAnnotation(row, request) {
  if (!row || !request) return !row && !request;
  const askSame = row.ask === null || request.ask === null
    ? row.ask === request.ask
    : row.ask.of_subject_id === request.ask.of_subject_id &&
      row.ask.means === request.ask.means && row.ask.deliver === request.ask.deliver;
  const discussesSame = (row.discusses ? row.discusses.ask_id : null) === (request.discusses ?? null);
  return askSame && discussesSame && row.status === request.status && row.read_through === request.read_through &&
    row.answers.length === request.answers.length &&
    row.answers.every((answer, i) => answer.ask_id === request.answers[i].ask_id &&
      answer.choice === request.answers[i].choice);
}

function ensureBackup(source, backup) {
  const current = fs.readFileSync(source);
  if (fs.existsSync(backup)) {
    if (!fs.readFileSync(backup).equals(current)) fail('inconsistent-state');
    return;
  }
  fs.writeFileSync(backup, current, { mode: 0o600, flag: 'wx' });
  fsyncFile(backup);
}

function openStore(opts) {
  const input = closedObject(opts, ['dataDir']) ||
    closedObject(opts, ['dataDir', 'aiSessionDiscriminator']);
  if (!input) fail('invalid-options');
  const dataDir = input.dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.includes('\0') ||
      !path.isAbsolute(dataDir)) {
    fail('invalid-data-dir');
  }
  if (input.aiSessionDiscriminator !== undefined &&
      typeof input.aiSessionDiscriminator !== 'function') fail('invalid-options');
  const aiSessionDiscriminator = input.aiSessionDiscriminator ||
    (() => Object.freeze({ session: null }));
  let dataStat;
  try { dataStat = fs.statSync(dataDir); } catch (_) { fail('data-dir-missing'); }
  if (!dataStat.isDirectory()) fail('invalid-data-dir');

  const root = path.join(dataDir, 'chat');
  const metaPath = path.join(root, 'meta.json');
  const messagesPath = path.join(root, 'messages.jsonl');
  const receiptsPath = path.join(root, 'receipts.jsonl');
  const activityPath = path.join(root, 'activity.json');
  const annotationsPath = path.join(root, 'annotations.jsonl');
  const annotationsNextPath = path.join(root, 'annotations.next.jsonl');
  const annotationsMarkerPath = path.join(root, 'annotations.clear.pending.json');
  recoverPendingClear(dataDir);
  const metaExists = fs.existsSync(metaPath);
  const messagesExist = fs.existsSync(messagesPath);
  if (metaExists !== messagesExist) fail('inconsistent-state');

  if (!metaExists) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    fsyncDirectory(dataDir);
    fs.writeFileSync(messagesPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsyncFile(messagesPath);
    fs.writeFileSync(receiptsPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsyncFile(receiptsPath);
    atomicWriteJson(activityPath, { schema: ACTIVITY_SCHEMA, entries: [] });
    atomicWriteJson(metaPath, { schema: SCHEMA, first_id: 1, next_id: 1 });
    fsyncDirectory(root);
  }

  let meta = parseMeta(fs.readFileSync(metaPath, 'utf8'));
  if (meta.schema === LEGACY_SCHEMA) {
    ensureBackup(metaPath, path.join(root, 'meta.schema1.backup'));
    ensureBackup(messagesPath, path.join(root, 'messages.schema1.backup'));
    if (!fs.existsSync(receiptsPath)) {
      fs.writeFileSync(receiptsPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsyncFile(receiptsPath);
    } else if (fs.statSync(receiptsPath).size !== 0) {
      fail('inconsistent-state');
    }
    if (!fs.existsSync(activityPath)) {
      atomicWriteJson(activityPath, { schema: ACTIVITY_SCHEMA, entries: [] });
    } else if (parseActivity(fs.readFileSync(activityPath, 'utf8')).size !== 0) {
      fail('inconsistent-state');
    }
    meta = { schema: SCHEMA, first_id: meta.first_id, next_id: meta.next_id };
    atomicWriteJson(metaPath, meta);
    fsyncDirectory(root);
  } else if (!fs.existsSync(receiptsPath) || !fs.existsSync(activityPath)) {
    fail('inconsistent-state');
  }
  const log = readLog(messagesPath);

  if (isContiguous(log.messages, meta.first_id, meta.next_id)) {
    if (log.torn) {
      const kept = log.raw.lastIndexOf('\n') + 1;
      fs.writeFileSync(messagesPath, log.raw.slice(0, kept), { encoding: 'utf8', flag: 'w' });
      fsyncFile(messagesPath);
    }
  } else if (!log.torn && isContiguous(log.messages, meta.first_id, meta.next_id + 1) &&
      log.messages[log.messages.length - 1].id === meta.next_id) {
    meta = { schema: SCHEMA, first_id: meta.first_id, next_id: meta.next_id + 1 };
    atomicWriteJson(metaPath, meta);
  } else if (log.torn) {
    fail('torn-write');
  } else if (log.messages.length === 0 && meta.first_id < meta.next_id) {
    fail('missing-history');
  } else {
    fail('inconsistent-state');
  }

  let messages = log.messages.slice();
  if (messages.length > 0 && messages[0].id !== meta.first_id) fail('inconsistent-state');
  const receiptLog = readReceipts(receiptsPath, messages);
  if (receiptLog.torn) {
    fs.writeFileSync(receiptsPath, receiptLog.kept, { encoding: 'utf8', flag: 'w' });
    fsyncFile(receiptsPath);
  }
  const receipts = receiptLog.receipts;
  const receiptRows = receiptLog.rows.slice();
  const activity = parseActivity(fs.readFileSync(activityPath, 'utf8'));
  recoverAnnotationsClear(dataDir, root, meta.first_id);
  if (!fs.existsSync(annotationsPath)) {
    fs.writeFileSync(annotationsPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsyncFile(annotationsPath);
    fsyncDirectory(root);
  }
  const annotationLog = readAnnotations(annotationsPath, messages, meta.first_id);
  if (annotationLog.torn) {
    // Truncate, never rewrite: the side-car has no meta to catch a short file.
    fs.truncateSync(annotationsPath, annotationLog.keptBytes);
    fsyncFile(annotationsPath);
  }
  let asks = annotationLog.index;
  let expected = fileIdentity(messagesPath);
  if (!expected) fail('inconsistent-state');
  let expectedReceipts = fileIdentity(receiptsPath);
  if (!expectedReceipts) fail('inconsistent-state');
  let expectedActivity = fileIdentity(activityPath);
  if (!expectedActivity) fail('inconsistent-state');
  let expectedAnnotations = fileIdentity(annotationsPath);
  if (!expectedAnnotations) fail('inconsistent-state');
  let closed = false;
  let fatal = null;
  let queue = Promise.resolve();

  function exclusive(work) {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function requireOpen() {
    if (closed) fail('store-closed');
    if (fatal) fail(fatal);
  }

  function noteFatal(code) {
    fatal = code;
    fail(code);
  }

  function assertLiveLog() {
    const identity = fileIdentity(messagesPath);
    if (!identity) noteFatal('log-missing');
    if (!sameIdentity(identity, expected)) noteFatal('log-changed');
  }

  function assertLiveReceipts() {
    const identity = fileIdentity(receiptsPath);
    if (!identity) noteFatal('log-missing');
    if (!sameIdentity(identity, expectedReceipts)) noteFatal('log-changed');
  }

  function assertLiveActivity() {
    const identity = fileIdentity(activityPath);
    if (!identity) noteFatal('log-missing');
    if (!sameIdentity(identity, expectedActivity)) noteFatal('log-changed');
    const annotationsIdentity = fileIdentity(annotationsPath);
    if (!annotationsIdentity) noteFatal('log-missing');
    if (!sameIdentity(annotationsIdentity, expectedAnnotations)) noteFatal('log-changed');
  }

  function boundPublicRows() {
    return asks.rows.filter(entry => entry.bound).map(entry => Annotations.publicRow(entry.row));
  }

  /* The rules a post annotation must pass against live state. Returns the
   * answers with their crossings, computed now and stored as fact. */
  function checkPostAnnotation(annotation, actor, approverOf = null, decisionOf = null) {
    if (annotation.ask && annotation.ask.of_subject_id === actor.subject_id) fail('ask-of-self');
    if (annotation.read_through !== null && annotation.read_through > highWater()) {
      fail('invalid-annotation');
    }
    const answeredIds = new Set(annotation.answers.map(answer => answer.ask_id));
    const who = { subject_id: actor.subject_id, name: actor.name };
    const answers = annotation.answers.map(answer => {
      const refusal = asks.checkAnswer(answer.ask_id, answer.revision);
      if (refusal) fail(refusal);
      return Object.freeze(Object.assign({
        ask_id: answer.ask_id,
        choice: answer.choice,
        crossed_by: asks.crossingFor(answer.ask_id, who, answeredIds),
      }, asks.answerFacts(answer.ask_id, who, answer.choice, approverOf instanceof Set && approverOf.has(answer.ask_id),
        decisionOf instanceof Set && decisionOf.has(answer.ask_id))));
    });
    if (annotation.discusses !== null) {
      const refusal = asks.checkDiscuss(annotation.discusses);
      if (refusal) fail(refusal);
    }
    if (annotation.status !== null) {
      const unread = [];
      let count = 0;
      for (const message of messages) {
        if (message.id <= annotation.read_through || message.subject_id === actor.subject_id) continue;
        if (message.recipients.some(recipient => recipient.subject_id === actor.subject_id) ||
            asks.isOpenAskOf(message.id, who)) {
          count += 1;
          if (unread.length < Annotations.MAX_UNREAD_IDS) unread.push(message.id);
        }
      }
      if (count > 0) refuseUnread(unread, count);
    }
    return Object.freeze(answers);
  }

  function highWater() {
    return meta.next_id - 1;
  }

  /* `requireNew`: a retry under a client id already used is refused, not
   * replayed, inside this same lock, for a caller that must know its post is
   * the first under that id. */
  // `approverOf`: host-only, the requests for approval this author answers as
  // the approver the host re-derived; never from a request body.
  function append(untrusted, trusted, annotationInput = null, requireNew = false, approverOf = null, decisionOf = null) {
    return exclusive(() => {
      requireOpen();
      const body = closedObject(untrusted, UNTRUSTED_KEYS);
      const actor = closedObject(trusted, TRUSTED_KEYS);
      if (!body || !isAllowedText(body.text)) fail('invalid-text');
      const annotation = annotationInput === null ? null : Annotations.parseRequest(annotationInput);
      if (annotationInput !== null && annotation === null) fail('invalid-annotation');
      if (!actor || !boundedString(actor.subject_id, 64) ||
          !boundedString(actor.name, MAX_BYLINE_BYTES) || !KINDS.includes(actor.kind) ||
          !Array.isArray(actor.recipients) || actor.recipients.length > 32) {
        fail('invalid-actor');
      }
      if (actor.kind === 'person') {
        if (actor.product !== null || actor.product_provenance !== null ||
            actor.client_message_id !== null) fail('invalid-actor');
      } else {
        if (!validProduct(actor.product) ||
            (actor.product_provenance !== 'client-reported' &&
              actor.product_provenance !== 'adapter-reported') ||
            !UUID_V4.test(actor.client_message_id)) fail('invalid-actor');
      }
      const recipientIds = new Set();
      const normalizedRecipients = [];
      for (const candidate of actor.recipients) {
        const recipient = closedObject(candidate, RECIPIENT_KEYS);
        if (!recipient || !boundedString(recipient.subject_id, 64) ||
            !boundedString(recipient.name, MAX_BYLINE_BYTES) ||
            recipient.subject_id === actor.subject_id || recipientIds.has(recipient.subject_id)) {
          fail('invalid-actor');
        }
        recipientIds.add(recipient.subject_id);
        normalizedRecipients.push(Object.freeze({
          subject_id: recipient.subject_id,
          name: recipient.name,
        }));
      }
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      if (actor.client_message_id !== null) {
        const prior = messages.find(message =>
          message.subject_id === actor.subject_id &&
          message.client_message_id === actor.client_message_id);
        if (prior) {
          if (requireNew === true) fail('already-posted');
          const exact = prior.text === body.text && prior.byline === actor.name &&
            prior.kind === actor.kind && prior.product === actor.product &&
            prior.product_provenance === actor.product_provenance;
          if (!exact || !sameAnnotation(asks.posts.get(prior.id) || null, annotation)) {
            fail('message-id-collision');
          }
          return publicMessage(prior, receipts, aiSessionDiscriminator);
        }
      }
      const answers = annotation ? checkPostAnnotation(annotation, actor, approverOf, decisionOf) : null;
      const record = Object.freeze({
        id: meta.next_id,
        ts: Date.now(),
        subject_id: actor.subject_id,
        byline: actor.name,
        kind: actor.kind,
        text: body.text,
        product: actor.product,
        product_provenance: actor.product_provenance,
        recipients: Object.freeze(normalizedRecipients),
        client_message_id: actor.client_message_id,
      });
      // The post row goes first. A crash before the message line leaves a row
      // that fails the bind check (no message with this id, author and ts).
      const row = annotation === null ? null : Annotations.parseRow({
        v: Annotations.ROW_VERSION,
        seq: asks.rows.length + 1,
        ts: record.ts,
        kind: 'post',
        message_id: record.id,
        subject_id: actor.subject_id,
        name: actor.name,
        ask: annotation.ask,
        answers,
        status: annotation.status,
        read_through: annotation.read_through,
        discusses: annotation.discusses === null ? null : {
          ask_id: annotation.discusses,
          party: asks.partyOf(annotation.discusses, { subject_id: actor.subject_id, name: actor.name }),
        },
      }, asks.rows.length + 1);
      if (annotation !== null && row === null) fail('invalid-annotation');
      try {
        if (row !== null) {
          appendLineExisting(annotationsPath, Annotations.encodeRow(row));
          expectedAnnotations = fileIdentity(annotationsPath);
          if (!expectedAnnotations) noteFatal('log-missing');
        }
        appendLineExisting(messagesPath, JSON.stringify(record) + '\n');
        const nextMeta = { schema: SCHEMA, first_id: meta.first_id, next_id: record.id + 1 };
        atomicWriteJson(metaPath, nextMeta);
        expected = fileIdentity(messagesPath);
        if (!expected) noteFatal('log-missing');
        messages.push(record);
        meta = nextMeta;
        if (row !== null) asks.replay(row, record);
        return publicMessage(record, receipts, aiSessionDiscriminator);
      } catch (error) {
        if (error && (error.code === 'store-fatal' || error.code === 'log-missing' ||
            error.code === 'log-changed')) {
          fatal = error.code;
          throw error;
        }
        if (error && OWN_CODES.includes(error.code)) throw error;
        noteFatal('store-fatal');
      }
    });
  }

  /* The durable high-water mark, served without messages, receipts, waits, or
   * any cursor effect. Exists so a seat can learn "current" without consuming
   * the transcript (the skip-to-current contract): a skip is not a read and
   * must never share a read's machinery. */
  function head() {
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      return Object.freeze({ head: highWater(), first_id: meta.first_id });
    });
  }

  function peekResult(newestFirst, searchedFrom, searchedTo, complete) {
    const oldestFirst = newestFirst.slice().reverse();
    return Object.freeze({
      messages: Object.freeze(oldestFirst),
      next_before: complete ? null : searchedFrom,
      first_id: meta.first_id,
      searched_from: searchedFrom,
      searched_to: searchedTo,
      complete,
    });
  }

  /* Bounded look-back: newest `limit` messages with id < before, returned
   * oldest-first. Does not advance any client cursor. */
  function peekBefore(query) {
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const q = closedObject(query, ['before', 'limit']);
      if (!q || !Number.isSafeInteger(q.before) || q.before < 1 ||
          !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_READ_LIMIT) {
        fail('invalid-read');
      }
      const high = Math.min(q.before - 1, highWater());
      if (high < meta.first_id) {
        return peekResult([], meta.first_id, high, true);
      }
      const selected = [];
      let index = messages.length - 1;
      while (index >= 0 && messages[index].id > high) index -= 1;
      while (index >= 0 && selected.length < q.limit) {
        selected.push(publicMessage(messages[index], receipts, aiSessionDiscriminator));
        index -= 1;
      }
      const complete = index < 0;
      const searchedFrom = selected.length > 0 ? selected[selected.length - 1].id : meta.first_id;
      return peekResult(selected, searchedFrom, high, complete);
    });
  }

  function peekFind(query) {
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const q = closedObject(query, ['find', 'limit', 'before']);
      if (!q || typeof q.find !== 'string' || q.find.length < 1 ||
          q.find.length > PEEK_FIND_MAX || q.find.includes('\0') ||
          !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_READ_LIMIT ||
          !Number.isSafeInteger(q.before) || q.before < 1) {
        fail('invalid-read');
      }
      const high = Math.min(q.before - 1, highWater());
      if (high < meta.first_id) {
        return peekResult([], meta.first_id, high, true);
      }
      const needle = q.find.toLowerCase();
      const selected = [];
      let scanned = 0;
      let index = messages.length - 1;
      while (index >= 0 && messages[index].id > high) index -= 1;
      let searchedFrom = high;
      while (index >= 0 && scanned < PEEK_SCAN_LIMIT) {
        const message = messages[index];
        searchedFrom = message.id;
        scanned += 1;
        if (String(message.text).toLowerCase().includes(needle) &&
            selected.length < q.limit) {
          selected.push(publicMessage(message, receipts, aiSessionDiscriminator));
        }
        index -= 1;
      }
      const complete = index < 0;
      return peekResult(selected, searchedFrom, high, complete);
    });
  }

  function read(query) {
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const q = closedObject(query, ['after', 'limit']);
      if (!q || !Number.isSafeInteger(q.after) || q.after < 0 ||
          q.after > highWater() ||
          !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_READ_LIMIT) {
        fail('invalid-read');
      }
      const page = [];
      for (const message of messages) {
        if (message.id <= q.after) continue;
        page.push(publicMessage(message, receipts, aiSessionDiscriminator));
        if (page.length === q.limit) break;
      }
      const cursor = page.length === 0
        ? Math.max(q.after, meta.first_id - 1)
        : page[page.length - 1].id;
      return Object.freeze({ messages: Object.freeze(page), cursor, first_id: meta.first_id });
    });
  }

  function snapshot() {
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      return Object.freeze({
        first_id: meta.first_id,
        next_id: meta.next_id,
        messages: Object.freeze(messages.map(message =>
          publicMessage(message, receipts, aiSessionDiscriminator))),
        annotations: Object.freeze(boundPublicRows()),
      });
    });
  }

  /* A lifecycle row: the asker withdraws an open ask or keeps an answered one
   * open. Never rings. */
  function annotate(input) {
    return exclusive(() => {
      requireOpen();
      const request = closedObject(input, LIFECYCLE_INPUT_KEYS);
      if (!request || !boundedString(request.subject_id, 64) ||
          !boundedString(request.name, MAX_BYLINE_BYTES) ||
          !['withdraw', 'keep_open', 'revise', 'approval'].includes(request.kind) ||
          !Number.isSafeInteger(request.ask_id) || request.ask_id < 1 ||
          (request.kind !== 'revise' && request.means !== null) ||
          (request.kind === 'revise' && !(request.means === null || Annotations.validMeans(request.means)))) {
        fail('invalid-annotation');
      }
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const refusal = asks.checkLifecycle(request.kind, request.ask_id, request.subject_id, true);
      if (refusal) fail(refusal);
      // An ask of a person always says what a yes means, revised or not.
      if (request.kind === 'revise' && request.means === null &&
          asks.asks.get(request.ask_id).of_kind === 'person') fail('means-required');
      const row = Annotations.parseRow(Object.assign({
        v: Annotations.ROW_VERSION,
        seq: asks.rows.length + 1,
        ts: Date.now(),
        kind: request.kind,
        subject_id: request.subject_id,
        name: request.name,
        ask_id: request.ask_id,
      }, request.kind === 'revise' ? { means: request.means } : {}), asks.rows.length + 1);
      if (!row) fail('invalid-annotation');
      try {
        appendLineExisting(annotationsPath, Annotations.encodeRow(row));
        expectedAnnotations = fileIdentity(annotationsPath);
        if (!expectedAnnotations) noteFatal('log-missing');
        asks.replay(row, undefined);
        return Annotations.publicRow(row);
      } catch (error) {
        if (error && (error.code === 'store-fatal' || error.code === 'log-missing' ||
            error.code === 'log-changed')) {
          fatal = error.code;
          throw error;
        }
        if (error && OWN_CODES.includes(error.code)) throw error;
        noteFatal('store-fatal');
      }
    });
  }

  /* A stamp row: the project a message belongs to and why. Only the
   * message's author stamps it, and only a message of this era. A derived
   * stamp (any reason but `set`) is written once per message: a retried post
   * keeps the stamp it has, so it never undoes its author's own `set`. Returns
   * the public row, or the existing one when a derived stamp was not needed. */
  function stamp(input) {
    return exclusive(() => {
      requireOpen();
      const request = closedObject(input, STAMP_INPUT_KEYS);
      if (!request || !boundedString(request.subject_id, 64) ||
          !boundedString(request.name, MAX_BYLINE_BYTES)) fail('invalid-annotation');
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const message = Number.isSafeInteger(request.message_id)
        ? messages.find(candidate => candidate.id === request.message_id) : undefined;
      if (!message) fail('message-not-found');
      if (message.subject_id !== request.subject_id) fail('not-author');
      if (request.reason !== 'set' && asks.stamps.has(message.id)) {
        return Annotations.publicRow(asks.stamps.get(message.id));
      }
      const row = Annotations.parseRow({
        v: Annotations.ROW_VERSION,
        seq: asks.rows.length + 1,
        ts: Date.now(),
        kind: 'stamp',
        subject_id: request.subject_id,
        name: request.name,
        message_id: request.message_id,
        project: request.project,
        reason: request.reason,
        record_id: request.record_id,
      }, asks.rows.length + 1);
      if (!row) fail('invalid-annotation');
      try {
        appendLineExisting(annotationsPath, Annotations.encodeRow(row));
        expectedAnnotations = fileIdentity(annotationsPath);
        if (!expectedAnnotations) noteFatal('log-missing');
        asks.replay(row, message);
        return Annotations.publicRow(row);
      } catch (error) {
        if (error && (error.code === 'store-fatal' || error.code === 'log-missing' ||
            error.code === 'log-changed')) {
          fatal = error.code;
          throw error;
        }
        if (error && OWN_CODES.includes(error.code)) throw error;
        noteFatal('store-fatal');
      }
    });
  }

  /* Bound rows after `after` (a side-car seq). The cursor passes over rows
   * that never bound. `first_id` is the era: a client that sees it change
   * starts again from 0, as it does for messages. */
  function readAnnotationRows(query) {
    return exclusive(() => {
      requireOpen();
      const q = closedObject(query, ['after', 'limit']);
      if (!q || !Number.isSafeInteger(q.after) || q.after < 0 ||
          !Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_READ_LIMIT) {
        fail('invalid-read');
      }
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const page = [];
      let cursor = Math.min(q.after, asks.rows.length);
      for (let i = cursor; i < asks.rows.length && page.length < q.limit; i++) {
        cursor = i + 1;
        if (asks.rows[i].bound) page.push(Annotations.publicRow(asks.rows[i].row));
      }
      return Object.freeze({ rows: Object.freeze(page), cursor, first_id: meta.first_id });
    });
  }

  /* For the host only, never a route: what the room stored about one post.
   * The ask's addressee and, per answer, its choice, whether its author was
   * the one asked, and that ask's addressee. Identities stay server-side. */
  function addresseeOf(ask) {
    return Object.freeze({ kind: ask.of_kind, subject_id: ask.of_subject_id, name: ask.of_name });
  }

  function postFacts(messageId) {
    return exclusive(() => {
      requireOpen();
      const row = asks.posts.get(messageId);
      if (!row) return null;
      // The ask this post closed as its done receipt, if it did.
      const discussed = row.discusses ? asks.asks.get(row.discusses.ask_id) : null;
      return Object.freeze({
        done_of: discussed && discussed.done && discussed.done.message_id === messageId ? discussed.ask_id : null,
        ask: row.ask ? addresseeOf(row.ask) : null,
        answers: Object.freeze(row.answers.map(answer => {
          const ask = asks.asks.get(answer.ask_id);
          return Object.freeze({
            ask_id: answer.ask_id, choice: answer.choice, by_addressee: answer.by_addressee,
            revision: answer.revision, of: ask ? addresseeOf(ask) : null,
          });
        })),
      });
    });
  }

  /* The answers an ask's addressee has given it so far, oldest first, with
   * the words and author of each, for the host to catch up a late binding. */
  function addresseeAnswers(askId) {
    return exclusive(() => {
      requireOpen();
      const ask = asks.asks.get(askId);
      if (!ask) return Object.freeze([]);
      return Object.freeze(ask.answers.filter(answer => answer.by_addressee).map(answer => {
        const message = messages.find(candidate => candidate.id === answer.message_id);
        return message ? Object.freeze({
          message_id: answer.message_id, choice: answer.choice, revision: answer.revision, text: message.text,
          author: Object.freeze({ subject_id: message.subject_id, name: message.byline, kind: message.kind }),
          of: addresseeOf(ask),
        }) : null;
      }).filter(Boolean));
    });
  }

  /* For the host only, never a route: the revision a revise row this store
   * just wrote made, so the Work record follows it by number, not by the
   * order requests happen to arrive in. Null when that row is not this era's. */
  function revisionOf(row) {
    return exclusive(() => {
      requireOpen();
      const entry = row && Number.isSafeInteger(row.seq) ? asks.rows[row.seq - 1] : undefined;
      if (!entry || !entry.bound || entry.row.kind !== 'revise' || entry.row.ask_id !== row.ask_id ||
          entry.row.ts !== row.ts || !Number.isSafeInteger(entry.revision)) return null;
      return entry.revision;
    });
  }

  /* For the host only, never a route: the project of the ask this saved post
   * answers or discusses, so a reply sits in its question's project. Null when
   * the post answers and discusses no known ask. */
  function repliedAskProject(messageId) {
    return exclusive(() => {
      requireOpen();
      const row = asks.posts.get(messageId);
      if (!row) return null;
      const ids = row.answers.map(answer => answer.ask_id);
      if (row.discusses) ids.push(row.discusses.ask_id);
      for (const id of ids) {
        const ask = asks.asks.get(id);
        if (ask && typeof ask.project === 'string') return ask.project;
      }
      return null;
    });
  }

  /* For the host only, never a route: who asked each of these asks, so an
   * answer or a reply to an ask can ring its asker. Unknown ids are left out. */
  function askersOf(askIds) {
    return exclusive(() => {
      requireOpen();
      const found = [];
      for (const askId of askIds) {
        const ask = asks.asks.get(askId);
        if (ask) found.push(Object.freeze({ ask_id: askId, subject_id: ask.asker_subject_id, name: ask.asker_name }));
      }
      return Object.freeze(found);
    });
  }

  /* The ask a seat's earlier post with this client id carried, so a retry
   * can be answered by the idempotency rule even if the addressee has since
   * left the roster. */
  function priorAsk(subjectId, clientMessageId) {
    return exclusive(() => {
      requireOpen();
      const prior = messages.find(message => message.subject_id === subjectId &&
        message.client_message_id === clientMessageId);
      const row = prior ? asks.posts.get(prior.id) : null;
      return row && row.ask ? Object.freeze({
        subject_id: row.ask.of_subject_id, name: row.ask.of_name, kind: row.ask.of_kind,
      }) : null;
    });
  }

  function openAsks(subjectId, name) {
    return exclusive(() => {
      requireOpen();
      if (!boundedString(subjectId, 64) || !boundedString(name, MAX_BYLINE_BYTES)) fail('invalid-read');
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      return asks.openAsksFor({ subject_id: subjectId, name });
    });
  }

  function clear(input) {
    return exclusive(() => {
      requireOpen();
      const request = closedObject(input, CLEAR_KEYS);
      if (!request || typeof request.archive_id !== 'string' ||
          !Number.isSafeInteger(request.exported_at) || request.exported_at < 0 ||
          !/^[0-9a-f]{64}$/.test(request.json_sha256) ||
          !/^[0-9a-f]{64}$/.test(request.markdown_sha256) ||
          !/^[0-9a-f]{64}$/.test(request.annotations_sha256)) fail('invalid-clear');
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();

      let verified;
      try { verified = verifyArchiveSet(dataDir, request.archive_id); }
      catch (_) { fail('archive-invalid'); }
      const current = Object.freeze({
        first_id: meta.first_id,
        next_id: meta.next_id,
        messages: Object.freeze(messages.map(message =>
          publicMessage(message, receipts, aiSessionDiscriminator))),
      });
      let expectedDocument;
      try { expectedDocument = documentFromSnapshot(current, request.exported_at); }
      catch (_) { fail('archive-invalid'); }
      if (verified.json_sha256 !== request.json_sha256 ||
          verified.markdown_sha256 !== request.markdown_sha256 ||
          JSON.stringify(verified.document) !== JSON.stringify(expectedDocument)) {
        fail('archive-stale');
      }
      // The side-car's archive is checked the way the transcript's is: the
      // live public projection, re-encoded, must be byte-identical to it.
      let archivedAnnotations;
      try { archivedAnnotations = fs.readFileSync(archivePaths(dataDir, request.archive_id).annotations); }
      catch (_) { fail('archive-invalid'); }
      if (Annotations.sha256(archivedAnnotations) !== request.annotations_sha256 ||
          !archivedAnnotations.equals(Annotations.encodeArchive(boundPublicRows()))) {
        fail('archive-stale');
      }
      // Open asks survive the clear (Patti's ruling, 2026-10-28): each becomes
      // a carry row in the next era, pointing at the archive that holds its
      // message. An ask already carried keeps its first archive.
      // An ask with a story to keep (a revision, or a yes not yet done) is
      // carried as one carry_state row instead: its revision, its earlier
      // scopes and that yes, so the done receipt still lands after the clear.
      // A release before it passes that row over and never shows the ask, so
      // nothing can answer it there that the story would later override.
      const carriedAt = Date.now();
      const carryRows = asks.openAsks().map((ask, i) => {
        const state = asks.carriedState(ask.ask_id);
        return Annotations.parseRow(Object.assign({
          v: Annotations.ROW_VERSION,
          seq: i + 1,
          ts: carriedAt,
          kind: state === null ? 'carry' : 'carry_state',
          subject_id: ask.asker_subject_id,
          name: ask.asker_name,
          ask_id: ask.ask_id,
          archive_id: ask.carried_from || request.archive_id,
          asked_at: ask.asked_at,
          era_first_id: meta.next_id,
          kept_open: ask.kept_open,
          ask: {
            of_subject_id: ask.of_subject_id,
            of_name: ask.of_name,
            of_kind: ask.of_kind,
            means: ask.means,
            deliver: ask.deliver,
            project: ask.project,
          },
        }, state === null ? {} : state), i + 1);
      });
      // A carried request for approval is re-marked right after the carries.
      for (const ask of asks.openAsks().filter(entry => entry.approval)) {
        const seq = carryRows.length + 1;
        carryRows.push(Annotations.parseRow({
          v: Annotations.ROW_VERSION, seq, ts: carriedAt, kind: 'approval',
          subject_id: ask.asker_subject_id, name: ask.asker_name, ask_id: ask.ask_id,
        }, seq));
      }
      if (carryRows.some(row => row === null)) fail('archive-invalid');
      const staged = Buffer.from(carryRows.map(Annotations.encodeRow).join(''), 'utf8');
      const marker = Object.freeze({
        schema: 1,
        archive_id: request.archive_id,
        exported_at: request.exported_at,
        source_first_id: meta.first_id,
        source_next_id: meta.next_id,
        message_count: messages.length,
        json_sha256: request.json_sha256,
        markdown_sha256: request.markdown_sha256,
      });
      try {
        // Order is the recovery contract (recoverAnnotationsClear): staged
        // side-car, its marker, then the transcript clear, then the install.
        fs.writeFileSync(annotationsNextPath, staged, { mode: 0o600, flag: 'w' });
        fsyncFile(annotationsNextPath);
        atomicWriteJson(annotationsMarkerPath, {
          schema: 1,
          archive_id: request.archive_id,
          source_next_id: meta.next_id,
          staged_sha256: Annotations.sha256(staged),
          archive_sha256: request.annotations_sha256,
        });
        fsyncDirectory(root);
        commitVerifiedClear(dataDir, marker);
        fs.renameSync(annotationsNextPath, annotationsPath);
        fsyncDirectory(root);
        fs.unlinkSync(annotationsMarkerPath);
        fsyncDirectory(root);
        meta = { schema: SCHEMA, first_id: marker.source_next_id, next_id: marker.source_next_id };
        messages = [];
        receipts.clear();
        receiptRows.length = 0;
        asks = Annotations.createAskIndex(marker.source_next_id);
        for (const row of carryRows) asks.replay(row, undefined);
        expected = fileIdentity(messagesPath);
        expectedReceipts = fileIdentity(receiptsPath);
        expectedAnnotations = fileIdentity(annotationsPath);
        if (!expected || !expectedReceipts || !expectedAnnotations) noteFatal('log-missing');
        return Object.freeze({ ok: true, first_id: meta.first_id, next_id: meta.next_id });
      } catch (caught) {
        fatal = 'store-fatal';
        if (caught && OWN_CODES.includes(caught.code)) throw caught;
        fail('store-fatal');
      }
    });
  }

  function acknowledge(input) {
    return exclusive(() => {
      requireOpen();
      const body = closedObject(input, ['subject_id', 'message_ids', 'now']);
      if (!body || !boundedString(body.subject_id, 64) ||
          !Array.isArray(body.message_ids) || body.message_ids.length < 1 ||
          body.message_ids.length > MAX_READ_LIMIT ||
          !Number.isSafeInteger(body.now) || body.now < 0) fail('invalid-ack');
      const ids = new Set();
      for (const id of body.message_ids) {
        if (!Number.isSafeInteger(id) || id < 1 || ids.has(id)) fail('invalid-ack');
        ids.add(id);
        const message = messages.find(candidate => candidate.id === id);
        if (!message || !message.recipients.some(recipient =>
          recipient.subject_id === body.subject_id)) fail('invalid-ack');
      }
      try {
        assertLiveLog();
        assertLiveReceipts();
        assertLiveActivity();
        let added = 0;
        for (const messageId of ids) {
          const key = messageId + '\0' + body.subject_id;
          if (receipts.has(key)) continue;
          const receipt = {
            message_id: messageId,
            subject_id: body.subject_id,
            acknowledged_at: body.now,
          };
          appendLineExisting(receiptsPath, JSON.stringify(receipt) + '\n');
          expectedReceipts = fileIdentity(receiptsPath);
          if (!expectedReceipts) noteFatal('log-missing');
          receipts.set(key, body.now);
          receiptRows.push(Object.freeze({
            message_id: messageId,
            subject_id: body.subject_id,
            acknowledged_at: body.now,
          }));
          added += 1;
        }
        return Object.freeze({ ok: true, acknowledged: ids.size, added });
      } catch (error) {
        if (error && (error.code === 'store-fatal' || error.code === 'log-missing' ||
            error.code === 'log-changed')) {
          fatal = error.code;
          throw error;
        }
        if (error && OWN_CODES.includes(error.code)) throw error;
        noteFatal('store-fatal');
      }
    });
  }

  function touch(subjectId, now) {
    return exclusive(() => {
      requireOpen();
      if (!boundedString(subjectId, 64) || !Number.isSafeInteger(now) || now < 0) {
        fail('invalid-activity');
      }
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const prior = activity.get(subjectId);
      if (prior !== undefined && now <= prior) return Object.freeze({ last_heard: prior });
      activity.set(subjectId, now);
      try {
        atomicWriteJson(activityPath, {
          schema: ACTIVITY_SCHEMA,
          entries: [...activity].map(([id, lastHeard]) => ({
            subject_id: id, last_heard: lastHeard,
          })),
        });
        expectedActivity = fileIdentity(activityPath);
        if (!expectedActivity) noteFatal('log-missing');
        return Object.freeze({ last_heard: now });
      } catch (error) {
        if (error && OWN_CODES.includes(error.code)) throw error;
        noteFatal('store-fatal');
      }
    });
  }

  function participantState(subjectIds) {
    return exclusive(() => {
      requireOpen();
      if (!Array.isArray(subjectIds) || subjectIds.length > 64 ||
          subjectIds.some(id => !boundedString(id, 64)) ||
          new Set(subjectIds).size !== subjectIds.length) fail('invalid-activity');
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      return Object.freeze(subjectIds.map(subjectId => {
        let outstanding = 0;
        let lastPostedAt = null;
        let lastFetchedAt = null;
        for (const message of messages) {
          if (message.subject_id === subjectId &&
              (lastPostedAt === null || message.ts > lastPostedAt)) lastPostedAt = message.ts;
          if (!message.recipients.some(recipient => recipient.subject_id === subjectId)) continue;
          const acknowledgedAt = receipts.get(message.id + '\0' + subjectId);
          if (acknowledgedAt === undefined) {
            outstanding += 1;
          } else if (lastFetchedAt === null || acknowledgedAt > lastFetchedAt) {
            lastFetchedAt = acknowledgedAt;
          }
        }
        return Object.freeze({
          subject_id: subjectId,
          last_heard: activity.get(subjectId) ?? null,
          outstanding,
          fetched_without_post_at: lastFetchedAt !== null &&
            (lastPostedAt === null || lastFetchedAt > lastPostedAt) ? lastFetchedAt : null,
          // When it last said something in this era: a poll is not speech.
          last_posted_at: lastPostedAt,
        });
      }));
    });
  }

  function deliveryChanges(query) {
    return exclusive(() => {
      requireOpen();
      const q = closedObject(query, ['after', 'limit']);
      if (!q || !Number.isSafeInteger(q.after) || q.after < 0 ||
          q.after > receiptRows.length || !Number.isSafeInteger(q.limit) ||
          q.limit < 1 || q.limit > MAX_READ_LIMIT) fail('invalid-read');
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const rows = receiptRows.slice(q.after, q.after + q.limit).map(receipt => {
        const message = messages.find(candidate => candidate.id === receipt.message_id);
        const recipient = message && message.recipients.find(candidate =>
          candidate.subject_id === receipt.subject_id);
        if (!recipient) fail('corrupt-receipts');
        return Object.freeze({
          message_id: receipt.message_id,
          subject_id: receipt.subject_id,
          name: recipient.name,
          session: sessionFor(recipient.subject_id, aiSessionDiscriminator),
          acknowledged_at: receipt.acknowledged_at,
        });
      });
      return Object.freeze({
        changes: Object.freeze(rows),
        cursor: q.after + rows.length,
      });
    });
  }

  async function close() {
    return exclusive(() => {
      closed = true;
    });
  }

  function coordinateIdleRelease(options) {
    const seats = options && options.seats;
    const now = options && options.now;
    const idleMs = options && options.idleMs;
    const commit = options && options.commit;
    if (!Array.isArray(seats) || !Number.isSafeInteger(now) || now < 0 ||
        !Number.isSafeInteger(idleMs) || idleMs < 1 || typeof commit !== 'function') {
      fail('invalid-activity');
    }
    return exclusive(() => {
      requireOpen();
      assertLiveLog();
      assertLiveReceipts();
      assertLiveActivity();
      const subject_ids = [];
      for (const row of seats) {
        if (!row || !boundedString(row.subject_id, 64) ||
            !Number.isSafeInteger(row.created_at) || row.created_at < 0) {
          fail('invalid-activity');
        }
        const lastHeard = activity.get(row.subject_id);
        const contact = Number.isSafeInteger(lastHeard) ? lastHeard : row.created_at;
        if (contact + idleMs <= now) subject_ids.push(row.subject_id);
      }
      if (subject_ids.length === 0) return 0;
      return commit(subject_ids);
    });
  }

  return Object.freeze({
    append, read, peekBefore, peekFind, head, snapshot, clear, acknowledge, touch,
    participantState, coordinateIdleRelease, deliveryChanges, close,
    annotate, stamp, readAnnotationRows, openAsks, priorAsk, postFacts, addresseeAnswers, revisionOf, askersOf, repliedAskProject,
  });
}

module.exports = Object.freeze({
  openStore,
  SCHEMA,
  MAX_TEXT_BYTES,
  MAX_READ_LIMIT,
  PEEK_SCAN_LIMIT,
  PEEK_FIND_MAX,
  DIRECTORY_SYNC_SUPPORTED,
});
