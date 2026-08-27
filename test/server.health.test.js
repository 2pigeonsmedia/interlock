'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  startHealthServer,
} = require('../src/server.js');

test('Interlock does not take the upstream host development port by default', () => {
  assert.equal(DEFAULT_PORT, 8788);
});

function request(runtime, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: runtime.address,
      port: runtime.port,
      path: options.path || '/health',
      method: options.method || 'GET',
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('the health surface answers only on fixed loopback', async () => {
  const runtime = await startHealthServer({ port: 0 });
  try {
    assert.equal(runtime.address, LOOPBACK_HOST);
    assert.match(runtime.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);

    const result = await request(runtime);
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(result.body), {
      ok: true,
      service: 'interlock',
      phase: 'phase-0',
      scope: 'health-only',
    });

    const head = await request(runtime, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    const refused = await request(runtime, { method: 'POST' });
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.allow, 'GET, HEAD');

    const missing = await request(runtime, { path: '/room' });
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).error, 'not-found');
  } finally {
    await runtime.close();
  }
});

test('the server has no option that can widen its bind address', async () => {
  assert.throws(
    () => startHealthServer({ port: 0, host: '0.0.0.0' }),
    /accepts only port/,
  );
  assert.throws(() => startHealthServer({ port: -1 }), /port must be an integer/);
});
