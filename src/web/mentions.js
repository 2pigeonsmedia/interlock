'use strict';

// One mention parser is used by both the durable chat service and the browser
// preview so the UI cannot promise a different recipient set from the server.
(function exposeMentions(root) {
  const HANDLE = /(^|[^\p{L}\p{N}@_-])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[^\p{L}\p{N}@_-])/gu;

  // Code formatting never rings (the owner's ruling): text inside an inline
  // code span or a fenced code block is quoted, never a mention, by the
  // Markdown rules GitHub uses. `unquoted` blanks every quoted character with
  // a space, so the length and every offset stay those of the original text.
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

  function blank(chars, from, to) {
    for (let index = from; index < to; index += 1) if (chars[index] !== '\n') chars[index] = ' ';
  }

  // Inline spans, within one stretch of text that holds no fence. A span
  // opens on a run of N backticks and closes on the next run of exactly N;
  // with no such run the opener is plain text. A span ends at a blank line.
  function blankSpans(chars, from, to) {
    let index = from;
    while (index < to) {
      if (chars[index] === '\\') { index += 2; continue; }
      if (chars[index] !== '`') { index += 1; continue; }
      let openEnd = index;
      while (openEnd < to && chars[openEnd] === '`') openEnd += 1;
      const width = openEnd - index;
      let probe = openEnd;
      let close = -1;
      while (probe < to) {
        if (chars[probe] === '\n' && /^\n[ \t]*\n/.test(chars.slice(probe, probe + 64).join(''))) break;
        if (chars[probe] !== '`') { probe += 1; continue; }
        let runEnd = probe;
        while (runEnd < to && chars[runEnd] === '`') runEnd += 1;
        if (runEnd - probe === width) { close = runEnd; break; }
        probe = runEnd;
      }
      if (close === -1) { index = openEnd; continue; }
      blank(chars, index, close);
      index = close;
    }
  }

  function unquoted(text) {
    if (text.indexOf('`') === -1 && text.indexOf('~~~') === -1) return text;
    const chars = text.split('');
    const lines = [];
    let start = 0;
    for (let index = 0; index <= chars.length; index += 1) {
      if (index === chars.length || chars[index] === '\n') {
        lines.push({ start, end: index, text: chars.slice(start, index).join('') });
        start = index + 1;
      }
    }
    let stretch = 0;
    let fence = null;
    for (const line of lines) {
      if (fence === null) {
        const open = FENCE_OPEN.exec(line.text);
        // A backtick fence's info string may not hold a backtick.
        if (open && !(open[1][0] === '`' && line.text.slice(open[0].length).includes('`'))) {
          blankSpans(chars, stretch, line.start);
          fence = { mark: open[1][0], width: open[1].length, start: line.start };
        }
        continue;
      }
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.text);
      if (close && close[1][0] === fence.mark && close[1].length >= fence.width) {
        blank(chars, fence.start, line.end);
        fence = null;
        stretch = line.end;
      }
    }
    // An unclosed fence quotes to the end of the message.
    if (fence !== null) blank(chars, fence.start, chars.length);
    else blankSpans(chars, stretch, chars.length);
    return chars.join('');
  }

  function resolve(text, names) {
    if (typeof text !== 'string' || !Array.isArray(names)) return Object.freeze([]);
    const known = names.filter(name => typeof name === 'string' && name.length > 0);
    const byFoldedName = new Map(known.map(name => [name.toLowerCase(), name]));
    const selected = new Set();
    for (const match of unquoted(text).matchAll(HANDLE)) {
      const token = match[2];
      if (token === 'all') {
        for (const name of known) selected.add(name);
        continue;
      }
      const name = byFoldedName.get(token.toLowerCase());
      if (name !== undefined) selected.add(name);
    }
    return Object.freeze(known.filter(name => selected.has(name)));
  }

  // The names a text @mentions one by one, without @all's expansion. An
  // @Name reaches its AI whether or not it is present (the ring waits for
  // its next poll); @all reaches the present ones only.
  function named(text, names) {
    if (typeof text !== 'string' || !Array.isArray(names)) return Object.freeze([]);
    const known = names.filter(name => typeof name === 'string' && name.length > 0);
    const byFoldedName = new Map(known.map(name => [name.toLowerCase(), name]));
    const selected = new Set();
    for (const match of unquoted(text).matchAll(HANDLE)) {
      if (match[2] === 'all') continue;
      const name = byFoldedName.get(match[2].toLowerCase());
      if (name !== undefined) selected.add(name);
    }
    return Object.freeze(known.filter(name => selected.has(name)));
  }

  function tokens(text) {
    if (typeof text !== 'string') return Object.freeze([]);
    const found = [];
    for (const match of unquoted(text).matchAll(HANDLE)) {
      const start = match.index + match[1].length;
      found.push(Object.freeze({
        start, end: start + match[2].length + 1, handle: match[2],
      }));
    }
    return Object.freeze(found);
  }

  // The composer's line from the room's answer to "whom would this ring?"
  // (POST /api/ring-preview). Anything but a list of names means the room
  // did not answer, and the line says so rather than guessing.
  function previewWords(recipients) {
    // An ask of a person needs what a yes means before the room will take it.
    if (recipients === 'means-required') return 'Fill in what a yes means to preview who this rings.';
    if (!Array.isArray(recipients) || !recipients.every(name => typeof name === 'string' && name.length > 0)) {
      return "Can't preview who this rings.";
    }
    return recipients.length === 0 ? 'No AI will be rung.' : `Will ring: ${recipients.join(', ')}.`;
  }

  const contract = Object.freeze({ resolve, named, tokens, previewWords });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockMentions', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
