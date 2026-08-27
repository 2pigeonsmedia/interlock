# identity

Household identity for a small number of real people: **sign in, or not in.**

One door. One authorization path. **No host names inside.**

Everything a host is meant to touch arrives through `index.js`. This Interlock
copy adds a fixed `room:main` AI-seat composition; it still carries no host name
or deployment URL.

## Requirements

Node **>= 20**. One dependency, pinned exactly: `@simplewebauthn/server@13.3.2`.

## Install and prove it works — before you trust it with a password

```sh
npm install          # from THIS manifest, not a host's
npm test             # the module's own corpus, on its own runner
```

`npm test` runs `test/run.js`, which resolves its corpus, **asserts the corpus is
non-empty, and prints it before running anything.** A glob that matches nothing
would otherwise exit 0 — a silent no-op wearing a tick. The Interlock root
manifest also names both the root and identity corpora explicitly.

## Use

```js
const identity = require('identity');

const house = identity.create({
  stateDir:       '/absolute/path/you/own',   // REQUIRED. Never guessed.
  tenant:         'my-house',                 // REQUIRED. YOU name your house (#193).
  cookieName:     identity.COOKIE_NAME,       // REQUIRED. The module owns the name.
  originClass:    'local',                    // REQUIRED. 'local' | 'tunnel'.
  hostLabel:      'my-host',                  // REQUIRED. Names the adopting host.
  rpId:           'localhost',                // REQUIRED. WebAuthn relying-party id.
  rpName:         'My House',                 // optional passkey-prompt display label
  origin:         'https://my.house',         // REQUIRED. Your exact service origin.
  liveOrigin:     'https://my.house',         // the live pin, for a live host
  challengeOrigin: 'http://localhost',        // REQUIRED in practice — see Limits (#398)
  webauthn:       false,                      // opt in to the ceremony surface
});
```

**This exact configuration constructs and reports healthy.** It is executed as
written by the module's own adoption gate, so if it stops being true the gate
fails rather than the documentation quietly rotting.

For a real loopback product, use exact `http://localhost[:port]` with
`contained: true`, `rpId: 'localhost'`, and `webauthn: true`. This keeps
production throttle and timing behavior. `harness: true` remains the isolated
test construction; combining it with `contained` refuses.

**Every value above is a plain configuration value.** There is no argument
anywhere in this API that is an object the module will trust to make a security
decision — see the refusal note below.

### What `create()` returns

| field | what it is |
|---|---|
| `service` | the administration service: invites, resets, roles, memberships, the two revoke doors, `setPassLifetime`, `health` |
| `login` | the sign-in service. `login.login({name, password, source, request_origin, sec_fetch_site, now})` |
| `sessions` | the session store the module built |
| `authenticators` | the WebAuthn ceremony service the module built, or `null` unless `webauthn: true` |
| `challenges` | the challenge store the module built |
| `grants` | the capability-administration surface |
| `authorizeWrite(meta, capability, resource)` | **the one authorization route.** Session first, then `can()` on the subject that session named |
| `authorizeRead(meta, capability, resource)` | read-side browser authorization |
| `authorizeBearer(meta, capability, resource)` | existing tool-only Bearer authorization |
| `authorizeSeatBearer(meta, capability, resource)` | AI-seat-only Bearer authorization, including stored product provenance |
| `firstOwner` | public `begin` / `redeem` / `complete` / `status` bootstrap ceremony; passkey-backed |
| `allowAiAdmission(meta, body)` | fresh-owner-step-up, idempotent binding of a client-held selector/digest and AI-chosen name to one bounded room seat; accepts no raw bearer |
| `revokeParticipant(meta, {name})` | fresh-owner-step-up removal of one non-owner person or AI seat by immutable public name; never removes an administrator |
| `signOutOtherSessions(meta)` | CSRF-protected self-service invalidation of every other browser session while preserving the caller |
| `confirmTranscriptClear(meta)` | consumes one fresh owner step-up for the host's separately verified archive-before-clear operation |
| `resolveSession(meta)` | read-side session resolution |
| `cookieName`, `clearCookie` | the module's own cookie strings |
| `tenant`, `originClass`, `stateDir`, `hostLabel` | your configuration, echoed back |

The package root also exposes pure `newAiCredential()`. The portable CLI calls
it before knocking and durably stores the returned token itself; the admission
request sends only the returned selector and digest. The server never receives
or re-mints that raw bearer.

`meta` is **trusted metadata the host extracts from the transport** — the socket,
named headers and the server clock. Never from a request body:

