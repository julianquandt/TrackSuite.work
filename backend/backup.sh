#!/bin/bash
# Encrypted, WAL-safe backup of the TrackSuite.work SQLite database.
#
# Usage (typically from cron):
#   WORK_TIME_BACKUP_AGE_RECIPIENT=age1... ./backend/backup.sh
#   # or, with GPG instead of age:
#   WORK_TIME_BACKUP_GPG_RECIPIENT=you@example.com ./backend/backup.sh
#
# Env:
#   WORK_TIME_DB_FILE         path to the live DB (default /opt/work-time-app/data/work_time_server.db)
#   WORK_TIME_BACKUP_DIR      where encrypted backups are written (default /opt/work-time-app/backups)
#   WORK_TIME_BACKUP_KEEP_DAYS   retention in days (default 30)
#   WORK_TIME_BACKUP_AGE_RECIPIENT   an age recipient (recommended), OR
#   WORK_TIME_BACKUP_GPG_RECIPIENT   a gpg recipient
#   WORK_TIME_BACKUP_OWNER    user[:group] to own the backups (default: none)
#
# Backups are ALWAYS encrypted: the script refuses to run if neither recipient
# is set, so an unencrypted copy of everyone's data is never left on disk.
set -euo pipefail

DB_FILE="${WORK_TIME_DB_FILE:-/opt/work-time-app/data/work_time_server.db}"
BACKUP_DIR="${WORK_TIME_BACKUP_DIR:-/opt/work-time-app/backups}"
KEEP_DAYS="${WORK_TIME_BACKUP_KEEP_DAYS:-30}"
AGE_RECIPIENT="${WORK_TIME_BACKUP_AGE_RECIPIENT:-}"
GPG_RECIPIENT="${WORK_TIME_BACKUP_GPG_RECIPIENT:-}"
BACKUP_OWNER="${WORK_TIME_BACKUP_OWNER:-}"

if [ ! -f "$DB_FILE" ]; then
    echo "Error: DB not found at $DB_FILE" >&2
    exit 1
fi
if [ -z "$AGE_RECIPIENT" ] && [ -z "$GPG_RECIPIENT" ]; then
    echo "Error: set WORK_TIME_BACKUP_AGE_RECIPIENT or WORK_TIME_BACKUP_GPG_RECIPIENT." >&2
    echo "Refusing to write an unencrypted backup." >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Run from cron as root, the backups end up root-owned and 0600, so pulling them
# off the box over SSH as an ordinary user fails. Handing ownership to that user
# is safer than granting them passwordless `sudo rsync`, which would give root
# read access to the whole filesystem to anyone holding their SSH key. What they
# get here is encrypted blobs they cannot decrypt without the age/GPG key.
if [ -n "$BACKUP_OWNER" ]; then
    if ! chown "$BACKUP_OWNER" "$BACKUP_DIR"; then
        echo "Error: could not chown $BACKUP_DIR to $BACKUP_OWNER." >&2
        echo "Run as root, and check the user exists." >&2
        exit 1
    fi
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp)"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT

# WAL-safe consistent snapshot (does not lock out writers for long).
sqlite3 "$DB_FILE" ".backup '$tmp'"

if [ -n "$AGE_RECIPIENT" ]; then
    out="$BACKUP_DIR/work_time_server-$stamp.db.age"
    age -r "$AGE_RECIPIENT" -o "$out" "$tmp"
else
    out="$BACKUP_DIR/work_time_server-$stamp.db.gpg"
    gpg --batch --yes --encrypt --recipient "$GPG_RECIPIENT" --output "$out" "$tmp"
fi
chmod 600 "$out"
[ -n "$BACKUP_OWNER" ] && chown "$BACKUP_OWNER" "$out"
echo "Wrote encrypted backup: $out"

# Retention: delete encrypted backups older than KEEP_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.db.age' -o -name '*.db.gpg' \) \
    -mtime "+$KEEP_DAYS" -print -delete
echo "Pruned backups older than $KEEP_DAYS days."
