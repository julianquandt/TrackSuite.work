#!/bin/bash
# Run the web app from this checkout against a LOCAL server with its own
# throwaway database. Nothing here talks to tracksuite.work or your account.
#
# Usage (from the repo root):
#   scripts/sandbox-web.sh          start (keeps the sandbox account between runs)
#   scripts/sandbox-web.sh reset    delete the sandbox database first
#
# A test account with sample data is created on the first run, and the
# browser opens already signed in to it (a dev-only sign-in link; it does not
# exist in the production build). Stop with Ctrl+C - that stops everything.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="${SANDBOX:-$HOME/.cache/tracksuite-sandbox/web}"
PY="$REPO/.venv/bin/python"
[ -x "$PY" ] || { echo "Missing $PY - create the venv first (see README)."; exit 1; }

if [ "${1:-}" = "reset" ]; then rm -rf "$SANDBOX"; echo "Sandbox removed."; fi
mkdir -p "$SANDBOX"

# Fixed throwaway secrets so sessions survive restarts of the sandbox.
[ -f "$SANDBOX/fernet.key" ] || "$PY" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" > "$SANDBOX/fernet.key"

export WORK_TIME_JWT_SECRET="sandbox-only-not-a-real-secret-0123456789abcdef"
export WORK_TIME_ENCRYPTION_KEY="$(cat "$SANDBOX/fernet.key")"
export WORK_TIME_DB_FILE="$SANDBOX/server.db"
export WORK_TIME_DISABLE_MAINTENANCE=1

cd "$REPO"
"$PY" -m uvicorn backend.app_server.main:app --host 127.0.0.1 --port 8007 > "$SANDBOX/server.log" 2>&1 &
SERVER_PID=$!
VITE_PID=""
trap 'kill $SERVER_PID ${VITE_PID} 2>/dev/null' EXIT
echo "Local server starting (log: $SANDBOX/server.log)..."

# Wait for the server, then sign the sandbox account in (created on first run).
for _ in $(seq 1 40); do
    curl -s -o /dev/null http://127.0.0.1:8007/meta/instance && break
    sleep 0.25
done
LOGIN_HASH="$("$PY" "$REPO/scripts/sandbox_web_seed.py" "$SANDBOX")"

cd "$REPO/website"
npx vite --port 3000 --strictPort &
VITE_PID=$!
for _ in $(seq 1 40); do
    curl -s -o /dev/null http://localhost:3000/ && break
    sleep 0.25
done

URL="http://localhost:3000/?sandbox=1${LOGIN_HASH}"
echo ""
echo "Signed in as sandbox@example.com - opening the browser."
echo "If it doesn't open, use this link: $URL"
xdg-open "$URL" >/dev/null 2>&1 || true
wait "$VITE_PID"
