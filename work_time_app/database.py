import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.expanduser("~/.local/share/work-time-app/data.db")

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS shifts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_time TEXT NOT NULL,
                end_time TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS off_days (
                date TEXT PRIMARY KEY
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        conn.commit()

def set_config(key, value):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

def get_config(key):
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT value FROM config WHERE key = ?", (key,))
        row = cur.fetchone()
        return row[0] if row else None

def start_shift():
    """Starts a new shift if none is active."""
    if get_active_shift():
        return False
    
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO shifts (start_time) VALUES (?)", (datetime.now().isoformat(),))
        conn.commit()
    return True

def end_shift():
    """Ends the currently active shift."""
    active = get_active_shift()
    if not active:
        return False
    
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "UPDATE shifts SET end_time = ? WHERE id = ?",
            (datetime.now().isoformat(), active['id'])
        )
        conn.commit()
    return True

def get_active_shift():
    """Returns the active shift or None."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute("SELECT * FROM shifts WHERE end_time IS NULL")
        return cur.fetchone()

def get_shifts_for_period(start_date, end_date):
    """Returns shifts between two dates."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "SELECT * FROM shifts WHERE start_time >= ? AND start_time <= ?",
            (start_date.isoformat(), end_date.isoformat())
        )
        return cur.fetchall()

def get_all_shifts():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute("SELECT * FROM shifts ORDER BY start_time DESC")
        return cur.fetchall()

def export_to_csv(file_path):
    import csv
    shifts = get_all_shifts()
    off_days = get_off_days()
    with open(file_path, 'w', newline='') as f:
        writer = csv.writer(f)
        # Shifts section
        f.write('[Shifts]\n')
        writer.writerow(['ID', 'Start Time', 'End Time', 'Duration (Hours)'])
        for s in shifts:
            start = datetime.fromisoformat(s['start_time'])
            end = datetime.fromisoformat(s['end_time']) if s['end_time'] else datetime.now()
            duration = (end - start).total_seconds() / 3600
            writer.writerow([s['id'], s['start_time'], s['end_time'], round(duration, 2)])
        # Off-days section
        f.write('\n[Off Days]\n')
        writer.writerow(['Date'])
        for d in off_days:
            writer.writerow([d])

def add_off_day(date_str):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT OR IGNORE INTO off_days (date) VALUES (?)", (date_str,))
        conn.commit()

def remove_off_day(date_str):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM off_days WHERE date = ?", (date_str,))
        conn.commit()

def get_off_days():
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT date FROM off_days ORDER BY date DESC")
        return [row[0] for row in cur.fetchall()]

def delete_shift(shift_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM shifts WHERE id = ?", (shift_id,))
        conn.commit()

def add_shift_manual(start_datetime_str, end_datetime_str):
    """Add a shift manually with specified start and end times."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO shifts (start_time, end_time) VALUES (?, ?)", 
                    (start_datetime_str, end_datetime_str))
        conn.commit()
