'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONNECTION_DIR_ENV, DATA_DIR_ENV, resolveConnectionDir, resolveDataDir,
} = require('../src/config.js');

test('the data directory follows each platform convention', () => {
  assert.equal(resolveDataDir({
    platform: 'win32', homedir: 'C:\\Users\\Ana',
    env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' },
  }), 'C:\\Users\\Ana\\AppData\\Local\\Interlock');

  assert.equal(resolveDataDir({
    platform: 'darwin', homedir: '/Users/ana', env: {},
  }), '/Users/ana/Library/Application Support/Interlock');

  assert.equal(resolveDataDir({
    platform: 'linux', homedir: '/home/ana', env: {},
  }), '/home/ana/.local/share/interlock');

  assert.equal(resolveDataDir({
    platform: 'linux', homedir: '/home/ana', env: { XDG_DATA_HOME: '/var/lib/ana' },
  }), '/var/lib/ana/interlock');
});

test('connection profiles live in one explicit protected subdirectory on every platform', () => {
  assert.equal(resolveConnectionDir({
    platform: 'win32', homedir: 'C:\\Users\\Ana',
    env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' },
  }), 'C:\\Users\\Ana\\AppData\\Local\\Interlock\\connections');
  assert.equal(resolveConnectionDir({
    platform: 'darwin', homedir: '/Users/ana', env: {},
  }), '/Users/ana/Library/Application Support/Interlock/connections');
  assert.equal(resolveConnectionDir({
    platform: 'linux', homedir: '/home/ana', env: {},
  }), '/home/ana/.local/share/interlock/connections');
  assert.equal(resolveConnectionDir({
    platform: 'linux', homedir: '/home/ana',
    env: { [CONNECTION_DIR_ENV]: '/run/user/1000/interlock-connections' },
  }), '/run/user/1000/interlock-connections');
  assert.throws(() => resolveConnectionDir({
    platform: 'linux', homedir: '/home/ana', env: { [CONNECTION_DIR_ENV]: 'relative' },
  }), /INTERLOCK_CONNECTION_DIR must be an absolute path/);
});

test('one explicit Interlock value overrides the platform default and must be absolute', () => {
  assert.equal(resolveDataDir({
    platform: 'linux', homedir: '/home/ana', env: { [DATA_DIR_ENV]: '/srv/interlock-data' },
  }), '/srv/interlock-data');

  assert.throws(() => resolveDataDir({
    platform: 'linux', homedir: '/home/ana', env: { [DATA_DIR_ENV]: 'relative/data' },
  }), /INTERLOCK_DATA_DIR must be an absolute path/);
  assert.throws(() => resolveDataDir({
    platform: 'win32', homedir: 'C:\\Users\\Ana', env: { [DATA_DIR_ENV]: '' },
  }), /INTERLOCK_DATA_DIR must be an absolute path/);
  assert.throws(() => resolveDataDir({
    platform: 'linux', homedir: '/home/ana', env: { [DATA_DIR_ENV]: '/tmp/bad\0path' },
  }), /INTERLOCK_DATA_DIR must be an absolute path/);
});
