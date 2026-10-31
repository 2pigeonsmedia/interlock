'use strict';

// A passkey step-up mints a new session id (identity/l1_sessions.js deletes the
// old one). A Work panel read sent with the old cookie and answered after the
// rotation gets a 401 although the person is still signed in. The room's own
// readers ignore such answers; the panel must too, or the page drops its CSRF
// token and asks for the password after every step-up. It asks the room once
// before treating a 401 as a sign-out.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'src', 'web');

function stub() {
  const target = function () { return proxy; };
  const proxy = new Proxy(target, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (key === 'hidden' || key === 'open' || key === 'disabled') return false;
      if (key === 'children' || key === 'childNodes') return [];
      if (key === 'textContent' || key === 'value' || key === 'className') return '';
      return proxy;
    },
    set() { return true; },
    apply() { return proxy; },
  });
  return proxy;
}

function loadPanel(fetchImpl) {
  const el = stub();
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto,
    URLSearchParams, AbortController, Map, Set, Promise, Date, JSON, Error, Object, Array,
    document: { getElementById: () => el, createElement: () => stub(), addEventListener() {}, activeElement: el },
    fetch: fetchImpl,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['work_panel_model.js', 'work_panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), context, { filename: file });
  }
  return context;
}

test('a 401 for a work read sent before a passkey rotation does not sign the owner out', async () => {
  // A tiny server: the session id rotates once (the step-up). A request carries
  // the id current when it was SENT; it is answered after the rotation.
  let epoch = 0;
  const pending = [];
  const fetchImpl = (url) => {
    const sentAt = epoch;
    if (String(url).startsWith('/api/session')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, authenticated: true, user: { name: 'Ana' } }), { status: 200 }));
    }
    return new Promise(resolve => pending.push(() => resolve(new Response(
      JSON.stringify(sentAt === epoch ? { ok: false, error: 'unavailable' } : { ok: false, error: 'not-authenticated' }),
      { status: sentAt === epoch ? 503 : 401 },
    ))));
  };
  const context = loadPanel(fetchImpl);
  let ended = 0;
  context.InterlockWorkPanel.start({ name: 'Ana', roles: ['owner'], kind: 'person' }, {
    mutate: async () => ({ ok: true }),
    aiNames: () => [], participants: () => [], composer: stub(),
    freshOwnerStepUp: async () => {},
    onSessionEnded: () => { ended += 1; },
  });
  // Arrange: the brief read is in flight with the pre-step-up cookie.
  assert.ok(pending.length >= 1, 'the panel must have a brief read in flight before the rotation');
  epoch += 1; // the passkey step-up rotates the session id; the owner is still signed in
  for (const answer of pending.splice(0)) answer();
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    assert.equal(ended, 0,
      'a stale-cookie 401 that crossed a passkey rotation must not end a live session');
  } finally {
    context.InterlockWorkPanel.stop();
  }
});

test('a 401 for a work read when the session really ended still signs the owner out, once', async () => {
  const fetchImpl = (url) => String(url).startsWith('/api/session')
    ? Promise.resolve(new Response(JSON.stringify({ ok: true, authenticated: false }), { status: 200 }))
    : Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'not-authenticated' }), { status: 401 }));
  const context = loadPanel(fetchImpl);
  let ended = 0;
  context.InterlockWorkPanel.start({ name: 'Ana', roles: ['owner'], kind: 'person' }, {
    mutate: async () => ({ ok: true }),
    aiNames: () => [], participants: () => [], composer: stub(),
    freshOwnerStepUp: async () => {},
    onSessionEnded: () => { ended += 1; },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    assert.equal(ended, 1, 'an expired session still ends, after one check');
  } finally {
    context.InterlockWorkPanel.stop();
  }
});
