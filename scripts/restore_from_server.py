#!/usr/bin/env python3
"""
Restore local work-time-app DB from the sync server.

Usage:
    python scripts/restore_from_server.py [--dry-run] [--force]

Reads server URL / API key / user_id from the local config table
(same values the app uses), pulls all shifts and off-days for that
user from the server, and inserts any that are missing locally.

This is purely additive — it never deletes local rows. Shifts are
de-duplicated by `start_time` (matching the sync logic).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Make the repo root importable when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests

# Reuse the app's database helpers so we hit the exact same DB file.
from work_time_app.database import (
    DB_PATH,
    init_db,
    get_config,
    get_all_shifts,
    get_off_days,
    add_off_day,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be inserted, don't write.")
    parser.add_argument("--server-url", help="Override server_url from config.")
    parser.add_argument("--api-key", help="Override api_key from config.")
    parser.add_argument("--user-id", type=int, help="Override user_id from config.")
    parser.add_argument(
        "--include-open",
        action="store_true",
        help="Also restore shifts that are still open (end_time IS NULL). "
             "By default these are skipped because they are usually "
             "stale clock-ins from older devices and will make the app "
             "appear permanently clocked in.",
    )
    args = parser.parse_args()

    init_db()

    server_url = (args.server_url or get_config("server_url") or "").rstrip("/")
    api_key = args.api_key or get_config("api_key")

    if not server_url or not api_key:
        print("ERROR: server_url and api_key are required.", file=sys.stderr)
        print(f"  DB: {DB_PATH}", file=sys.stderr)
        print("  Configure the app first, or pass --server-url and --api-key.",
              file=sys.stderr)
        return 2

    headers = {"X-API-KEY": api_key}

    # Fetch from server. The backend derives the user from the API key,
    # so the user_id query param is ignored — we still send it if known
    # for compatibility with older servers.
    user_id_qs = f"?user_id={int(args.user_id or get_config('user_id') or 0)}"

    print(f"Fetching shifts from {server_url} ...")
    r = requests.get(f"{server_url}/shifts/{user_id_qs}",
                     headers=headers, timeout=30)
    r.raise_for_status()
    server_shifts = r.json()

    print(f"Fetching off-days ...")
    r = requests.get(f"{server_url}/off-days/{user_id_qs}",
                     headers=headers, timeout=30)
    r.raise_for_status()
    server_off_days = r.json()

    print(f"Server has {len(server_shifts)} shifts, "
          f"{len(server_off_days)} off-days.")

    open_shifts = [s for s in server_shifts if not s.get("end_time")]
    if open_shifts:
        print(f"  ({len(open_shifts)} of those are open / still clocked in)")
    if open_shifts and not args.include_open:
        print("  Skipping open shifts (use --include-open to restore them).")
        server_shifts = [s for s in server_shifts if s.get("end_time")]

    # Diff against local
    local_shifts = get_all_shifts()
    local_starts = {s["start_time"] for s in local_shifts}
    new_shifts = [s for s in server_shifts
                  if s["start_time"] not in local_starts]

    local_off = set(get_off_days())
    new_off = [d["date"] for d in server_off_days
               if d["date"] not in local_off]

    print(f"Local has {len(local_shifts)} shifts ({len(new_shifts)} to add), "
          f"{len(local_off)} off-days ({len(new_off)} to add).")

    if args.dry_run:
        for s in new_shifts:
            print(f"  + shift {s['start_time']} -> {s.get('end_time')}")
        for d in new_off:
            print(f"  + off-day {d}")
        print("Dry run; no changes written.")
        return 0

    if not new_shifts and not new_off:
        print("Nothing to restore. Local is already in sync with server.")
        return 0

    # Insert. We bypass add_shift_manual so we can also restore active
    # (end_time IS NULL) shifts faithfully.
    with sqlite3.connect(DB_PATH) as conn:
        for s in new_shifts:
            conn.execute(
                "INSERT INTO shifts (start_time, end_time) VALUES (?, ?)",
                (s["start_time"], s.get("end_time")),
            )
        conn.commit()

    for d in new_off:
        add_off_day(d)

    print(f"Restored {len(new_shifts)} shifts and {len(new_off)} off-days "
          f"into {DB_PATH}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
