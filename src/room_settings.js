'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'room-settings.json';

function fail(code) {
  const error = new Error('room_settings: ' + code);
  error.code = code;
  return error;
}

function settingsPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.includes('\0') ||
      !path.isAbsolute(dataDir)) {
    throw fail('invalid-data-dir');
  }
  return path.join(dataDir, FILE_NAME);
}

function readRoomSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        Object.keys(raw).length === 1 && raw.allow_ended_reuse === false) {
      return Object.freeze({ allow_ended_reuse: false });
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ allow_ended_reuse: true });
}

function writeRoomSettings(dataDir, settings) {
  const allow = !(settings && settings.allow_ended_reuse === false);
  const file = settingsPath(dataDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ allow_ended_reuse: allow })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  return Object.freeze({ allow_ended_reuse: allow });
}

module.exports = Object.freeze({
  readRoomSettings,
  writeRoomSettings,
});
