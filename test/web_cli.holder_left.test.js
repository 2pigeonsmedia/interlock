'use strict';

// The words for an item whose holder or next has left the room (ruling,
// 2026-11-10): the CLI rows, the project row line and the Needs you card each
// say "holder left" with the name, beside the state, never in place of it.


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EXIT_OK, EXIT_RUNTIME, run } = require('../src/cli.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEST_TOKEN = 'test-bearer-not-a-real-credential';

async function captureCommand(argv, dependencies = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: value => { stdout += String(value); } },
    stderr: { write: value => { stderr += String(value); } },
  }, dependencies);
  return { code, stderr, stdout };
}

function world(responder) {
  const profile = Object.freeze({
    schema: 2, name: 'Marlow', product: 'Codex CLI', product_provenance: 'client-reported',
    server_url: 'http://localhost:8788', request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: TEST_TOKEN, selector: 'selectorselectorselecto', digest: 'a'.repeat(64),
    state: 'admitted', created_at: 1, admitted_at: 2, subject_id: 'seat-1', expires_at: 99_999, cursor: 0,
  });
  const calls = [];
  const dependencies = {
    clock: () => 100,
    config: { resolveConnectionDir: () => '/tmp/interlock-cli-connections' },
    profiles: {
      validName: value => /^[A-Za-z0-9-]{2,24}$/.test(value),
      openProfiles: () => ({ load: () => profile, acquireReadLease() { return { release() {} }; } }),
    },
    fetch: async (url, init = {}) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url, method: init.method || 'GET', headers: init.headers, body });
      const answer = responder({ url, method: init.method || 'GET', body });
      const status = answer.status || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (answer.headers || {})[name.toLowerCase()] || null },
        json: async () => answer.json,
        text: async () => answer.text === undefined ? JSON.stringify(answer.json) : answer.text,
      };
    },
  };
  return { calls, dependencies };
}

const PANEL = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
const MODEL = require('../src/web/work_panel_model.js');

test('brief and list rows say holder left, with the name', async () => {
  const brief = {
    ok: true, cursor: 3, projects: [], reported_to_me: [], decisions: [],
    needs_me: [{ id: 'W-6', kind: 'work', project: 'finance', title: 'Reconcile March', state: 'active', holder_left: ['Juno'],
      responsible: { name: 'Juno', kind: 'seat' }, next_to: null, next_action: 'Match rows', awaiting: null }],
    open: [{ id: 'W-7', kind: 'work', project: 'finance', title: 'Check fees', state: 'open', holder_left: ['Juno'],
      responsible: null, next_to: { name: 'Juno', kind: 'seat' }, next_action: 'check' }],
  };
  const { dependencies } = world(() => ({ json: brief }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /W-6 · Reconcile March — Match rows \(active, holder left: Juno\)/);
  assert.match(result.stdout, /W-7 · open · Check fees · next: Juno — check · holder left: Juno/);
});

test('the project row line and the Needs you card say holder left', () => {
  const line = MODEL.projectRowLine({ id: 'W-6', kind: 'work', state: 'active', next_to: null, responsible: { name: 'Juno', kind: 'seat' },
    next_action: '', evidence_attached: false, awaiting: null, target: '', holder_left: ['Juno'] });
  assert.match(line, /^holder left: Juno · responsible: Juno/, 'first, so a narrow row never hides it');
  const cards = MODEL.needsCards({ projects: [], needs_me: [{ id: 'W-6', kind: 'work', project: 'ops', title: 'Reconcile March', state: 'active',
    created_by: { name: 'Cue', kind: 'seat' }, next_action: '', updated_at: 1, holder_left: ['Juno'] }] }, 1);
  assert.deepEqual(cards.cards.find(card => card.id === 'W-6').holderLeft, ['Juno']);
  assert.ok(PANEL.includes("if (card.holderLeft && card.holderLeft.length) facts.push('holder left: ' + card.holderLeft.join(', '));"));
  const plain = MODEL.projectRowLine({ id: 'W-8', kind: 'work', state: 'active', next_to: null, responsible: null,
    next_action: '', evidence_attached: false, awaiting: null, target: '' });
  assert.doesNotMatch(plain, /holder left/, 'a row from an older room has no holder_left and says nothing');
});
