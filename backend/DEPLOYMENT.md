# Backend Deployment Guide

Deploy the TrackSuite.work backend on a Linux server using Apache2 as a reverse proxy.

This file is the canonical guide. The self-hosting page on tracksuite.work is a summary of it and links back here; where the two disagree, this file is right.

**You need:** a Linux server (Ubuntu/Debian recommended), Python 3.12+ with `venv` (3.12 is what CI tests), Node.js 20.19+ or 22.12+ to build the web app, Git, and a reverse proxy with TLS.

## 0. Start Over From Scratch

To remove the currently installed backend service and all deployed files without touching Apache, run this on the server:

```bash
cd /opt/work-time-app
sudo ./backend/uninstall.sh
```

This removes:

- the `work-time-backend` systemd service
- `/etc/systemd/system/work-time-backend.service`
- `/opt/work-time-app`

Apache virtual hosts, enabled modules, and any existing Apache config are left unchanged.

After that, continue with Part 1 below to install again from scratch.

## 1. Initial Deployment

These steps assume you are using the bundled systemd service file unchanged. It runs the backend as `www-data`, and the deploy script sets up `/opt/work-time-app/data` so that user can write the SQLite database.

### Choose a deployment mode

Pick one of these before you continue. The differences are all configuration — there is one codebase and one build.

| | **Public** | **Single-user** | **Team / HR** |
|---|---|---|---|
| Who it's for | tracksuite.work itself | one person syncing their own devices | a company, staff only |
| Web signup | open to anyone | none at all | gated by email domain and/or invite code |
| Accounts created | in the browser | from the server's terminal | in the browser |
| Website built | full site incl. landing page + downloads | tracker only | tracker only |
| Email provider | required | not needed | optional but recommended |

**Single-user** — no signup form exists; you create your account once over SSH:

```ini
WORK_TIME_SIGNUP_MODE=closed
WORK_TIME_MAX_USERS=1
```

**Team / HR** — staff enrol themselves, nobody else can:

```ini
WORK_TIME_SIGNUP_MODE=restricted
WORK_TIME_SIGNUP_ALLOWED_DOMAINS=acme.com,acme.de
WORK_TIME_SIGNUP_INVITE_CODES=<paste a long random string>
WORK_TIME_INSTANCE_NAME=Acme Time
```

Set either restriction or both — with both, an address must match a permitted domain *and* present a valid invite code. See Part 3a for the full reference and Part 5a for creating accounts from the terminal.

Then pick how Apache serves it:

- Full site: Apache serves the website from `website/dist` and proxies `/api/` to the backend. Use Apache Option A in Part 4.
- Backend API only: your existing website keeps `/`, and Apache proxies only a path such as `/tracksuite-work-api/` to the backend. There is no website in this setup. Use Apache Option B in Part 4.

With the current frontend build, the website should live on its own site root or subdomain. If you already have another website at `/`, use backend API only on that site unless you want to rework the frontend for a subpath deployment.

**The build gives you the app, and only the app** — tracker, dashboard and reports. `/` goes straight to the tracker, or to the sign-in page. The tracksuite.work landing page, desktop-download section and self-hosting guide are never built: that is marketing for a hosted service, not part of what you are deploying. There is nothing to configure and nothing to switch off.

Copy `website/.env.example` to `website/.env.local` to publish your own imprint and privacy policy. That file is untracked, so it survives every deploy. See Part 3b.

Run these commands on the server:

```bash
sudo mkdir -p /opt/work-time-app
sudo chown "$USER":"$USER" /opt/work-time-app
git clone --filter=blob:none --sparse https://github.com/julianquandt/TrackSuite.work.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website shared
sudo ./backend/deploy.sh main
```

If you only want the backend API and are not serving the web app, use this final command instead so the website build is skipped:

```bash
sudo SKIP_WEBSITE_BUILD=1 ./backend/deploy.sh main
```

You can also fetch just the deploy script and let it do the cloning:

```bash
deploy_script="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/julianquandt/TrackSuite.work/main/backend/deploy.sh -o "$deploy_script"
chmod +x "$deploy_script"
sudo "$deploy_script" main
```

Use `mktemp` (above) rather than a fixed `/tmp/...` filename so another local user can't pre-create/symlink the path and win the race to run code as root.

Deploying **your own fork**, or a private repository? Point the script at it with `WORK_TIME_REPO_URL`, and give the server an SSH key or deploy key that can read it:

