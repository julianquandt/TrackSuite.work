#!/usr/bin/env python3
"""Repair shifts whose end_time is corrupt (duration far exceeds a real day).

These come from open/running shifts that got "clocked out" to a wrong moment
(e.g. all closed to the same timestamp weeks/months after they started), so
the true end time was never recorded and cannot be recovered automatically.

Pick a remedy:
  (default)   report only -- list the corrupt shifts, change nothing.
  --null      re-open them (end_time = NULL) so the owner can set the real
              end via the app's timeline editor. Stats will show them as
              running until fixed.
  --endofday  cap end_time to 23:59:59 on each shift's OWN start date.
              Produces sane per-day totals but the hours are a guess.
  --delete    tombstone them (soft-delete, LWW-synced). Removes the sessions.
  --from-json PATH   apply exact corrected end_times: {"<uuid>": "YYYY-MM-DDTHH:MM:SS", ...}
              This is the ACCURATE path -- use real values the owner supplies.

Selection (which shifts are flagged):
  --threshold-hours N   (default) flag shifts longer than N hours (default 24).
                        Zero false positives -- nobody works >24h in one sitting.
  --closed-on DATE      flag shifts that ENDED on DATE but STARTED an earlier day
                        (the mass-close fingerprint: open shifts bulk-closed to a
                        wrong moment). Catches sub-24h cases the threshold misses;
                        spares same-day legit work and open timers. Eyeball the
                        report first -- a genuine overnight shift would also match.

Nothing is committed without --apply. A backup is always written first.

Usage:
  python3 fix_corrupt_end_time.py data/work_time_server.db                     # report
  python3 fix_corrupt_end_time.py data/work_time_server.db --endofday          # preview
  python3 fix_corrupt_end_time.py data/work_time_server.db --endofday --apply  # commit
  python3 fix_corrupt_end_time.py data/work_time_server.db --from-json ends.json --apply
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone


def parse_dt(s):
    if not s:
        return None
    s = s.strip().replace("T", " ")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    for fmt in (
        "%Y-%m-%d %H:%M:%S.%f%z", "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
    ):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        except ValueError:
            continue
    return None


def canonical_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def main(path, mode, threshold, apply, json_path, closed_on):
    if not os.path.exists(path):
        print(f"DB not found: {path}")
        sys.exit(1)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, user_id, uuid, start_time, end_time FROM shifts "
        "WHERE deleted=0 AND end_time IS NOT NULL"
    ).fetchall()

    corrupt = []
    for r in rows:
        start, end = parse_dt(r["start_time"]), parse_dt(r["end_time"])
        if not start or not end:
            continue
        dur = (end - start).total_seconds() / 3600.0
        if closed_on:
            # Mass-close fingerprint: ended on the given day but started on an
            # EARLIER day (spanned midnight because it was open and bulk-closed).
            # Spares same-day legit work and the live open timer.
            if end.date().isoformat() == closed_on and start.date() < end.date():
                corrupt.append((dict(r), start, dur))
        elif dur > threshold:
            corrupt.append((dict(r), start, dur))

    if not corrupt:
        if closed_on:
            print(f"No shifts closed on {closed_on} that started earlier. Nothing to do.")
        else:
            print(f"No shifts longer than {threshold}h. Nothing to do.")
        conn.close()
        return

    corrected = None
    if json_path:
        with open(json_path) as f:
            corrected = json.load(f)

    criterion = (f"closed on {closed_on}, started earlier"
                 if closed_on else f"> {threshold}h")
    print(f"Corrupt shifts ({criterion}), remedy = {mode}:")
    plan = []  # (id, new_end_or_None, delete_bool, label)
    for r, start, dur in sorted(corrupt, key=lambda x: x[2], reverse=True):
        if mode == "from-json":
            new_end = corrected.get(r["uuid"])
            if new_end is None:
                print(f"  id={r['id']} uuid={r['uuid']}  -- NO entry in json, skipped")
                continue
            plan.append((r["id"], new_end, False, f"end -> {new_end}"))
            label = f"end -> {new_end}"
        elif mode == "null":
            plan.append((r["id"], None, False, "re-open (end=NULL)"))
            label = "re-open (end=NULL)"
        elif mode == "endofday":
            new_end = start.strftime("%Y-%m-%dT23:59:59")
            plan.append((r["id"], new_end, False, f"end -> {new_end}"))
            label = f"end -> {new_end}"
        elif mode == "delete":
            plan.append((r["id"], None, True, "delete (tombstone)"))
            label = "delete (tombstone)"
        else:  # report
            label = "(report only)"
        print(f"  id={r['id']} user={r['user_id']} dur={dur:8.1f}h  "
              f"{r['start_time']} -> {r['end_time']}   {label}")

    if mode == "report":
        print("\nReport only. Pick a remedy flag (--null/--endofday/--delete/--from-json).")
        conn.close()
        return
    if not apply:
        print(f"\nPREVIEW ({len(plan)} shift(s)). Re-run with --apply to commit.")
        conn.close()
        return

    backup = f"{path}.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    conn.execute("VACUUM INTO ?", (backup,))
    print(f"\nBackup written: {backup}")

    stamp = canonical_now()
    n = 0
    for sid, new_end, delete, _ in plan:
        if delete:
            conn.execute(
                "UPDATE shifts SET deleted=1, deleted_at=?, updated_at=? WHERE id=?",
                (stamp, stamp, sid),
            )
        else:
            conn.execute(
                "UPDATE shifts SET end_time=?, updated_at=? WHERE id=?",
                (new_end, stamp, sid),
            )
        n += 1
    conn.commit()
    print(f"Applied to {n} shift(s). Clients sync the correction next pull.")
    conn.close()


if __name__ == "__main__":
    argv = sys.argv[1:]
    pos = [a for a in argv if not a.startswith("--")]
    apply = "--apply" in argv
    mode = "report"
    if "--null" in argv:
        mode = "null"
    elif "--endofday" in argv:
        mode = "endofday"
    elif "--delete" in argv:
        mode = "delete"
    elif "--from-json" in argv:
        mode = "from-json"
    json_path = None
    if "--from-json" in argv:
        i = argv.index("--from-json")
        json_path = argv[i + 1] if i + 1 < len(argv) else None
        if json_path:
            pos = [p for p in pos if p != json_path]
    threshold = 24.0
    if "--threshold-hours" in argv:
        i = argv.index("--threshold-hours")
        threshold = float(argv[i + 1])
        pos = [p for p in pos if p != argv[i + 1]]
    closed_on = None
    if "--closed-on" in argv:
        i = argv.index("--closed-on")
        closed_on = argv[i + 1] if i + 1 < len(argv) else None
        if closed_on:
            pos = [p for p in pos if p != closed_on]
    if len(pos) != 1:
        print(__doc__)
        sys.exit(1)
    main(pos[0], mode, threshold, apply, json_path, closed_on)
