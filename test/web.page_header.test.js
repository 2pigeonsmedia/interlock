'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'web', 'page_header.js'), 'utf8');

class FakeElement {
  constructor() {
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.title = '';
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
      },
      contains: name => this.classes.has(name),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  async click() {
    const handler = this.listeners.get('click');
    if (handler) await handler({ target: this });
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function world(fetcher, csrf = 'csrf-token') {
  const elements = Object.fromEntries([
    '#connection-state', '#connect-ai-button', '#settings-button',
    '#account-label', '#logout-button',
  ].map(selector => [selector, new FakeElement()]));
  const assigned = [];
  const storage = new Map(csrf === null ? [] : [['interlock.csrf.v1', csrf]]);
  const timers = [];
  const context = {
    URL,
    document: { querySelector: selector => elements[selector] || null },
    fetch: fetcher,
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      removeItem: key => storage.delete(key),
    },
    setInterval: (callback, interval) => {
      timers.push({ callback, interval });
      return timers.length;
    },
    window: {
      location: {
        href: 'http://localhost:8788/help',
        origin: 'http://localhost:8788',
        assign: target => assigned.push(target),
      },
    },
  };
  vm.runInNewContext(SOURCE, context, { filename: 'page_header.js' });
  return { elements, assigned, storage, timers };
}

test('secondary header loads owner actions, pending count, panel routes, and sign-out', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/session') return response(200, {
      ok: true,
      authenticated: true,
      user: { name: 'Patti', roles: ['owner'] },
    });
    if (url === '/api/ai/admissions') return response(200, {
      ok: true,
      pending: [{ request_id: 'one' }, { request_id: 'two' }],
    });
    if (url === '/health') return response(200, { ok: true });
    if (url === '/api/logout') return response(200, { ok: true });
    throw new Error('unexpected fetch: ' + url);
  };
  const { elements, assigned, storage, timers } = world(fetcher);
  await settle();

  assert.equal(elements['#connection-state'].textContent, 'Local: running');
  assert.equal(elements['#account-label'].textContent, 'Patti · Owner');
  assert.equal(elements['#connect-ai-button'].disabled, false);
  assert.equal(elements['#settings-button'].disabled, false);
  assert.equal(elements['#connect-ai-button'].textContent, 'Connect an AI (2)');
  assert.equal(elements['#connect-ai-button'].classList.contains('has-waiting'), true);
  assert.match(elements['#connect-ai-button'].attributes.get('aria-label'), /2 AIs are waiting/);
  assert.deepEqual(timers.map(timer => timer.interval), [10_000, 2_000]);

  await elements['#connect-ai-button'].click();
  await elements['#settings-button'].click();
  assert.deepEqual(assigned, ['/?open=connect-ai', '/?open=settings']);

  await elements['#logout-button'].click();
  const logout = calls.find(call => call.url === '/api/logout');
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.headers['x-csrf-token'], 'csrf-token');
  assert.equal(storage.has('interlock.csrf.v1'), false);
  assert.equal(assigned.at(-1), '/');
});

test('secondary header keeps owner actions closed when no person is signed in', async () => {
  const fetcher = async url => {
    if (url === '/api/session') return response(200, { ok: true, authenticated: false });
    if (url === '/health') return response(200, { ok: true });
    throw new Error('unexpected fetch: ' + url);
  };
  const { elements, assigned } = world(fetcher, null);
  await settle();

  assert.equal(elements['#account-label'].textContent, 'Not signed in');
  assert.equal(elements['#connect-ai-button'].disabled, true);
  assert.equal(elements['#settings-button'].disabled, true);
  assert.equal(elements['#logout-button'].textContent, 'Sign in');
  await elements['#logout-button'].click();
  assert.deepEqual(assigned, ['/']);
});

test('secondary header identifies a signed-in non-owner without opening owner actions', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url === '/api/session') return response(200, {
      ok: true,
      authenticated: true,
      user: { name: 'Rowan', roles: ['participant'] },
    });
    if (url === '/health') return response(200, { ok: true });
    throw new Error('unexpected fetch: ' + url);
  };
  const { elements } = world(fetcher);
  await settle();

  assert.equal(elements['#account-label'].textContent, 'Rowan · Person');
  assert.equal(elements['#connect-ai-button'].disabled, true);
  assert.equal(elements['#settings-button'].disabled, true);
  assert.equal(elements['#logout-button'].textContent, 'Sign out');
  assert.equal(calls.includes('/api/ai/admissions'), false);
});

test('secondary header does not claim it can sign out without this tab csrf', async () => {
  const fetcher = async url => {
    if (url === '/api/session') return response(200, {
      ok: true,
      authenticated: true,
      user: { name: 'Patti', roles: ['owner'] },
    });
    if (url === '/api/ai/admissions') return response(200, { ok: true, pending: [] });
    if (url === '/health') return response(200, { ok: true });
    throw new Error('unexpected fetch: ' + url);
  };
  const { elements, assigned } = world(fetcher, null);
  await settle();

  assert.equal(elements['#account-label'].textContent, 'Patti · Owner');
  assert.equal(elements['#logout-button'].textContent, 'Sign in to sign out');
  assert.match(elements['#logout-button'].title, /sign in before it can securely sign out/);
  await elements['#logout-button'].click();
  assert.deepEqual(assigned, ['/']);
});
