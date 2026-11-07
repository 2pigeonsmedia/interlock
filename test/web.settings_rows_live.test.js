'use strict';

// The rows a running room serves to Settings and to People pass the page's
// own row checks. 0.3.4 added `waiting` to Settings rows while the page kept
// requiring the 0.3.3 shape, so Settings refused the whole list. This runs
// the shipped room.js against rows from a real server.

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const vm = require('node:vm');

const identity = require('identity');
const { createDevice } = require('../identity/test/step_up_fixture.js');

const { LOOPBACK_HOST, startInterlockServer } = require('../src/server.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
const { reserveTestPort } = require('./helpers/reserve_port.js');

function reservePort() {
  return reserveTestPort();
}

function call(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = Object.assign({ host: `localhost:${runtime.port}` }, options.headers);
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    const request = http.request({
      agent: false, host: runtime.address, port: runtime.port,
      path: options.path || '/', method: options.method || 'GET', headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.once('error', error => {
      error.message += ` (${options.method || 'GET'} ${options.path || '/'})`;
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function post(runtime, pathname, body, session = {}, headers = {}) {
  return call(runtime, {
    path: pathname, method: 'POST', body,
    headers: Object.assign({
      origin: runtime.url,
      'sec-fetch-site': 'same-origin',
      ...(session.cookie ? { cookie: session.cookie } : {}),
      ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}),
    }, headers),
  });
}

function get(runtime, pathname, session) {
  return call(runtime, { path: pathname, headers: { cookie: session.cookie } });
}

async function bootstrap(runtime) {
  const password = 'correct horse battery staple';
  const redeemed = await post(runtime, '/api/bootstrap/redeem', { name: 'Ana', password });
  assert.equal(redeemed.status, 200, redeemed.text);
  const session = { cookie: redeemed.headers['set-cookie'][0].split(';', 1)[0], csrf: redeemed.json.csrf_token };
  const device = createDevice({ origin: runtime.url, rpId: 'localhost' });
  const registration = await post(runtime, '/api/bootstrap/registration/options', {}, session);
  assert.equal(registration.status, 200, registration.text);
  const registered = await post(runtime, '/api/bootstrap/registration/finish', {
    ceremony_id: registration.json.ceremony_id,
    response: device.registration(registration.json.options.challenge),
  }, session);
  assert.equal(registered.status, 200, registered.text);
  const elevation = await post(runtime, '/api/bootstrap/elevation/options', {}, session);
  assert.equal(elevation.status, 200, elevation.text);
  const completed = await post(runtime, '/api/bootstrap/complete', {
    ceremony_id: elevation.json.ceremony_id,
    response: device.assertion(elevation.json.options.challenge),
  }, session);
  assert.equal(completed.status, 200, completed.text);
  return { password, device };
}

async function login(runtime, password) {
  const response = await post(runtime, '/api/login', { name: 'Ana', password });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';', 1)[0], csrf: response.json.csrf_token };
}

async function elevate(runtime, session, device) {
  const options = await post(runtime, '/api/elevation/options', {}, session);
  assert.equal(options.status, 200, options.text);
  const finished = await post(runtime, '/api/elevation/finish', {
    ceremony_id: options.json.ceremony_id,
    response: device.assertion(options.json.options.challenge),
  }, session);
  assert.equal(finished.status, 200, finished.text);
  return { cookie: finished.headers['set-cookie'][0].split(';', 1)[0], csrf: finished.json.csrf_token };
}

async function waitForPending(runtime, session, requestId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await call(runtime, { path: '/api/ai/admissions', headers: { cookie: session.cookie } });
    assert.equal(response.status, 200, response.text);
    if (response.json.pending.some(row => row.request_id === requestId && row.connected === true)) return response;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('the loopback knock did not become visibly connected');
}

// The owner session must hold a fresh step-up when this is called.
async function admitSeat(runtime, owner, name) {
  const candidate = identity.newAiCredential();
  const body = {
    request_id: crypto.randomUUID(), name, product: 'Codex CLI', product_provenance: 'client-reported',
    selector: candidate.selector, digest: candidate.digest,
  };
  const waiting = post(runtime, '/api/ai/admissions', body);
  await waitForPending(runtime, owner, body.request_id);
  const allowed = await post(runtime, `/api/ai/admissions/${body.request_id}/allow`, {}, owner);
  assert.equal(allowed.status, 200, allowed.text);
  const joined = await waiting;
  assert.equal(joined.status, 200, joined.text);
  return { token: candidate.token, name };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function aiPost(runtime, pathname, body, token) {
  return call(runtime, { path: pathname, method: 'POST', body, headers: bearer(token) });
}

function aiGet(runtime, pathname, token) {
  return call(runtime, { path: pathname, headers: bearer(token) });
}

function uuid() {
  return crypto.randomUUID();
}

test('Settings and People rows from a running room pass the page\'s row checks', async () => {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-server-settings-rows-'));
  const runtime = await startInterlockServer({ port, dataDir });
  try {
    const { password, device } = await bootstrap(runtime);
    const owner = await elevate(runtime, await login(runtime, password), device);
    const cue = await admitSeat(runtime, owner, 'Cue');
    const filed = await aiPost(runtime, '/api/ai/work/items/create',
      { operation_id: uuid(), kind: 'work', project: 'ops', title: 'Reconcile March', body: 'b', responsible: 'Cue' }, cue.token);
    assert.equal(filed.status, 201, 'ARRANGEMENT: Cue holds open work, so the Work facts are set: ' + filed.text);
    const ana = await login(runtime, password);
    const settings = await get(runtime, '/api/settings/participants', ana);
    assert.equal(settings.status, 200, settings.text);
    const people = await get(runtime, '/api/participants', ana);
    assert.equal(people.status, 200, people.text);
    assert.ok(settings.json.participants.some(row => row.name === 'Cue'), 'ARRANGEMENT: the seat is in Settings');
    const { page } = loadPage();
    for (const row of settings.json.participants) {
      assert.equal(page.validSettingsParticipant(row), true, `Settings row for ${row.name}: ${Object.keys(row).join(',')}`);
    }
    for (const row of people.json.participants) {
      assert.equal(page.validParticipant(row), true, `People row for ${row.name}: ${Object.keys(row).join(',')}`);
    }
    // When a seat last wrote to Work is on People rows only, never on Settings.
    const cuePeople = people.json.participants.find(row => row.name === 'Cue');
    assert.ok(Number.isSafeInteger(cuePeople.last_work_at), 'People says when Cue last wrote to Work');
    const cueSettings = settings.json.participants.find(row => row.name === 'Cue');
    assert.equal(Object.hasOwn(cueSettings, 'last_work_at'), false, 'Settings does not');
    assert.equal(Object.keys(cueSettings).length, 15, 'Settings rows keep the 15 keys the page checks');
  } finally {
    await runtime.close();
  }
});
