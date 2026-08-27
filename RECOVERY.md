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

## What recovery changes

A successful recovery atomically:

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
