'use strict';

// Each person's own time zone (v0.4.0), as they set it in Settings. The room
// uses it to tell its AIs what time it is for that person; it is never
// inferred from a browser or the server. Its own file, which Interlock 0.3.x
// never opens, so a rollback ignores it.

const fs = require('node:fs');
const path = require('node:path');

const { validTimeZone } = require('./rings.js');

const FILE_NAME = 'time-zones.json';
const SCHEMA = 1;

function fail(code) {
  const error = new Error('time_zones: ' + code);
  error.code = code;
  return error;
}

function zonesPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.includes('\0') ||
      !path.isAbsolute(dataDir)) {
    throw fail('invalid-data-dir');
  }
  return path.join(dataDir, FILE_NAME);
}

function validSubject(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('\0');
}

/* subject_id -> time zone, for every person who set one. */
function readTimeZones(dataDir) {
  let text;
  try {
    text = fs.readFileSync(zonesPath(dataDir), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return new Map();
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw fail('invalid-time-zones');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 ||
      raw.schema !== SCHEMA || !Array.isArray(raw.entries)) throw fail('invalid-time-zones');
  const zones = new Map();
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 2 ||
        !validSubject(entry.subject_id) || zones.has(entry.subject_id) ||
        !validTimeZone(entry.time_zone)) throw fail('invalid-time-zones');
    zones.set(entry.subject_id, entry.time_zone);
  }
  return zones;
}

function timeZoneOf(dataDir, subjectId) {
  return readTimeZones(dataDir).get(subjectId) || null;
}

/* Set (a zone) or clear (null) one person's time zone. */
function writeTimeZone(dataDir, subjectId, zone) {
  if (!validSubject(subjectId) || !(zone === null || validTimeZone(zone))) throw fail('invalid-time-zone');
  const zones = readTimeZones(dataDir);
  if (zone === null) zones.delete(subjectId);
  else zones.set(subjectId, zone);
  const file = zonesPath(dataDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const entries = [...zones].map(([id, timeZone]) => ({ subject_id: id, time_zone: timeZone }));
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: SCHEMA, entries })}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return zone;
}

module.exports = Object.freeze({ readTimeZones, timeZoneOf, writeTimeZone, FILE_NAME });
