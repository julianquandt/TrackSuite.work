#!/bin/bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/work-time-app}"
SERVICE_NAME="${SERVICE_NAME:-work-time-backend}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
FORCE="${FORCE:-0}"

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "Error: run this script with sudo or as root." >&2
        exit 1
    fi
}

validate_paths() {
    if [ -z "$DEPLOY_DIR" ] || [ "$DEPLOY_DIR" = "/" ]; then
        echo "Error: refusing to remove DEPLOY_DIR='$DEPLOY_DIR'." >&2
        exit 1
    fi
}

confirm_uninstall() {
    if [ "$FORCE" = "1" ]; then
        return
    fi

    echo "This will stop and disable ${SERVICE_NAME}, remove ${SYSTEMD_UNIT_PATH}, and delete ${DEPLOY_DIR}."
    echo "Apache configuration will not be changed."
    read -r -p "Continue? [y/N] " reply
    case "$reply" in
        y|Y|yes|YES)
            ;;
        *)
            echo "Aborted."
            exit 1
            ;;
    esac
}

stop_service() {
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
}

remove_service_unit() {
    rm -f "$SYSTEMD_UNIT_PATH"
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
}

remove_deploy_dir() {
    rm -rf "$DEPLOY_DIR"
}

require_root
validate_paths
confirm_uninstall

stop_service
remove_service_unit
remove_deploy_dir

echo "Backend uninstall complete. Apache configuration was left unchanged."