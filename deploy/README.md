# Deploying notas-whatsapp

A one-time runbook for getting notas-whatsapp running 24/7 on a free Oracle
Cloud VM, behind TLS, with process supervision and daily backups. Written so
someone who has never touched this project can follow it top to bottom
without guessing. Commands assume a fresh **Ubuntu 22.04** VM and a `bash`
shell; adjust paths if yours differ.

Everything here is a deployment config/runbook — no application behavior
changes. (Two small code fixes needed for production-readiness — see
"Notes on what's already fixed in this repo" at the end — were made as part
of this same task and are already committed.)

## Table of contents

1. [Create the Oracle Cloud VM](#1-create-the-oracle-cloud-vm)
2. [Point a DuckDNS subdomain at it](#2-point-a-duckdns-subdomain-at-it)
3. [Install Node, pm2, Caddy, sqlite3](#3-install-node-pm2-caddy-sqlite3)
4. [Get the app onto the VM](#4-get-the-app-onto-the-vm)
5. [Configure `.env`](#5-configure-env)
6. [Run database migrations](#6-run-database-migrations)
7. [Authorize Google Calendar access](#7-authorize-google-calendar-access)
8. [Build and start the app with pm2](#8-build-and-start-the-app-with-pm2)
9. [Make pm2 survive reboots](#9-make-pm2-survive-reboots)
10. [Configure Caddy for TLS](#10-configure-caddy-for-tls)
11. [Install the daily backup cron job](#11-install-the-daily-backup-cron-job)
12. [Install the monthly cuota-pending reminder cron job](#12-install-the-monthly-cuota-pending-reminder-cron-job)
13. [Pair WhatsApp](#13-pair-whatsapp)
14. [Live Groq classification smoke test](#14-live-groq-classification-smoke-test)
15. [Manual end-to-end verification](#15-manual-end-to-end-verification)
16. [Migrating to a new machine](#16-migrating-to-a-new-machine)
17. [Notes on what's already fixed in this repo](#17-notes-on-whats-already-fixed-in-this-repo)
18. [Automated deploys (GitHub Actions)](#18-automated-deploys-github-actions)

---

## 1. Create the Oracle Cloud VM

1. Sign up for an Oracle Cloud Infrastructure (OCI) account at
   <https://www.oracle.com/cloud/free/> — this needs a credit card for
   identity verification but the "Always Free" resources below never bill.
2. In the OCI Console: **Compute → Instances → Create instance**.
3. Name it (e.g. `notas-whatsapp`).
4. **Image and shape**:
   - Image: **Canonical Ubuntu 22.04** (the plain x86_64 build — not the
     "Minimal" variant, and you don't need to hunt for an aarch64 one for
     this shape).
   - Shape: click "Change shape" → **Virtual Machine** → **Specialty and
     previous generation** (or wherever your console lists it) →
     **`VM.Standard.E2.1.Micro`** (AMD, 1 OCPU / 1 GB memory). This is the
     *other* Always Free shape, separate from the ARM Ampere one — it isn't
     subject to the "out of host capacity" problem the ARM shape has, since
     it's a far less contested resource. Confirm it's marked "Always Free
     eligible" before continuing. The Always Free tier allows **two**
     `E2.1.Micro` instances per tenancy, so you have headroom later if you
     ever want a second one.
5. **Networking**: let it create a new VCN or use an existing one; keep
   "Assign a public IPv4 address" checked.
6. **Add SSH keys**: let OCI generate a key pair and download the private
   key (or paste your own public key). Keep the private key safe — it's
   your only way in.
7. Click **Create**. Wait for the instance state to become "Running", then
   note its **public IP address** from the instance detail page.
8. **Open the firewall at the OCI (cloud) level** — this is separate from
   and in addition to the VM's own `ufw`/`iptables`, and is the most common
   place people get stuck (SSH works, but port 80/443 "just don't respond"
   because OCI's own default Security List only allows port 22 in):
   - Instance detail page → the VCN link → **Security Lists** → the
     default security list → **Add Ingress Rules**.
   - Add: Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range
     `80` — click Add Ingress Rules again for port `443` the same way.
9. (Recommended, free) **Reserve the public IP** so it never changes even
   if you stop/start the instance: **Networking → IP Management → Reserved
   Public IPs → Create Reserved Public IP**, then attach it to the
   instance's VNIC (detach the ephemeral one, attach the reserved one).
   This means you only have to set the DuckDNS IP once, in step 2.
10. SSH in to confirm it works:
    ```bash
    chmod 600 ~/Downloads/ssh-key-....key   # the private key OCI gave you
    ssh -i ~/Downloads/ssh-key-....key ubuntu@<VM_PUBLIC_IP>
    ```
    (Default user on the Canonical Ubuntu image is `ubuntu`.)
11. **Add swap.** `E2.1.Micro` only has 1 GB of real RAM, which is too
    tight for `next build` (step 8 below) and for running the WhatsApp
    connection, Next.js server and SQLite together without some headroom.
    This costs nothing (uses disk, which you have plenty of in the free
    tier — 200 GB total block storage included):
    ```bash
    sudo fallocate -l 4G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    free -h   # should now show ~4.0G under Swap
    ```

The rest of this runbook assumes you're SSH'd into the VM as `ubuntu`,
unless stated otherwise.

## 2. Point a DuckDNS subdomain at it

1. Go to <https://www.duckdns.org>, sign in (GitHub/Google/etc. login — it's
   free, no account creation form).
2. Under "add domain", pick a subdomain, e.g. `mi-bot-whatsapp` → this gives
   you `mi-bot-whatsapp.duckdns.org`.
3. Set its IP to the VM's public IP (the reserved one from step 1.9, if you
   made one) and click "update ip".
4. Confirm it resolves:
   ```bash
   dig +short mi-bot-whatsapp.duckdns.org
   ```
   should print the VM's public IP.

If you did **not** reserve a static public IP in step 1.9, the VM's
ephemeral IP can change if the instance is stopped and restarted (it stays
the same across reboots that don't stop the instance). In that case,
install DuckDNS's own updater as a cron job on the VM — see
<https://www.duckdns.org/install.jsp> (bash install) — so the DNS record
self-heals after an IP change. With a reserved IP this isn't needed.

## 3. Install Node, pm2, Caddy, sqlite3

On the VM:

```bash
# Node.js 20 LTS (works on ARM/aarch64)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2, globally
sudo npm install -g pm2

# sqlite3 CLI — used by deploy/backup.sh for a safe online backup
sudo apt-get install -y sqlite3

# Caddy (official repo — see https://caddyserver.com/docs/install#debian-ubuntu-raspbian)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Verify versions:

```bash
node -v    # v20.x
npm -v
pm2 -v
caddy version
sqlite3 --version
```

## 4. Get the app onto the VM

Clone (or copy) the repo onto the VM. If it lives in a private git remote:

```bash
git clone <your-repo-url> ~/notas-whatsapp
cd ~/notas-whatsapp
npm install
```

(`npm install`, not `npm ci --omit=dev` — the build needs the devDependencies,
notably `typescript`, `prisma` and `tailwindcss`.)

The rest of this runbook assumes the app lives at `~/notas-whatsapp` on the
VM. Everywhere below that says `$APP_DIR`, substitute that path (or set the
shell variable: `APP_DIR=~/notas-whatsapp`).

## 5. Configure `.env`

Create `$APP_DIR/.env` on the VM (never commit this file — it's gitignored)
with:

(o copiá `.env.example` a `.env` y completá los valores:
`cp .env.example .env`)

```bash
DATABASE_URL="file:./prod.db"
SESSION_SECRET="<generate with: openssl rand -hex 32>"
WEBAPP_USERNAME="<your chosen login username>"
WEBAPP_PASSWORD_HASH="<bcrypt hash — see below>"
GROQ_API_KEY="<your Groq API key, from https://console.groq.com>"

# Google Calendar integration — create an OAuth client (type: "Desktop app")
# in Google Cloud Console (APIs & Services → Credentials), with the
# Calendar API enabled on the project.
GOOGLE_CLIENT_ID="<from Google Cloud Console>"
GOOGLE_CLIENT_SECRET="<from Google Cloud Console>"
GOOGLE_REDIRECT_URI="http://localhost:3000/oauth2callback"
```

To generate `WEBAPP_PASSWORD_HASH` (bcrypt hash of your chosen login
password), run this once, anywhere Node + bcrypt are available (e.g. right
here in `$APP_DIR`, since `bcrypt` is already a dependency):

```bash
node -e "const bcrypt=require('bcrypt'); bcrypt.hash(process.argv[1], 10).then(h => console.log(h))" '<your chosen password>'
```

> **Important — `DATABASE_URL="file:./prod.db"`:** Prisma's sqlite
> connector resolves a relative `file:` path **relative to
> `prisma/schema.prisma`'s directory**, not the process's working
> directory. With the value above, the actual database file ends up at
> `$APP_DIR/prisma/prod.db` — not `$APP_DIR/prod.db`. `deploy/backup.sh`
> already knows this and resolves the path the same way; keep
> `DATABASE_URL` in this exact `file:./<name>.db` shape so that stays true.

## 6. Run database migrations

```bash
cd $APP_DIR
npx prisma migrate deploy
```

This creates `prisma/prod.db` with the current schema (no interactive
prompts — `migrate deploy` just applies existing migrations, unlike
`migrate dev`).

## 7. Authorize Google Calendar access

One-time, interactive (needs a browser on whatever machine you do this
from — can be your laptop, pointed at the same `.env`, or the VM itself if
it has a way for you to open a URL):

```bash
cd $APP_DIR
npx tsx scripts/setup-google-auth.ts
```

It prints a Google OAuth consent URL — open it, sign in with the Google
account whose Calendar reminders should go to, approve, and paste the code
it gives you back into the prompt. This writes `$APP_DIR/.google-token.json`
(gitignored — holds a live refresh token, never commit it). From then on,
`src/lib/calendar.ts` reads this file on every reminder confirmation to
create the Calendar event; it's read fresh every call, so no restart is
needed after this step, but the app does need this file to exist before any
reminder gets confirmed.

## 8. Build and start the app with pm2

```bash
cd $APP_DIR
npm run build
pm2 start deploy/pm2.config.cjs
pm2 status
```

`deploy/pm2.config.cjs` starts exactly one process named `notas-whatsapp`,
running `next start -H 127.0.0.1 -p 3000` (via `npm start -- ...`), with
`autorestart: true`.

**Why `-H 127.0.0.1` and not `0.0.0.0`:** the app must only be reachable
through Caddy's reverse proxy (step 10), never directly from the internet.
The login route's rate limiter (`src/lib/rateLimit.ts`, 5 attempts/minute
per IP) identifies the caller by the `x-forwarded-for` request header —
and that header is only trustworthy when Caddy is the *only* thing that can
set it. If the Next.js process were reachable directly (bound to
`0.0.0.0`, or reachable because a firewall rule was accidentally opened on
port 3000), any internet client could set their own `x-forwarded-for` and
bypass the rate limiter completely. Binding to `127.0.0.1` makes the app
unreachable except via `localhost`, which only Caddy (running on the same
machine) can reach.

## 9. Make pm2 survive reboots

```bash
pm2 save
pm2 startup
```

`pm2 startup` prints a `sudo env PATH=$PATH:... pm2 startup systemd -u ubuntu --hp /home/ubuntu` command — **copy and run the exact command it prints** (it varies by user/path). This installs a systemd unit that restarts pm2 (and everything `pm2 save` remembered) on every VM boot. Confirm with:

```bash
sudo reboot
# wait ~30s, then reconnect:
ssh -i <key> ubuntu@<VM_PUBLIC_IP>
pm2 status   # should show notas-whatsapp already running
```

## 10. Configure Caddy for TLS

1. Copy `deploy/Caddyfile.example` to `deploy/Caddyfile` (same pattern as
   `.env` in step 5: `deploy/Caddyfile` is gitignored, so it only ever
   lives on the VM and never gets committed) and replace
   `your-domain.example.com` with your actual DuckDNS subdomain from
   step 2:
   ```bash
   cp $APP_DIR/deploy/Caddyfile.example $APP_DIR/deploy/Caddyfile
   # then edit $APP_DIR/deploy/Caddyfile and fill in your real domain
   ```
2. Install it as Caddy's config:
   ```bash
   sudo cp $APP_DIR/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
   sudo systemctl reload caddy
   sudo systemctl enable caddy   # survive reboots
   ```
3. Caddy automatically requests and renews a Let's Encrypt certificate for
   the domain the first time it's reachable on port 80 — no manual
   certbot step. Check it worked:
   ```bash
   curl -vI https://mi-bot-whatsapp.duckdns.org 2>&1 | grep -E "SSL|HTTP"
   ```
   You should see a successful TLS handshake and an HTTP response (likely
   a redirect to `/login`).

If Caddy's log (`sudo journalctl -u caddy -f`) shows ACME challenge
failures, double-check: the OCI security list ingress rules from step 1.8
(port 80 must be open — Let's Encrypt's HTTP-01 challenge needs it even
though the end result is HTTPS), and that DNS (step 2) actually resolves to
this VM's current IP.

> **Migrating an already-deployed instance to this gitignored
> `deploy/Caddyfile`:** **do this backup *before* this change reaches
> `main`.** `.github/workflows/ci-cd.yml`'s `deploy` job runs
> automatically on every push to `main`, with no manual approval step,
> and it runs `git fetch origin main && git reset --hard origin/main` on
> the VM unconditionally — so there's no "do it after" here: by the time
> this commit is on `main`, the next push can already trigger the deploy
> that deletes the file. If you deployed before this change, your VM has
> a real `deploy/Caddyfile` (with your actual domain) tracked by git, and
> once `deploy/Caddyfile` is removed from the tracked tree and
> gitignored, that same `git reset --hard` will **delete** the real file
> from the VM's working directory on the next deploy. This only loses the
> repo-side copy at `$APP_DIR/deploy/Caddyfile` — Caddy itself runs from
> `/etc/caddy/Caddyfile` (the copy installed in step 10.2, below), which
> this deploy job never touches, so the site keeps serving uninterrupted
> through the deploy and across reboots. The repo-side copy is only used
> again if you need to re-run step 10.2 (e.g. on a fresh VM, or after
> editing the Caddyfile). Before merging/pushing this change to `main`:
> 1. **Back up the current file** somewhere outside the repo:
>    ```bash
>    cp $APP_DIR/deploy/Caddyfile ~/Caddyfile.backup
>    ```
> 2. Deploy as usual (`git pull` or the automated workflow's `git reset
>    --hard origin/main`).
> 3. If `$APP_DIR/deploy/Caddyfile` no longer exists afterward, restore it
>    from the backup:
>    ```bash
>    cp ~/Caddyfile.backup $APP_DIR/deploy/Caddyfile
>    ```
>    It's gitignored now, so leaving it there going forward is safe — git
>    won't touch it again. If you forgot to back it up before deploying,
>    Caddy's live config at `/etc/caddy/Caddyfile` is still the real file
>    with your actual domain — restore the repo-side copy from there
>    instead:
>    ```bash
>    cp /etc/caddy/Caddyfile $APP_DIR/deploy/Caddyfile
>    ```

## 11. Install the daily backup cron job

```bash
chmod +x $APP_DIR/deploy/backup.sh
mkdir -p ~/backups/notas-whatsapp
crontab -e
```

Add this line (runs daily at 3:00 AM server time):

```cron
0 3 * * * APP_DIR=/home/ubuntu/notas-whatsapp /home/ubuntu/notas-whatsapp/deploy/backup.sh >> /home/ubuntu/backups/notas-whatsapp/backup.log 2>&1
```

(Adjust the two `/home/ubuntu/notas-whatsapp` paths if `$APP_DIR` differs.)

`deploy/backup.sh` copies the live database (via `sqlite3 .backup`, which
takes a consistent snapshot even while the app is writing to it) to
`~/backups/notas-whatsapp/notas-YYYY-MM-DD.db`, then deletes any backup
file in that directory older than 7 days. Test it manually once before
trusting the cron job:

```bash
$APP_DIR/deploy/backup.sh
ls -la ~/backups/notas-whatsapp
```

## 12. Install the monthly cuota-pending reminder cron job

`src/app/api/cron/cuota-reminder/route.ts` sends a WhatsApp message to
yourself listing any active, unpaid cuotas for the current month (nothing
sent if none are pending). It's a plain HTTP GET, authenticated by a shared
secret instead of a session cookie (it's called by system cron, not a
logged-in browser) — `middleware.ts` excludes `api/cron/` from the login
check for exactly this reason.

1. Add `CRON_SECRET` to `$APP_DIR/.env` (same file as `WEBAPP_PASSWORD_HASH`
   and the rest, step 5 above):
   ```bash
   CRON_SECRET="<generate with: openssl rand -hex 32>"
   ```
   Restart the app so it picks up the new env var:
   ```bash
   pm2 restart notas-whatsapp
   ```
2. Add this line to the same crontab from step 11 (`crontab -e`):
   ```cron
   0 13 25 * * curl -fsS "https://<your-domain>/api/cron/cuota-reminder?secret=$CRON_SECRET" >> ~/backups/notas-whatsapp/cuota-reminder.log 2>&1
   ```
   (Replace `<your-domain>` with your DuckDNS subdomain from step 2, and
   `$CRON_SECRET` with the actual value from `.env` — cron doesn't read
   `.env` files, so the literal value has to go in the crontab line
   itself.) Runs the 25th of every month at 13:00 UTC ≈ 10:00 ART — the
   VM's system clock runs UTC while the default `APP_TIMEZONE` is Argentina
   (same fact `src/lib/timezone.ts` already works around); adjust the hour if your VM
   turns out to be configured to local time instead.

Test it manually once before trusting the cron job:

```bash
curl -i "https://<your-domain>/api/cron/cuota-reminder?secret=$CRON_SECRET"
```

A `{"sent":false}` body means it ran fine and nothing is pending; a
`{"sent":true,"count":N}` body means it ran fine and just sent the WhatsApp
message. A `401` means `CRON_SECRET` doesn't match between `.env` and the
URL (or the app hasn't been restarted since `.env` was edited).

## 13. Pair WhatsApp

```bash
pm2 logs notas-whatsapp
```

On first boot (no `.wa-auth/` directory yet), Baileys prints a QR code to
the logs. Scan it with the WhatsApp account you want the bot to run as:
**WhatsApp → Settings → Linked Devices → Link a Device**. Once paired,
Baileys writes session credentials under `$APP_DIR/.wa-auth/` and you won't
need to re-scan unless that directory is lost (see "Migrating to a new
machine" below). `Ctrl-C` exits `pm2 logs` without stopping the app itself.

Also on first boot (no prior `.wa-auth/`), the app writes
`$APP_DIR/.wa-first-boot.json` — a durable cutoff timestamp the bot uses to
tell "a message that arrived while the bot was offline, which should be
processed" apart from "WhatsApp's history-sync replay of old messages on
(re)pairing, which should be ignored". A fresh install doesn't need to do
anything about this file — it's created automatically and correctly on its
own. It only matters if you later move this bot's identity to a different
machine (see section 16).

## 14. Live Groq classification smoke test

Classification (`src/lib/whatsapp/classify.ts`) was only ever exercised in
development against **mocked** Groq responses. Once `GROQ_API_KEY` is a
real key, do one real end-to-end check before trusting reminders in
production — the thing most worth verifying for real is that the live
model actually returns a datetime in the exact `...-03:00`-offset shape the
code strictly requires (anything else — a bare date, a `Z` suffix, no
offset, a past time — gets silently discarded into a null/"ambiguous"
reminder instead of a scheduled one).

**Option A — through WhatsApp (closest to real usage):**

1. With the app running and WhatsApp paired, send yourself (on "Mensaje a
   mí mismo" / your own WhatsApp number) a message like:
   ```
   recordame mañana a las 10 que llame al dentista
   ```
2. Open `https://<your-subdomain>/recordatorios` in the webapp.
3. **Pass:** a new entry appears with `rawText` close to what you sent, a
   `parsedDatetime` that is tomorrow at 10:00 Argentina time, and `status`
   other than an immediate failure.
4. **Failure looks like:** the note shows up instead under
   `/sin-clasificar` (classification fell back to `no_identificado`), or it
   appears as a reminder with no date/an "ambiguous" status — meaning the
   model's datetime didn't pass `validateParsedDatetime` in
   `src/lib/whatsapp/classify.ts` (wrong offset, past time, or malformed).
   If that happens, check `pm2 logs notas-whatsapp` for the raw model
   response (classification failures never throw, so look at the log
   output, not an exception).

**Option B — a one-off script, no WhatsApp needed (faster to repeat):**

```bash
cd $APP_DIR
npx tsx -e '
import { classifyMessage } from "./src/lib/whatsapp/classify";
classifyMessage("recordame mañana a las 10 que llame al dentista", new Date().toISOString())
  .then((r) => console.log(JSON.stringify(r, null, 2)));
'
```

**Pass:** printed JSON has `"intent": "capture"`, `"noteType": "recordatorio"`,
and a `"parsedDatetime"` ending in exactly `-03:00` (not `Z`, not `+00:00`,
not missing), for a time strictly in the future. Example of a passing
result:

```json
{
  "intent": "capture",
  "noteType": "recordatorio",
  "parsedDatetime": "2026-10-29T10:00:00-03:00"
}
```

If `parsedDatetime` is `null` or missing here, the live model didn't comply
with the prompt's offset requirement for this input — try rephrasing the
test message (e.g. a more explicit date) and re-run; if it's still null for
clearly-dated input, that's worth a closer look at
`buildSystemPrompt`/`validateParsedDatetime` in `src/lib/whatsapp/classify.ts`
before relying on reminders in production.

## 15. Manual end-to-end verification

This is the one part of this runbook that **must be run on the real,
provisioned VM** — it can't be done from a dev machine or simulated. Once
everything above is done:

1. **TLS**: open `https://<your-subdomain>` in a browser (or
   `curl -vI https://<your-subdomain>`). It should load the login page with
   a valid certificate (no browser warning; `curl` shows a clean TLS
   handshake, no self-signed/expired cert errors).
2. **End-to-end note capture**: send a WhatsApp message to "Mensaje a mí
   mismo" (e.g. "gasté 500 pesos en el supermercado"). Within a few
   seconds, log in to the webapp and confirm the note shows up (on
   `/gastos`, `/ideas`, `/recordatorios` or `/sin-clasificar` depending on
   what you sent).
3. **Process supervision**: simulate a crash and confirm pm2 brings it back:
   ```bash
   pm2 restart notas-whatsapp
   pm2 status
   ```
   `status` should show `online` and an incremented restart counter, not
   `errored`/`stopped`.

Only once all three pass is the deployment actually done, not just
configured.

## 16. Migrating to a new machine

If this bot's WhatsApp identity ever needs to move to a different VM
(hardware migration, re-provisioning, etc.), copy **both**
`.wa-auth/` and `.wa-first-boot.json` to the new machine, not just
`.wa-auth/`. `.wa-auth/` alone is enough to keep the paired WhatsApp session
working, but without the matching `.wa-first-boot.json`, the bot on the new
machine has no record of when it was last known to be online — losing the
distinction between "messages that arrived while genuinely offline" (which
should be processed) and "WhatsApp's history-sync replaying old messages"
(which should be ignored), risking duplicate processing of old messages
right after the move. A brand-new install with no prior `.wa-auth/` doesn't
have this concern — it sets its own fresh first-boot cutoff automatically
and correctly.

## 17. Notes on what's already fixed in this repo

These were identified during this project's bug-fixing history as
necessary before this app could be considered production-ready, and are
already applied in the commit this file ships with — nothing further to do
for them, they're listed here only so the reasoning isn't lost:

- `src/app/api/recordatorios/route.ts` and
  `src/app/api/sin-clasificar/route.ts` now have
  `export const dynamic = "force-dynamic";`. Without it, `next build`
  statically prerendered both routes (their `GET` handlers never read the
  `request` argument, which is what Next.js uses to decide whether a route
  can be prerendered) — under `next start` in production that would have
  served whatever data existed at build time, forever, never reflecting new
  notes/reminders.
- `src/lib/calendar.ts`'s `calendar.events.insert` call now passes an
  explicit `{ timeout: 20_000 }` (gaxios/googleapis option, milliseconds).
  Without it, a hung network path to Google could block indefinitely — and
  because WhatsApp messages are processed one at a time (see
  `src/lib/whatsapp/reminders.ts`'s serialized queue), that would have
  stalled the entire bot, not just one reminder confirmation.

## 18. Automated deploys (GitHub Actions)

`.github/workflows/ci-cd.yml` runs two jobs:

- **`test`** — on every push to any branch and every PR into `main`:
  `npm ci`, `npx prisma generate`, the full `vitest` suite, and a real
  `npm run build`. This is what would have caught, before either ever
  reached the VM: the stale-generated-Prisma-client type error and the
  `next build` OOM's underlying cause (neither — the OOM is VM-memory-only
  and doesn't reproduce on GitHub's runners, but the type error would have
  failed CI immediately instead of surfacing mid-deploy).
- **`deploy`** — only on a push to `main`, only if `test` passed, and only
  if the repository variable `ENABLE_DEPLOY` is set to `true` (see
  "One-time setup to enable it" below) — SSHes into the VM and runs the
  exact same recovery sequence used manually on 2026-10-30 (`pm2 stop` →
  `git reset --hard origin/main` →
  `npm install` → `npx prisma generate` → `npx prisma migrate deploy` →
  `npm run build` with `NODE_OPTIONS=--max-old-space-size=3072` → `pm2
  restart`). The build still runs on the VM itself, not on the GitHub
  runner — this keeps the app's actual runtime unchanged (no Next.js
  "standalone" output mode, which would need separate verification that
  Prisma's native query engine and Baileys' optional native WebSocket
  addons survive that packaging before trusting it against a bot already
  in daily use).

**This workflow only handles *updates* to an already-running deployment.**
It assumes everything from steps 1–13 above is already done on the VM:
`.env` configured, `.wa-auth/` paired, `.google-token.json` authorized,
pm2 already running the app once. A brand-new VM still goes through this
whole runbook by hand first.

### One-time setup to enable it

> **Auto-deploy requires BOTH of these — the 3 secrets below AND this
> repository variable. Either one alone is not enough:** set the
> repository **variable** `ENABLE_DEPLOY` to `true` (GitHub repo →
> Settings → Secrets and variables → Actions → **Variables** tab — not
> the Secrets tab) to let the `deploy` job actually run. Without it, the
> job is skipped (not a failure) even if all 3 secrets below are already
> configured.
>
> **If you already had this workflow running before this gate was
> added** (i.e. your instance currently auto-deploys on every push to
> `main`): this is a real behavior change for your own setup, not just a
> safeguard for new repos. After pulling this change, your deploys will
> **silently stop** — the job will show as skipped, not failed — until
> you go set `ENABLE_DEPLOY=true` on the repository. Do that *before* or
> immediately after this change reaches your `main`, or you'll be left
> wondering why pushes to `main` no longer update the VM.

1. **Generate a dedicated deploy key** — don't reuse your own SSH key, so
   it can be revoked/rotated independently of your personal VM access:
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/deploy_key -N ""
   ```
2. **Authorize the public half on the VM** (as `ubuntu`):
   ```bash
   cat ~/deploy_key.pub | ssh -i <your-personal-key> ubuntu@<VM_IP> 'cat >> ~/.ssh/authorized_keys'
   ```
3. **Add 3 repository secrets** (GitHub repo → Settings → Secrets and
   variables → Actions → New repository secret):
   - `DEPLOY_HOST` — the VM's public IP or DuckDNS domain.
   - `DEPLOY_USER` — `ubuntu`.
   - `DEPLOY_SSH_KEY` — the full contents of `~/deploy_key` (the *private*
     half, including the `-----BEGIN...-----`/`-----END...-----` lines).
4. Delete `~/deploy_key`/`~/deploy_key.pub` from wherever you generated
   them once the secret is saved — only GitHub needs to hold the private
   key from here on.
5. **Set the repository variable** (GitHub repo → Settings → Secrets and
   variables → Actions → **Variables** tab → New repository variable):
   - `ENABLE_DEPLOY` — `true`.

   This step is easy to miss because it lives under a separate tab from
   the secrets above, and skipping it is not a hard failure — the
   `deploy` job will just show as skipped on every push to `main`.
6. Push to `main` (or merge a PR into it) and watch the **Actions** tab —
   the `deploy` job's log is the same output you'd see running the
   commands by hand over SSH.
