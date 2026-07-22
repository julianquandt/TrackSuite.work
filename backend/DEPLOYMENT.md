# Backend Deployment Guide

Deploy the TrackSuite.work backend on a Linux server using Apache2 as a reverse proxy.

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

Pick one of these before you continue:

- Full TrackSuite.work site: Apache serves the TrackSuite.work website from `website/dist` and proxies `/api/` to the backend. Users register in the browser. Use Apache Option A in Part 4.
- Backend API only: your existing website keeps `/`, and Apache proxies only a path such as `/tracksuite-work-api/` to the backend. There is no TrackSuite.work website in this setup. Use Apache Option B in Part 4.

With the current frontend build, the full TrackSuite.work website should live on its own site root or subdomain. If you already have another website at `/`, use backend API only on that site unless you want to rework the frontend for a subpath deployment.

For a private repository, run these commands on the server:

```bash
sudo mkdir -p /opt/work-time-app
sudo chown "$USER":"$USER" /opt/work-time-app
git clone --filter=blob:none --sparse git@github.com:YOUR_USERNAME/work-time-app.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website
sudo ./backend/deploy.sh main
```

If you only want the backend API and are not serving the TrackSuite.work website, use this final command instead so the website build is skipped:

```bash
sudo SKIP_WEBSITE_BUILD=1 ./backend/deploy.sh main
```

If your repository is public, you can also download the deploy script directly instead:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/work-time-app/main/backend/deploy.sh -o /tmp/tracksuite-work-deploy.sh
chmod +x /tmp/tracksuite-work-deploy.sh
sudo WORK_TIME_REPO_URL=git@github.com:YOUR_USERNAME/work-time-app.git /tmp/tracksuite-work-deploy.sh main
```

For a backend-only deployment from the downloaded script, use:

```bash
sudo SKIP_WEBSITE_BUILD=1 WORK_TIME_REPO_URL=git@github.com:YOUR_USERNAME/work-time-app.git /tmp/tracksuite-work-deploy.sh main
```

The server must have an SSH key or deploy key that can read the private repository.

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

If the server's own timezone differs from the one you track time in — a UTC VPS serving a Europe/Berlin user, say — set `WORK_TIME_REPORT_TIMEZONE` to your IANA zone. The desktop app stores wall-clock timestamps without an offset, and `/stats/daily-hours/` needs the zone to read them back into the right day and duration:

```ini
Environment="WORK_TIME_REPORT_TIMEZONE=Europe/Berlin"
```

If Apache runs on the same machine and proxies locally to `127.0.0.1`, you can leave `WORK_TIME_TRUSTED_PROXIES` unset. If you later put TrackSuite.work behind a different reverse proxy address, set `WORK_TIME_TRUSTED_PROXIES` accordingly so auth throttling uses the real client IP.

Then start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now work-time-backend
```

### Verify the running backend

Before you continue, confirm the service is running the current auth-enabled backend.

The API root should return status ok:

```bash
curl https://yourdomain.com/tracksuite-work-api/
```

Register should not return `404 Not Found`. A successful first registration returns `201`, and a duplicate email returns `409`:

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
sudo a2enmod proxy proxy_http ssl rewrite
sudo nano /etc/apache2/sites-available/tracksuite-work.conf
```

```apache
<VirtualHost *:80>
    ServerName yourdomain.com
    RewriteEngine On
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>

<VirtualHost *:443>
    ServerName yourdomain.com

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
    ProxyPass /api/ http://127.0.0.1:8007/
    ProxyPassReverse /api/ http://127.0.0.1:8007/

    # Block access to .git and backend source
    <DirectoryMatch "\.(git)">
        Require all denied
    </DirectoryMatch>

    # SSL via Certbot or manual config
    # SSLCertificateFile /etc/letsencrypt/live/yourdomain.com/fullchain.pem
    # SSLCertificateKeyFile /etc/letsencrypt/live/yourdomain.com/privkey.pem
</VirtualHost>
```

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