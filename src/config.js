'use strict';

const os = require('node:os');
const path = require('node:path');

const DATA_DIR_ENV = 'INTERLOCK_DATA_DIR';
const CONNECTION_DIR_ENV = 'INTERLOCK_CONNECTION_DIR';

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function requireAbsolute(api, value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') ||
      !api.isAbsolute(value)) {
    throw new Error(`interlock config: ${label} must be an absolute path`);
  }
  return api.normalize(value);
}

function resolveDataDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const api = pathApi(platform);

  if (Object.prototype.hasOwnProperty.call(env, DATA_DIR_ENV)) {
    return requireAbsolute(api, env[DATA_DIR_ENV], DATA_DIR_ENV);
  }

  const home = requireAbsolute(api, homedir, 'home directory');
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' && api.isAbsolute(env.LOCALAPPDATA)
      ? api.normalize(env.LOCALAPPDATA)
      : api.join(home, 'AppData', 'Local');
    return api.join(local, 'Interlock');
  }
  if (platform === 'darwin') {
    return api.join(home, 'Library', 'Application Support', 'Interlock');
  }
  const xdg = typeof env.XDG_DATA_HOME === 'string' && api.isAbsolute(env.XDG_DATA_HOME)
    ? api.normalize(env.XDG_DATA_HOME)
    : api.join(home, '.local', 'share');
  return api.join(xdg, 'interlock');
}

function resolveConnectionDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homedir = options.homedir || os.homedir();
  const api = pathApi(platform);
  if (Object.prototype.hasOwnProperty.call(env, CONNECTION_DIR_ENV)) {
    return requireAbsolute(api, env[CONNECTION_DIR_ENV], CONNECTION_DIR_ENV);
  }
  return api.join(resolveDataDir({ platform, env, homedir }), 'connections');
}

module.exports = Object.freeze({
  CONNECTION_DIR_ENV,
  DATA_DIR_ENV,
  resolveConnectionDir,
  resolveDataDir,
});
