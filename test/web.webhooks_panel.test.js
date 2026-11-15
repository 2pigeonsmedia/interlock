'use strict';

// Settings → Webhooks, in a small fake DOM: rows for each AI, the secret shown
// once from the answer that made it and cleared when Settings closes, plain
// words for a refusal, and no markup taken from the room.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'webhooks_panel.js'), 'utf8');

function fakeNode(tag) {
  const node = {
    tagName: tag, className: '', children: [], dataset: {}, hidden: false, value: '', type: '', checked: false,
    listeners: {}, attributes: {},
    get textContent() { return (this._text || '') + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { this._text = String(value); this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; this._text = ''; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    setAttribute(key, value) { this.attributes[key] = value; },
    focus() {}, select() {},
    set innerHTML(_) { throw new Error('innerHTML is never used'); },
  };
  return node;
}

function load(fetchAnswer, confirmAnswer = true) {
  const window = {
    confirm: () => confirmAnswer,
  };
  const context = {
    window, globalThis: window,
    document: {
      createElement: fakeNode,
      createTextNode: text => ({ textContent: String(text), children: [] }),
    },
    fetch: async () => ({ ok: true, json: async () => fetchAnswer() }),
  };
  window.document = context.document;
  window.fetch = context.fetch;
  vm.runInNewContext(SOURCE, context);
  return { window, context };
}

function find(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function parts() {
  return {
    list: fakeNode('div'), status: fakeNode('p'), secretBox: Object.assign(fakeNode('div'), { hidden: true }),
    secretValue: fakeNode('input'), secretFor: fakeNode('strong'), httpsOnlyNote: fakeNode('p'),
  };
}

test('rows name each AI and where its webhook points; markup in a name stays text', async () => {
  const seats = [
    { name: 'Scout', webhook: { target: 'https://hooks.example', excerpt: true, created_at: 1, updated_at: 2 } },
    { name: '<img src=x onerror=alert(1)>', webhook: null },
  ];
  const { window } = load(() => ({ ok: true, https_only: true, seats }));
  const p = parts();
  const panel = window.InterlockWebhooksPanel.create(Object.assign(p, { mutate: async () => ({}) }));
  await panel.refresh();
  assert.equal(p.list.children.length, 2);
  assert.match(p.list.children[0].textContent, /Scout — calls https:\/\/hooks\.example, with an excerpt/);
  assert.match(p.list.children[1].textContent, /<img src=x onerror=alert\(1\)> — no webhook/);
  assert.equal(p.httpsOnlyNote.hidden, false);
});

test('the secret shows once from the answer that made it, and hideSecret clears it', async () => {
  const { window } = load(() => ({ ok: true, https_only: false, seats: [{ name: 'Scout', webhook: null }] }));
  const p = parts();
  const calls = [];
  const panel = window.InterlockWebhooksPanel.create(Object.assign(p, {
    mutate: async (route, body) => { calls.push([route, body]); return { ok: true, name: 'Scout', secret: 'ilwh_' + 'S'.repeat(43) }; },
  }));
  await panel.refresh();
  const form = find(p.list, node => node.tagName === 'form')[0];
  const input = find(form, node => node.tagName === 'input' && node.type === 'url')[0];
  input.value = ' https://hooks.example/r/abc ';
  await form.listeners.submit[0]({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  // Compared as JSON: the body was made inside the page's own context.
  assert.equal(JSON.stringify(calls), JSON.stringify([['/api/settings/webhooks/set', { name: 'Scout', url: 'https://hooks.example/r/abc', excerpt: false }]]));
  assert.equal(p.secretBox.hidden, false);
  assert.equal(p.secretValue.value, 'ilwh_' + 'S'.repeat(43));
  assert.equal(p.secretFor.textContent, 'Scout');
  panel.hideSecret();
  assert.equal(p.secretBox.hidden, true);
  assert.equal(p.secretValue.value, '');
});

test('a refused address reads as plain words; a declined confirm changes nothing', async () => {
  const seats = [{ name: 'Scout', webhook: { target: 'https://hooks.example', excerpt: false, created_at: 1, updated_at: 2 } }];
  const { window } = load(() => ({ ok: true, https_only: true, seats }), false);
  const p = parts();
  const calls = [];
  const panel = window.InterlockWebhooksPanel.create(Object.assign(p, {
    mutate: async route => {
      calls.push(route);
      const error = new Error('invalid-webhook-url');
      error.code = 'invalid-webhook-url';
      throw error;
    },
  }));
  await panel.refresh();
  const buttons = find(p.list, node => node.tagName === 'button' && node.type === 'button');
  const remove = buttons.find(node => node.textContent === 'Delete webhook');
  remove.listeners.click[0]();
  assert.deepEqual(calls, [], 'the delete waited for a yes that never came');
  const form = find(p.list, node => node.tagName === 'form')[0];
  await form.listeners.submit[0]({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.status.textContent, /not one the room can call/);
  assert.equal(p.secretBox.hidden, true);
});
