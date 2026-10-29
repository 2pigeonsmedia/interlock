'use strict';

// The People column as the shipped room.js builds it, run in a vm against a
// page stand-in whose elements keep their children, so the rendered groups
// and rows can be read back in order.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOM_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
const PEOPLE_MODEL_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'people_model.js'), 'utf8');

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
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.className = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = standIn();
    this.dataset = {};
    this.style = {};
    this.options = [];
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
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
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.dispatch('click'); }
  focus() {}
  reset() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  contains() { return false; }
  querySelector() { return new Element('div'); }
  querySelectorAll() { return []; }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
  findAll(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.children) child.findAll(predicate, out);
    return out;
  }
}

function loadPage() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element('div'));
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement(tag) { return new Element(tag); },
    addEventListener() {},
    activeElement: null,
    hidden: false,
    title: 'Interlock',
  };
  const storage = { getItem: () => 'csrf', setItem() {}, removeItem() {} };
  const page = {
    document,
    sessionStorage: storage,
    localStorage: storage,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    queueMicrotask() {},
    navigator: { credentials: {}, clipboard: { writeText: async () => {} } },
    location: { href: 'http://localhost/', pathname: '/', search: '', origin: 'http://localhost' },
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
  };
  page.window = page;
  page.window.addEventListener = () => {};
  page.PublicKeyCredential = function PublicKeyCredential() {};
  vm.createContext(page);
  vm.runInContext(PEOPLE_MODEL_JS, page, { filename: 'people_model.js' });
  vm.runInContext(ROOM_JS, page, { filename: 'room.js' });
  // The ask picker beside the composer is not under test here.
  page.renderAskTargets = () => {};
  return { page, el: id => document.querySelector(id) };
}

const NOW = Date.now();

function row(name, kind, extra = {}) {
  const seat = kind === 'seat';
  return Object.assign({
    name, kind, session: seat ? 1 : null, product: seat ? 'Claude Code' : null,
    product_provenance: seat ? 'client-reported' : null, expires_at: seat ? NOW + 3_600_000 : null,
    last_heard: seat ? NOW - 60_000 : null, present: true, outstanding: 0, fetched_without_post_at: null,
    model: null, project: null, assigned: null, presence: null,
  }, extra);
}

const MIXED = [
  row('Loose', 'seat'),
  row('Scout', 'seat', { project: 'finance', model: 'opus-5.5' }),
  row('Patti', 'person'),
  row('Quiet', 'seat', { project: 'finance', present: false, last_heard: NOW - 3 * 3_600_000 }),
  row('Wren', 'seat', { project: 'ops' }),
];

test('renderRoster puts People first and Not yet assigned last for a mixed roster', () => {
  const { page, el } = loadPage();
  for (const participant of MIXED) {
    assert.equal(page.validParticipant(participant), true, `ARRANGEMENT: ${participant.name} is a valid 14-key row`);
  }
  page.renderRoster(MIXED);
  const groups = el('#roster-list').children;
  assert.ok(groups.every(group => group.tagName === 'DETAILS'), 'each group is a details element');
  const keys = groups.map(group => group.dataset.group);
  assert.equal(keys[0], 'people');
  assert.equal(keys[keys.length - 1], 'unassigned');
  assert.deepEqual(keys, ['people', 'project:finance', 'project:ops', 'unassigned']);
  assert.equal(groups[0].open, true, 'People is open');
  assert.equal(groups[1].open, false, 'a project group nobody waits in is folded');
  assert.equal(groups[0].children[0].tagName, 'SUMMARY');
  assert.equal(groups[0].children[0].textContent, 'People');
});

