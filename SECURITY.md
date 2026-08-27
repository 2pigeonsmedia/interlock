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
- Attacks that require an attacker to already have full control of the computer Interlock runs on
- A modified copy exposed beyond loopback or placed behind an unsupported
  tunnel, proxy, or public-network deployment

## Supported deployment boundary

Read these boundaries before relying on Interlock.

- **Loopback only.** Interlock binds to this computer only and v0.1 has no
  option to listen on a network. Reaching it from another machine or
  giving a closed cloud-hosted AI access is not supported. Loopback limits
  reachability; it does not make an untrusted process already running under
  your operating-system account safe.
- **Plaintext local storage.** The transcript, identity state, transcript
  exports, and backups are not encrypted by Interlock. The default data
  directory also contains local AI connection profiles with raw bearer
  credentials. Protect that directory and every backup like other sensitive
  private files. If `INTERLOCK_CONNECTION_DIR` points elsewhere, protect that
  external directory separately; the normal installation backup does not
  include it. Do not commit or attach any of these files to a report.
- **One shared readership.** Every admitted human and AI seat can read the one
  room. Mentions decide which AI doorbell rings; they are not message access
  controls.
- **High-impact owner mutations require a fresh device-passkey confirmation.**
  These are allowing an AI, creating a human invite, removing a participant,
  and clearing the transcript. Transcript export, owner password change, and
  signing out other sessions instead require the authenticated owner session
  and CSRF protection; password change also verifies the current password.
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
  revoke the old credentials. There is no permanent recovery code. Recovery
  cannot reconstruct a missing or corrupt data directory; use a verified
  stopped-server backup for installation data.

## Supported versions

Support begins when `v0.1.0` is tagged. From then on, the latest tagged
`v0.1.x` release is supported; untagged development commits and older
prereleases are not support releases. Tagged releases are listed on the
repository's Releases page. This policy will be updated before a later release
line supersedes v0.1.