```bash
sudo WORK_TIME_REPO_URL=git@github.com:YOUR_USERNAME/YOUR_FORK.git "$deploy_script" main
```

The deploy script creates `/opt/work-time-app`, checks out only `backend/`, `app_server/`, and `website/`, creates a virtualenv at `/opt/work-time-app/venv_server/`, and ensures `/opt/work-time-app/data` is owned by the runtime user so SQLite can write there.

## 2. Generate Authentication Secrets

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Save both outputs. The backend now requires a strong JWT signing secret and a Fernet encryption key for MFA secret storage.

## 3. Systemd Service

```bash
sudo cp /opt/work-time-app/backend/work-time-backend.service /etc/systemd/system/
sudo nano /etc/systemd/system/work-time-backend.service
```

Set the `WORK_TIME_JWT_SECRET` and `WORK_TIME_ENCRYPTION_KEY` environment variables to the values you generated. Leave `User=` and `Group=` as `www-data` unless you intentionally want a different service account:

```ini
Environment="WORK_TIME_JWT_SECRET=<your-64-char-hex-secret>"
Environment="WORK_TIME_ENCRYPTION_KEY=<your-fernet-key>"
```

The backend **refuses to start** with the shipped `CHANGE-ME-...` placeholders (and with any value containing "change-me" or shorter than 32 chars), so a misconfigured deploy fails loudly instead of running on a known key.

**Recommended — keep secrets out of the world-readable unit file.** Anything set with `Environment=` is visible to any local user via `systemctl show`/`systemctl cat`. Put the secrets in a root-only file instead:

```bash
sudo tee /etc/work-time-backend.env >/dev/null <<'EOF'
WORK_TIME_JWT_SECRET=<your-64-char-hex-secret>
WORK_TIME_ENCRYPTION_KEY=<your-fernet-key>
EOF
sudo chmod 600 /etc/work-time-backend.env
sudo chown root:root /etc/work-time-backend.env
```

Then replace the two `Environment=` secret lines in the unit with:

```ini
EnvironmentFile=/etc/work-time-backend.env
```

systemd reads the file as root before dropping to `www-data`, so the service still gets the values while other local users can't read them.

If the server's own timezone differs from the one you track time in — a UTC VPS serving a Europe/Berlin user, say — set `WORK_TIME_REPORT_TIMEZONE` to your IANA zone. The desktop app stores wall-clock timestamps without an offset, and `/stats/daily-hours/` needs the zone to read them back into the right day and duration:

```ini
Environment="WORK_TIME_REPORT_TIMEZONE=Europe/Berlin"
```

If Apache runs on the same machine and proxies locally to `127.0.0.1`, you can leave `WORK_TIME_TRUSTED_PROXIES` unset. If you later put TrackSuite.work behind a different reverse proxy address, set `WORK_TIME_TRUSTED_PROXIES` accordingly so auth throttling uses the real client IP.

#### Email (Resend) — enables verification & security notices

Outgoing email is sent via [Resend](https://resend.com). Set these to turn it on:

```ini
Environment="RESEND_API_KEY=re_...your key..."
Environment="WORK_TIME_MAIL_FROM=TrackSuite.work <noreply@mail.yourdomain.com>"
Environment="WORK_TIME_PUBLIC_BASE_URL=https://yourdomain.com"
```

- `WORK_TIME_MAIL_FROM` must be an address on a domain you've verified in Resend.
- `WORK_TIME_PUBLIC_BASE_URL` is the public web-app URL, used to build the links in emails (verification, etc.). No trailing slash.

**Behavior:** with email configured, new registrations must **verify their email address** before they can finish authenticator enrollment or sign in (blocks account-squatting and confirms the address is reachable). Existing accounts are grandfathered as verified by the migration, so nobody is locked out. Email also powers password-change / account-deletion / authenticator-reset security notices.

**If you don't configure Resend**, email verification is simply **disabled** — registrations auto-verify, exactly like before — so the server still works fully without an email provider. (You then won't have breach-notification email or verification.)

Optional storage-limitation cleanup of long-inactive accounts (off by default; requires email so users get a warning first):

```ini
Environment="WORK_TIME_INACTIVE_WARN_DAYS=730"          # warn after ~24 months idle
Environment="WORK_TIME_INACTIVE_DELETE_GRACE_DAYS=30"   # delete 30 days after the warning if still idle
```

