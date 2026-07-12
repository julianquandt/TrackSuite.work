#!/bin/bash
set -e

exec "$(dirname "$0")/backend/deploy.sh" "$@"
