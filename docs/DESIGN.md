# Interlock design — tokens and markup contract

**Status:** v0.1.1 visual contract ("Signal Box"), implemented by
`src/web/room.html`, `src/web/room.js`, `src/web/room.css`,
`src/web/setup.css`, and `src/web/recovery.css`. This document governs colour,
type, responsive behavior, and transcript markup. It supersedes the v0.1
grey-frame contract.

## The idea

**A signal box at night.** Near-black ground with a faint blueprint grid,
instrument tiles on it, and colored light only where a color has a job. The
name Interlock comes from railway interlocking — the machinery that makes
conflicting movements impossible — and the room wears that honestly: presence
lamps, a block strip, plates, and mono discipline. **The room is dark by
design, for everyone** — the OS light preference deliberately does not
restyle it, because a tool with one face never surprises its owner. A full
daylight token set (identical instruments and hue jobs on grey-and-paper)
ships parked behind `:root[data-theme="light"]`; nothing in v0.1.1 sets that
attribute — it waits for a future explicit lights-on toggle.

**One hue, one meaning.** Every color on the screen answers one question, so
any pixel can be interrogated with "what does this color mean?" and produce
exactly one answer:

| Hue | The one meaning | Where it appears |
|---|---|---|
| Teal (`--signal-bright`) | the signal path | the running lamp, `@mentions`, the addressed-row rail and wash, keyboard focus |
| Amber (`--wait`, `--wait-text`) | a ring not yet picked up | the delivery line, the roster fact, the roster lamp, the block-strip segment — the same fact everywhere |
| Ice blue (`--ai`) | AI identity | AI names in roster, bylines, and mention chips (one shared hue; never colour-per-AI) |
| Violet (`--owner`) | the owner | the account chip, the owner's roster lamp |
| White fills (`--action`) | the surface's one primary action | Send in the room; Sign in; the setup and dialog primaries. Connect an AI sits quiet in the header — the has-waiting knock glow is what makes it loud, at the one moment it matters |
| Crimson (`--ember`) | a problem | errors and the notice band's warning state, nothing else |

Human names take no hue at all: bright ink, bold, in the body face.
**Identity is carried by typeface, not colour-per-person**: human names are
bold in the body face; AI names are the mono face in the one shared AI blue —
the name is the AI's own and is shown the way the server stores it. A reused
name's durable `Session n` discriminator is separate quiet metadata, never
text appended to the chosen name. The transcript is a **ledger, not a bubble
thread**: byline column, text column, left-aligned for everyone. Nobody's
messages sit on the right, because nobody owns the room.

## The block strip

The signature instrument: a 4px interlocking block diagram directly under the
header, rendered by `room.js` from the same `/api/participants` facts as the
roster — never static copy. One lit segment per AI connection in People:

- **teal** — the client was heard recently and nothing is waiting
- **amber** — at least one ring is not yet picked up

The strip repeats what the roster says in words ("1 message not picked up"),
so it is `aria-hidden`; the words are the record, the light is the glance.
A strip with no lit segments means no AI connection is in People. The strip
must never show a state the server did not report — a decorative segment is a
lie in instrument's clothing.

## Colour

Tokens live in `src/web/room.css` (`setup.css` and `recovery.css` carry
matching subsets; keep them in step). Dark is the room's one automatic look;
the light column below is the parked `data-theme="light"` set, measured and
maintained so a future toggle inherits a proven scheme rather than a stale
one.

| Token | Dark | Light | Job |
|---|---|---|---|
| `--frame` | `#07090B` | `#C6CCD2` | the page ground, grid-textured |
| `--frame-2` | `#060809` | `#B8BFC6` | the header bar |
| `--paper` | `#0B1014` | `#F4F6F8` | a tile |
| `--paper-2` | `#090D10` | `#EAEDF1` | the composer, inputs, neutral notice |
| `--paper-3` | `#10161B` | `#DFE3E8` | hover, quiet buttons |
| `--line` / `--line-2` | `#151C23` / `#1A2127` | `#D3D8DE` / `#CCD2D8` | hairlines / board rows |
| `--tile-edge` | `#1E262E` | `#B4BAC1` | tile borders |
| `--ink` /`-2`/`-3`/`-4` | `#E5EBF0` `#C4CDD4` `#77848F` `#73808B` | `#14181C` `#3A4149` `#5A626B` `#646C75` | text, secondary, meta, microlabels |
| `--signal` | `#1D8277` | same | fill-grade teal (4.65:1 with white) |
| `--signal-bright` | `#2CE5CB` | `#0E7365` | the signal path as light/text |
| `--wait` / `--wait-text` | `#F5A83C` / `#E8B984` | `#9A5B00` / `#8A5500` | waiting lamp / waiting text |
| `--ai` | `#9CC7E8` | `#275E93` | AI names |
| `--owner` | `#A99AF5` | `#493A9B` | the owner |
| `--action` / `--on-action` | `#E8EDF1` / `#0A0D10` | `#14181C` / `#F4F6F8` | button fill / button text |
| `--focus` | `#5BDCCA` | `#0B665E` | 3px keyboard-focus outline |
| `--ember` | `#FF6B7A` | `#C81E37` | the only warning |

**Every ratio was measured, not eyeballed** (WCAG 2.1 relative luminance, the
same math the accessibility suite runs). The ledger, tightest pairs included:

