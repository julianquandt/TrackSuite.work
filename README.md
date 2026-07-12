# TrackSuite.work

A **local-first**, cross-platform work-time tracker for Windows, macOS, and Linux — with an optional, self-hostable sync backend and a companion web app.

Track your hours with one click, organize time into projects, and see where it went — all stored locally on your machine. If you want your data on more than one device (or a browser), run the small sync server and everything stays in sync, end to end, with last-write-wins conflict resolution.

## Features

- **One-click clock in/out** from the app or the system tray.
- **Projects** — tag time to projects, switch mid-shift (auto-splits the session), quick-switch with number keys, and retag past time on a draggable day timeline.
- **Off-days & work schedules** — set per-day target hours and scheduled off-days.
- **Statistics** — weekly and trend charts, stacked by project, plus a per-project hours breakdown.
- **Local-first** — the desktop app is fully functional with **no account and no server**. Your data lives in a local SQLite database.
- **Optional multi-device sync** — a self-hosted FastAPI backend keeps desktop and web in sync (bidirectional, last-write-wins, tombstone-aware). Accounts are protected with **TOTP two-factor auth**.
- **In-app auto-updates** on Windows, macOS, and the Linux AppImage.

## Download

Grab the latest desktop build from the [**Releases**](https://github.com/julianquandt/TrackSuite.work/releases/latest) page:

- **Windows** — installer (`.exe`)
- **macOS** — `.dmg`
- **Linux** — `.deb`, `.rpm`, `.AppImage`, or Flatpak

The app works standalone; no account or server needed unless you want sync.

## Self-hosting the sync backend (optional)

Only needed if you want to sync across devices or use the web app. The backend is a small FastAPI service backed by SQLite. Full instructions — including Apache reverse-proxy config, systemd unit, TLS, and first-user setup — are in **[backend/DEPLOYMENT.md](backend/DEPLOYMENT.md)**.

In short:

```bash
git clone --filter=blob:none --sparse https://github.com/julianquandt/TrackSuite.work.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website
sudo ./backend/deploy.sh main
```

You supply two secrets via environment variables (a JWT signing secret and a Fernet encryption key — the service refuses to start with defaults), point the desktop app at your server URL + a sync API key, and you're done.

## How it works

- **Local-first storage.** The desktop app (Tauri + Rust + SQLite) is the source of truth on your machine and works entirely offline.
- **Optional sync.** When configured, the app reconciles its full local state with the server using last-write-wins per record; deletions propagate as tombstones, so nothing silently reappears.
- **Security.** Passwords are hashed with Argon2, TOTP secrets are encrypted at rest, sessions use short-lived JWTs with hashed refresh tokens, and every record is scoped to its owner. See the deployment guide for hardening notes.

## Building from source

- **Desktop app** (`desktop/`): [Tauri](https://tauri.app) 2 + TypeScript. `npm install && npm run tauri build`. Requires the Rust toolchain and the platform's WebView dependencies.
- **Web app** (`website/`): Vite + TypeScript. `npm install && npm run build`.
- **Backend** (`backend/`, `app_server/`): Python 3.12+ / FastAPI. Install `requirements_server.txt`, set the auth env vars, and run with Uvicorn (see the deployment guide).

## License

MIT — see [LICENSE](LICENSE).
