#!/usr/bin/env python3
"""Read-only diagnostic for absurd daily-hour totals across ALL users.

Usage:
    python3 scripts/diagnose_bad_hours.py /path/to/work_time_server.db

Does NOT modify anything. Run it against a COPY of production first, e.g.:
    cp work_time_server.db /tmp/diag.db
    python3 scripts/diagnose_bad_hours.py /tmp/diag.db
"""
import sqlite3
import sys
from datetime import datetime, timezone

DAY_HOURS_ALERT = 24.0  # a single day can never legitimately exceed 24h


def parse_dt(s):
    """Parse the mix of ISO/naive timestamp formats the app stores."""
    if not s:
        return None
    s = s.strip().replace("T", " ")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # try a few layouts
    for fmt in (
        "%Y-%m-%d %H:%M:%S.%f%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def main(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, user_id, uuid, start_time, end_time, deleted "
        "FROM shifts WHERE deleted=0"
    ).fetchall()

    now = datetime.now(timezone.utc)
    per_day = {}          # (user_id, date) -> total hours
    per_day_count = {}    # (user_id, date) -> live shift count
    long_shifts = []      # shifts whose own duration is absurd
    open_shifts = []      # end_time NULL

    for r in rows:
        start = parse_dt(r["start_time"])
        if start is None:
            print(f"  ! unparseable start_time id={r['id']} user={r['user_id']}: {r['start_time']!r}")
            continue
        day = start.date().isoformat()
        key = (r["user_id"], day)

        if not r["end_time"]:
            open_shifts.append(dict(r))
            dur = (now - start).total_seconds() / 3600.0
        else:
            end = parse_dt(r["end_time"])
            if end is None:
                print(f"  ! unparseable end_time id={r['id']} user={r['user_id']}: {r['end_time']!r}")
                continue
            dur = (end - start).total_seconds() / 3600.0

        if dur > 24.0:
            long_shifts.append((dict(r), dur))

        per_day[key] = per_day.get(key, 0.0) + dur
        per_day_count[key] = per_day_count.get(key, 0) + 1

    print("\n=== DAYS OVER 24h (per user) ===")
    bad_days = sorted(
        ((k, v) for k, v in per_day.items() if v > DAY_HOURS_ALERT),
        key=lambda kv: kv[1], reverse=True,
    )
    for (uid, day), hours in bad_days[:50]:
        print(f"  user={uid}  {day}  total={hours:8.1f}h  live_shifts={per_day_count[(uid, day)]}")
    print(f"  ...{len(bad_days)} bad (user,day) pairs total")

    print("\n=== INDIVIDUAL SHIFTS LONGER THAN 24h (corrupt end_time) ===")
    for r, dur in sorted(long_shifts, key=lambda x: x[1], reverse=True)[:30]:
        print(f"  id={r['id']} user={r['user_id']} dur={dur:10.1f}h  "
              f"{r['start_time']} -> {r['end_time']}  uuid={r['uuid']}")
    print(f"  ...{len(long_shifts)} shifts over 24h total")

    print("\n=== OPEN (end_time NULL) SHIFTS ===")
    for r in open_shifts[:30]:
        print(f"  id={r['id']} user={r['user_id']} start={r['start_time']} uuid={r['uuid']}")
    print(f"  ...{len(open_shifts)} open shifts total")

    print("\n=== RESURRECTED DUPLICATES (live shift with a deleted twin) ===")
    dupes = conn.execute(
        "SELECT user_id, COUNT(*) c FROM shifts a "
        "WHERE a.deleted=0 AND EXISTS ("
        "  SELECT 1 FROM shifts b WHERE b.deleted=1 AND b.user_id=a.user_id "
        "  AND b.start_time=a.start_time "
        "  AND (b.end_time=a.end_time OR (b.end_time IS NULL AND a.end_time IS NULL))"
        ") GROUP BY user_id ORDER BY c DESC"
    ).fetchall()
    for r in dupes:
        print(f"  user={r['user_id']}  resurrected_live_shifts={r['c']}")
    print(f"  ...{len(dupes)} users affected by resurrection")

    conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
