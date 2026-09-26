'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWorkStore } = require('../src/work/store.js');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-work-store-'));
}

function storePath(dataDir) {
  return path.join(dataDir, 'work', 'store.json');
}

test('first open creates the store with the Operations project', () => {
  const dataDir = freshDir();
  const store = openWorkStore({ dataDir });
  assert.equal(store.state, 'ready');
  assert.equal(store.reason, null);
  assert.equal(fs.existsSync(storePath(dataDir)), true);
  const snapshot = store.read();
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.next_id, 1);
  assert.equal(snapshot.next_event, 1);
  assert.deepEqual(snapshot.projects.map(p => [p.id, p.display_name, p.retired_at]),
    [['ops', 'Operations', null]]);
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.operations, {});
  store.close();
});

test('commit writes atomically, leaves no temporary file, and survives reopen', () => {
  const dataDir = freshDir();
  const store = openWorkStore({ dataDir });
  const result = store.commit(draft => {
    const id = store.nextId(draft, 'W');
    draft.items.push({ id, title: 'first' });
    return { id };
  });
  assert.deepEqual(result, { id: 'W-1' });
  assert.equal(fs.existsSync(storePath(dataDir) + '.tmp'), false);
  assert.equal(Object.isFrozen(store.read()), true);
  store.close();
  const reopened = openWorkStore({ dataDir });
  assert.deepEqual(reopened.read().items, [{ id: 'W-1', title: 'first' }]);
  assert.equal(reopened.read().next_id, 2);
  reopened.close();
});

test('ids and the event sequence only increase across reopen', () => {
  const dataDir = freshDir();
  const store = openWorkStore({ dataDir });
  const ids = store.commit(draft => [
    store.nextId(draft, 'W'), store.nextId(draft, 'D'), store.nextEvent(draft), store.nextEvent(draft),
  ]);
  assert.deepEqual(ids, ['W-1', 'D-2', 1, 2]);
  store.close();
  const reopened = openWorkStore({ dataDir });
  assert.deepEqual(reopened.commit(draft => [reopened.nextId(draft, 'W'), reopened.nextEvent(draft)]),
    ['W-3', 3]);
  reopened.close();
});

test('a store with an unknown schema opens damaged and refuses writes without rewriting', () => {
  const dataDir = freshDir();
  fs.mkdirSync(path.join(dataDir, 'work'), { recursive: true });
  const bytes = '{"schema":2,"next_id":1,"next_event":1,"projects":[],"items":[],"events":[],"operations":{}}\n';
  fs.writeFileSync(storePath(dataDir), bytes);
  const store = openWorkStore({ dataDir });
  assert.equal(store.state, 'damaged');
  assert.equal(store.reason, 'unknown-schema');
  assert.throws(() => store.commit(draft => draft), error => error.code === 'store-damaged');
  assert.equal(fs.readFileSync(storePath(dataDir), 'utf8'), bytes);
  assert.equal(store.read(), null);
  store.close();
});

test('a store that is not JSON opens damaged and is never rewritten', () => {
  const dataDir = freshDir();
  fs.mkdirSync(path.join(dataDir, 'work'), { recursive: true });
  fs.writeFileSync(storePath(dataDir), 'not json\n');
  const store = openWorkStore({ dataDir });
  assert.equal(store.state, 'damaged');
  assert.equal(store.reason, 'invalid-json');
  assert.throws(() => store.commit(draft => draft), error => error.code === 'store-damaged');
  assert.equal(fs.readFileSync(storePath(dataDir), 'utf8'), 'not json\n');
  store.close();
});

test('a failed commit keeps the previous committed store', () => {
  const dataDir = freshDir();
  const store = openWorkStore({ dataDir });
  store.commit(draft => { draft.items.push({ id: store.nextId(draft, 'W'), title: 'kept' }); });
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => store.commit(draft => { draft.items.push({ id: 'W-2', title: 'lost' }); }),
      /disk full/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(store.read().items.map(item => item.id), ['W-1']);
  store.close();
  const reopened = openWorkStore({ dataDir });
  assert.deepEqual(reopened.read().items.map(item => item.id), ['W-1']);
  reopened.close();
});

test('a mutation that leaves the draft invalid is refused before anything is written', () => {
  const dataDir = freshDir();
  const store = openWorkStore({ dataDir });
  assert.throws(() => store.commit(draft => { draft.next_id = 'seven'; }),
    error => error.code === 'invalid-store');
  assert.equal(store.read().next_id, 1);
  store.close();
});