Then start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now work-time-backend
```

## 3a. Who may create an account (signup policy)

By default the instance is **open** — anyone who can reach it may register. That is right for a public service and wrong for almost every self-hosted one, so it is configurable. All of these go in the same `EnvironmentFile` as the secrets.

| Variable | Default | Meaning |
|---|---|---|
| `WORK_TIME_SIGNUP_MODE` | `open` | `open` \| `restricted` \| `closed` |
| `WORK_TIME_SIGNUP_ALLOWED_DOMAINS` | *(none)* | Comma-separated email domains permitted to register, e.g. `acme.com,acme.de`. Only applies in `restricted` mode. |
| `WORK_TIME_SIGNUP_INVITE_CODES` | *(none)* | Comma- or space-separated invite codes. Only applies in `restricted` mode. Treat as secrets. |
| `WORK_TIME_MAX_USERS` | `0` (unlimited) | Hard cap on the number of accounts, enforced in every mode. |
| `WORK_TIME_INSTANCE_NAME` | `TrackSuite.work` | Shown in the web app's header. |

Modes:

- **`open`** — anyone may register.
- **`restricted`** — an address must satisfy every restriction you configured. Domains only → staff self-enrol. Codes only → anyone holding the code. Both → both must match.
- **`closed`** — `/auth/register` refuses everything with `403`. Create accounts with the CLI in Part 5a.

Two safety behaviours worth knowing, both deliberate:

- A **typo** in `WORK_TIME_SIGNUP_MODE` is treated as `closed`, not `open`. A misspelled mode must never expose registration to the internet.
- `restricted` with **neither** domains nor codes configured refuses everything, rather than behaving like `open`.

The policy is checked *before* the duplicate-email check, so on a closed instance every registration attempt returns an identical response — the status code can't be used to probe which addresses already have accounts.

Check what an instance is advertising at any time:

```bash
curl -s https://yourdomain.com/api/meta/instance
```

That endpoint is public and returns only non-secret facts (mode, whether an invite is required, permitted domains, whether email is on). Invite codes are never exposed. The web app fetches it at startup so it doesn't offer a signup form the server would refuse.

## 3b. Website build configuration (imprint, privacy policy, branding)

The frontend is configured at **build** time, in `website/.env.local` — untracked, so `git checkout` during a deploy leaves it alone:

```bash
cp /opt/work-time-app/website/.env.example /opt/work-time-app/website/.env.local
sudo nano /opt/work-time-app/website/.env.local
sudo ./backend/deploy.sh main     # rebuilds the site with your values
```

What it controls: `VITE_LEGAL_*`, the operator details published in the Impressum, Privacy Policy and Terms.

**If you run a public instance from the EU, the legal values are not optional.** Austria (§ 25 MedienG, § 5 ECG) and Germany (§ 5 DDG) both require a reachable imprint, and Art. 13 GDPR requires a privacy notice naming the controller. Set `VITE_LEGAL_JURISDICTION` to `at` (default) or `de` and the pages cite that country's statutes, liability rules, data-protection authority and governing law; anything else gets a generic English imprint you should have reviewed locally.

Austria only: `VITE_LEGAL_SMALL_WEBSITE=1` switches the imprint to the reduced disclosure of § 25 Abs 5 MedienG — name, city and business purpose, **without a street address**. Read the caveat in `.env.example` before using it; it is available to a site that presents nothing beyond the operator's own affairs and has no influence on public opinion.

Leave `VITE_LEGAL_NAME` empty on an app-only build and no legal pages are published at all — the correct choice for an internal company instance already covered by the company's own imprint and privacy notice. Set it and leave a mandatory field blank, and the page renders a visible warning telling you which one.

### Publishing updated terms

Two version strings must move together, or accounts will be prompted to accept terms whose published text hasn't changed (or worse, not prompted when it has):

| Where | Setting | Purpose |
| --- | --- | --- |
| `website/.env.local` | `VITE_LEGAL_EFFECTIVE_DATE` | The "last updated" stamp shown on the pages |
| systemd unit | `WORK_TIME_TOS_VERSION` | What the backend records against each account |

After a change, every account whose stored version differs sees a one-time prompt on next load, linking the Terms and Privacy Policy and recording acceptance against the new version. `GET /auth/tos` reports the state for the signed-in account; `POST /auth/tos/accept` records it, and rejects a version string that isn't current so a stale browser tab can't accept terms it never displayed.

The prompt is notice, not a gate — it can be dismissed, and returns next load. Someone who does not agree keeps access to export and account deletion, which the Terms explicitly promise them.

This prompt *is* the notice § 9 of the Terms commits you to: a material change takes effect for a user the next time they use the service after seeing it. No mailout is required. Discontinuing the service is the separate case — § 5 still promises 30 days' email notice, because silently switching off a server people keep data on is the one change that can actually harm them. `list-users` (§ 5a) gets you the addresses.

## 3c. Verify the running backend

Before you continue, confirm the service is running the current auth-enabled backend.

The API root should return status ok:

```bash
curl https://yourdomain.com/tracksuite-work-api/
```

Confirm the signup policy you configured in Part 3a is the one actually in force:

```bash
curl -s https://yourdomain.com/tracksuite-work-api/meta/instance
```

Register should not return `404 Not Found`. A successful first registration returns `201`, and a duplicate email returns `409`. (On a `restricted` or `closed` instance this correctly returns `403` instead — that is the policy working, not a fault; create the account with the CLI in Part 5a.)

```bash
curl -i -X POST https://yourdomain.com/tracksuite-work-api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters"}'
```

If `/auth/register` returns `404`, your server is still running older backend code. In that case, rerun the deploy script and restart the service:

```bash
cd /opt/work-time-app
sudo ./backend/deploy.sh main
sudo systemctl restart work-time-backend
```

## 4. Apache2 Reverse Proxy

Choose one of these setups.

### Option A: Full TrackSuite.work site (website + API)

Use this if TrackSuite.work should be the main app at a domain or subdomain such as `tracksuite-work.example.com`.

This is the right choice if you want both the browser UI and the API. With the current frontend build, do not try to mount the TrackSuite.work website under a subpath such as `/tracksuite-work/` inside an existing site.

```bash
sudo a2enmod proxy proxy_http ssl rewrite headers
sudo nano /etc/apache2/sites-available/tracksuite-work.conf
```

> **Do not expose the service until TLS is actually on.** The `:443` block
> below enables `SSLEngine on` and references certificate files. Run Certbot (or
> install certs) **before** enabling the site — otherwise Apache serves the vhost
> without a usable certificate and clients could send passwords/tokens in the
> clear. All API traffic (bearer tokens, API keys, passwords) must only ever
> travel over HTTPS.

```apache
<VirtualHost *:80>
    ServerName yourdomain.com
    RewriteEngine On
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>

