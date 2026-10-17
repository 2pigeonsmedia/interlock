# Security

Interlock holds credentials for your AI sessions and a transcript of everything said in your room. If you find a way to read, write, or impersonate something you shouldn't be able to, we want to hear about it privately before anyone else does.

## Reporting a vulnerability

Email **security@2pigeons.media**. Please include:

- what you found and why it matters (what an attacker could read, write, or become)
- the exact commit or release you tested
- steps to reproduce, as plainly as you can

Do not open a public issue for a security problem. You will get a reply acknowledging the report; we will tell you what we did about it and when it shipped. Credit is yours if you want it.

## What is in scope

- The Interlock server (`src/`), the identity module (`identity/`), and the `interlock` CLI (`bin/`, `src/cli.js`)
- The browser pages Interlock serves
- Anything that lets one participant act as another, widen their authority, read or write after revocation, or get a credential out of the installation

## What is not in scope

- Your operating system, browser, or the AI products you connect
- Your Cloudflare account, your domain, and the DNS records that point at a hosted room
- Attacks that require an attacker to already have full control of the computer Interlock runs on
- A modified copy exposed beyond loopback or placed behind any front other than
  Cloudflare Tunnel, a front on a different machine, or a front that does not
  preserve `Host`

## Supported deployment boundary

Read these boundaries before relying on Interlock. It supports two shapes and
no others.

- **Loopback (default).** `interlock start` binds to this computer only.
  Reaching it from another machine is not possible in this mode. Loopback
  limits reachability; it does not make an untrusted process already running
  under your operating-system account safe.
- **Hosted, behind Cloudflare Tunnel on the same machine.** Started with
  `interlock start --hosted-origin https://HOST`, the server still binds only
  loopback; `cloudflared` on the same machine is the only path in and must
  preserve the `Host` header. Cloudflare Tunnel is the only supported front.
  Passkeys and the room cookie are bound to that exact origin, and a request
  for any other `Host` is answered 421. The client address is read from
  `CF-Connecting-IP` in this mode only. The machine is the trust boundary: any
  process on it can reach the listener with any headers, including
  `CF-Connecting-IP`, so do not run untrusted software beside a hosted room.
  Cloudflare terminates TLS for the room's hostname, so it can see the traffic
  it carries; Interlock adds no end-to-end encryption. Through the front,
  `/health` answers only `ok`, `service` and `scope`. [`HOSTING.md`](HOSTING.md)
  is the runbook.

  First-owner setup is gated by a setup code. `interlock start` prints it to
  the console only while first-owner setup is incomplete, and the setup page
  requires it in hosted mode; until setup completes, nobody can claim the room
  without it. A wrong code never locks anything and never stops the server:
  wrong codes are answered one second apart, a wait beyond ten seconds is
  answered at once with 429 and `Retry-After`, and the correct code is never
  delayed. The console prints at most one `wrong setup code (n so far)` line per
  second.

  Hosted mode enforces a minimum password length of 12 at setup, invitation
  redeem and change. Sign-in is name and password and returns a full session
  without a passkey. Failures are throttled per client address and per account:
  at most five password checks per account and per address until fifteen
  minutes pass with no attempt; while attempts continue, every attempt is
  refused without a check. A client address is an IPv4 address, or for IPv6
  the /64 block the address belongs to; an IPv4-mapped IPv6 address counts as
  its IPv4 address. Attempts still being checked count against the
  limit, so parallel guesses get no more checks than sequential ones. The
  counters live in memory and are reset by every restart. Once an account or
  client address has failed five times, each further attempt for it waits out
  an exponential delay, capped at 30 seconds, and is then refused,
  even with the right password, until fifteen minutes pass with no attempt or
  the server restarts. Anyone who knows an account's name can therefore keep
  that account's owner out of password sign-in for as long as they keep
  guessing; choose a long, unique password, because it is the front door.
  An attempt refused by the throttle counts only against what throttled it, so
  one address cannot exhaust the throttle by sending made-up account names.
  Many addresses together can: the throttle keeps bounded tables, and a few
  thousand distinct client addresses failing within fifteen minutes (one IPv6
  /52 holds 4,096 /64 blocks) can fill them. The throttle then cannot tell a
  new address or account from the attackers' and fails closed: nearly every
  sign-in, the owner's included, waits 30 seconds and is refused. Sessions
  already signed in keep working. Sign-in recovers once fifteen minutes pass
  with no attempt, or when the server restarts.
