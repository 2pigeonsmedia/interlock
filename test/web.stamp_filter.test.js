'use strict';

// The project stamp in the browser: the asks model ingests stamp rows (the
// newest wins), and room.js, run in a vm against a page stand-in, marks each
// message row with its project and whether it addresses the viewer, and
// filters by one class on the list plus one inserted CSS rule, never by
// rebuilding the list. The inserted rule is then evaluated by a small generic
// selector matcher against the rows, so "stays visible" is read off the rule.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Asks = require('../src/web/asks_model.js');

const WEB = path.join(__dirname, '..', 'src', 'web');
const ROOM_JS = fs.readFileSync(path.join(WEB, 'room.js'), 'utf8');
const ROOM_HTML = fs.readFileSync(path.join(WEB, 'room.html'), 'utf8');
const ASK_TURN_JS = fs.readFileSync(path.join(WEB, 'ask_turn.js'), 'utf8');
const ASKS_JS = fs.readFileSync(path.join(WEB, 'asks_model.js'), 'utf8');

function stamp(seq, messageId, project, reason = 'set', by = 'Scout', recordId = null) {
  return { seq, ts: seq, kind: 'stamp', by, message_id: messageId, project, reason, record_id: recordId };
}

test('the model ingests stamp rows; the newest stamp of a message wins; bad shapes refuse the page', () => {
  const state = Asks.createAsksState();
  const page = { ok: true, first_id: 1, cursor: 3, rows: [
    stamp(1, 10, 'orchard', 'assignment'),
    stamp(2, 11, 'household', 'record', 'Ana', 'W-12'),
    stamp(3, 10, 'household', 'set'),
  ] };
  assert.equal(Asks.validPage(page), true);
  state.apply(page.rows.slice(0, 2));
  assert.deepEqual(state.stamp(10), { project: 'orchard', reason: 'assignment', record_id: null, by: 'Scout' },
    'ARRANGEMENT: the first stamp is in');
  state.apply(page.rows.slice(2));
  assert.deepEqual(state.stamp(10), { project: 'household', reason: 'set', record_id: null, by: 'Scout' }, 'newest wins');
  assert.equal(state.stamp(12), null, 'an unstamped message has no stamp');
  assert.deepEqual([...state.stampCounts()].sort(), [['household', 2]]);
  state.apply([stamp(4, 11, null, 'set', 'Ana')]);
  assert.deepEqual([...state.stampCounts()], [['household', 1]], 'a whole-room stamp counts for no project');
  state.reset();
  assert.equal(state.stamp(10), null, 'a new era starts empty');
  for (const bad of [
    Object.assign(stamp(1, 10, 'orchard'), { subject_id: 'x' }),
    stamp(1, 10, 'Orchard'),
    stamp(1, 10, 'orchard', 'guess'),
    stamp(1, 10, 'orchard', 'record'),
    stamp(1, 10, 'orchard', 'set', 'Scout', 'W-1'),
  ]) {
    assert.equal(Asks.validPage({ ok: true, first_id: 1, cursor: 1, rows: [bad] }), false, JSON.stringify(bad));
  }
});

test('the plate names the project and why', () => {
  assert.equal(Asks.stampPlate({ project: 'orchard', reason: 'assignment', record_id: null, by: 'Scout' }, 'Orchard'),
    "Orchard · from Scout's assignment");
  assert.equal(Asks.stampPlate({ project: 'orchard', reason: 'record', record_id: 'W-12', by: 'Ana' }, 'Orchard'),
    'Orchard · from W-12');
  assert.equal(Asks.stampPlate({ project: 'ops', reason: 'ask', record_id: null, by: 'Ana' }, 'Operations'),
    'Operations · from its ask');
  assert.equal(Asks.stampPlate({ project: null, reason: 'set', record_id: null, by: 'Scout' }, null),
    'Whole room · set by Scout');
});

// ── room.js in a vm ─────────────────────────────────────────────────────────

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

class ClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toggle(name, on) { if (on === undefined ? !this.names.has(name) : on) this.names.add(name); else this.names.delete(name); }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this._text = '';
    this.hidden = false;
    this.className = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new ClassList();
    this.dataset = {};
    this.value = '';
    this.replaceCalls = 0;
    this.parent = null;
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  click() { for (const handler of this.listeners.get('click') || []) handler({}); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  insertBefore(node, anchor) {
    node.parent = this;
    const at = anchor ? this.children.indexOf(anchor) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren(...nodes) { this.replaceCalls += 1; this.children = []; this.append(...nodes); }
  // Enough selector support for these rows: a single class, or the filter's
  // own selector evaluated generically (see matches below).
  querySelectorAll(selector) {
    const out = [];
    const walk = node => { for (const child of node.children) { if (matches(child, selector, [])) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/* A small generic matcher for compound selectors: `.class`, `[data-x]`,
 * `[data-x="v"]` and `:not(compound)`, joined by descendant spaces. It knows
 * nothing about projects. `ancestors` is the chain above `node`. */
function matchesCompound(node, compound) {
  let rest = compound.trim();
  while (rest.length > 0) {
    let m;
    if ((m = /^:not\(([^()]*)\)/.exec(rest))) {
      if (matchesCompound(node, m[1])) return false;
    } else if ((m = /^\.([a-zA-Z0-9_-]+)/.exec(rest))) {
      if (!node.classList.contains(m[1]) && !String(node.className).split(/\s+/).includes(m[1])) return false;
    } else if ((m = /^\[data-([a-z-]+)(?:="([^"]*)")?\]/.exec(rest))) {
      const value = node.dataset[camel(m[1])];
      if (value === undefined || (m[2] !== undefined && value !== m[2])) return false;
    } else if ((m = /^([a-z]+)/.exec(rest))) {
      if (node.tagName !== m[1].toUpperCase()) return false;
    } else {
      throw new Error('selector the matcher does not know: ' + rest);
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

function matches(node, selector, ancestors) {
  const parts = selector.trim().split(/\s+(?![^(]*\))/);
  if (!matchesCompound(node, parts[parts.length - 1])) return false;
  let chain = [];
  for (let up = node.parent; up; up = up.parent) chain.push(up);
  chain = ancestors.length ? ancestors : chain;
  let at = 0;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (at < chain.length && !matchesCompound(chain[at], parts[i])) at += 1;
    if (at >= chain.length) return false;
    at += 1;
  }
  return true;
}

/* Whether a row is hidden by the sheet's rules: any `display: none` rule
 * whose selector matches it. */
function hiddenBy(sheet, row) {
  return sheet.cssRules.some(rule => {
    const m = /^(.*)\{\s*display:\s*none;\s*\}$/.exec(rule);
    return m && matches(row, m[1], []);
  });
}

function loadRoom() {
  const elements = new Map();
  const sheet = {
    href: 'http://localhost/room.css',
    cssRules: [],
    insertRule(rule, index) { this.cssRules.splice(index, 0, rule); return index; },
  };
  const stored = new Map();
  const storage = {
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element('div'));
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement(tag) { return new Element(tag); },
    addEventListener() {},
    dispatchEvent() {},
    styleSheets: [sheet],
    activeElement: null,
    hidden: false,
    title: 'Interlock',
  };
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
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    InterlockRequestGeneration: { create: () => ({ rotate() {}, capture: () => 0, isCurrent: () => true }) },
    InterlockAttention: { create: () => standIn() },
    InterlockMentions: standIn(),
    InterlockMessagePage: standIn(),
    InterlockReplyReference: standIn(),
    InterlockTranscriptScroll: standIn(),
    InterlockWorkPanel: standIn(),
    InterlockPeopleModel: standIn(),
  };
  page.window = page;
  page.window.addEventListener = () => {};
  page.PublicKeyCredential = function PublicKeyCredential() {};
  vm.createContext(page);
  vm.runInContext(ASK_TURN_JS, page, { filename: 'ask_turn.js' });
  vm.runInContext(ASKS_JS, page, { filename: 'asks_model.js' });
  vm.runInContext(ROOM_JS, page, { filename: 'room.js' });
  page.renderAskTargets = () => {};
  const transcript = document.querySelector('#transcript');
  transcript.classList.add('transcript');
  return { page, sheet, stored, transcript, el: id => document.querySelector(id) };
}

function row(transcript, id) {
  const article = new Element('article');
  article.className = 'message';
  article.dataset.messageId = String(id);
  const actions = new Element('div');
  actions.className = 'message-actions';
  article.append(actions);
  transcript.append(article);
  return article;
}

test('room.js marks rows, filters by one class and one inserted rule, and never rebuilds the list', () => {
  const { page, sheet, stored, transcript, el } = loadRoom();
  vm.runInContext(`currentUser = { name: 'Ana', kind: 'person', roles: ['owner'] };
    rosterProjects = [{ id: 'orchard', display_name: 'Orchard' }, { id: 'household', display_name: 'Household' }];`, page);
  const rows = {
    orchard: row(transcript, 1),
    household: row(transcript, 2),
    rangMe: row(transcript, 3),
    askedMe: row(transcript, 4),
    unstamped: row(transcript, 5),
    wholeRoom: row(transcript, 6),
  };
  const apply = rows => { page.__rows = rows; vm.runInContext('asksState.apply(__rows)', page); };
  apply([
    { seq: 1, ts: 1, kind: 'post', by: 'Scout', message_id: 4, ask: { of: 'Ana', of_kind: 'person', means: 'm', deliver: 'now', project: 'household' },
      answers: [], status: null, read_through: null, discusses: null },
    stamp(2, 1, 'orchard', 'assignment'),
    stamp(3, 2, 'household', 'record', 'Scout', 'W-2'),
    stamp(4, 3, 'household', 'assignment'),
    stamp(5, 4, 'household', 'ask'),
    stamp(6, 6, null, 'set'),
  ]);
  vm.runInContext("messageDelivery.set(3, [{ name: 'Ana' }]); messageDelivery.set(1, [{ name: 'Wren' }]);", page);
  for (const [, article] of Object.entries(rows)) page.decorateMessage(article, Number(article.dataset.messageId));
  page.renderProjectFilter();

  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([key, article]) =>
    [key, [article.dataset.project ?? null, article.dataset.addressedMe ?? null]])), {
    orchard: ['orchard', null], household: ['household', null], rangMe: ['household', 'true'],
    askedMe: ['household', 'true'], unstamped: [null, null], wholeRoom: [null, null],
  }, 'each row carries its project and whether it addresses the viewer');
  assert.equal(rows.orchard.querySelector('.stamp-plate').textContent, "Orchard · from Scout's assignment");
  assert.equal(rows.household.querySelector('.stamp-plate').textContent, 'Household · from W-2');
  assert.equal(rows.wholeRoom.querySelector('.stamp-plate').textContent, 'Whole room · set by Scout');
  assert.equal(rows.unstamped.querySelector('.stamp-plate'), null, 'an unstamped message shows nothing');
  assert.deepEqual(el('#project-filter').children.map(chip => chip.textContent),
    ['All', 'Household (3)', 'Orchard (1)'], 'All plus one chip per stamped project, with counts');
  assert.equal(el('#project-filter-hidden').hidden, true, 'no line while the filter is All');

  const rebuildsBefore = transcript.replaceCalls;
  assert.equal(sheet.cssRules.length, 0, 'ARRANGEMENT: no filter rule yet');
  assert.ok(Object.values(rows).every(article => !hiddenBy(sheet, article)), 'ARRANGEMENT: nothing hidden under All');
  el('#project-filter').children[2].click();
  assert.ok(transcript.classList.contains('filter-project-orchard'), 'the filter is one class on the list');
  assert.deepEqual(sheet.cssRules, [Asks.filterRule('orchard')], 'and one rule inserted into the room sheet');
  assert.equal(stored.get('interlock.projectFilter'), 'orchard', 'remembered for this tab');
  const hidden = Object.fromEntries(Object.entries(rows).map(([key, article]) => [key, hiddenBy(sheet, article)]));
  assert.deepEqual(hidden, {
    orchard: false, household: true, rangMe: false, askedMe: false, unstamped: false, wholeRoom: false,
  }, 'only a row stamped for another project that does not address the viewer is hidden');
  assert.equal(el('#project-filter-hidden').textContent, '1 message hidden by the Orchard filter');
  assert.equal(el('#project-filter-hidden').hidden, false);

  // A stamp arriving for a rendered row patches that row in place.
  apply([stamp(7, 5, 'household', 'set', 'Ana')]);
  page.refreshAsks();
  assert.equal(rows.unstamped.dataset.project, 'household');
  assert.equal(hiddenBy(sheet, rows.unstamped), true, 'a re-stamped row follows the filter with no redraw');
  assert.equal(el('#project-filter-hidden').textContent, '2 messages hidden by the Orchard filter');

  el('#project-filter').children[0].click();
  assert.equal(transcript.classList.contains('filter-project-orchard'), false, 'All takes the class off');
  assert.ok(Object.values(rows).every(article => !hiddenBy(sheet, article)), 'and nothing is hidden');
  assert.equal(stored.has('interlock.projectFilter'), false);
  assert.equal(transcript.replaceCalls, rebuildsBefore, 'the list was never rebuilt');
  assert.equal(transcript.replaceCalls, 0);
});

test('the Conversation header holds the filter chips and the hidden line; the source never rebuilds the list for them', () => {
  assert.match(ROOM_HTML, /<div id="project-filter" class="project-filter"[^>]*hidden><\/div>/);
  assert.match(ROOM_HTML, /<p id="project-filter-hidden" class="project-filter-hidden"[^>]*hidden><\/p>/);
  const start = ROOM_JS.indexOf('// ── the project stamp and the filter');
  const section = ROOM_JS.slice(start, ROOM_JS.indexOf('function decorateMessage(', start));
  assert.ok(start > 0 && section.length > 0, 'ARRANGEMENT: the section is found');
  assert.equal(/transcript\.replaceChildren|transcript\.innerHTML/.test(section), false);
  assert.equal(/\.style\b|setAttribute\('style'/.test(section), false, 'no inline style: the CSP stays unchanged');
});

test('a project id that is not a plain id never becomes a CSS rule', () => {
  assert.equal(typeof Asks.filterRule('orchard'), 'string', 'ARRANGEMENT: a plain id makes a rule');
  for (const hostile of ['orchard"]){}*{display:none}', 'orchard x', 'Orchard', '', 'a', 'x'.repeat(40), null]) {
    assert.equal(Asks.filterRule(hostile), null, JSON.stringify(hostile));
  }
});
