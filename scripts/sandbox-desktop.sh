#!/bin/bash
# Run the desktop app from this checkout in a sandbox, so your real data and
# settings can't be touched:
#   - its own database and webview storage   (XDG_DATA_HOME  -> sandbox)
#   - its own autostart entry                (XDG_CONFIG_HOME -> sandbox,
#                                              all other config linked to yours)
#   - no sync: a copied database has its server URL and key removed
#
# Usage (from the repo root):
#   scripts/sandbox-desktop.sh            start with an empty database
#   scripts/sandbox-desktop.sh copy       start with a COPY of your real data
#   scripts/sandbox-desktop.sh backup     only back up your real database
#   scripts/sandbox-desktop.sh reset      delete the sandbox
#
# Your real database (~/.local/share/work-time-app/data.db) is only ever
# opened read-only, and only by "copy" and "backup".
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${SANDBOX:-$HOME/.cache/tracksuite-sandbox}"
REAL_DB="$HOME/.local/share/work-time-app/data.db"
SANDBOX_DB="$SANDBOX/data/work-time-app/data.db"
MODE="${1:-empty}"

# Consistent read-only copy via SQLite's backup API (safe while the installed
# app is running; never writes to the source).
copy_db() {
    python3 - "$1" "$2" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()
PY
}

case "$MODE" in
    reset)
        rm -rf "$SANDBOX"
        echo "Sandbox removed: $SANDBOX"
        exit 0
        ;;
    backup)
        [ -f "$REAL_DB" ] || { echo "No real database at $REAL_DB"; exit 1; }
        out="$HOME/tracksuite-backup-$(date +%Y%m%d-%H%M%S).db"
        copy_db "$REAL_DB" "$out"
        echo "Backup written: $out"
        exit 0
        ;;
    copy)
        [ -f "$REAL_DB" ] || { echo "No real database at $REAL_DB"; exit 1; }
        mkdir -p "$(dirname "$SANDBOX_DB")"
        rm -f "$SANDBOX_DB" "$SANDBOX_DB-wal" "$SANDBOX_DB-shm"
        copy_db "$REAL_DB" "$SANDBOX_DB"
        # Cut the copy off from the server: without URL and key it never syncs,
        # so nothing you try here can reach your real account.
        python3 - "$SANDBOX_DB" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("DELETE FROM config WHERE key IN ('server_url', 'api_key', 'user_id', 'last_synced_at')")
c.commit(); c.close()
PY
        echo "Copied your data into the sandbox (sync settings removed)."
        ;;
    empty)
        mkdir -p "$(dirname "$SANDBOX_DB")"
        ;;
    *)
        echo "Unknown mode: $MODE (use: empty, copy, backup, reset)"
        exit 1
        ;;
esac

# The sandbox config folder mirrors your real ~/.config (links), except
# "autostart": that is the only config the app writes. So the system theme
# (dconf), GTK settings and fonts stay yours, but your login entry is safe.
REAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$SANDBOX/config/autostart"
for entry in "$REAL_CONFIG"/* "$REAL_CONFIG"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in autostart|com.tracksuite-work.desktop|work-time-app) continue ;; esac
    ln -sfn "$entry" "$SANDBOX/config/$name"
done
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"

echo "Sandbox: $SANDBOX"
echo "Starting the dev build (a second tray icon appears; quit it from its tray menu)."
cd "$REPO/desktop"
npm run tauri dev
