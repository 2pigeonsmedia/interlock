'use strict';

// The People and Settings rows carry four people facts (model, project, who
// set it, presence line) and the Allow card one (the declared project). The
// page checks every row's exact shape, so it must accept the new shape and
// still refuse an older one. This runs the shipped room.js.

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
    InterlockTranscriptScroll: standIn(),
    InterlockWorkPanel: standIn(),
    InterlockAsks: standIn(),
    InterlockPeopleModel: require('../src/web/people_model.js'),
  };
  page.window = page;
  page.window.addEventListener = () => {};
  page.PublicKeyCredential = function PublicKeyCredential() {};
  vm.createContext(page);
  vm.runInContext(ROOM_JS, page, { filename: 'room.js' });
  return { page, el: id => document.querySelector(id) };
}

const OLD_SEAT = { name: 'Scout', kind: 'seat', session: null, product: 'Claude Code', product_provenance: 'client-reported',
  expires_at: 5, last_heard: 4, present: true, outstanding: 0, fetched_without_post_at: null };
const FACTS = { model: 'Opus 5.5', project: 'ops', assigned: { how: 'join', by_name: 'server', at: 3 },
  presence: { middle: 'building the import', waiting_on: null, need: null, since: 2 } };

test('a participant row must carry the four people facts, each well formed', () => {
  const { page } = loadPage();
  assert.equal(page.validParticipant(Object.assign({}, OLD_SEAT, FACTS)), true, 'ARRANGEMENT: the new shape is accepted');
  assert.equal(page.validParticipant(Object.assign({}, OLD_SEAT, { model: null, project: null, assigned: null, presence: null })), true);
  assert.equal(page.validParticipant(OLD_SEAT), false, 'a row from an older server is refused, never half-read');
  assert.equal(page.validParticipant(Object.assign({}, OLD_SEAT, FACTS, { assigned: { how: 'guessed', by_name: 'x', at: 1 } })), false);
  assert.equal(page.validParticipant(Object.assign({}, OLD_SEAT, FACTS, { presence: { middle: 'x' } })), false);
  assert.equal(page.validParticipant(Object.assign({}, OLD_SEAT, FACTS, { extra: 1 })), false);
});