<VirtualHost *:443>
    ServerName yourdomain.com

    SSLEngine on
    SSLProtocol -all +TLSv1.2 +TLSv1.3

    # Security headers
    Header always set Strict-Transport-Security "max-age=63072000; includeSubDomains"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    Header always set Content-Security-Policy "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"

    # `connect-src 'self'` is deliberate and load-bearing: the page must not be
    # able to call a third party directly, because that would transmit every
    # visitor's IP to it automatically. The download list comes from GitHub via
    # /api/meta/releases/latest (server-side, cached) for exactly this reason —
    # if downloads ever stop listing individual files, fix the backend, do not
    # whitelist api.github.com here.

    # Serve the static website
    DocumentRoot /opt/work-time-app/website/dist
    <Directory /opt/work-time-app/website/dist>
        Options -Indexes
        AllowOverride None
        Require all granted
        DirectoryIndex index.html
        # The website uses hash-based routes (#/login, #/dashboard), so unknown
        # paths should stay 404 instead of falling back to index.html.
    </Directory>

    # Proxy /api/ -> FastAPI backend (strip /api prefix)
    ProxyPreserveHost On
    # Overwrite (don't append) X-Forwarded-For so a client can't spoof the hop
    # the backend trusts for per-IP rate limiting. mod_proxy adds the real
    # client as the right-most entry, which the backend then uses.
    RequestHeader set X-Forwarded-For "%{REMOTE_ADDR}s"
    # Cap request bodies at the proxy too (defence in depth; the app also caps at
    # 32 MB). Full-state sync of a very large history is well under this.
    LimitRequestBody 33554432
    ProxyPass /api/ http://127.0.0.1:8007/
    ProxyPassReverse /api/ http://127.0.0.1:8007/

    # Block access to .git and backend source
    <DirectoryMatch "\.(git)">
        Require all denied
    </DirectoryMatch>

    # SSL certificate (Certbot writes these; must exist before enabling the site)
    SSLCertificateFile /etc/letsencrypt/live/yourdomain.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/yourdomain.com/privkey.pem
