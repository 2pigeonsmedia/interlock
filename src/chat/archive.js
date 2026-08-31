'use strict';

// Verified transcript export and archive-before-clear support for Interlock's
// one room. Archive files deliberately contain only public chat facts: opaque
// identity ids and AI client idempotency keys never leave the live store.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARCHIVE_SCHEMA = 2;
const LEGACY_ARCHIVE_SCHEMA = 1;
const CLEAR_MARKER_SCHEMA = 1;
const ARCHIVE_ID = /^transcript-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOCUMENT_KEYS = Object.freeze(['schema', 'product', 'exported_at', 'transcript', 'messages']);
const TRANSCRIPT_KEYS = Object.freeze(['first_id', 'next_id', 'message_count']);
const LEGACY_MESSAGE_KEYS = Object.freeze([
  'id', 'ts', 'byline', 'kind', 'product', 'product_provenance', 'text', 'delivery',
]);
const MESSAGE_KEYS = Object.freeze([...LEGACY_MESSAGE_KEYS, 'session']);
const LEGACY_DELIVERY_KEYS = Object.freeze(['name', 'acknowledged_at']);
const DELIVERY_KEYS = Object.freeze([...LEGACY_DELIVERY_KEYS, 'session']);
const CLEAR_KEYS = Object.freeze([
  'schema', 'archive_id', 'exported_at', 'source_first_id', 'source_next_id',
  'message_count', 'json_sha256', 'markdown_sha256',
]);
const OPTION_KEYS = Object.freeze(['dataDir', 'store']);
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';
const MAX_DATE_MS = 8_640_000_000_000_000;

function error(code) {
  const value = new Error('chat.archive: ' + code);
  value.code = code;
  return value;
}

function closedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key =>
    typeof key !== 'string' || !keys.includes(key))) return null;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validDateMs(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(dirPath) {
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(filePath, body) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'w' });
  fsyncFile(tmp);
  fs.renameSync(tmp, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function archivePaths(dataDir, archiveId) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !ARCHIVE_ID.test(archiveId)) {
    throw error('invalid-archive');
  }
  const root = path.join(dataDir, 'archives');
  return Object.freeze({
    root,
    json: path.join(root, archiveId + '.json'),
    markdown: path.join(root, archiveId + '.md'),
  });
}

function clearMarkerPath(dataDir) {
  return path.join(dataDir, 'chat', 'clear.pending.json');
}

function archiveId(now) {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
  return `transcript-${stamp}-${crypto.randomUUID()}`;
}

function documentFromSnapshot(snapshot, exportedAt) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : null;
  if (!source || !Number.isSafeInteger(source.first_id) || source.first_id < 1 ||
      !Number.isSafeInteger(source.next_id) || source.next_id < source.first_id ||
      !Array.isArray(source.messages) || source.messages.length !== source.next_id - source.first_id ||
      !validDateMs(exportedAt)) throw error('invalid-snapshot');
  const messages = source.messages.map((message, index) => {
    if (!message || message.id !== source.first_id + index || !validDateMs(message.ts) ||
        typeof message.byline !== 'string' ||
        (message.kind !== 'person' && message.kind !== 'seat') ||
        (message.kind === 'seat'
          ? !(message.session === null ||
            (Number.isSafeInteger(message.session) && message.session > 0))
          : message.session !== null) ||
        typeof message.text !== 'string' || !Array.isArray(message.recipients)) {
      throw error('invalid-snapshot');
    }
    if (message.kind === 'person' &&
        (message.product !== null || message.product_provenance !== null)) {
      throw error('invalid-snapshot');
    }
    if (message.kind === 'seat' &&
        (typeof message.product !== 'string' ||
          (message.product_provenance !== 'client-reported' &&
            message.product_provenance !== 'adapter-reported'))) {
      throw error('invalid-snapshot');
    }
    const delivery = message.recipients.map(recipient => {
      if (!recipient || typeof recipient.name !== 'string' ||
          !(recipient.session === null ||
            (Number.isSafeInteger(recipient.session) && recipient.session > 0)) ||
          !(recipient.acknowledged_at === null || validDateMs(recipient.acknowledged_at))) {
        throw error('invalid-snapshot');
      }
      return Object.freeze({
        name: recipient.name,
        session: recipient.session,
        acknowledged_at: recipient.acknowledged_at,
      });
    });
    return Object.freeze({
      id: message.id,
      ts: message.ts,
      byline: message.byline,
      kind: message.kind,
      session: message.session,
      product: message.product,
      product_provenance: message.product_provenance,
      text: message.text,
      delivery: Object.freeze(delivery),
    });
  });
  return Object.freeze({
    schema: ARCHIVE_SCHEMA,
    product: 'Interlock',
    exported_at: exportedAt,
    transcript: Object.freeze({
      first_id: source.first_id,
      next_id: source.next_id,
      message_count: messages.length,
    }),
    messages: Object.freeze(messages),
  });
}

