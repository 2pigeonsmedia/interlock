'use strict';

// A tab whose session was replaced by a sign-in in another tab still holds
// its old CSRF token. Its passkey step-up is refused before the passkey is
// asked for. The page must say so plainly and offer to sign in again in this
// tab, never fail silently with no prompt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');

// Any property read that the page never set answers with a harmless callable
// stand-in, so incidental calls (classList.add, focus, replaceChildren) work.
function standIn() {
  const fn = function () { return standIn(); };
  return new Proxy(fn, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (!(key in target)) target[key] = standIn();
      return target[key];
    },
  });
}

class Element {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = standIn();
    this.dataset = {};
    this.style = {};
  }
  get dateTime() { return this.attributes.get('datetime') || ''; }
  set dateTime(value) { this.attributes.set('datetime', String(value)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) || []).map(handler => handler(event)));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch('close');
  }
  showModal() { this.open = true; }
  click() { return this.dispatch('click'); }
  reset() {}
  focus() {}
  append() {}
  replaceChildren() {}
  querySelector() { return new Element('child'); }
  querySelectorAll() { return []; }
}

function loadPage() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element(selector));
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement(tag) { return new Element(tag); },
    addEventListener() {},
    hidden: false,
    title: 'Interlock',
  };
  const storage = { getItem: () => 'csrf', setItem() {}, removeItem() {} };
  const page = {
    document,
    sessionStorage: storage,
    localStorage: storage,
    // Session and connection checks never answer, so only the test drives the page.
    fetched: [],
    fetch: path => { page.fetched.push(path); return new Promise(() => {}); },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    navigator: { credentials: {}, clipboard: { writeText: async () => {} } },
    location: { href: 'http://localhost/', pathname: '/', search: '' },
    history: { replaceState() {} },
    URL, URLSearchParams, Intl, Date, Math, JSON, Promise, Error, Object, Array, Set, Map,
    Number, String, Boolean, Symbol, RegExp, TypeError, Uint8Array, btoa, atob, console,
    AbortController, FormData: class { get() { return ''; } },
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    InterlockRequestGeneration: { create: () => ({ rotate() {}, capture: () => 0, isCurrent: () => true }) },
    InterlockAttention: { create: () => standIn() },
    InterlockMentions: standIn(),
    InterlockMessagePage: standIn(),
    InterlockReplyReference: standIn(),
    InterlockAsks: standIn(),
    InterlockTranscriptScroll: standIn(),
    InterlockWorkPanel: standIn(),
    InterlockPeopleModel: require('../src/web/people_model.js'),
  };
  page.window = page;
  page.window.addEventListener = () => {};
  page.PublicKeyCredential = function PublicKeyCredential() {};
  vm.createContext(page);
  vm.runInContext(ROOM_JS, page, { filename: 'room.js' });
  return { page, el: id => document.querySelector(id) };
}

test('a step-up refused for a stale tab names it and offers sign-in, without a silent no-prompt', async () => {
  const { page, el } = loadPage();
  const asked = [];
  page.navigator.credentials.get = async () => { asked.push('get'); return null; };
  page.fetch = async url => {
    page.fetched.push(url);
    if (url === '/api/elevation/options') {
      return { ok: false, status: 403, json: async () => ({ ok: false, error: 'not-authorized' }) };
    }
    return new Promise(() => {});
  };
  await assert.rejects(page.freshOwnerStepUp(), error => error.code === 'tab-out-of-date');
  assert.ok(page.fetched.includes('/api/elevation/options'), 'ARRANGEMENT: the step-up was asked for');
  assert.deepEqual(asked, [], 'no passkey prompt for a refusal a passkey cannot fix');
  assert.match(el('#login-status').textContent, /This tab is out of date/, 'the sign-in form says why');
});

test('a step-up refused for any other reason is not called a stale tab', async () => {
  const { page, el } = loadPage();
  page.fetch = async url => (url === '/api/elevation/options'
    ? { ok: false, status: 503, json: async () => ({ ok: false, error: 'unavailable' }) }
    : new Promise(() => {}));
  await assert.rejects(page.freshOwnerStepUp(), error => error.code === 'unavailable');
  assert.doesNotMatch(el('#login-status').textContent, /out of date/);
});

test('an owner act refused for a stale tab names it; for a viewer who is not an admin it stays a plain refusal', async () => {
  const refuse = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'not-authorized' }) });
  const admin = loadPage();
  admin.page.fetch = refuse;
  admin.page.viewerIsAdmin = () => true;
  await assert.rejects(admin.page.freshAdminMutation('/api/grants/create', {}), error => error.code === 'tab-out-of-date');
  assert.match(admin.el('#login-status').textContent, /This tab is out of date/);
  const member = loadPage();
  member.page.fetch = refuse;
  member.page.viewerIsAdmin = () => false;
  await assert.rejects(member.page.freshAdminMutation('/api/grants/create', {}), error => error.code === 'not-authorized');
  assert.doesNotMatch(member.el('#login-status').textContent, /out of date/);
});