test('a row reads name · plate · state word · age, and a quiet seat stays listed', () => {
  const { page, el } = loadPage();
  page.renderRoster(MIXED);
  const finance = el('#roster-list').children.find(group => group.dataset.group === 'project:finance');
  const names = finance.findAll(node => node.tagName === 'STRONG').map(node => node.textContent);
  assert.deepEqual(names, ['Scout', 'Quiet']);
  const lines = finance.findAll(node => node.className === 'participant-fact participant-state').map(node => node.textContent);
  assert.equal(lines[0], 'AI · opus-5.5 · working · 1m');
  assert.equal(lines[1], 'AI · quiet · 3h');
  const lamps = finance.findAll(node => node.className === 'presence-lamp').map(node => node.dataset.state);
  assert.deepEqual(lamps, ['working', 'quiet']);
});

test('the row toggles its detail, and only an owner or admin sees the project select', () => {
  const { page, el } = loadPage();
  page.renderRoster(MIXED);
  const scoutCard = () => el('#roster-list').find(node => node.className === 'person-card' &&
    node.find(child => child.tagName === 'STRONG' && child.textContent === 'Scout'));
  const toggle = scoutCard().find(node => node.className === 'person-row');
  const detail = scoutCard().find(node => node.className === 'person-detail');
  assert.equal(detail.hidden, true, 'ARRANGEMENT: the detail starts folded');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  assert.equal(detail.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(detail.find(node => node.textContent === 'opus-5.5 · model reported by client'));
  assert.equal(detail.find(node => node.tagName === 'SELECT'), null, 'a signed-out viewer has no project select');

  page.renderRoster(MIXED);
  assert.equal(scoutCard().find(node => node.className === 'person-detail').hidden, false,
    'an opened row stays open across a refresh');

  vm.runInContext("currentUser = { name: 'Patti', kind: 'person', roles: ['owner'], first_owner: true };", page);
  page.renderRoster(MIXED);
  const select = scoutCard().find(node => node.tagName === 'SELECT');
  assert.ok(select, 'an owner gets the project select');
  assert.equal(select.value, 'finance');
  assert.deepEqual(select.children.map(option => option.value)[0], '', 'Not yet assigned is a choice');
  assert.equal(select.children[0].textContent, 'Not yet assigned');
});

test('the Allow card names the declared project only when one was typed', () => {
  const { page, el } = loadPage();
  const knock = {
    request_id: 'r1', name: 'Scout', product: 'Claude Code', product_provenance: 'client-reported',
    previously_used: false, last_ended_at: null, reuse: 'fresh', reuse_session: null,
    created_at: NOW, expires_at: NOW + 60_000, match_code: 'ABCDE', connected: true, declared_project: null,
  };
  assert.equal(page.validPendingAi(knock), true, 'ARRANGEMENT: the 13-key knock is valid');
  page.renderPendingAis([knock]);
  assert.equal(el('#pending-ai-list').find(node => node.className === 'pending-ai-project'), null);

  page.renderPendingAis([Object.assign({}, knock, { declared_project: 'finanse' })]);
  const line = el('#pending-ai-list').find(node => node.className === 'pending-ai-project');
  assert.ok(line);
  assert.equal(line.textContent, 'Project: finanse (as typed by the AI)');
});

test('grants are validated with closed keys before People uses them', () => {
  const { page } = loadPage();
  const good = {
    grant_id: 'G-1', holder_name: 'Scout', holder_kind: 'seat', project: 'finance', scope: 'books',
    until: null, by_name: 'Ana', at: NOW, state: 'active', revoked_at: null, revoked_by: null, reason: null,
  };
  assert.equal(page.validGrant(good), true, 'ARRANGEMENT: the 12-key grant is valid');
  assert.equal(page.validGrant(Object.assign({}, good, { extra: 1 })), false);
  const missing = Object.assign({}, good);
  delete missing.reason;
  assert.equal(page.validGrant(missing), false);
  assert.equal(page.validGrant(Object.assign({}, good, { state: 'revoked' })), false, 'revoked needs revoked_at');
  assert.equal(page.validGrant(Object.assign({}, good, { grant_id: 'G-0' })), false);
});
