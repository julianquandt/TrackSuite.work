#!/usr/bin/env bash
# Generate offline Flatpak dependency sources for TrackSuite.work.
#
# Run this script whenever either of these lock files changes:
#   desktop/package-lock.json
#   desktop/src-tauri/Cargo.lock
#
# The generated files (node-sources.json, cargo-sources.json) must be committed
# to the repository so that the Flatpak CI job and local flatpak-builder builds
# can work without network access inside the sandbox.
#
# Requirements:
#   pip install flatpak-node-generator
#   pip install aiohttp aiofiles   (needed by flatpak-cargo-generator)
#
# flatpak-cargo-generator is fetched directly from flatpak-builder-tools on GitHub.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Node dependencies ──────────────────────────────────────────────────────────
echo "==> Generating node-sources.json …"
if ! command -v flatpak-node-generator &>/dev/null; then
  echo "ERROR: flatpak-node-generator not found. Install it with:"
  echo "  pip install flatpak-node-generator"
  exit 1
fi
flatpak-node-generator npm \
  "$REPO_ROOT/desktop/package-lock.json" \
  -o "$SCRIPT_DIR/node-sources.json"
echo "    Written: $SCRIPT_DIR/node-sources.json"

# ── Cargo dependencies ─────────────────────────────────────────────────────────
echo "==> Generating cargo-sources.json …"
pip install --quiet aiohttp aiofiles tomlkit

CARGO_GEN_URL="https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/master/cargo/flatpak-cargo-generator.py"
CARGO_GEN="$(mktemp).py"
curl -fsSL "$CARGO_GEN_URL" -o "$CARGO_GEN"

python3 "$CARGO_GEN" \
  "$REPO_ROOT/desktop/src-tauri/Cargo.lock" \
  -o "$SCRIPT_DIR/cargo-sources.json"
echo "    Written: $SCRIPT_DIR/cargo-sources.json"

echo "==> Done. Commit node-sources.json and cargo-sources.json."