function validDocument(document) {
  const root = closedObject(document, DOCUMENT_KEYS);
  const transcript = root && closedObject(root.transcript, TRANSCRIPT_KEYS);
  if (!root || (root.schema !== ARCHIVE_SCHEMA && root.schema !== LEGACY_ARCHIVE_SCHEMA) ||
      root.product !== 'Interlock' ||
      !validDateMs(root.exported_at) || !transcript ||
      !Number.isSafeInteger(transcript.first_id) || transcript.first_id < 1 ||
      !Number.isSafeInteger(transcript.next_id) || transcript.next_id < transcript.first_id ||
      !Number.isSafeInteger(transcript.message_count) || transcript.message_count < 0 ||
      !Array.isArray(root.messages) || root.messages.length !== transcript.message_count ||
      transcript.message_count !== transcript.next_id - transcript.first_id) return false;
  for (let index = 0; index < root.messages.length; index += 1) {
    const legacy = root.schema === LEGACY_ARCHIVE_SCHEMA;
    const message = closedObject(root.messages[index],
      legacy ? LEGACY_MESSAGE_KEYS : MESSAGE_KEYS);
    if (!message || message.id !== transcript.first_id + index ||
        !validDateMs(message.ts) ||
        typeof message.byline !== 'string' || message.byline.length === 0 ||
        (message.kind !== 'person' && message.kind !== 'seat') ||
        typeof message.text !== 'string' || !Array.isArray(message.delivery)) return false;
    if (!legacy && (message.kind === 'seat'
      ? !(message.session === null ||
        (Number.isSafeInteger(message.session) && message.session > 0))
      : message.session !== null)) return false;
    if (message.kind === 'person') {
      if (message.product !== null || message.product_provenance !== null) return false;
    } else if (typeof message.product !== 'string' ||
        (message.product_provenance !== 'client-reported' &&
          message.product_provenance !== 'adapter-reported')) return false;
    for (const candidate of message.delivery) {
      const delivery = closedObject(candidate, legacy ? LEGACY_DELIVERY_KEYS : DELIVERY_KEYS);
      if (!delivery || typeof delivery.name !== 'string' || delivery.name.length === 0 ||
          (!legacy && !(delivery.session === null ||
            (Number.isSafeInteger(delivery.session) && delivery.session > 0))) ||
          !(delivery.acknowledged_at === null || validDateMs(delivery.acknowledged_at))) {
        return false;
      }
    }
  }
  return true;
}

function encodedJson(document) {
  return Buffer.from(JSON.stringify(document, null, 2) + '\n', 'utf8');
}

