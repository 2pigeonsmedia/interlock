'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const attention = require('../src/web/attention.js');

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

test('new chat signals only for another participant while the room is not being watched', () => {
  const document = page();
  const { calls, FakeAudioContext } = fakeAudio();
  const signal = attention.create({ document, AudioContext: FakeAudioContext });
  assert.equal(signal.arm(), true);

  assert.equal(signal.messages([{ byline: 'Grok' }], 'Ana', true), false,
    'the initial transcript is catch-up, not a new-message alert');
  assert.equal(signal.messages([{ byline: 'Ana' }], 'Ana'), false,
    'the sender must not alert herself');
  assert.equal(signal.messages([{ byline: 'Grok' }], 'Ana'), false,
    'a message already visible in the focused room needs no alert');

  document.setFocused(false);
  assert.equal(signal.messages([{ byline: 'Grok' }], 'Ana'), true);
  assert.equal(document.title, '● Interlock');
  assert.deepEqual(calls, { starts: 1, stops: 1 });
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
  const signal = attention.create({ document, AudioContext: null });
  assert.equal(signal.arm(), false);
  assert.equal(signal.messages([{ byline: 'Marlow' }], 'Ana'), true);
  assert.equal(document.title, '● Interlock');
});

test('the room wires attention into background owner admission polling and chat pages', () => {
  const root = path.join(__dirname, '..');
  const room = fs.readFileSync(path.join(root, 'src', 'web', 'room.js'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'src', 'web', 'room.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'web', 'room.css'), 'utf8');
  assert.match(shell, /<script src="\/attention\.js" defer><\/script>/);
  assert.match(room, /roomAttention\.messages\(page\.messages,/);
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
