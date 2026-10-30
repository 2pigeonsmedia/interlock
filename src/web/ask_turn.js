'use strict';

// Whose turn an ask is, derived from facts the room stored, never typed. One
// function for the server and the page, so every place an ask appears says
// the same thing.
//
//   waiting    open; `waiting_on` is the party who did not write the latest
//              exchange (a bystander's reply never moves the turn)
//   agreed     its addressee said yes to the current scope; `acting` is the
//              party who is on it: the asker when a person was asked (a
//              permission: "a yes means I do X"), the addressee when an AI was
//              asked (a request)
//   declined   its addressee said no
//   done       the party who was on it posted its done receipt
//   withdrawn  the asker withdrew it
(function exposeAskTurn(root) {
  /* `ask`: { state: 'open'|'answered'|'withdrawn', done: boolean,
   *          asker: name, addressee: name, addressee_kind: 'person'|'seat',
   *          last_choice: 'yes'|'no'|null, latest_party: 'asker'|'addressee'|null } */
  function actingParty(ask) {
    return ask.addressee_kind === 'person' ? 'asker' : 'addressee';
  }

  function turnOf(ask) {
    if (ask.state === 'withdrawn') return Object.freeze({ phase: 'withdrawn', waiting_on: null, acting: null });
    if (ask.done) return Object.freeze({ phase: 'done', waiting_on: null, acting: null });
    if (ask.state === 'answered') {
      return ask.last_choice === 'no'
        ? Object.freeze({ phase: 'declined', waiting_on: null, acting: null })
        : Object.freeze({
          phase: 'agreed', waiting_on: null,
          acting: actingParty(ask) === 'asker' ? ask.asker : ask.addressee,
        });
    }
    return Object.freeze({
      phase: 'waiting',
      waiting_on: ask.latest_party === 'addressee' ? ask.asker : ask.addressee,
      acting: null,
    });
  }

  // The turn in words, from one viewer's chair, so the chip, the card and the
  // CLI all say the same thing. `viewer` may be null (a bystander's view).
  function turnWords(turn, viewer) {
    if (!turn) return '';
    if (turn.phase === 'waiting') return turn.waiting_on === viewer ? 'your turn' : 'waiting on ' + turn.waiting_on;
    if (turn.phase === 'agreed') return turn.acting === viewer ? 'agreed → you are on it' : 'agreed → ' + turn.acting + ' is on it';
    return turn.phase;
  }

  // Whether the ask waits on this viewer: their turn to answer or reply, or
  // agreed and theirs to carry out until the done receipt.
  function waitsOn(turn, viewer) {
    if (!turn || !viewer) return false;
    return (turn.phase === 'waiting' && turn.waiting_on === viewer) || (turn.phase === 'agreed' && turn.acting === viewer);
  }

  const contract = Object.freeze({ turnOf, actingParty, turnWords, waitsOn });
  if (typeof module === 'object' && module && module.exports) module.exports = contract;
  else Object.defineProperty(root, 'InterlockAskTurn', {
    configurable: false, enumerable: false, writable: false, value: contract,
  });
}(globalThis));
