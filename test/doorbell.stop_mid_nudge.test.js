'use strict';

// A Codex host can stop the adapter while the nudge is being handed over: the
// nudge itself starts the host's turn, and a supervisor that pauses the
// doorbell during a turn stops it then. The adapter saves the cursor of what
// it nudges before it hands the nudge over, so a fresh adapter started from
// that state does not ring the same message again. A host that refuses the
// nudge leaves nothing saved, so the ring stays eligible.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'integrations', 'doorbell.js');
const REQUEST_A = '11111111-1111-4111-8111-111111111111';

function world(hostExit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-doorbell-midnudge-'));
  const files = {
    root,
    stateDir: path.join(root, 'state'),
    page: path.join(root, 'page.json'),
    hostLog: path.join(root, 'host-log.txt'),
    interlock: path.join(root, 'fake-interlock.js'),
    host: path.join(root, 'fake-codex.js'),
  };
  fs.writeFileSync(files.page, JSON.stringify({
    ok: true,
    rings: [{ id: 9, ts: 1_788_379_200_000, byline: 'Ana', kind: 'person', session: null }],
    cursor: 9, timed_out: false, connection_session: 3, connection_request_id: REQUEST_A,
  }) + '\n');
  fs.writeFileSync(files.interlock, `#!/usr/bin/env node
const fs = require('node:fs');
const page = JSON.parse(fs.readFileSync(process.env.FAKE_RING_PAGE, 'utf8'));
const at = process.argv.indexOf('--after');
const after = at >= 0 ? Number(process.argv[at + 1]) : -1;
if (after >= page.cursor) page.rings = [];
process.stdout.write(JSON.stringify(page) + '\\n');
`, { mode: 0o700 });
  // The host records each nudge it is handed; told to, it then stops its
  // caller, the adapter, before returning, as a turn supervisor would.
  fs.writeFileSync(files.host, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_HOST_LOG, 'nudge\\n');
if (process.env.FAKE_HOST_STOPS_CALLER === '1') process.kill(process.ppid, 'SIGKILL');
process.exit(Number(process.env.FAKE_HOST_EXIT || 0));
`, { mode: 0o700 });
  files.hostExit = hostExit;
  return files;
}

function run(files, stopsCaller) {
  return childProcess.spawnSync(process.execPath, [RUNNER,
    '--adapter', 'codex', '--connection', 'Marlow', '--session', 'host-session-1',
    '--state-dir', files.stateDir, '--once'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      INTERLOCK_DOORBELL_INTERLOCK: files.interlock,
      INTERLOCK_DOORBELL_CODEX: files.host,
      FAKE_RING_PAGE: files.page,
      FAKE_HOST_LOG: files.hostLog,
      FAKE_HOST_EXIT: String(files.hostExit),
      FAKE_HOST_STOPS_CALLER: stopsCaller ? '1' : '0',
      XDG_DATA_HOME: files.root,
      LOCALAPPDATA: files.root,
    }),
  });
}

const nudges = files => (fs.existsSync(files.hostLog)
  ? fs.readFileSync(files.hostLog, 'utf8').split('\n').filter(Boolean).length : 0);

test('an adapter stopped while handing over a nudge does not repeat it from a fresh start',
  { skip: process.platform === 'win32' && 'the fake host stops its caller with a POSIX signal' }, () => {
    const files = world(0);
    const stopped = run(files, true);
    assert.equal(stopped.signal, 'SIGKILL', `arrangement: the adapter was stopped mid-nudge: ${stopped.stderr}`);
    assert.equal(nudges(files), 1, 'arrangement: the host was handed the nudge once');

    const fresh = run(files, false);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(nudges(files), 1, 'the fresh adapter rang the same message again');
  });

test('a refused nudge saves nothing, and the next run offers the same ring', () => {
  const files = world(7);
  const refused = run(files, false);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Codex rejected the nudge; ring remains eligible/);
  assert.equal(fs.readdirSync(files.stateDir).some(name => /^doorbell-[0-9a-f]{24}\.json$/.test(name)), false,
    'a refused nudge left a saved cursor');
  files.hostExit = 0;
  const accepted = run(files, false);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(nudges(files), 2, 'the same ring was offered again after the host recovered');
});
