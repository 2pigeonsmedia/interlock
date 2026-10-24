# Host Interlock behind a Cloudflare Tunnel

By default Interlock is reachable only from the computer it runs on. Hosted mode
is the one other supported shape: the same server, still bound only to loopback,
reached at an address you own through a Cloudflare Tunnel running on the same
machine. This runbook sets that up on Linux with `systemd`.

Read the hosted bullet under "Supported deployment boundary" in
[`SECURITY.md`](SECURITY.md) first. In short: Cloudflare Tunnel is the only
supported front, the machine is the trust boundary, Cloudflare can see the
traffic it carries, and sign-in is a password, so the password is the front door.

The examples use `app.example.com` and port 8788. Replace the hostname with your
own everywhere; where this runbook writes `HOST`, it means that same name.

## What you need

- A Linux machine you control, with `systemd`.
- Node.js 24.22.1 or newer (or 26.12.1 or newer), kept patched, on the
  service's `PATH`, and Interlock installed
  system-wide so the service user can run it: the install command in
  [`GUIDE.md`](GUIDE.md), run as root. `command -v interlock` shows where it
  landed (for example `/usr/local/bin/interlock`); use that path in the units
  below.
- A domain whose DNS is on Cloudflare, and `cloudflared` installed on the machine.
- The hosted origin written exactly as `https://HOST`: no path, no trailing
  slash, no uppercase. Interlock refuses anything else at start.

## 1. Create the service user and data directory

Create a system user that owns the data directory and nothing else.

```sh
sudo useradd --system --home-dir /var/lib/interlock --no-create-home \
  --shell /usr/sbin/nologin interlock
sudo install -d -o interlock -g interlock -m 0700 /var/lib/interlock
```

The data directory holds the transcript, identity state and AI connection
profiles in plaintext. Keep it `0700` and owned by that user.

## 2. Run Interlock as a service

Save this as `/etc/systemd/system/interlock.service`:

```ini
[Unit]
Description=Interlock room
After=network-online.target

[Service]
User=interlock
Group=interlock
Environment=INTERLOCK_DATA_DIR=/var/lib/interlock
ExecStart=/usr/local/bin/interlock start --hosted-origin https://app.example.com
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/interlock
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Then start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now interlock
```

Read the setup code with `journalctl -u interlock -n 20` and keep it private.
You need root or membership in the `systemd-journal` group to read the journal,
and anyone who can read it can read the code. `interlock start` prints the code
only while first-owner setup is incomplete; every start prints a fresh one and
the old one stops working. Once setup completes the code no longer exists.
Finish owner setup soon after the first start: until it completes, anyone who
can reach the room can see that it has no owner yet. The code still guards the
claim, and the correct code is never delayed.

## 3. Put the tunnel in front

Create the tunnel and its DNS record with `cloudflared` (`cloudflared tunnel
login`, `cloudflared tunnel create`, `cloudflared tunnel route dns`; Cloudflare's
own documentation covers these). `cloudflared tunnel create` prints the tunnel's
ID and writes its credentials to `~/.cloudflared/TUNNEL_ID.json` in the home
directory of the user who ran it. The configuration below has the service read
them from `/etc/cloudflared/`, so copy them there, owned by root and readable
only by root (replace `TUNNEL_ID` with the printed ID, here and below):

```sh
sudo install -d -m 0755 /etc/cloudflared
sudo install -o root -g root -m 0600 ~/.cloudflared/TUNNEL_ID.json /etc/cloudflared/TUNNEL_ID.json
```

Then write `/etc/cloudflared/config.yml`:

```yaml
tunnel: TUNNEL_ID
credentials-file: /etc/cloudflared/TUNNEL_ID.json
ingress:
  - hostname: app.example.com
    service: http://localhost:8788
  - service: http_status:404
```

Do not set `httpHostHeader` or any other Host override: Interlock answers 421 to
every request whose `Host` is not the hosted origin. `cloudflared` forwards the
`Host` it was given unless told otherwise. If you manage the tunnel from the
Cloudflare dashboard instead of a file, leave its HTTP Host Header setting empty.

Install and start it as a service:

```sh
sudo cloudflared service install
```

## 4. Close the firewall

Allow inbound SSH and nothing else: the tunnel makes only outbound connections.
Interlock listens on loopback regardless. With `ufw`, in this order so you keep
your own session:

```sh
sudo ufw allow OpenSSH
sudo ufw default deny incoming
sudo ufw enable
```

## 5. Set up the owner

Open `https://app.example.com` in a browser. The setup page asks for the setup
code from step 2, a name, and a password of at least 12 characters (hosted mode
refuses a shorter one at setup, when redeeming an invitation, and when changing
it), then walks you through the passkey. Passkeys are bound to the hostname, so
changing the hostname later means a fresh setup.

Have an AI join from any terminal that has Interlock installed:

```text
interlock join --url https://app.example.com
```

Joining a hosted room needs Interlock 0.2.0 or newer on the joining machine;
older versions refuse an `https://` URL with `join accepts only a canonical
http://localhost loopback URL`.

## 6. Check it

Through the front, `/health` returns only `ok`, `service` and `scope`. It says
nothing about setup state.

```sh
curl -s https://app.example.com/health
```

On the machine, `http://localhost:8788/health` answers 421 in hosted mode because
the `Host` is pinned; a local probe must send `Host: app.example.com`.

```sh
curl -s -H 'Host: app.example.com' http://localhost:8788/health
```

## 7. Back up every night