</VirtualHost>
```

For **Option B** (backend under an existing site), add the same security-header
lines and the `RequestHeader set X-Forwarded-For "%{REMOTE_ADDR}s"` directive
inside your existing `:443` vhost, and make sure the API path is only reachable
over HTTPS.

```bash
sudo a2ensite tracksuite-work.conf
sudo systemctl restart apache2
```

### Option B: Backend API only on an existing Apache site

Use this if your existing website already owns `/` and you only want to expose the TrackSuite.work backend on a dedicated endpoint such as `/tracksuite-work-api/`.

Add these lines inside your existing `<VirtualHost *:443>` block:

```apache
ProxyPreserveHost On
ProxyPass /tracksuite-work-api/ http://127.0.0.1:8007/
ProxyPassReverse /tracksuite-work-api/ http://127.0.0.1:8007/
```

Then set the desktop app server URL to:

```text
https://yourdomain.com/tracksuite-work-api
```

This keeps your current Apache `DocumentRoot` unchanged and only forwards requests under `/tracksuite-work-api/` to TrackSuite.work.

## 5. Authentication Flow

The backend uses short-lived **JWT access tokens** plus **refresh-token-backed browser sessions** for interactive use, and **API keys** for desktop app sync.
Users can register, log in, and manage API keys through the web portal if you deployed the TrackSuite.work website. The desktop app does not create accounts or log in directly. It only needs the API base URL and a sync API key.

If you only exposed the backend on a path such as `/tracksuite-work-api/`, there is no browser registration page there, so create the first user with the API.

### Register the first user

If you deployed the full TrackSuite.work website on its own domain or subdomain, open that site in a browser and use the sign-up form.

If you exposed only the backend under an existing Apache site, register with a direct API call:

```bash
curl -X POST https://yourdomain.com/tracksuite-work-api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters"}'
```

The registration response includes `totp_secret` and leaves the account in a pending MFA-enrollment state. Add that secret to your authenticator app and then confirm the enrollment with the first 6-digit code before you try to log in.

If you used the dedicated TrackSuite.work site setup from Option A, the equivalent API endpoint is:

```bash
curl -X POST https://tracksuite-work.example.com/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters"}'
```

### Confirm enrollment, save recovery codes, and create a sync key

After registration, confirm the authenticator enrollment. This returns an access token, a refresh token, session metadata, and a one-time set of recovery codes. Save the recovery codes offline immediately.

```bash
curl -X POST https://yourdomain.com/tracksuite-work-api/auth/mfa/confirm-enrollment \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters","otp":"123456","device_name":"Initial browser"}'
```

For the dedicated website deployment from Option A, use:

```bash
curl -X POST https://tracksuite-work.example.com/api/auth/mfa/confirm-enrollment \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters","otp":"123456","device_name":"Initial browser"}'
```

Later sign-ins use the normal login endpoint, and each recovery code can be used once with `/auth/login/recovery` if the authenticator is unavailable.

```bash
curl -X POST https://yourdomain.com/tracksuite-work-api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"you@example.com","password":"choose-a-password-with-at-least-8-characters","otp":"123456","device_name":"Primary browser"}'
```

After enrollment confirmation or a later login, create an API key with the returned access token:

```bash
curl -X POST https://yourdomain.com/tracksuite-work-api/auth/api-keys \
    -H "Authorization: Bearer YOUR_JWT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"Desktop app"}'
```

Paste the returned API key into the desktop app settings for sync.

## 5a. Managing accounts from the terminal

On a `closed` instance there is no signup form, so accounts come from the CLI. It needs the *same environment as the service* — above all `WORK_TIME_ENCRYPTION_KEY`, since the email address and authenticator secret are encrypted at rest and the wrong key produces an unusable account.

```bash
cd /opt/work-time-app
sudo -u www-data env $(grep -v '^#' /etc/work-time-backend.env | xargs) \
    ./venv_server/bin/python -m app_server.cli create-user --email me@example.com