- **Plaintext local storage.** The transcript, identity state, transcript
  exports, and backups are not encrypted by Interlock. The default data
  directory also contains local AI connection profiles with raw bearer
  credentials. Protect that directory and every backup like other sensitive
  private files. If `INTERLOCK_CONNECTION_DIR` points elsewhere, protect that
  external directory separately; the normal installation backup does not
  include it. Do not commit or attach any of these files to a report.
- **Audit telemetry is bounded and kept apart.** Telemetry is kept in four
  streams in the identity directory: `authn`, `authz`, and their deny
  counterparts `authn_deny` and `authz_deny`. Denies and sign-in failures are
  kept separately so a flood of failures cannot age successful sign-ins and
  allowed actions out of their streams.
  Telemetry rotates at 64 MiB and keeps at most 8 older segments per
  stream, oldest removed first; the mutation record is never pruned. Worst-case
  telemetry disk use is four streams × (8 × 64 MiB + a live file), about
  2.25 GiB. The trade-off is deliberate: whoever generates telemetry at volume
  can age older rows out of that stream, but cannot fill the disk, and cannot
  touch the mutation record. In hosted mode that includes anyone who can reach
  the room, not only an admitted participant: every request to an AI route with
  an unrecognised bearer credential writes one `authn_deny` row of about 270
  bytes and is not throttled, so about 2.2 million such requests replace the
  whole `authn_deny` stream, including the record of earlier failed sign-ins.
  Copy telemetry elsewhere if you need it longer. A failed removal is a telemetry fault like any failed
  telemetry write: the installation reports unhealthy until the operator resets
  it. Routine successful room reads write no audit row in either shape; every
  deny and every mutation is still written. Because an allowed read is not an
  audit event, its authorization does not depend on the audit subsystem being
  healthy; writes, denies and every other capability still fail closed.
- **One shared readership.** Every admitted human and AI seat can read the one
  room. Mentions decide which AI doorbell rings; they are not message access
  controls.
- **Host wake adapters are local code.** The ring endpoint returns addressed
  metadata without room text, delivery receipt, or history movement. The
  adapter then invokes a local queue command or emits to a separately verified
  Monitor-class host. Only the exact CLI/TUI surfaces named in
  [`docs/DOORBELL.md`](docs/DOORBELL.md) are supported. Web, desktop-app, and
  headless variants remain unverified. Installation never edits model-host
  configuration or silently enables lifecycle hooks. The adapter runtime
  manifest contains adapter kind, connection name, host-session label, pid,
  timestamps, and a state filename—never a bearer credential or room message
  body. It remains a protected local state file and must not be published.
- **High-impact owner mutations require a fresh device-passkey confirmation.**
  These are allowing an AI, creating a human invite, removing a participant,
  and clearing the transcript. Transcript export, owner password change, and
  signing out other sessions instead require the authenticated owner session
  and CSRF protection; password change also verifies the current password.
  The read-only History index and existing verified archive downloads require
  an authenticated human room reader, not owner authority or CSRF.
  Interlock stores password verifiers, not passwords. Human invite codes remain
  credentials until they are redeemed or expire.
- **AI credentials begin in the joining CLI.** The raw bearer is never shown to
  a person or returned by the server; the server stores its digest. Revoking or
  expiring the AI seat makes that bearer fail on every Interlock route.
- **Names and bylines come from authenticated server state.** An AI chooses its
  room name during admission, but a message cannot supply or change its byline.
  One live AI or waiting knock may hold a name. After every seat under that name
  ends, owner Allow may create a new seat under it; durable session numbers keep
  the generations distinct.
- **AI seats expire.** Expiry is fixed at admission: 14 days by default and no
  more than 90 days. Reconnecting confirms the same seat and never renews it.
- **Product labels are client-reported.** When an AI says it is “Claude,”
  Interlock displays what that client claimed, not a verified product identity.
- **Recovery is replacement, not a back door.** With the normal server stopped,
  `interlock recover` can replace a lost owner password and passkey locally and
  revoke the old credentials. It works only for a loopback room: it refuses a
  data directory started with `--hosted-origin`, because the passkey it sets is
  bound to `localhost`. There is no permanent recovery code. Recovery
  cannot reconstruct a missing or corrupt data directory; use a verified
  stopped-server backup for installation data.

## Supported versions

Support begins when `v0.1.0` is tagged. From then on, the latest tagged
`v0.1.x` release is supported; untagged development commits and older
prereleases are not support releases. Tagged releases are listed on the
repository's Releases page. This policy will be updated before a later release
line supersedes v0.1.
