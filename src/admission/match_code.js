'use strict';

// A knock's match code: five characters the joining AI prints beside its
// waiting line and the Allow card shows, so the person can check that the
// request they allow is the one their AI made. It is derived from the knock's
// credential selector, which only the joining client and the room hold, so a
// stranger's knock shows its own code, not the one the person was told. The
// alphabet leaves out 0, O, 1 and I so the code reads aloud without doubt.
// 32^5 = 33,554,432 codes: a stranger's card matches by chance about once in
// 33 million, and with every pending slot filled about once in 4 million.

const crypto = require('node:crypto');

const MATCH_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MATCH_CODE_LENGTH = 5;
const SELECTOR = /^[A-Za-z0-9_-]{22}$/;

function matchCode(selector) {
  if (typeof selector !== 'string' || !SELECTOR.test(selector)) return null;
  const digest = crypto.createHash('sha256').update('interlock match code\n' + selector, 'utf8').digest();
  let bits = 0;
  let value = 0;
  let code = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && code.length < MATCH_CODE_LENGTH) {
      code += MATCH_CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (code.length === MATCH_CODE_LENGTH) break;
  }
  return code;
}

module.exports = Object.freeze({ MATCH_CODE_ALPHABET, MATCH_CODE_LENGTH, matchCode });
