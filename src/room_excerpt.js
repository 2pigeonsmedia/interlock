'use strict';

// A record's title or answer, quoted in a room line. The room line is a
// courtesy; the record holds the whole text. When the quote is cut, it is
// cut at a word and says where the whole text is, so a seat can always
// read its assignment.

const ROOM_EXCERPT_MAX = 200;
// One unbroken token longer than this share of the limit is cut where it
// stands, so a long URL or path still leaves a useful quote.
const WORD_BACKOFF_SHARE = 0.5;

function roomExcerpt(text, id, max = ROOM_EXCERPT_MAX) {
  const lines = String(text).split('\n');
  const first = lines[0];
  const moreLines = lines.slice(1).some(rest => rest.trim() !== '');
  if (first.length <= max && !moreLines) return first;
  let kept = first;
  if (first.length > max) {
    kept = first.slice(0, max);
    if (!/\s/.test(first[max])) {
      const space = kept.search(/\s\S*$/);
      if (space >= max * WORD_BACKOFF_SHARE) kept = kept.slice(0, space);
    }
  }
  kept = kept.replace(/[\s,;:.–—-]+$/, '');
  return typeof id === 'string' && id !== ''
    ? `${kept}… (full: \`interlock work get ${id}\`)`
    : `${kept}…`;
}

module.exports = { roomExcerpt, ROOM_EXCERPT_MAX };
