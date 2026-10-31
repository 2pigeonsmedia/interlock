'use strict';

// The shared Work record's durable home: one versioned JSON file under
// <dataDir>/work/, replaced whole on every commit by the single server
// process. This layer holds no rules — it reads, validates, allocates ids and
// event sequence numbers, and writes atomically. An unknown or unreadable
// store opens as `damaged`: reads return null, writes refuse, nothing is
// rewritten or "repaired".

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJson, fsyncDirectory } = require('../atomic_json.js');

const SCHEMA = 1;
const ID_PREFIXES = Object.freeze(['W', 'D']);
const DEFAULT_PROJECT = Object.freeze({ id: 'ops', display_name: 'Operations' });

function fail(code) {
  const error = new Error('work.store: ' + code);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PROJECT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const ITEM_ID = /^[WD]-[1-9][0-9]*$/;
const ITEM_KINDS = Object.freeze(['work', 'finding', 'decision']);

function uniqueStrings(values) {
  return new Set(values).size === values.length;
}

// The whole document, not just its container: every record has the shape
// the service relies on, ids are unique, and the counters are ahead of them.
function validStore(value) {
  if (!(plainObject(value) && value.schema === SCHEMA &&
    Number.isSafeInteger(value.next_id) && value.next_id >= 1 &&
    Number.isSafeInteger(value.next_event) && value.next_event >= 1 &&
    Array.isArray(value.projects) && Array.isArray(value.items) &&
    Array.isArray(value.events) && plainObject(value.operations))) return false;
  if (!value.projects.every(row => plainObject(row) && typeof row.id === 'string' && PROJECT_ID.test(row.id) &&
    typeof row.display_name === 'string')) return false;
  if (!uniqueStrings(value.projects.map(row => row.id))) return false;
  if (!value.items.every(row => plainObject(row) && typeof row.id === 'string' && ITEM_ID.test(row.id) &&
    ITEM_KINDS.includes(row.kind))) return false;
  if (!uniqueStrings(value.items.map(row => row.id))) return false;
  if (value.items.some(row => Number(row.id.slice(2)) >= value.next_id)) return false;
  if (!value.events.every(row => plainObject(row) && Number.isSafeInteger(row.seq) && row.seq >= 1)) return false;
  if (!uniqueStrings(value.events.map(row => String(row.seq)))) return false;
  if (value.events.some(row => row.seq >= value.next_event)) return false;
  return true;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function emptyStore(now) {
  return {
    schema: SCHEMA,
    next_id: 1,
    next_event: 1,
    projects: [{
      id: DEFAULT_PROJECT.id,
      display_name: DEFAULT_PROJECT.display_name,
      objective: '',
      today: '',
      revision: 1,
      updated_by: null,
      updated_at: now,
      created_at: now,
      retired_at: null,
    }],
    items: [],
    events: [],
    operations: {},
  };
}

function openWorkStore(options) {
  if (!plainObject(options) || typeof options.dataDir !== 'string' ||
      !path.isAbsolute(options.dataDir)) fail('invalid-data-dir');
  const dataDir = options.dataDir;
  let dataStat;
  try { dataStat = fs.statSync(dataDir); } catch (_) { fail('data-dir-missing'); }
  if (!dataStat.isDirectory()) fail('invalid-data-dir');

  const root = path.join(dataDir, 'work');
  const filePath = path.join(root, 'store.json');
  const tmpPath = filePath + '.tmp';
  let state = 'ready';
  let reason = null;
  let current = null;
  let closed = false;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    fsyncDirectory(dataDir);
    const fresh = emptyStore(Date.now());
    atomicWriteJson(filePath, fresh);
    current = deepFreeze(fresh);
  } else {
    let text = null;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { state = 'damaged'; reason = 'unreadable'; }
    let parsed = null;
    if (state === 'ready') {
      try { parsed = JSON.parse(text); } catch (_) { state = 'damaged'; reason = 'invalid-json'; }
    }
    if (state === 'ready') {
      if (!plainObject(parsed)) { state = 'damaged'; reason = 'invalid-store'; }
      else if (parsed.schema !== SCHEMA) { state = 'damaged'; reason = 'unknown-schema'; }
      else if (!validStore(parsed)) { state = 'damaged'; reason = 'invalid-store'; }
      else current = deepFreeze(parsed);
    }
    if (state === 'ready' && fs.existsSync(tmpPath)) {
      // A leftover temporary file from an interrupted commit of THIS protocol;
      // the committed file parsed, so the leftover is residue, not data.
      try { fs.unlinkSync(tmpPath); } catch (_) { /* leave it; the next commit overwrites it */ }
    }
  }

  function requireOpen() {
    if (closed) fail('store-closed');
  }

  function read() {
    requireOpen();
    return current;
  }

  function commit(mutate) {
    requireOpen();
    if (state !== 'ready') fail('store-damaged');
    if (typeof mutate !== 'function') fail('invalid-mutation');
    const draft = structuredClone(current);
    const result = mutate(draft);
    if (!validStore(draft)) fail('invalid-store');
    try {
      atomicWriteJson(filePath, draft);
    } catch (error) {
      // The failure may sit after the rename. Read the file back and let it
      // decide what memory holds; if it matches neither side, stop writing.
      let onDisk = null;
      try { onDisk = fs.readFileSync(filePath, 'utf8'); } catch (_) { onDisk = null; }
      const draftText = JSON.stringify(draft) + '\n';
      const currentText = JSON.stringify(current) + '\n';
      if (onDisk === draftText) current = deepFreeze(draft);
      else if (onDisk !== currentText) { state = 'damaged'; reason = 'uncertain-commit'; }
      throw error;
    }
    current = deepFreeze(draft);
    return result;
  }

  // The same change on a copy, validated and thrown away: nothing is written.
  function check(mutate) {
    requireOpen();
    if (state !== 'ready') fail('store-damaged');
    if (typeof mutate !== 'function') fail('invalid-mutation');
    const draft = structuredClone(current);
    const result = mutate(draft);
    if (!validStore(draft)) fail('invalid-store');
    return result;
  }

  function nextId(draft, prefix) {
    if (!plainObject(draft) || !Number.isSafeInteger(draft.next_id)) fail('invalid-draft');
    if (!ID_PREFIXES.includes(prefix)) fail('invalid-prefix');
    const id = prefix + '-' + draft.next_id;
    draft.next_id += 1;
    return id;
  }

  function nextEvent(draft) {
    if (!plainObject(draft) || !Number.isSafeInteger(draft.next_event)) fail('invalid-draft');
    const seq = draft.next_event;
    draft.next_event += 1;
    return seq;
  }

  function close() {
    closed = true;
  }

  return Object.freeze({
    get state() { return state; }, get reason() { return reason; },
    path: filePath, read, commit, check, nextId, nextEvent, close,
  });
}

module.exports = Object.freeze({ DEFAULT_PROJECT, SCHEMA, openWorkStore });
