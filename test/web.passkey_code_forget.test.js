'use strict';

// A passkey code the first owner creates is shown once, like an invite code.
// It must leave the page when Settings closes and when the page signs out, so
// a later viewer of the same browser tab cannot read it. A member whose
// sign-in is too old to spend a code is told to sign in again and offered the
// way to do it. This runs the shipped room.js against a minimal stand-in for
// the page.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const CODE = 'a-shown-passkey-code-0123456789abcdefghijklmn';

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

async function showCode(page, el) {
  // The first owner's confirmed request answers with a code for Cal.
  page.freshAdminMutation = async () => ({ ok: true, name: 'Cal', passkey_code: CODE, expires_at: Date.now() + 86_400_000 });
  page.loadSettingsParticipants = async () => ({});
  el('#settings-dialog').open = true;
  await page.sendPasskeyCode({ name: 'Cal' }, new Element('button'));
  assert.equal(el('#passkey-code-value').textContent, CODE, 'ARRANGEMENT: the code is shown');
  assert.equal(el('#passkey-code-name').textContent, 'Cal');
  assert.notEqual(el('#passkey-code-expiry').getAttribute('datetime'), null);
  assert.equal(el('#passkey-code-result').hidden, false);
}

function assertForgotten(el, when) {
  assert.equal(el('#passkey-code-value').textContent, '', `the code is gone ${when}`);
  assert.equal(el('#passkey-code-name').textContent, '', `the name is gone ${when}`);
  assert.equal(el('#passkey-code-expiry').textContent, '', `the expiry is gone ${when}`);
  assert.equal(el('#passkey-code-expiry').getAttribute('datetime'), null, `the datetime is gone ${when}`);
  assert.equal(el('#passkey-code-result').hidden, true, `the result is hidden ${when}`);
}

test('a shown passkey code is forgotten when Settings closes', async () => {
  const { page, el } = loadPage();
  await showCode(page, el);
  el('#settings-dialog').close();
  assertForgotten(el, 'after Settings closes');
});

test('a shown passkey code is forgotten when the page signs out', async () => {
  const { page, el } = loadPage();
  await showCode(page, el);
  // Signing out without the close event firing still clears it.
  el('#settings-dialog').open = false;
  page.showLogin('You are signed out.');
  assertForgotten(el, 'after sign-out');
});

test('a member whose sign-in is too old is told to sign in again, and offered it', async () => {
  const { page, el } = loadPage();
  page.ownerMutation = async () => {
    throw Object.assign(new Error('sign-in-required'), { code: 'sign-in-required', status: 409 });
  };
  await el('#add-passkey-button').click();
  assert.equal(el('#add-passkey-signin').hidden, true, 'ARRANGEMENT: the sign-in offer starts hidden');
  await el('#add-passkey-form').dispatch('submit', { preventDefault() {} });
  assert.equal(el('#add-passkey-status').textContent, 'Sign in again, then enter the code.');
  assert.equal(el('#add-passkey-signin').hidden, false, 'the page offers to sign out and in again');
  el('#add-passkey-signin').click(); // the sign-out it starts never answers here
  assert.ok(page.fetched.includes('/api/logout'), 'which signs out first, so the next sign-in is fresh');
});
