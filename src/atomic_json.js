'use strict';

// Whole-file JSON replacement with the durability steps every local store
// shares: write a sibling temporary file, fsync it, rename it over the target,
// fsync the directory. Moved here from src/chat/store.js so the chat store and
// the work store use one implementation.

const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(dirPath) {
  if (!DIRECTORY_SYNC_SUPPORTED) return;
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteJson(filePath, value) {
  const tmp = filePath + '.tmp';
  const encoded = JSON.stringify(value) + '\n';
  fs.writeFileSync(tmp, encoded, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  fsyncFile(tmp);
  fs.renameSync(tmp, filePath);
  fsyncDirectory(path.dirname(filePath));
}

module.exports = Object.freeze({
  DIRECTORY_SYNC_SUPPORTED,
  atomicWriteJson,
  fsyncDirectory,
  fsyncFile,
});
