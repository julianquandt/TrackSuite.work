#!/usr/bin/env python3
"""Re-tombstone resurrected duplicate shifts across ALL users.

The pre-0.8 desktop app could push shifts that had already been deleted,
resurrecting them as live duplicates (a live shift sitting next to its own
deleted twin at the same start/end time). This re-deletes those live
duplicates with a fresh canonical timestamp so last-write-wins syncs the
correction to every device. It only sticks because the >=0.8.1 version gate
now blocks old clients from re-pushing the resurrection.

DRY RUN by default -- prints what it WOULD do and changes nothing.
Add --apply to actually commit (a backup is written first, always).

Usage:
    python3 fix_resurrected_shifts.py /path/to/work_time_server.db          # dry run
    python3 fix_resurrected_shifts.py /path/to/work_time_server.db --apply  # commit
"""
import os
import sqlite3
import sys
from datetime import datetime, timezone

# Selects live shifts that have a deleted twin (same user, same start_time, and
# matching end_time incl. the NULL==NULL case) -> the resurrection duplicates.
SELECT_RESURRECTED = """
SELECT a.id, a.user_id, a.start_time, a.end_time, a.uuid
FROM shifts a
WHERE a.deleted = 0
  AND EXISTS (
    SELECT 1 FROM shifts b
    WHERE b.deleted = 1
      AND b.user_id = a.user_id
      AND b.start_time = a.start_time
      AND (b.end_time = a.end_time OR (b.end_time IS NULL AND a.end_time IS NULL))
  )
"""


def canonical_now():
    # Matches sync_now(): e.g. 2026-07-14T12:00:00.123456+00:00
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def main(path, apply):
    if not os.path.exists(path):
        print(f"DB not found: {path}")
        sys.exit(1)

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    victims = conn.execute(SELECT_RESURRECTED).fetchall()
    if not victims:
        print("No resurrected duplicate shifts found. Nothing to do.")
        conn.close()
        return

    # Sanity: make sure our fresh stamp is newer than every existing one so LWW
    # wins on all clients.
    max_updated = conn.execute(
        "SELECT MAX(updated_at) m FROM shifts"
    ).fetchone()["m"]
    stamp = canonical_now()
    if max_updated and stamp <= max_updated:
        print(f"! Refusing: generated stamp {stamp!r} is not newer than the "
              f"newest existing updated_at {max_updated!r}. Check the clock.")
        conn.close()
        sys.exit(1)

    per_user = {}
    for r in victims:
        per_user[r["user_id"]] = per_user.get(r["user_id"], 0) + 1

    print(f"Found {len(victims)} resurrected live duplicate(s) across "
          f"{len(per_user)} user(s):")
    for uid, c in sorted(per_user.items(), key=lambda kv: kv[1], reverse=True):
        print(f"  user={uid}  duplicates={c}")
    print(f"\nWould stamp deleted=1, deleted_at={stamp}, updated_at={stamp}")

    if not apply:
        print("\nDRY RUN -- nothing changed. Re-run with --apply to commit.")
        conn.close()
        return

    # Always back up before mutating (atomic, consistent snapshot).
    backup = f"{path}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    conn.execute("VACUUM INTO ?", (backup,))
    print(f"\nBackup written: {backup}")

    ids = [r["id"] for r in victims]
    placeholders = ",".join("?" * len(ids))
    cur = conn.execute(
        f"UPDATE shifts SET deleted=1, deleted_at=?, updated_at=? "
        f"WHERE id IN ({placeholders})",
        [stamp, stamp, *ids],
    )
    conn.commit()
    print(f"Re-tombstoned {cur.rowcount} shift(s). Done.")
    print("Clients will pull the correction on their next sync.")
    conn.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--apply" in sys.argv[1:]
    if len(args) != 1:
        print(__doc__)
        sys.exit(1)
    main(args[0], apply)
