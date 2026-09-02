'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const attention = require('../src/web/attention.js');
const mentions = require('../src/web/mentions.js');

function page({ hidden = false, focused = true } = {}) {
  return {
    hidden,
    title: 'Interlock',
    hasFocus() { return focused; },
    setFocused(value) { focused = value; },
  };
}

function fakeAudio() {
  const calls = { starts: 0, stops: 0 };
  class FakeAudioContext {
    constructor() {
      this.currentTime = 5;
      this.destination = {};
      this.state = 'running';
    }

    createOscillator() {
      return {
        frequency: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        start() { calls.starts += 1; },
        stop() { calls.stops += 1; },
      };
    }

    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    }
  }
  return { calls, FakeAudioContext };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('only a new message explicitly addressing the Owner signals', () => {
  const document = page();
  const { calls, FakeAudioContext } = fakeAudio();
  const signal = attention.create({
    document,
    AudioContext: FakeAudioContext,
    Notification: null,
    mentionTokens: mentions.tokens,
    storage: memoryStorage(),
  });
  assert.equal(signal.arm(), true);

  assert.equal(signal.messages([
    { id: 1, byline: 'Grok', text: '@Ana initial' },
  ], 'Ana', true, true), false,
    'the initial transcript is catch-up, not a new-message alert');
  assert.equal(signal.messages([
    { id: 2, byline: 'Ana', text: '@Ana my own note' },
  ], 'Ana', false, true), false,
    'the sender must not alert herself');
  assert.equal(signal.messages([
    { id: 3, byline: 'Grok', text: 'ordinary room chatter' },
  ], 'Ana', false, true), false, 'ordinary chat stays silent');
  assert.equal(signal.messages([
    { id: 4, byline: 'Grok', text: '@all is for AI seats' },
  ], 'Ana', false, true), false, '@all must not become an Owner mention');
  assert.equal(signal.messages([
    { id: 5, byline: 'Grok', text: '@Ana owner only' },
  ], 'Ana', false, false), false, 'a non-owner gets no Owner notification');

  assert.equal(signal.messages([
    { id: 6, byline: 'Grok', text: 'please look @ana' },
  ], 'Ana', false, true), true, 'an explicit mention chirps even while focused');
  assert.equal(document.title, 'Interlock', 'a visible mention needs no tab marker');
  assert.deepEqual(calls, { starts: 1, stops: 1 });

  document.setFocused(false);
  assert.equal(signal.messages([
    { id: 7, byline: 'Grok', text: '@Ana background mention' },
  ], 'Ana', false, true), true);
  assert.equal(document.title, '● Interlock');
  assert.deepEqual(calls, { starts: 2, stops: 2 });
  assert.equal(signal.clearIfLooking(), false);
  document.setFocused(true);
  assert.equal(signal.clearIfLooking(), true);
  assert.equal(document.title, 'Interlock');
});

test('a newly waiting AI chirps once and does not repeat on unchanged polling', () => {
  const document = page();
  const { calls, FakeAudioContext } = fakeAudio();
  const signal = attention.create({ document, AudioContext: FakeAudioContext });
  signal.arm();

  assert.equal(signal.pending([{ request_id: 'request-1' }]), true,
    'the knock is audible even while the room itself is visible');
  assert.equal(document.title, 'Interlock', 'a visible knock does not need a tab marker');
  assert.equal(signal.pending([{ request_id: 'request-1' }]), false);
  assert.equal(signal.pending([
    { request_id: 'request-1' }, { request_id: 'request-2' },
  ]), true);
  assert.deepEqual(calls, { starts: 2, stops: 2 });

  document.setFocused(false);
  assert.equal(signal.pending([{ request_id: 'request-3' }]), true);
  assert.equal(document.title, '● Interlock');
  signal.reset();
  assert.equal(document.title, 'Interlock');
});

test('attention remains a silent visual feature when Web Audio is unavailable', () => {
  const document = page({ focused: false });
  const signal = attention.create({
    document, AudioContext: null, Notification: null,
    mentionTokens: mentions.tokens,
  });
  assert.equal(signal.arm(), false);
  assert.equal(signal.messages([
    { id: 1, byline: 'Marlow', text: '@Ana please look' },
  ], 'Ana', false, true), true);
  assert.equal(document.title, '● Interlock');
});

