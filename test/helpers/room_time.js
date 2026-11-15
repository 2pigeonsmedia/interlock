'use strict';

// The 0.4.0 CLI leads `history` and `work brief` with one room time line,
// read from GET /api/ai/room-time. Tests that pin a scripted sequence of
// requests answer that route as an older room does (404, and the line is left
// out) so their pins keep meaning what they were written to mean; tests
// against a real room split the line off and assert it.

function withoutRoomTime(dependencies = {}) {
  if (!dependencies || typeof dependencies.fetch !== 'function') return dependencies;
  const fetch = dependencies.fetch;
  return Object.assign({}, dependencies, {
    fetch: (url, init) => (String(url).endsWith('/api/ai/room-time')
      ? Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ ok: false, error: 'not-found' }) })
      : fetch(url, init)),
  });
}

/* { line, rest }: the leading room time line (or null) and the output after it. */
function splitRoomTime(stdout) {
  const match = /^(Room time: [^\n]*)\n/.exec(stdout);
  return match ? { line: match[1], rest: stdout.slice(match[0].length) } : { line: null, rest: stdout };
}

module.exports = { withoutRoomTime, splitRoomTime };
