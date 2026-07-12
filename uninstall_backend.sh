#!/bin/bash
set -e

exec "$(dirname "$0")/backend/uninstall.sh" "$@"