test('Owner explicitly enables generic native notifications from a user gesture', async () => {
  const document = page({ focused: false });
  const created = [];
  let permissionRequests = 0;
  class FakeNotification {
    static permission = 'default';
    static async requestPermission() {
      permissionRequests += 1;
      FakeNotification.permission = 'granted';
      return 'granted';
    }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      created.push(this);
    }
    close() {}
  }
  const { calls, FakeAudioContext } = fakeAudio();
  const signal = attention.create({
    document,
    AudioContext: FakeAudioContext,
    Notification: FakeNotification,
    mentionTokens: mentions.tokens,
    storage: memoryStorage(),
  });
  signal.arm();
  assert.equal(signal.notificationPermission(), 'default');
  assert.equal(signal.messages([
    { id: 11, byline: 'Grok', text: '@Ana permission is still a person choice' },
  ], 'Ana', false, true), true);
  assert.equal(permissionRequests, 0, 'an incoming mention must never open a permission prompt');
  assert.equal(created.length, 0, 'default permission allows the tab/audio signal only');
  assert.equal(await signal.requestNotifications(), 'granted');
  assert.equal(permissionRequests, 1);
  assert.equal(signal.messages([
    { id: 12, byline: 'Marlow', text: '@Ana private body must not escape' },
  ], 'Ana', false, true), true);
  assert.deepEqual(calls, { starts: 2, stops: 2 });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Interlock needs you');
  assert.equal(created[0].options.body, 'Marlow addressed you in Interlock.');
  assert.equal(created[0].options.body.includes('private body'), false);
  assert.equal(created[0].options.tag, 'interlock-owner-mention-12');
});

test('duplicate tabs share one monotonic Owner-mention claim', () => {
  const storage = memoryStorage();
  const { calls, FakeAudioContext } = fakeAudio();
  const first = attention.create({
    document: page({ focused: false }), AudioContext: FakeAudioContext,
    Notification: null, mentionTokens: mentions.tokens, storage,
  });
  const second = attention.create({
    document: page({ focused: false }), AudioContext: FakeAudioContext,
    Notification: null, mentionTokens: mentions.tokens, storage,
  });
  first.arm();
  second.arm();
  const rows = [{ id: 14, byline: 'Grok', text: '@Ana once' }];
  assert.equal(first.messages(rows, 'Ana', false, true), true);
  assert.equal(second.messages(rows, 'Ana', false, true), false);
  assert.deepEqual(calls, { starts: 1, stops: 1 });
});

test('the room wires attention into background owner admission polling and chat pages', () => {
  const root = path.join(__dirname, '..');
  const room = fs.readFileSync(path.join(root, 'src', 'web', 'room.js'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'src', 'web', 'room.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'web', 'room.css'), 'utf8');
  assert.match(shell, /<script src="\/attention\.js" defer><\/script>/);
  assert.match(room, /roomAttention\.messages\(page\.messages,/);
  assert.match(room, /currentUser\.roles\.includes\('owner'\)/);
  assert.match(shell, /id="enable-owner-notifications-button"/);
  assert.match(room, /roomAttention\.requestNotifications\(\)/,
    'native permission must come from the explicit Owner control');
  assert.match(room, /InterlockMessagePage\.caughtUp\(page, MESSAGE_PAGE_LIMIT\)/,
    'every full historical page must remain quiet until an under-limit page proves catch-up');
  assert.match(room, /roomAttention\.pending\(result\.pending\)/);
  assert.match(room, /if \(owner\) loadPendingAis\(\);/,
    'owners must see knocks without first opening the Connect an AI sheet');
  assert.match(room, /if \(pendingAiLoading \|\| !owner\) return;/,
    'non-owners must not poll the administrative admissions route');
  assert.match(room, /function showLogin\([^]*?roomRequestGeneration\.rotate\(\);/,
    'leaving the room must invalidate owner-only admission responses still in flight');
  assert.match(css, /#connect-ai-button\.has-waiting/);
});