```

It prompts for a password (so it stays out of your shell history), then prints a QR code, the manual setup key and ten recovery codes. Scan or type the key into your authenticator app and save the recovery codes — they are shown once. The account is created fully active: no email round-trip to complete, so it works on an instance with no mail provider at all.

Install `qrencode` (`sudo apt install qrencode`) for the QR code; without it you get the setup key and the `otpauth://` URI, which every authenticator app accepts as manual entry.

Other commands, same invocation pattern:

| Command | Purpose |
|---|---|
| `list-users` | Accounts on this instance and their state. |
| `reset-password --email …` | New password; signs the user out everywhere. |
| `reset-2fa --email …` | New authenticator secret + recovery codes. The lost-phone escape hatch when no mailer is configured. |
| `recovery-codes --email …` | Fresh recovery codes; voids the old set. |
| `delete-user --email …` | Permanent, irreversible deletion of the account and all its data. Prompts unless you pass `--yes`. |

## 6. Updating

```bash
cd /opt/work-time-app
sudo ./backend/deploy.sh main
sudo systemctl restart work-time-backend
```

The first deploy needs `WORK_TIME_REPO_URL`. Later updates reuse the `origin` URL already stored in `/opt/work-time-app/.git/`.

If you want to remove the backend entirely and reinstall cleanly later, use:

```bash
cd /opt/work-time-app
sudo ./backend/uninstall.sh
```

## 7. Sync Data Model and Client Compatibility

As of v0.7.0 the server uses a robust bidirectional, last-write-wins sync model. Shifts and off-days now carry a stable `uuid`, an `updated_at` timestamp, and a soft-delete tombstone (`deleted`/`deleted_at`). Desktop clients reconcile their full local state against the server through `POST /sync/`, and deletions propagate instead of silently reappearing.

### Schema migration is automatic

No manual database steps are required. On startup the backend additively adds the new columns, backfills identity/timestamps for existing rows, collapses any pre-existing duplicate off-days, and adds a unique `(user_id, date)` constraint. The migration is **non-destructive** — existing shifts and off-days keep all their data. As always, take a copy of `data/work_time_server.db` before upgrading if you want a rollback point.

### Older clients keep working

The upgrade is backward compatible. All previous endpoints and request/response shapes are preserved; the new fields are optional on input and additive on output, so pre-v0.7.0 desktop and web clients continue to sync without changes. The server fills in `uuid`/`updated_at` on their behalf and hides tombstoned rows from their `GET` responses.

**One transition caveat:** a pre-v0.7.0 **desktop** app is push-only and re-uploads its full local state without understanding tombstones. If someone deletes a shift or off-day on an updated client, an old desktop client that still holds that item locally can *resurrect* it on its next sync. This is not a crash or data loss — it only affects cross-client deletions, and it stops once everyone updates. To avoid it entirely for browser users, deploy the updated `website/` alongside the backend (the served web app is always current), and encourage colleagues on the old desktop app to update.

## 8. Data-at-rest encryption & key rotation

Sensitive fields are encrypted at rest with the Fernet key in `WORK_TIME_ENCRYPTION_KEY`: report profile/letterhead, TOTP secrets, **email addresses, shift notes, project names, hourly rates, the work schedule, API-key names, and session labels**. Timestamps, IDs, colors, and currencies stay in clear (needed for server-side logic and not identifying on their own). An attacker who exfiltrates only the SQLite file — without the key — gets ciphertext for all of the above.

Keep the encryption key off the same disk/backup as the database where practical, and enable full-disk encryption on the host.

**Rotating the encryption key** (e.g. suspected key exposure):

1. Generate a new Fernet key.
2. Move the current key into `WORK_TIME_OLD_ENCRYPTION_KEYS` (comma-separated; holds one or more retired keys) and set the new key as `WORK_TIME_ENCRYPTION_KEY`.
3. Restart the service. On startup the backend re-encrypts every value still under an old key with the new key (reads try all keys; writes use the new one).
4. Once the logs/DB confirm migration, remove the old key from `WORK_TIME_OLD_ENCRYPTION_KEYS` and restart again.

Rotating `WORK_TIME_JWT_SECRET` simply invalidates existing access tokens; clients transparently re-authenticate with their refresh tokens (or re-login).

## 9. Backups (encrypted)

Use the bundled **`backend/backup.sh`** — it takes a WAL-safe snapshot, encrypts it (age or GPG), and prunes old backups. It refuses to run without a recipient, so it never leaves an unencrypted copy on disk.

