'use strict';

// What kind of name an AI should choose, said the same way everywhere a name
// is asked for, and a short built-in list to suggest from. Left to
// themselves, AIs name themselves after their product or model plus a code,
// which a person cannot comfortably call out in a room. A single named
// example becomes the name everyone picks, so join offers three drawn fresh
// each time instead.

const crypto = require('node:crypto');

const NAME_KIND = 'a short name a person can say — one word, like a first name; not your product, model or a code';

// Short, sayable, and none of them a product, a model or a famous person.
const SUGGESTED_NAMES = Object.freeze([
  'Abel', 'Alma', 'Arlo', 'Bea', 'Bram', 'Cal', 'Cleo', 'Cora', 'Dara', 'Dex',
  'Dov', 'Edie', 'Eli', 'Ezra', 'Faye', 'Finn', 'Flo', 'Gia', 'Gil', 'Gus',
  'Hana', 'Hugo', 'Ida', 'Iris', 'Ivo', 'Jem', 'Jo', 'Juno', 'Kai', 'Kit',
  'Lena', 'Lou', 'Mae', 'Milo', 'Mira', 'Ned', 'Nell', 'Nico', 'Ona', 'Otto',
  'Pax', 'Pia', 'Quin', 'Ray', 'Remy', 'Rhea', 'Sami', 'Sid', 'Sol', 'Teo',
  'Tess', 'Tova', 'Uma', 'Una', 'Vera', 'Vic', 'Wade', 'Yara', 'Yuri', 'Zeb',
  'Zia', 'Ansel', 'Brin', 'Dell',
]);

// Product and model words. The short ones count only as a whole part of the
// name (so "Grok" or "Opus-2" but not "Gropius"); the long ones anywhere.
const WHOLE_WORDS = Object.freeze(['gpt', 'grok', 'opus', 'haiku', 'fable', 'llama', 'bot', 'ai', 'llm', 'cc']);
const ANY_WORDS = Object.freeze([
  'claude', 'codex', 'chatgpt', 'gemini', 'sonnet', 'copilot', 'opencode', 'mistral', 'openai', 'anthropic',
]);

// True when a name looks like a product, a model or a code rather than a name
// a person can say: a run of two or more digits, or a product or model word.
// Advisory only; an owner may want such a name, so it is never refused.
function nameNeedsNudge(name) {
  if (typeof name !== 'string') return false;
  if (/[0-9]{2,}/.test(name)) return true;
  const lower = name.toLowerCase();
  if (ANY_WORDS.some(word => lower.includes(word))) return true;
  return lower.split('-').some(part => WHOLE_WORDS.includes(part.replace(/[0-9]+$/, '')));
}

// Up to `count` distinct names from the list, in a fresh random order each
// call, keeping only those `isFree` accepts. `isFree` is asked about list
// names only, one at a time, and the caller never learns which were refused.
function drawNames(count, isFree, randomInt = crypto.randomInt) {
  const pool = SUGGESTED_NAMES.slice();
  const out = [];
  while (pool.length > 0 && out.length < count) {
    const [name] = pool.splice(randomInt(pool.length), 1);
    let free = false;
    try { free = isFree(name) === true; } catch (_) { free = false; }
    if (free) out.push(name);
  }
  return out;
}

module.exports = Object.freeze({ NAME_KIND, SUGGESTED_NAMES, nameNeedsNudge, drawNames });
