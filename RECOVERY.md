# Recover the Interlock owner

Use owner recovery when the owner password or passkey is lost. Interlock does
not create or store a permanent recovery code, master password, or back door.

## Run recovery

1. Stop the normal Interlock server with Ctrl+C.
2. On the computer that holds the Interlock data, run:

   ```text
   interlock recover
   ```

3. Open the exact `http://localhost` URL printed in the terminal.
4. Enter and confirm a new password, then create the new passkey when the
   browser asks.
5. Keep the terminal open. After replacement, the recovery-only listener
   retires and normal Interlock starts automatically on the same address.
6. When the page shows **Sign in to Interlock**, use that link and sign in with
   the new password. Keep the terminal running while you use Interlock normally;
   Ctrl+C now stops the normal server.

If the installation normally uses a custom `INTERLOCK_DATA_DIR`, use the same
environment setting for `recover`. `--port PORT` is available when the default
loopback port is already in use.

Plain `interlock recover` works only for a room served at `http://localhost`:
it refuses a data directory started with `--hosted-origin`, because the new
passkey would be bound to `localhost`. A hosted room uses
`interlock recover --hosted`, below.

## Recover a hosted room

A room started with `--hosted-origin` recovers in two halves. Whoever runs the
server issues a one-time code on the machine that holds the data; the owner
redeems it on the room's own address and creates a passkey bound to that
hostname. Access to that machine is the proof of ownership, as it is for local
recovery.

1. Stop the service.
2. On that machine, as the user that owns the data directory and with the same
   `INTERLOCK_DATA_DIR` as the service, run:

   ```text
   interlock recover --hosted
   ```

   It prints the owner's name, the room's address, and the code once. The code
   is not stored anywhere: only its SHA-256 digest is kept.
3. Start the service again. Nothing about the owner sign-in has changed yet:
   the old password and passkeys keep working until the code is redeemed.
4. Give the code to the owner privately. The owner opens
   `https://HOST/recover-owner` (the sign-in page links to it as **I have an
   owner recovery code**), enters the code and a new password of at least 12
   characters, and creates the new passkey when the browser asks.
5. The owner signs in with the new password.

The code:

- works once and expires 30 minutes after it was issued;
- is replaced by running `interlock recover --hosted` again: only the newest
  code works;
- is refused with one answer, `code-refused`, whether it is wrong, expired,
  used, replaced or no recovery is pending; a refused code changes nothing;
- after five refused codes from one client address, that address waits 15
  minutes (`code-busy`); other addresses are not held up.

Redeeming it, in one identity transaction:

- spends the code;
- replaces the owner password verifier;
- revokes every old owner passkey;
- binds the new passkey to the hosted hostname.

Then the owner's signed-in sessions in the running server end.

`interlock recover --hosted` starts no listener and needs no port. It refuses
while the server is running, on a loopback room, and on a directory with no
completed installation. Run it as the service user: a run as root leaves files
the service cannot write. If that happened, run
`sudo chown -R interlock:interlock /var/lib/interlock` (your data directory and
service user) before starting the service. [`HOSTING.md`](HOSTING.md) has the
exact commands for the systemd setup.

## What recovery changes

A successful local recovery atomically:

- replaces the owner password verifier;
- revokes every old owner passkey;
- binds the newly created passkey;
- consumes the one recovery authorization; and
- invalidates old browser sessions. The stopped normal process has no live
  in-memory session state, and its cookies do not work after restart.

Human participants, AI seats, transcript, archives, and room settings are not
changed.

## The 15-minute window

Opening the page does not start a recovery authorization. The server creates a
fresh, owner-bound authorization only when passkey creation begins. It expires
after at most 15 minutes and is consumed once. The WebAuthn prompt itself has a
shorter one-minute challenge; cancelling that prompt can be retried while the
15-minute authorization remains live.

If the recovery process is interrupted after passkey creation began, its raw
authorization secret is deliberately lost. Keep the normal server stopped and
wait no more than 15 minutes before running `interlock recover` again. This is
safer than storing a reusable recovery secret.

## Security boundary

Recovery acquires the same installation lock as `interlock start`, backup, and
restore. It refuses while the normal server is running. Its temporary server:

- listens only on the machine's loopback interfaces;
- accepts only the canonical printed `localhost` origin and Host value;
- requires same-origin browser metadata plus a process-local CSRF token;
- exposes only the recovery page and recovery API, never the chat, login, or
  administration routes; and
- never sends the raw operator secret, identity ids, password, or passkey private
  key through a URL or log. A non-secret capability identifier remains inside
  identity's audit records so the recovery action is traceable.

The normal Interlock server exposes none of the recovery routes or assets.
The browser reveals its sign-in link only after the recovery listener has
released the installation lock and the normal server's health response is live
on the same canonical address. If that startup fails, the page does not show a
dead link; it directs the owner to the terminal instead.

Recovery cannot repair a missing or corrupt data directory. Use a verified
backup to restore installation data first, without overwriting an existing
installation, then run recovery if its owner credentials are unavailable. See
[`BACKUP.md`](BACKUP.md).
