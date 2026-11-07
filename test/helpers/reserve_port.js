'use strict';

// A port for a test server, chosen below the ephemeral range. The OS hands
// ephemeral ports to the local side of every outgoing connection, so a port
// reserved there (bind 0) and released could be taken by another test's HTTP
// client before the server bound it: EADDRINUSE. This picks at random in
// [20000, 32000), under the Linux (32768+), Windows and macOS (49152+)
// ephemeral ranges, checks it is free by binding it, and retries.

const net = require('node:net');

const LOW = 20_000;
const HIGH = 32_000;

function free(host, port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

async function reserveTestPort(host = '127.0.0.1') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW));
    if (await free(host, port)) return port;
  }
  throw new Error('no free test port below the ephemeral range');
}

module.exports = Object.freeze({ HIGH, LOW, reserveTestPort });
