'use strict';

// Test servers take ports below the ephemeral range, so an outgoing
// connection in a parallel test cannot take a reserved port first.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const test = require('node:test');

const { HIGH, LOW, reserveTestPort } = require('./helpers/reserve_port.js');

test('a reserved test port is free, in range, and below the ephemeral range', async () => {
  if (process.platform === 'linux') {
    const [ephemeralLow] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    assert.ok(HIGH <= ephemeralLow, `the range ends at ${HIGH}, below this machine's ephemeral ${ephemeralLow}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const port = await reserveTestPort();
    assert.ok(port >= LOW && port < HIGH, String(port));
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
    });
  }
});

test('every test file that reserves a port uses the shared helper', () => {
  const dir = __dirname;
  const own = fs.readdirSync(dir).filter(name => name.endsWith('.test.js'))
    .filter(name => /^function reservePort\(\)/m.test(fs.readFileSync(`${dir}/${name}`, 'utf8')));
  assert.ok(own.length > 0, 'ARRANGEMENT: test files reserve ports');
  for (const name of own) {
    const text = fs.readFileSync(`${dir}/${name}`, 'utf8');
    assert.match(text, /^function reservePort\(\) \{\n  return reserveTestPort\(\);\n\}$/m, `${name} reserves through the helper`);
  }
});