Generate the key **on your own machine, not the server** — a private key sitting next to the database it decrypts protects nobody:

```bash
age-keygen -o ~/tracksuite-backup.key   # prints the age1... recipient; keep the file safe
```

```bash
# One-off (age recommended):
WORK_TIME_BACKUP_AGE_RECIPIENT=age1yourpublickey... ./backend/backup.sh

# Nightly via cron (crontab -e as root), keeping 30 days:
0 3 * * * WORK_TIME_BACKUP_AGE_RECIPIENT=age1... WORK_TIME_BACKUP_KEEP_DAYS=30 WORK_TIME_BACKUP_OWNER=youruser /opt/work-time-app/backend/backup.sh >> /var/log/wtt-backup.log 2>&1
```

`WORK_TIME_BACKUP_OWNER` is what lets you pull the files off the box. Root's cron writes them `root:root 0600` in a `0700` directory, so `rsync` over SSH as an ordinary user fails with `Permission denied`. Setting it hands the directory and each encrypted file to that user. Prefer it over granting passwordless `sudo rsync`, which would give root read access to the entire filesystem to anyone holding that user's SSH key — what this grants instead is blobs they can't decrypt without the age key. If you have existing root-owned backups, take them over once:

```bash
sudo chown -R youruser /opt/work-time-app/backups
```

Then pull them from your machine:

```bash
rsync -avz --delete server:/opt/work-time-app/backups/ ~/backups/tracksuite/
```

**Back up `WORK_TIME_ENCRYPTION_KEY` separately too** (see Part 8). Email addresses, TOTP secrets, notes, project names and rates are encrypted at rest, so a restored database without that key is ciphertext — a perfect backup of unreadable data. Keep it wherever you keep the age key, not inside the backups it decrypts.

Verify a restore occasionally, which is also how you confirm you still have both keys:

```bash
age -d -i ~/tracksuite-backup.key -o /tmp/restored.db ~/backups/tracksuite/work_time_server-<stamp>.db.age
sqlite3 /tmp/restored.db "select count(*) from users;"
```

Store the encrypted backups **off-box** and keep the age/GPG private key somewhere separate from the server (a backup you can't decrypt after the server is lost is useless; a key on the same disk defeats the encryption). Test a restore periodically: decrypt, then point `WORK_TIME_DB_FILE` at the restored copy. **Note:** a deleted account persists in existing backups until they rotate out of the retention window — state this in your privacy policy, and don't selectively restore individual deleted accounts.

## 10. Data-subject rights (GDPR)

The backend exposes self-service endpoints so account holders can exercise their rights without manual DB work:

- `GET /account/export` — machine-readable JSON export of everything held for the account (Art. 15/20).
- `POST /account/delete` (password + OTP) — irreversibly hard-deletes the user and all their data, then `VACUUM`s the file (Art. 17).
- `POST /auth/password` (current password + OTP) — password change; revokes all other sessions.

A background sweep also enforces storage limitation: tombstones are purged after 180 days, expired/revoked sessions (and their IP/user-agent) after a 30-day grace, aged auth-rate-limit rows after a day, and never-enrolled (unconfirmed) accounts after 48 hours. Set `WORK_TIME_DISABLE_MAINTENANCE=1` to disable the sweep.

### Audit logging (breach-notification readiness)

The backend logs PII-light security events (register, login success/failure, enrollment, MFA reset, password change, account export/deletion, email verification, API-key creation) to stdout, which systemd captures in the journal. It never logs passwords, tokens, OTPs, or note/content — only the event name, the actor's user id, and the client IP. This is what lets you determine *who* was affected after an incident (Art. 33/34). View and cap retention:

```bash
journalctl -u work-time-backend | grep 'tracksuite.audit'
# Cap journald retention (also covers the IPs in these logs):
#   /etc/systemd/journald.conf → MaxRetentionSec=90d
```

## 11. Server maintenance

- Enable unattended security updates (`sudo apt install unattended-upgrades`).
- Confirm the Certbot renewal timer is active: `systemctl list-timers | grep certbot`.
- Cap journald retention so logs (which include client IPs) don't accumulate indefinitely — set `MaxRetentionSec=90d` in `/etc/systemd/journald.conf`.
- Re-run the deploy script periodically to pick up dependency and security fixes.