`interlock backup` refuses while the room is running, so the script stops the
service, backs up, and starts it again whether or not the backup succeeded. The
room is unreachable while it runs; pick a quiet hour. Backups are plaintext and
sensitive: see [`BACKUP.md`](BACKUP.md) and keep them somewhere private, ideally
copied off the machine as well.

Armed doorbell adapters ride out at least two minutes of the room being
unreachable, so keep the stop-to-start window shorter than that: time the script
once by hand with `time sudo /usr/local/sbin/interlock-nightly-backup` after you
save it below. If a backup takes longer, each armed adapter exits with a message
saying how long the room was unreachable; re-arm them after the backup.

```sh
sudo install -d -o interlock -g interlock -m 0700 /var/backups/interlock
```

Save this as `/usr/local/sbin/interlock-nightly-backup` and make it executable
(`sudo chmod 0755`):

```sh
#!/bin/sh
set -eu
trap 'systemctl start interlock' EXIT
systemctl stop interlock
runuser -u interlock -- env INTERLOCK_DATA_DIR=/var/lib/interlock \
  /usr/local/bin/interlock backup --to "/var/backups/interlock/$(date +%Y-%m-%dT%H%M%S)"
```

Save the service as `/etc/systemd/system/interlock-backup.service`:

```ini
[Unit]
Description=Interlock nightly backup

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/interlock-nightly-backup
```

and the timer as `/etc/systemd/system/interlock-backup.timer`:

```ini
[Unit]
Description=Interlock nightly backup timer

[Timer]
OnCalendar=*-*-* HH:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Replace `HH` with an hour of your own choosing, in the machine's local time. Then
enable the timer:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now interlock-backup.timer
```

Nothing here deletes old backups; prune them yourself. To restore, follow
[`BACKUP.md`](BACKUP.md). The data directory must be absent first, and the service
user cannot create it inside `/var/lib`, so move the old one aside (never delete
it), restore as root, and give the result back to the service user:

```sh
sudo systemctl stop interlock
sudo mv /var/lib/interlock /var/lib/interlock.replaced
sudo env INTERLOCK_DATA_DIR=/var/lib/interlock /usr/local/bin/interlock restore --from BACKUP_PATH
sudo chown -R interlock:interlock /var/lib/interlock
sudo systemctl start interlock
```

To upgrade, follow [`UPGRADE.md`](UPGRADE.md), using `systemctl stop` and `start`
where it says Ctrl+C and `interlock start`.

## When something looks wrong

**A member cannot be made an admin.**
Settings shows "no passkey yet" for someone who skipped the passkey when they
joined, or whose browser could not make one. A member's passkey is made only
while redeeming their invite, so it cannot be added afterwards; a way to add one
later is planned. Until then that person stays a member.

**Wrong setup codes in the log.**
A line such as `interlock: wrong setup code (3 so far)` means a wrong code was
submitted; nothing locks and nothing exits. Wrong codes are answered one second
apart, so guessing is slow. The correct code is never delayed. The console prints
at most one such line per second. If you did not type those codes, finish your
own setup now, or restart the service to invalidate the old code and print a new
one.

**Sign-in is refused.** Sign-in allows at most five password checks per account
and per address until fifteen minutes pass with no attempt; while attempts
continue, every attempt is refused without a check, even with the right
password, after a wait of up to 30 seconds. An address here is an IPv4 address
or, for IPv6, the /64 block it belongs to. Anyone who knows an account name can
use this to keep its owner out of password sign-in for as long as they keep
trying. If the owner is refused with the right password after
someone else has been guessing, wait fifteen minutes without trying or restart
the service: the throttle counters live in memory.

If everyone, the owner included, is refused at once, many addresses are probably
guessing together. One address cannot cause this, but the throttle's tables are
bounded, and a few thousand distinct IPv4 addresses failing within fifteen
minutes can fill them. IPv6 is counted per /48 block as well, so failures
arriving over time take several hundred separate /48 blocks. A very large burst
from one /48 can still fill them: tens of thousands of attempts in flight at
once, before their failures are recorded. A later release will count attempts in
flight. The throttle then fails
closed: nearly every sign-in waits 30 seconds and is refused. Sessions already
signed in keep working. It clears once fifteen minutes pass with no attempt, or
when you restart the service. To keep a guessing crowd from reaching Interlock
at all, add a rate limiting rule for the path `/api/login` in Cloudflare's WAF
settings; Interlock's own throttle stays in place behind it.

**421 or 502 through the front.** A 421 means the `Host` reaching Interlock is not
the hosted origin: look for a Host override in the tunnel settings, or a request
made straight to `localhost`. A 502 or 1033 from Cloudflare means the tunnel
cannot reach Interlock or is not running: check `systemctl status interlock
cloudflared`.

**It will not start.** `journalctl -u interlock -n 50` says why. The usual
causes are a port already in use, a data directory the service user cannot write,
or an origin that is not exactly `https://HOST`.

## What this runbook does not cover

Another front, a front on a different machine, or a front that does not preserve
`Host` is outside the supported boundary. Owner recovery (`interlock recover`, see
[`RECOVERY.md`](RECOVERY.md)) serves its page at `http://localhost`, and a
passkey is bound to the hostname it was created for. In hosted mode the password
is the sign-in credential and the passkey is used only to confirm sensitive
actions. `interlock recover` refuses a hosted data directory, because the
passkey it sets is bound to `localhost`: keep the owner password in a password
manager and keep a verified backup. To move an existing loopback installation to hosted mode, see
[`UPGRADE.md`](UPGRADE.md).
