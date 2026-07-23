# TrackSuite.work

**Track your work hours with one click — on your desktop or in the browser.**

### → [tracksuite-work.julianquandt.com](https://tracksuite-work.julianquandt.com)

TrackSuite.work is a simple, private time tracker. Clock in when you start working, clock out when you stop, and see exactly where your hours went — organized by project, week, and day. Your data stays on your machine unless you choose to sync it.

## What you can do

- **Clock in and out in one click** — from the app window or right from your system tray, without breaking your flow.
- **Organize time by project** — tag your hours, switch projects mid-shift (it splits the session for you), and jump between projects with number keys.
- **Fix the past** — forgot to tag some time? Drag across a visual day timeline to reassign it after the fact.
- **Set your schedule** — define target hours per day and mark scheduled off-days, so you can see how you're tracking against your own goals.
- **See where your time goes** — weekly and trend charts broken down by project, plus a clear per-project hours summary.
- **Work anywhere** — use the downloadable desktop app, the web app, or both together.

## Two ways to use it

**Desktop app** — the full experience, works completely offline, no account needed. Your data lives in a local database on your computer. Available for **Windows, macOS, and Linux**.

**Web app** — track your time from any browser, nothing to install.

Want your hours on more than one device? Sign in and everything syncs automatically between the desktop app and the web — with a sensible "most recent change wins" rule so nothing gets lost.

👉 **Get started at [tracksuite-work.julianquandt.com](https://tracksuite-work.julianquandt.com)** — download links, install instructions (including apt for Debian/Ubuntu), and the web app are all there.

## Download

The website has guided install instructions for every platform. If you'd rather grab a file directly, the latest desktop builds are on the [**Releases**](https://github.com/julianquandt/TrackSuite.work/releases/latest) page:

- **Windows** — installer (`.exe`)
- **macOS** — `.dmg`
- **Linux** — apt repository (recommended, auto-updating), `.deb`, `.rpm`, or `.AppImage`

The desktop app updates itself on Windows, macOS, and the Linux AppImage. Installed via apt? Updates arrive with your normal system updates.

## Your data, your control

- **Private by default.** The desktop app works with **no account and no server** — nothing leaves your machine.
- **Sync only if you want it.** Multi-device sync is entirely optional and runs on a server you host yourself.
- **Secure when synced.** Accounts use two-factor authentication (TOTP), and every record is tied to its owner.

---

## For developers & self-hosters

<details>
<summary><strong>Architecture overview</strong></summary>

- **Desktop app** — [Tauri](https://tauri.app) 2 (Rust) with a TypeScript UI and a local SQLite database. It's the source of truth on your machine and works entirely offline.
- **Web app** — a Vite + TypeScript single-page app.
- **Sync backend** — a small FastAPI service backed by SQLite. When configured, the desktop app reconciles its full local state with the server using **last-write-wins per record**; deletions propagate as **tombstones**, so nothing silently reappears.
- **Security** — passwords are hashed with Argon2, TOTP secrets are encrypted at rest, sessions use short-lived JWTs with hashed refresh tokens, and every record is scoped to its owner.

</details>

### Self-hosting the sync backend (optional)

Only needed if you want to sync across devices or use the web app on your own infrastructure. The backend is a small FastAPI service backed by SQLite. Full instructions — including Apache reverse-proxy config, systemd unit, TLS, and first-user setup — are in **[backend/DEPLOYMENT.md](backend/DEPLOYMENT.md)**.

In short:

```bash
git clone --filter=blob:none --sparse https://github.com/julianquandt/TrackSuite.work.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website
sudo ./backend/deploy.sh main
```

You supply two secrets via environment variables (a JWT signing secret and a Fernet encryption key — the service refuses to start with defaults), point the desktop app at your server URL + a sync API key, and you're done.

### Building from source

- **Desktop app** (`desktop/`): [Tauri](https://tauri.app) 2 + TypeScript. `npm install && npm run tauri build`. Requires the Rust toolchain and the platform's WebView dependencies.
- **Web app** (`website/`): Vite + TypeScript. `npm install && npm run build`.
- **Backend** (`backend/`, `app_server/`): Python 3.12+ / FastAPI. Install `requirements_server.txt`, set the auth env vars, and run with Uvicorn (see the deployment guide).

## License

MIT — see [LICENSE](LICENSE).
