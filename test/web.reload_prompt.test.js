'use strict';

// After an upgrade, a tab left open keeps running the old page. The server
// names its version on the routes the page polls; the first one the page sees
// is the one it was loaded with, and a different one later means the page is
// stale. From then on the room notice says to reload, whatever else happens.
// This runs the shipped room.js against the same minimal page stand-in the
// passkey code tests use.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const UPDATED = 'Interlock was updated. Reload this page.';

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
  };
  page.window = page;
  page.window.addEventListener = () => {};
  page.PublicKeyCredential = function PublicKeyCredential() {};
  vm.createContext(page);
  vm.runInContext(ROOM_JS, page, { filename: 'room.js' });
  return { page, el: id => document.querySelector(id) };
}

function rosterAnswer(version) {
  const headers = new Map(version === undefined ? [] : [['x-interlock-version', version]]);
  return {
    ok: true,
    status: 200,
    headers: { get: name => headers.has(name) ? headers.get(name) : null },
    json: async () => ({ ok: true, participants: [] }),
  };
}

async function pollRoster(page, version) {
  page.fetch = async () => rosterAnswer(version);
  await page.loadRoster();
}

test('a changed server version turns the room notice into a reload prompt that stays', async () => {
  const { page, el } = loadPage();
  el('#room-view').hidden = false;
  await pollRoster(page, '0.2.1');
  await pollRoster(page, '0.2.1');
  page.setRoomNotice('Message saved.', 'success');
  assert.equal(el('#room-notice').textContent, 'Message saved.', 'ARRANGEMENT: the same version leaves notices alone');

  await pollRoster(page, '0.2.2');
  assert.equal(el('#room-notice').textContent, UPDATED);
  page.setRoomNotice('Message saved.', 'success');
  assert.equal(el('#room-notice').textContent, UPDATED, 'the reload prompt is not replaced');
  assert.equal(el('#room-notice').className, 'room-notice');
  await pollRoster(page, '0.2.1');
  assert.equal(el('#room-notice').textContent, UPDATED, 'a version change either way is a stale page');
});

test('an answer without a version leaves the page as it is', async () => {
  const { page, el } = loadPage();
  el('#room-view').hidden = false;
  await pollRoster(page, undefined);
  await pollRoster(page, '0.2.1');
  await pollRoster(page, undefined);
  page.setRoomNotice('Message saved.', 'success');
  assert.equal(el('#room-notice').textContent, 'Message saved.');
});