```js
const meta = {
  cookie_header:  req.headers.cookie,
  request_origin: req.headers.origin,          // absent stays ABSENT
  sec_fetch_site: req.headers['sec-fetch-site'],
  csrf_token:     req.headers['x-csrf-token'],
  now:            Date.now(),
};
const decision = house.authorizeWrite(meta, 'write', 'room:main');
```

**Do not substitute a safe-looking default for an absent `Origin` or
`Sec-Fetch-Site`.** That reads as tidiness and is a fail-open: the module's
exact-origin and same-site checks would be comparing your guesses against
themselves. Absent stays absent, and the module refuses.

### Configuration REFUSES rather than defaults

| config | why there is no default |
|---|---|
| `stateDir` | the only defaults available are guesses at *your* directories — how credential material became committable in a host's source tree (`#268`) |
| `tenant` | the name of YOUR house. The module carries none — a default here would be one particular house's name, which is the defect `#193` removed |
| `cookieName` | the module owns one cookie name; a host carrying a second copy is a second definition of one rule |
| `originClass` | it describes how **this process** is reached; the only available default is the unconditional `'local'` a real defect once shipped |
| `hostLabel` | the module carries no host identity of its own |
| `rpId` | the relying-party id is a property of your deployment |

### `authenticatorService` is REFUSED, deliberately

`create()` **throws** if you pass one. A caller-supplied verifier is not
configuration — it *is* the security check, and accepting one would let a host
hand in an object that answers `ok: true`. The module builds its own.

## What is deliberately NOT exported

**The superseded copied AI claim and serial-handle route.** Neither
`issueAiClaim` nor `redeemAiClaim` is present on `create()`, and
`service.issueAiClaim` is also absent. Package exports expose no internal
`ai_seats.js` path, so its legacy `nextHandle` implementation cannot be composed
by a host. Knock-and-Allow uses `allowAiAdmission` only.

**`installTool`.** The implementation is still in `administration.js`; the public
door is shut. It needs module-owned tests and a ruling on `#347`, which says the
path is non-atomic — a partial failure can squat the tool name and leave a live
tool credential with no identity. Un-exporting stops new callers; **it does not
repair that.** Fixing the door is not fixing the room.

## Honest limits

Read these before you rely on anything above.

- **There is one state-directory source.** `create({stateDir})` binds it through
  `configureStateDir()`. Environment variables and adjacent folders are ignored;
  a direct internal call without explicit configuration refuses.
- **The live-origin pin is not exercised by a loopback proof.** A contained
  copy takes the `contained` branch and never consults it.
- ⚠ **`#398` — non-loopback production WebAuthn is a canonical HTTPS pair.**
  `authenticators.js` and `challenges.createStore` accept the localhost test
  harness, the production-behavior contained localhost pair, or
  `webauthn: true` with a canonical HTTPS `origin` whose hostname equals `rpId` exactly —
  no wildcards or suffix match. The adopting host pins which pair it passes
  (`#384`: this folder does not bake a house URL). Hosts that leave
  `webauthn: false` may still pass a loopback
  `challengeOrigin` beside an HTTPS service origin.
  *Earlier this file said production HTTPS could not opt in at all. That leftover
  is what #398 retired — not as a wildcard Origin, and not as a baked host URL.*
- **One tenant PER PROCESS.** The repository is told its house at `initialize({ tenant })` and validates every row against it. Two houses in one process is refused, not silently merged.
- **WebAuthn binds `localhost` (contained or harness) or a host-pinned canonical HTTPS `rpId`.**
  `rpId` is required configuration. Wildcards and hostname/origin mismatches refuse.
- **First-owner completion is passkey-backed.** `firstOwner` is public on the
  `create()` instance only when `webauthn: true` successfully constructs the
  module-owned verifier. Without it, the ceremony refuses as unavailable.
- **The AI seam is intentionally one-room.** Allow fixes read/write to
  `room:main`; the client supplies its chosen name, bounded reported product,
  provenance, and candidate selector/digest, but cannot supply a principal,
  authority, resource, lifetime, kind, generation, server clock, or raw bearer.
- **The module corpus is a floor, not a platform journey.** It proves the public
  compositions and transaction boundaries. Native Windows/macOS/Ubuntu passkey
  journeys remain a separate release gate.

## Provenance

The unmodified baseline came from the private upstream source commit
`0df0640d4a32840f247c83d9bf9a97a988b7db5e`, tree
`9bfc37f7f8c80ca93e92e851bd6dc8eeaaf0ca88`. Interlock's public first-owner,
atomic AI-seat, seat-Bearer, and explicit-state seams intentionally diverge
from it. See `../docs/IDENTITY_PROVENANCE.md`.
