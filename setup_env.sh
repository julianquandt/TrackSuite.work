#!/bin/bash
set -euo pipefail

# System dependencies for Ubuntu 24.04.
# This keeps the legacy GTK client runnable while also installing the Linux
# packages needed for the new Tauri desktop shell.
sudo add-apt-repository -y universe
sudo apt update
sudo apt install -y \
        build-essential \
        curl \
        gir1.2-adw-1 \
        gir1.2-ayatanaappindicator3-0.1 \
        gir1.2-webkit-6.0 \
        libadwaita-1-dev \
    libatk1.0-dev \
        libayatana-appindicator3-dev \
    libgtk-3-dev \
        librsvg2-dev \
    libsoup-3.0-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        patchelf \
        pkg-config \
        python3-dbus \
        python3-gi \
        python3-gi-cairo \
        python3-pip \
        python3-venv

cat <<'EOF'
System packages installed.

For the Tauri desktop app, make sure these user-level tools are available too:
    - Node.js 24+
    - Rust via rustup

Recommended commands:
    curl https://sh.rustup.rs -sSf | sh
    corepack enable
EOF
