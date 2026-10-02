# TrackSuite.work

**Track your work hours with one click — on your desktop or in the browser.**

### → [tracksuite.work](https://tracksuite.work)

TrackSuite.work is a simple, private time tracker. Clock in when you start working, clock out when you stop, and see exactly where your hours went — organized by project, week, and day. Your data stays on your machine unless you choose to sync it.

## What you can do

- **Clock in and out in one click** — from the app window, your system tray, or a global keyboard shortcut ([HOTKEYS.md](HOTKEYS.md)), without breaking your flow.
- **Organize time by project** — tag your hours, switch projects mid-shift (it splits the session for you), and jump between projects with number keys.
- **Fix the past** — paint projects onto a visual day timeline, drag a block's edge to correct its time, or paint time you forgot to track onto an empty spot. Everything can be undone.
- **Set your schedule** — define target hours per day and mark off days (vacation, sick leave, public holidays), so you can see how you're tracking against your own goals.
- **Focus when you want to** — an optional Pomodoro timer next to the clock, with short and long breaks, a soft sound, and nothing in your way when it's off.
- **See where your time goes** — weekly and trend charts broken down by project, plus a clear per-project hours summary.
- **Bill and report** — client reports (hours × rate per project) and timesheets (hours vs. your schedule), with your letterhead, as CSV or PDF.
- **Work anywhere** — use the downloadable desktop app, the web app, or both together.

## Two ways to use it

**Desktop app** — the full experience, works completely offline, no account needed. Your data lives in a local database on your computer. Available for **Windows, macOS, and Linux**.

**Web app** — track your time from any browser, nothing to install.

Want your hours on more than one device? Sign in and everything syncs automatically between the desktop app and the web — with a sensible "most recent change wins" rule so nothing gets lost.

👉 **Get started at [tracksuite.work](https://tracksuite.work)** — download links, install instructions (including apt for Debian/Ubuntu), and the web app are all there.

## Download

The website has guided install instructions for every platform. If you'd rather grab a file directly, the latest desktop builds are on the [**Releases**](https://github.com/julianquandt/TrackSuite.work/releases/latest) page:

- **Windows** — installer (`.exe`)
- **macOS** — `.dmg`
- **Linux** — apt repository (recommended, auto-updating), `.deb`, `.rpm`, or `.AppImage`

The desktop app updates itself on Windows, macOS, and the Linux AppImage. Installed via apt? Updates arrive with your normal system updates.

**macOS, first launch:** the app isn't notarized by Apple, so macOS asks once before opening it. Open the app, then go to **System Settings → Privacy & Security** and click **Open Anyway** (on macOS 14 and older, right-click the app → Open works too). If macOS says the app "is damaged", run `xattr -cr "/Applications/TrackSuite.work.app"` in Terminal and open it again. Updates install without this step.

## Your data, your control

- **Private by default.** The desktop app works with **no account and no server** — nothing leaves your machine.
- **Sync only if you want it.** Multi-device sync is entirely optional — through tracksuite.work, or on a server you host yourself.
- **Secure when synced.** Accounts use two-factor authentication (TOTP), and every record is tied to its owner.

---

## For developers & self-hosters

<details>
<summary><strong>Architecture overview</strong></summary>

- **Desktop app** — [Tauri](https://tauri.app) 2 (Rust) with a TypeScript UI and a local SQLite database. It's the source of truth on your machine and works entirely offline.
- **Web app** — a Vite + TypeScript single-page app.
- **Sync backend** — a small FastAPI service backed by SQLite. When configured, the desktop app reconciles its full local state with the server using **last-write-wins per record**; deletions propagate as **tombstones**, so nothing silently reappears.
- **Shared code** — logic and UI pieces both apps use (timeline, undo, focus timer, date and shift rules) live in `shared/`, tested with `node --test`.
- **Security** — passwords are hashed with Argon2; email addresses, TOTP secrets, notes, project names and rates are encrypted at rest; sessions use short-lived JWTs with hashed refresh tokens; every record is scoped to its owner.

</details>

### Self-hosting the sync backend (optional)

Only needed if you want to sync across devices or use the web app on your own infrastructure. The backend is a small FastAPI service backed by SQLite. Full instructions — including Apache reverse-proxy config, systemd unit, TLS, and first-user setup — are in **[backend/DEPLOYMENT.md](backend/DEPLOYMENT.md)**.

In short:

```bash
git clone --filter=blob:none --sparse https://github.com/julianquandt/TrackSuite.work.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website shared
sudo ./backend/deploy.sh main
```

You supply two secrets via environment variables (a JWT signing secret and a Fernet encryption key — the service refuses to start with defaults), point the desktop app at your server URL + a sync API key, and you're done.

**Pick a signup policy.** A fresh instance accepts registrations from anyone who can reach it, which is rarely what you want on your own server:

```ini
# Just me: no signup form; create the account over SSH (see below).
WORK_TIME_SIGNUP_MODE=closed
WORK_TIME_MAX_USERS=1

# My team: colleagues enrol themselves, nobody else can.
WORK_TIME_SIGNUP_MODE=restricted
WORK_TIME_SIGNUP_ALLOWED_DOMAINS=acme.com
WORK_TIME_SIGNUP_INVITE_CODES=a-long-random-string
```

On a closed instance, accounts are created from the terminal — it prints a QR code, setup key and recovery codes, and needs no mail provider:

```bash
sudo -u www-data ./venv_server/bin/python -m app_server.cli create-user --email me@example.com
```

**You get the app, not our marketing** — the tracker (with statistics and reports) and the account page. The tracksuite.work landing page and download section are never part of your build, so `/` goes straight to the tracker. Nothing to configure.

Copy `website/.env.example` to `website/.env.local` if you publish your instance, to set the operator details for your own imprint and privacy policy.

### Building from source

- **Desktop app** (`desktop/`): [Tauri](https://tauri.app) 2 + TypeScript. `npm install && npm run tauri build`. Requires the Rust toolchain and the platform's WebView dependencies.
- **Web app** (`website/`): Vite + TypeScript. `npm install && npm run build`.
- Both apps import code from `shared/`, so build from a full checkout (or include `shared` in a sparse one). `npm run test:shared` in either app runs its tests.
- **Backend** (`backend/`, `app_server/`): Python 3.12+ / FastAPI. Install `requirements_server.txt`, set the auth env vars, and run with Uvicorn (see the deployment guide).

## License

MIT — see [LICENSE](LICENSE). Run it, fork it, rename it, sell it.
