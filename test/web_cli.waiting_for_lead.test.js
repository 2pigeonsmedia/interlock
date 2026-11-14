'use strict';

// A project with no lead (ruling, 2026-11-14): its waiting work is one line in
// the CLI brief and one Needs-you card, whose act opens the grant form on
// that project. A server that sends no such line shows nothing new.


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

const LINE = Object.freeze({ project: 'books', display_name: 'Ledger', count: 3, items: ['W-3', 'W-11', 'W-14'], since: 50 });

test('the CLI brief shows one line per project with no lead, counted in Needs you', async () => {
  const brief = {
    ok: true, cursor: 3, projects: [], reported_to_me: [], decisions: [], open: [],
    needs_me: [{ id: 'W-6', kind: 'work', project: 'ops', title: 'Reconcile March', state: 'active', holder_left: [],
      responsible: { name: 'Ana', kind: 'person' }, next_to: null, next_action: 'Match rows', awaiting: null }],
    waiting_for_lead: [LINE],
  };
  const { dependencies } = world(() => ({ json: brief }));
  const result = await captureCommand(['work', 'brief', '--connection', 'Marlow'], dependencies);
  assert.equal(result.code, EXIT_OK, result.stderr);
  assert.match(result.stdout, /^Needs you \(2\)$/m);
  assert.match(result.stdout,
    /^ {2}books · Ledger has no lead — 3 items wait for one \(W-3, W-11, W-14\); a lead grant on books hands them on$/m);
  const older = await captureCommand(['work', 'brief', '--connection', 'Marlow'],
    world(() => ({ json: Object.assign({}, brief, { waiting_for_lead: undefined }) })).dependencies);
  assert.match(older.stdout, /^Needs you \(1\)$/m, 'an older server: no line, no error');
});

test('the Needs you card: one per project with no lead, its act a lead grant on that project', () => {
  const brief = { projects: [{ id: 'books', display_name: 'Ledger' }], needs_me: [], waiting_for_lead: [LINE] };
  const { count, cards } = MODEL.needsCards(brief, 100);
  assert.equal(count, 1);
  assert.deepEqual([cards[0].kind, cards[0].grantProject, cards[0].question, cards[0].detail],
    ['lead', 'books', 'Ledger has no lead', '3 items wait for a lead: W-3, W-11, W-14']);
  assert.equal(MODEL.needsCards({ projects: [], needs_me: [] }, 100).count, 0, 'an older server: nothing');
  assert.equal(MODEL.needsCards(Object.assign({}, brief, { waiting_for_lead: [{ project: 'books', count: 0, items: [], since: 1 }] }), 100).count, 0,
    'a line with nothing waiting is no card');
  const rows = MODEL.needsYou(brief, 100).rows;
  assert.deepEqual([rows[0].kind, rows[0].action, rows[0].title], ['lead', 'Grant a lead', 'Ledger has no lead']);
});

test('the panel asks the room to open the grant form on that project; the room opens Settings there, for an administrator', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'work_panel.js'), 'utf8');
  assert.match(panel, /new CustomEvent\('interlock:grant-lead', \{ detail: \{ project \} \}\)/);
  assert.match(panel, /if \(card\.kind === 'lead'\) \{[\s\S]*?grantLead\(card\.grantProject\)/);
  const room = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'room.js'), 'utf8');
  assert.match(room, /addEventListener\('interlock:grant-lead'[\s\S]*?!viewerIsAdmin\(\)\) return;\s*settingsButton\.click\(\);[\s\S]*?grantProject\.value = detail\.project;/);
});
