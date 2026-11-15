'use strict';

// Node's fetch ignores HTTPS_PROXY, HTTP_PROXY and NO_PROXY unless the
// process starts with NODE_USE_ENV_PROXY=1 or --use-env-proxy. A client in a
// sandbox that reaches the internet only through a proxy would then wait on
// connections that never leave the computer. The client commands install
// the same proxy agent at start with http.setGlobalProxyFromEnv, so the
// variables work without either switch. A room on this computer is always
// reached directly, whatever NO_PROXY says.

const LOOPBACK = Object.freeze(['localhost', '127.0.0.1', '::1', '[::1]']);

function first(env, upper) {
  const lower = env[upper.toLowerCase()];
  if (typeof lower === 'string' && lower.trim() !== '') return { name: upper.toLowerCase(), value: lower.trim() };
  const value = env[upper];
  if (typeof value === 'string' && value.trim() !== '') return { name: upper, value: value.trim() };
  return null;
}

// The proxy variables this process would use, or null when none is set.
function proxySettings(env = process.env) {
  const https = first(env, 'HTTPS_PROXY');
  const http = first(env, 'HTTP_PROXY');
  if (!https && !http) return null;
  return Object.freeze({ https, http, noProxy: first(env, 'NO_PROXY') });
}

// A proxy URL as it may be shown: no user name or password.
function redact(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.href.replace(/\/$/, '');
  } catch (_) {
    return '(not a valid URL)';
  }
}

function describeProxy(settings, protocol) {
  const chosen = protocol === 'http:' ? settings.http : (settings.https || null);
  if (!chosen) return null;
  return `${chosen.name}=${redact(chosen.value)}`;
}

// Installs the proxy from the environment for fetch and the http(s) agents.
// Answers { installed, settings } or { installed: false, reason }.
function useEnvProxy(env = process.env, http = require('node:http')) {
  const settings = proxySettings(env);
  if (!settings) return Object.freeze({ installed: false, reason: 'not-set', settings: null });
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    return Object.freeze({ installed: false, reason: 'unsupported', settings });
  }
  const noProxy = [settings.noProxy ? settings.noProxy.value : '', ...LOOPBACK]
    .filter(Boolean).join(',');
  const proxyEnv = {
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  if (settings.https) proxyEnv.HTTPS_PROXY = settings.https.value;
  if (settings.http) proxyEnv.HTTP_PROXY = settings.http.value;
  try {
    http.setGlobalProxyFromEnv(proxyEnv);
  } catch (_) {
    return Object.freeze({ installed: false, reason: 'invalid', settings });
  }
  return Object.freeze({ installed: true, reason: null, settings });
}

module.exports = Object.freeze({ LOOPBACK, describeProxy, proxySettings, redact, useEnvProxy });