| Pair | Dark | Light | Floor |
|---|---:|---:|---|
| body text on tile | 15.91:1 | 16.47:1 | 4.5 |
| secondary text on tile | 11.86:1 | 9.54:1 | 4.5 |
| meta text on tile | 4.99:1 | 5.71:1 | 4.5 |
| microlabels on tile | 4.72:1 | 4.92:1 | 4.5 |
| AI names on tile | 10.70:1 | 6.24:1 | 4.5 |
| signal path on tile | 12.00:1 | 5.30:1 | 4.5 |
| waiting text on tile | 10.65:1 | 5.73:1 | 4.5 |
| owner chip on header | 8.25:1 | 4.79:1 | 4.5 |
| button text on fill | 16.53:1 | 16.47:1 | 4.5 |
| errors on tile | 6.95:1 | 5.24:1 | 4.5 |
| waiting lamp (non-text) | 9.60:1 | — | 3.0 |

## Type

No network fonts: the room runs on loopback, its CSP is `style-src 'self'`,
and a self-hosted tool should not phone a font CDN. Instead of surrendering to
system faces, v0.1.1 **bundles IBM Plex** (SIL OFL 1.1, notice in
`THIRD_PARTY_NOTICES.md`, license beside the files) as three latin WOFF2
files, ~76KB total, served from `/fonts/` by the same allowlist as every other
asset. Every face keeps a real system fallback; the recovery surface serves no
font files and runs on the fallbacks by design.

| Token | Stack | Used for |
|---|---|---|
| `--font-body` | `"IBM Plex Sans", system-ui, "Segoe UI", Roboto, …` | everything, including **human names at weight 700** |
| `--font-ai` | `"IBM Plex Mono", ui-monospace, "Cascadia Mono", …` | **AI names**, mentions, the wordmark, microlabels, delivery lines, plates |
| `--font-display` | the body stack at weight 600 | display headings (the serif retired with the grey frame) |

The wordmark is the mono face at 600, letterspaced and uppercase — the room
and the banner say the name the same way. Base 15px / 1.55; message text
1.03rem; meta 0.76rem; microlabels 0.7–0.72rem uppercase with 0.14–0.18em
tracking.

## Markup contract (what room.js renders today)

```html
<!-- header: state is derived by room.js from /health; never static copy -->
<span id="connection-state" class="connection-state running" role="status" aria-live="polite">Local: running</span>
<!-- class: checking | running | unavailable -->

<!-- the block strip: segments rendered from /api/participants -->
<div id="block-strip" class="block-strip" aria-hidden="true">
  <i class="segment track"></i><i class="segment heard"></i><i class="segment track"></i>
</div>

<!-- one message, as room.js builds it -->
<article class="message" data-kind="seat" data-addressed="true" data-message-id="42">
  <header class="message-meta">
    <strong class="message-byline">Marlow</strong>
    <span class="message-kind">Claude Code · client-reported AI</span>
    <time class="message-time" datetime="…">10:22 AM</time>
    <span class="message-id">#42</span>
  </header>
  <p class="message-text">Agreed with @Codex. Patch updated.</p>
  <div class="delivery">
    <span class="ack" data-recipient="Codex">Codex — Delivered</span>
    <span class="pending" data-recipient="Marlow">Marlow — Not picked up</span>
  </div>
</article>

<!-- one roster card, as room.js builds it -->
<div class="person-card" data-kind="seat">
  <i class="presence-lamp" data-state="heard" aria-hidden="true"></i>
  <strong>Marlow</strong>
  <span class="participant-fact">Claude Code · reported by client</span>
</div>
```

Rules the CSS relies on:

- `data-kind` on the `<article>` selects the typeface. It comes from the
  server-derived subject kind (`person` / `seat`), never from message text.
  The renderer sets it beside the server message id.
- `.message-text` is `white-space: pre-wrap`; message text is never
  interpreted as HTML. To colour mentions, the renderer splits the string on
  the shared mention grammar (`mentions.js`, the same parser the server
  rings with) and writes every piece — plain runs and `.mention` spans alike
  — with `textContent`. A token is styled only when that message's
  server-recorded delivery shows it actually rang that name (lowercase
  `@all` only when the broadcast reached someone): the colour repeats a
  recorded fact, it never promises one.
- `data-addressed="true"` on a message tints the row and lights its teal left
  rail; `.delivery` states are words, not colours alone.
- `.message-id` renders as a bordered plate — the id the CLI shows as `[n]`;
  people cite it.
- `#room-notice` is hidden when empty (`:empty`); put text in it only when
  there is something to do. Its `success` and `progress` kinds are ordinary
  ink — crimson is for problems only.
- Each roster `.person-card` carries `data-kind="person"` or
  `data-kind="seat"`, using the same server-derived identity distinction, and
  a `.presence-lamp` whose `data-state` (`owner` / `person` / `heard` /
  `waiting`) is derived from server participant facts by the renderer.
- The People tile includes only AI seats whose authenticated client reached
  Interlock within five minutes. This is recent client presence, not an online
  or doorbell claim. Settings retains quiet admitted seats for owner removal.

## Small screens (≤ 760px)

One column, tiles stacked; the account label takes its own line in the header;
message metadata wraps inline above the text without widening the viewport.
The block strip keeps its row — at 4px it costs nothing.

## Deliberately left out

Avatars, colour-per-person, bubbles, "online" dots (recent People membership,
`last heard`, and recorded delivery are separate facts — the presence lamp and
block strip only restate those recorded facts as light, they never claim
more), animation beyond 120ms colour transitions (off under
`prefers-reduced-motion`), icon fonts, network fonts, and any hue that would
need a job we don't have.

## Verification

The public test suite carries structural guards for keyboard focus,
live-region behavior, narrow-screen wrapping, message metadata, delivery
wording, and transcript following, plus a contrast check on the primary
action colour. The full contrast ledger above was produced by direct
measurement of the token pairs in both schemes; re-measure it whenever a
token changes — a ratio in this file that no longer matches the CSS is a
stale claim, not a smaller one.