function markdownText(value) {
  return String(value)
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, character =>
      `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, '\\$1');
}

function textFence(text) {
  let longest = 0;
  for (const match of text.matchAll(/~+/g)) longest = Math.max(longest, match[0].length);
  return '~'.repeat(Math.max(3, longest + 1));
}

function encodedMarkdown(document) {
  if (!validDocument(document)) throw error('invalid-archive');
  const lines = [
    '# Interlock transcript',
    '',
    `Exported: ${new Date(document.exported_at).toISOString()}`,
    `Messages: ${document.transcript.message_count}`,
    `Message range: ${document.transcript.message_count === 0
      ? 'empty'
      : `${document.transcript.first_id}–${document.transcript.next_id - 1}`}`,
    '',
  ];
  for (const message of document.messages) {
    lines.push(`## ${message.id} · ${markdownText(message.byline)} · ${message.kind}`);
    lines.push('');
    lines.push(`Time: ${new Date(message.ts).toISOString()}`);
    if (message.kind === 'seat') {
      if (Number.isSafeInteger(message.session)) lines.push(`Session: ${message.session}`);
      lines.push(`Product: ${markdownText(message.product)} (${message.product_provenance})`);
    }
    if (message.delivery.length > 0) {
      lines.push('Delivery: ' + message.delivery.map(delivery => {
        const state = delivery.acknowledged_at === null
          ? 'unconfirmed'
          : `acknowledged ${new Date(delivery.acknowledged_at).toISOString()}`;
        const session = Number.isSafeInteger(delivery.session)
          ? ` · Session ${delivery.session}` : '';
        return `${markdownText(delivery.name)} — ${state}${session}`;
      }).join('; '));
    }
    lines.push('');
    const fence = textFence(message.text);
    lines.push(fence, message.text, fence, '');
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function writeArchive(dataDir, snapshot, exportedAt = Date.now()) {
  const document = documentFromSnapshot(snapshot, exportedAt);
  const id = archiveId(exportedAt);
  const files = archivePaths(dataDir, id);
  fs.mkdirSync(files.root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(files.root, 0o700);
  fsyncDirectory(dataDir);
  const json = encodedJson(document);
  const markdown = encodedMarkdown(document);
  fs.writeFileSync(files.json, json, { mode: 0o600, flag: 'wx' });
  fsyncFile(files.json);
  fs.writeFileSync(files.markdown, markdown, { mode: 0o600, flag: 'wx' });
  fsyncFile(files.markdown);
  fsyncDirectory(files.root);
  const verified = verifyArchiveSet(dataDir, id);
  if (!verified.json.equals(json) || !verified.markdown.equals(markdown)) {
    throw error('archive-verification-failed');
  }
  return Object.freeze({
    archive_id: id,
    exported_at: exportedAt,
    message_count: document.transcript.message_count,
    json_sha256: verified.json_sha256,
    markdown_sha256: verified.markdown_sha256,
  });
}

function verifyArchiveSet(dataDir, id) {
  const files = archivePaths(dataDir, id);
  let json;
  let markdown;
  try {
    json = fs.readFileSync(files.json);
    markdown = fs.readFileSync(files.markdown);
  } catch (_) {
    throw error('archive-verification-failed');
  }
  let document;
  try { document = JSON.parse(json.toString('utf8')); }
  catch (_) { throw error('archive-verification-failed'); }
  if (!validDocument(document) || !encodedJson(document).equals(json) ||
      !encodedMarkdown(document).equals(markdown)) {
    throw error('archive-verification-failed');
  }
  return Object.freeze({
    document,
    json,
    markdown,
    json_sha256: sha256(json),
    markdown_sha256: sha256(markdown),
  });
}

function validClearMarker(value) {
  const marker = closedObject(value, CLEAR_KEYS);
  return marker && marker.schema === CLEAR_MARKER_SCHEMA &&
    ARCHIVE_ID.test(marker.archive_id) && Number.isSafeInteger(marker.exported_at) &&
    marker.exported_at >= 0 && Number.isSafeInteger(marker.source_first_id) &&
    marker.source_first_id >= 1 && Number.isSafeInteger(marker.source_next_id) &&
    marker.source_next_id >= marker.source_first_id && Number.isSafeInteger(marker.message_count) &&
    marker.message_count === marker.source_next_id - marker.source_first_id &&
    /^[0-9a-f]{64}$/.test(marker.json_sha256) &&
    /^[0-9a-f]{64}$/.test(marker.markdown_sha256);
}

function verifyMarkerArchive(dataDir, marker) {
  if (!validClearMarker(marker)) throw error('invalid-clear-marker');
  const verified = verifyArchiveSet(dataDir, marker.archive_id);
  const source = verified.document.transcript;
  if (verified.document.exported_at !== marker.exported_at ||
      source.first_id !== marker.source_first_id || source.next_id !== marker.source_next_id ||
      source.message_count !== marker.message_count ||
      verified.json_sha256 !== marker.json_sha256 ||
      verified.markdown_sha256 !== marker.markdown_sha256) {
    throw error('archive-verification-failed');
  }
  return verified;
}

function finishPendingClear(dataDir, marker) {
  verifyMarkerArchive(dataDir, marker);
  const root = path.join(dataDir, 'chat');
  atomicWrite(path.join(root, 'messages.jsonl'), Buffer.alloc(0));
  atomicWrite(path.join(root, 'receipts.jsonl'), Buffer.alloc(0));
  atomicWrite(path.join(root, 'meta.json'), Buffer.from(JSON.stringify({
    schema: 2,
    first_id: marker.source_next_id,
    next_id: marker.source_next_id,
  }) + '\n', 'utf8'));
  fs.unlinkSync(clearMarkerPath(dataDir));
  fsyncDirectory(root);
}

function commitVerifiedClear(dataDir, marker) {
  verifyMarkerArchive(dataDir, marker);
  const markerPath = clearMarkerPath(dataDir);
  if (fs.existsSync(markerPath)) throw error('clear-already-pending');
  atomicWrite(markerPath, Buffer.from(JSON.stringify(marker) + '\n', 'utf8'));
  finishPendingClear(dataDir, marker);
}

function recoverPendingClear(dataDir) {
  const markerPath = clearMarkerPath(dataDir);
  if (!fs.existsSync(markerPath)) return false;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch (_) { throw error('invalid-clear-marker'); }
  finishPendingClear(dataDir, marker);
  return true;
}

function publicReceipt(receipt) {
  return Object.freeze({
    archive_id: receipt.archive_id,
    exported_at: receipt.exported_at,
    message_count: receipt.message_count,
    downloads: Object.freeze({
      markdown: `/api/transcript/exports/${receipt.archive_id}.md`,
      json: `/api/transcript/exports/${receipt.archive_id}.json`,
    }),
  });
}

function publicListing(id, verified) {
  const document = verified.document;
  return Object.freeze({
    archive_id: id,
    exported_at: document.exported_at,
    message_count: document.transcript.message_count,
    first_id: document.transcript.first_id,
    next_id: document.transcript.next_id,
    downloads: Object.freeze({
      markdown: `/api/transcript/exports/${id}.md`,
      json: `/api/transcript/exports/${id}.json`,
    }),
  });
}

function createArchiveService(options) {
  const input = closedObject(options, OPTION_KEYS);
  if (!input || typeof input.dataDir !== 'string' || !path.isAbsolute(input.dataDir) ||
      !input.store || typeof input.store.snapshot !== 'function' ||
      typeof input.store.clear !== 'function') throw error('invalid-options');

  async function exportTranscript() {
    const snapshot = await input.store.snapshot();
    return publicReceipt(writeArchive(input.dataDir, snapshot));
  }

  async function clearTranscript() {
    const snapshot = await input.store.snapshot();
    const receipt = writeArchive(input.dataDir, snapshot);
    const result = await input.store.clear({
      archive_id: receipt.archive_id,
      exported_at: receipt.exported_at,
      json_sha256: receipt.json_sha256,
      markdown_sha256: receipt.markdown_sha256,
    });
    return Object.freeze(Object.assign({}, publicReceipt(receipt), {
      first_id: result.first_id,
      next_id: result.next_id,
    }));
  }

  function listArchives() {
    const root = path.join(input.dataDir, 'archives');
    if (!fs.existsSync(root)) return Object.freeze([]);
    let entries;
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('archive-list-unavailable');
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (caught) {
      if (caught && caught.code === 'archive-list-unavailable') throw caught;
      throw error('archive-list-unavailable');
    }
    const candidates = new Map();
    for (const entry of entries) {
      let format = null;
      if (entry.name.endsWith('.json')) format = 'json';
      else if (entry.name.endsWith('.md')) format = 'md';
      if (format === null) continue;
      const id = entry.name.slice(0, -(format.length + 1));
      if (!ARCHIVE_ID.test(id)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw error('archive-verification-failed');
      const formats = candidates.get(id) || new Set();
      formats.add(format);
      candidates.set(id, formats);
    }
    const listed = [];
    for (const [id, formats] of candidates) {
      if (formats.size !== 2 || !formats.has('json') || !formats.has('md')) {
        throw error('archive-verification-failed');
      }
      listed.push(publicListing(id, verifyArchiveSet(input.dataDir, id)));
    }
    listed.sort((left, right) => {
      if (left.exported_at !== right.exported_at) {
        return left.exported_at > right.exported_at ? -1 : 1;
      }
      return left.archive_id < right.archive_id ? 1 :
        (left.archive_id > right.archive_id ? -1 : 0);
    });
    return Object.freeze(listed);
  }

  function readArtifact(id, format) {
    if (!ARCHIVE_ID.test(id) || (format !== 'json' && format !== 'md')) {
      throw error('invalid-archive');
    }
    const verified = verifyArchiveSet(input.dataDir, id);
    return Object.freeze({
      body: format === 'json' ? verified.json : verified.markdown,
      content_type: format === 'json'
        ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      filename: id + '.' + format,
    });
  }

  return Object.freeze({ exportTranscript, clearTranscript, listArchives, readArtifact });
}

module.exports = Object.freeze({
  ARCHIVE_SCHEMA,
  ARCHIVE_ID,
  CLEAR_MARKER_SCHEMA,
  createArchiveService,
  documentFromSnapshot,
  writeArchive,
  verifyArchiveSet,
  commitVerifiedClear,
  recoverPendingClear,
});
