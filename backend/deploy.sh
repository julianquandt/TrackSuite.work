#!/bin/bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/work-time-app}"
BRANCH="${1:-main}"
# Upstream. Only used for a first deploy that isn't already a checkout and
# didn't set WORK_TIME_REPO_URL — deploying a fork means setting that variable.
DEFAULT_REPO_URL="https://github.com/julianquandt/TrackSuite.work.git"
APP_USER="${APP_USER:-www-data}"
APP_GROUP="${APP_GROUP:-www-data}"
SKIP_PYTHON_SETUP="${SKIP_PYTHON_SETUP:-0}"
SKIP_WEBSITE_BUILD="${SKIP_WEBSITE_BUILD:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_git_repo() {
    [ -d "$DEPLOY_DIR" ] && git -C "$DEPLOY_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

resolve_repo_url() {
    if [ -n "${WORK_TIME_REPO_URL:-}" ]; then
        printf '%s\n' "$WORK_TIME_REPO_URL"
        return
    fi

    if is_git_repo; then
        git -C "$DEPLOY_DIR" remote get-url origin 2>/dev/null && return
    fi

    if git -C "$SCRIPT_DIR/.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null && return
    fi

    printf '%s\n' "$DEFAULT_REPO_URL"
}

configure_origin() {
    if git -C "$DEPLOY_DIR" remote get-url origin >/dev/null 2>&1; then
        git -C "$DEPLOY_DIR" remote set-url origin "$REPO_URL"
    else
        git -C "$DEPLOY_DIR" remote add origin "$REPO_URL"
    fi
}

configure_sparse_checkout() {
    if git -C "$DEPLOY_DIR" sparse-checkout init --cone >/dev/null 2>&1; then
        git -C "$DEPLOY_DIR" sparse-checkout set backend app_server website shared
        return
    fi

    git -C "$DEPLOY_DIR" config core.sparseCheckout true
    mkdir -p "$DEPLOY_DIR/.git/info"
    cat > "$DEPLOY_DIR/.git/info/sparse-checkout" <<'EOF'
backend/*
app_server/*
website/*
shared/*
EOF
}

ensure_runtime_permissions() {
    mkdir -p "$DEPLOY_DIR/data"

    if [ "$(id -u)" -ne 0 ]; then
        echo "Warning: not running as root; leaving $DEPLOY_DIR/data ownership unchanged." >&2
        return
    fi

    if ! getent passwd "$APP_USER" >/dev/null 2>&1; then
        echo "Error: user '$APP_USER' does not exist on this system." >&2
        exit 1
    fi

    if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
        echo "Error: group '$APP_GROUP' does not exist on this system." >&2
        exit 1
    fi

    chown -R "$APP_USER:$APP_GROUP" "$DEPLOY_DIR/data"
    chmod 750 "$DEPLOY_DIR/data"
}

REPO_URL="$(resolve_repo_url)"

echo "Starting deployment (branch: $BRANCH)..."

if [ "$REPO_URL" = "$DEFAULT_REPO_URL" ] && ! is_git_repo; then
    echo "Cloning upstream: $REPO_URL"
    echo "  (deploying a fork? set WORK_TIME_REPO_URL to its clone URL instead.)"
fi

if is_git_repo; then
    echo "Updating existing repository..."
else
    echo "Initializing new repository with sparse-checkout..."
    mkdir -p "$DEPLOY_DIR"
    git -C "$DEPLOY_DIR" init >/dev/null
fi

configure_origin
configure_sparse_checkout
git -C "$DEPLOY_DIR" fetch --depth=1 origin "$BRANCH"
git -C "$DEPLOY_DIR" checkout -B "$BRANCH" "origin/$BRANCH"

# ── Backend ──────────────────────────────────────────────────────

ensure_runtime_permissions

if [ "$SKIP_PYTHON_SETUP" != "1" ]; then
    if [ ! -d "$DEPLOY_DIR/venv_server" ]; then
        echo "Creating virtual environment..."
        python3 -m venv "$DEPLOY_DIR/venv_server"
    fi

    echo "Installing server dependencies..."
    source "$DEPLOY_DIR/venv_server/bin/activate"
    pip install --upgrade pip
    pip install -r "$DEPLOY_DIR/backend/requirements.txt"
else
    echo "Skipping Python environment setup."
fi

# ── Website ──────────────────────────────────────────────────────

if [ "$SKIP_WEBSITE_BUILD" = "1" ]; then
    echo "Skipping website build."
elif command -v node >/dev/null 2>&1 && [ -f "$DEPLOY_DIR/website/package.json" ]; then
    echo "Building website..."
    cd "$DEPLOY_DIR/website"

    # Per-deployment build config (the operator details behind the imprint and
    # privacy policy) lives in website/.env.local — untracked, so it survives the
    # checkout above, and Vite reads it itself. Every build is the app alone;
    # see vite.config.ts.
    if [ ! -f .env.local ]; then
        echo "  No website/.env.local — building without legal pages."
        echo "  See website/.env.example to publish your own imprint."
    fi

    npm ci 2>/dev/null || npm install
    npm run build
    cd "$DEPLOY_DIR"
    echo "Website built → website/dist/"
else
    echo "Skipping website build (Node.js not found or website/ missing)."
    echo "Install Node.js 20.19+ (or 22.12+) to build the website."
fi

echo "--------------------------------------------------"
echo "Deployment successful!"
echo ""

# ── Restart the backend so the new code actually takes effect ─────
# This script only updates files (code, venv, frontend). The running Python
# process keeps serving the OLD code — and its startup migrations don't run —
# until it is restarted. A repeat deploy therefore serves a fresh frontend
# against a stale backend (new routes 404, new columns missing) unless we
# restart here. Auto-restart when we can (root + systemd + the unit already
# installed); otherwise print the exact command / first-time setup steps.
SERVICE="work-time-backend"
if command -v systemctl >/dev/null 2>&1 && systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
        echo "Restarting ${SERVICE} (loads new code, runs startup migrations)..."
        systemctl daemon-reload
        systemctl restart "${SERVICE}"
        echo "Restarted. Recent status:"
        systemctl --no-pager --lines=0 status "${SERVICE}" || true
    else
        echo "Backend code updated — restart it to load the new code + migrations:"
        echo "  sudo systemctl restart ${SERVICE}"
    fi
else
    echo "First-time setup — the ${SERVICE} service isn't installed yet:"
    echo "  1. Generate a JWT secret:         python3 -c \"import secrets; print(secrets.token_hex(32))\""
    echo "  2. Generate an encryption key:    python3 -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
    echo "  3. Edit the service file:         sudo nano /etc/systemd/system/work-time-backend.service"
    echo "     Set WORK_TIME_JWT_SECRET and WORK_TIME_ENCRYPTION_KEY to the generated values."
    echo "     Keep User/Group aligned with APP_USER/APP_GROUP (${APP_USER}:${APP_GROUP})."
    echo "  4. Start the service:             sudo systemctl daemon-reload && sudo systemctl enable --now ${SERVICE}"
fi