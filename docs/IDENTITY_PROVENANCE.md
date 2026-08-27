# Identity module provenance

Interlock adopted only the `identity/` directory from the private upstream source
repository. No upstream host, room, ticket, board, MCP, state, or Git-history file
was copied.

## Pinned baseline

- Source commit: `0df0640d4a32840f247c83d9bf9a97a988b7db5e`
- Commit date: `2026-08-20T21:03:12-04:00`
- Commit subject: `Land 8: tools use Bearer; leftover room key stays until funeral`
- `identity/` tree: `9bfc37f7f8c80ca93e92e851bd6dc8eeaaf0ca88`
- Declared external dependency: `@simplewebauthn/server` `13.3.2`
- Adopted files: 45 regular files; no symlinks

At extraction, the pinned tree hash matched the `identity/` tree on the upstream
source's live `master`, and `git log -1 master -- identity` resolved to the pinned commit.
Later upstream commits had not changed the lock.

## Divergence rule

The source pin identifies the unmodified baseline. Interlock's three public
seams and removal of the legacy adjacent-state fallback intentionally diverge
from that baseline and are reviewed in this repository.

Interlock does not automatically synchronize future upstream identity changes
before v0.2. If the upstream source finds an identity defect, it files a
pointer; the owner or the Interlock maintainer decides explicitly whether to
re-pin.

## Interlock divergence

The initial Phase 0 Interlock-specific change set added:

- first-owner `begin` / `redeem` / `complete` / `status` on the public
  `create()` instance, using the module-built passkey verifier;
- owner-step-up issuance of a 15-minute AI claim whose factual product label is
  integrity-bound into the one-time secret and never stored in plaintext;
- one atomic transaction for claim consumption, installation-unique handle,
  seat, bearer credential, `room:main` read/write grants, and audit intent;
- a seat-only public Bearer authorization composition beside the unchanged
  tool-only composition; and
- one explicit state-directory source, with environment and adjacent-directory
  fallbacks removed.

The later owner ruling replaced the copied-claim/serial-name workflow before it
became a host route. The current public package:

- exposes pure `newAiCredential()` so the CLI creates and holds the bearer
  before knocking;
- exposes fresh-L2 `allowAiAdmission()` to bind only selector/digest material,
  an AI-chosen live-or-pending unique name, and bounded product provenance in one
  idempotent transaction;
- removes `issueAiClaim` / `redeemAiClaim` from the `create()` instance and
  removes `issueAiClaim` from its raw administration service; and
- keeps the legacy serial generator behind the package export boundary, where
  a host cannot compose it.

The 2026-08-23 AI-seat lifetime ruling adds one further intentional divergence:
`policy.js`, the repository standing validator, and the audit mutation validator
all use a 14-day default and 90-day maximum for the fixed-at-admission seat pass.
The separate 24-hour human invitation and 15-minute pending-admission bounds are
unchanged. Module tests prove the default on a real AI enrollment and carry one
90-day policy intent through policy commit, repository validation, and durable
audit validation.

The same ruling replaces historical AI-name reservation without weakening the
person-name rule. `subjects.aiNameStatus()` and `createAiSeatInDraft()` refuse a
folded name held by a live seat or ever held by a person, but return an informed
previously-used result after every seat under that name has expired or been
revoked. The repository independently refuses overlapping admitted AI-seat
lifetimes for one folded name and retains historical person-name exclusion, so
a direct transaction cannot bypass either rule. Pending-knock uniqueness remains
the host admission service's separate responsibility; its schema-2 durable row
carries the previously-used marker and last-ended timestamp across restart.
Every new Interlock AI seat also stores its immutable per-name
`session_ordinal`; the repository requires the admission-ordered sequence and
refuses missing, forged, or skipped later ordinals. The public
`aiSessionDiscriminator()` seam reveals no label for one generation and the
stable ordinal once another generation exists. The chat projection resolves
that fact from each message's private immutable subject id at read and export
time, so earlier bylines become `session 1` without rewriting transcript rows.
Transcript archive schema 2 carries the discriminator while the verifier keeps
schema-1 archives readable and recoverable.

The first-owner browser proof then adds a contained localhost WebAuthn
construction that keeps test-harness mode off, publishes only boolean recovery
state, refuses a second bootstrap mint while an owner candidate is active, and
uses the module-specific `__Host-identity-session` cookie so an upstream host and
Interlock cannot overwrite one another's browser sessions.
The audit writer still fsyncs every mutation file; on native Windows it
explicitly reports directory-entry fsync as unsupported instead of treating the
platform's `EPERM` as an unhealthy audit store. Other directory-sync failures
remain fatal.

The module-owned seam control injects a failure after client-held credential
binding mutates the private draft and proves that seat, credential, grants, and
enrollment audit all remain unchanged. It also proves fresh L2, exact-retry
idempotency, live-seat name refusal, ended-seat reuse markers, historical
person-name exclusion, direct overlap refusal, raw-bearer absence, and
server-derived product/name attribution. The adopted identity corpus currently
contains 82 test cases; every identity test file passes when run in a fresh
isolated Node process.
