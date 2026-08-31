'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const NOTICE = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const PROTOCOL = fs.readFileSync(path.join(ROOT, 'docs', 'PROTOCOL.md'), 'utf8');
const UPGRADE = fs.readFileSync(path.join(ROOT, 'UPGRADE.md'), 'utf8');
const LOCK = require('../package-lock.json');

function dependencyName(packagePath) {
  return packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

test('third-party notices cover every exact production package in the lockfile', () => {
  const dependencies = Object.entries(LOCK.packages)
    .filter(([packagePath, details]) => packagePath.includes('node_modules/') &&
      packagePath !== 'node_modules/identity' && details.dev !== true)
    .map(([packagePath, details]) => ({
      name: dependencyName(packagePath),
      version: details.version,
      license: details.license,
    }));
  assert.ok(dependencies.length > 0);
  for (const dependency of dependencies) {
    const row = `| \`${dependency.name}\` | \`${dependency.version}\` | ${dependency.license} |`;
    assert.ok(NOTICE.includes(row), `missing dependency notice row: ${row}`);
  }
  const rows = NOTICE.match(/^\| `[^`]+` \| `[^`]+` \| [^|]+ \|/gm) || [];
  assert.equal(rows.length, dependencies.length,
    'the notice must not retain packages that are absent from the production lock graph');
});

test('the upgrade path backs up first and never teaches an in-place downgrade', () => {
  assert.match(UPGRADE, /Stop the foreground server with Ctrl\+C/);
  assert.match(UPGRADE, /interlock backup --to ABSOLUTE_NEW_BACKUP_PATH/);
  assert.match(UPGRADE, /npm install --global --install-links=true \./);
  assert.match(UPGRADE, /same `INTERLOCK_DATA_DIR` and `INTERLOCK_CONNECTION_DIR`/);
  assert.match(UPGRADE, /downgrade in place is not a rollback/);
  assert.match(UPGRADE, /configured data path is absent/);
  assert.match(UPGRADE, /interlock restore --from ABSOLUTE_NEW_BACKUP_PATH/);
  assert.match(UPGRADE, /Do not delete or clean the data\s+directory/);
  assert.match(UPGRADE, /Stop every old listening command before replacing its CLI/);
  assert.match(UPGRADE, /reload the browser tab/);
  assert.match(UPGRADE,
    /local\s+re-arm rule before the outage.*never make an Interlock “UP” message the\s+trigger, because a stopped listener cannot hear it/is);
  assert.match(UPGRADE,
    /prearranged local trigger.*upgraded `history` and `listen` without waiting for a room message.*retry the globally installed command.*resolves that command afresh.*never retain a\s+direct path to the old release/is);
  assert.match(UPGRADE, /pre-repair CLI may report[^]*unreachable[^]*version mismatch/);
  assert.match(UPGRADE, /old `say` reports failure[^]*do\s+not retry[^]*already have been\s+accepted/);
  assert.doesNotMatch(UPGRADE, /rm\s+-rf|rmdir\s+\/s|git reset/i);
});

test('the tested-on list names exact runtimes without turning WSL into native Ubuntu', () => {
  assert.match(README, /Node 24\.14\.1[^\n]*WSL\/Linux[^\n]*362\/362/);
  assert.match(README, /Native Windows[\s\S]*not re-run here/,
    'this RC must not invent a native Windows number it did not re-run');
  assert.match(README, /fresh\s+source trees passed 308\/308 tests/,
    'the v0.1.0 tag proofs stay described as that tag\'s, never re-claimed');
  assert.match(README, /automated runtime compatibility/);
  assert.match(README,
    /v0\.1\.0 tag.s[\s\S]*deeper proofs[\s\S]*not re-run for v0\.1\.2 beyond the suites named above/,
    'unrepeated proofs must say so');
  assert.match(README, /deferred to v0\.1\.3 by owner ruling/,
    'Features 4 and 5 must be named as deferred, not omitted');
  assert.match(README, /native(?: Ubuntu)?\s+browser\/passkey journey/i);
  assert.match(README, /no native macOS journey was run/i);
  assert.match(README, /post-v0\.1\s+evidence goals,\s+not claims made by this tested-on table/i);
  assert.match(README, /cold-newcomer[\s\S]*journey[\s\S]*open evidence goal[\s\S]*discretion/i);
  assert.doesNotMatch(README, /journeys remain open[^]*not yet a public release/i,
    'the tested-on boundary must not silently reopen gates moved to post-v0.1');
  assert.match(README, /After its seat ends[^]*fresh session[^]*Session 1[^]*Session 2/);
  assert.match(README,
    /Ordinary `history` and `listen` each return at most one transcript[^]*`history --drain`[^]*12 KiB[^]*up to 100[^]*first message outside the budget untouched[^]*single[^]*message is never truncated[^]*cannot acknowledge[^]*backlog outside model context/);
  assert.match(PROTOCOL, /previously_used: true[^]*last_ended_at/);
  assert.match(PROTOCOL, /14 days by default and never more than 90 days/);
  assert.match(PROTOCOL, /cursor commits[^]*bound to the exact admission request/);
  assert.match(PROTOCOL,
    /read lease spans each complete `history` or\s+`listen` transaction[^]*second reader[^]*refuses before it\s+contacts the room/);
  assert.match(PROTOCOL,
    /`history --drain` repeats[^]*fetch, receipt, and cursor transactions[^]*one local read lease[^]*12 KiB[^]*100 messages[^]*overflow message receives no receipt or cursor commit[^]*legal message remains atomic/);
  assert.match(PROTOCOL,
    /connection_session[^]*ended same-name\s+generation is never submitted by the replacement bearer/);
  assert.match(PROTOCOL,
    /five-minute recent-client `present` state[^]*People always shows people[^]*only while its authenticated client has reached[^]*within the last five minutes[^]*not a doorbell or\s+model-attention claim[^]*remains admitted[^]*manageable in Settings/);
});
