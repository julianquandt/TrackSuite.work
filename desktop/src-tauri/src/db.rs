use chrono::NaiveDateTime;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(test)]
thread_local! {
    /// Per-test database file. Tests run on parallel threads, so each test
    /// thread points conn() at its own temp file.
    static TEST_DB_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn db_path() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_DB_PATH.with(|p| p.borrow().clone()) {
        return path;
    }
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("work-time-app");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("data.db")
}

fn conn() -> Result<Connection, String> {
    let c = Connection::open(db_path()).map_err(|e| e.to_string())?;
    // The UI, the tray and the Rust background loop all write; wait for a
    // competing writer instead of failing with SQLITE_BUSY.
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(c)
}

/// Start a write transaction. IMMEDIATE takes the write lock up front, so two
/// read-then-write sequences can never interleave.
fn write_tx(c: &mut Connection) -> Result<Transaction<'_>, String> {
    c.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn init_db() -> Result<(), String> {
    let c = conn()?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT,
            start_time TEXT NOT NULL,
            end_time TEXT,
            project_uuid TEXT,
            updated_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT,
            auto_closed_at TEXT,
            started_from TEXT,
            last_active_at TEXT,
            note TEXT
        );
        CREATE TABLE IF NOT EXISTS off_days (
            date TEXT PRIMARY KEY,
            uuid TEXT,
            updated_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT,
            reason TEXT
        );
        CREATE TABLE IF NOT EXISTS projects (
            uuid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT,
            rate TEXT,
            currency TEXT
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    migrate_sync_columns(&c)?;
    migrate_single_open_shift(&c)?;
    Ok(())
}

/// Name of the partial unique index that allows at most one open shift.
const SINGLE_OPEN_INDEX: &str = "idx_shifts_single_open";

/// Enforce "at most one open shift" in the schema. Older databases can hold
/// several open shifts (cross-device races, old clients), so close the extras
/// first: the most recently started one stays open; every other one is closed
/// to its last heartbeat (when that is after its start) or else to the end of
/// its start day, and flagged with auto_closed_at for review — the same rule
/// the server applies.
fn migrate_single_open_shift(c: &Connection) -> Result<(), String> {
    let exists: bool = c
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1")
        .and_then(|mut s| s.exists(params![SINGLE_OPEN_INDEX]))
        .map_err(err)?;
    if exists {
        return Ok(());
    }

    let open: Vec<(i64, String, Option<String>)> = {
        let mut stmt = c
            .prepare(
                "SELECT id, start_time, last_active_at FROM shifts \
                 WHERE end_time IS NULL AND deleted = 0",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };
    if open.len() > 1 {
        let mut sorted = open;
        sorted.sort_by(|a, b| sort_key(&b.1).cmp(&sort_key(&a.1)));
        let ts = sync_now();
        for (id, start, last_active) in sorted.into_iter().skip(1) {
            let end = forced_close_time(&start, last_active.as_deref());
            c.execute(
                "UPDATE shifts SET end_time = ?1, auto_closed_at = ?2, updated_at = ?2 WHERE id = ?3",
                params![end, ts, id],
            )
            .map_err(err)?;
        }
    }

    c.execute(
        &format!(
            "CREATE UNIQUE INDEX IF NOT EXISTS {} ON shifts(deleted) \
             WHERE end_time IS NULL AND deleted = 0",
            SINGLE_OPEN_INDEX
        ),
        [],
    )
    .map_err(err)?;
    Ok(())
}

/// End time for a shift that must be closed without the user: its last
/// heartbeat if that is after the start, else the end of its local start day.
fn forced_close_time(start: &str, last_active: Option<&str>) -> String {
    let start_dt = to_local_naive(start);
    if let (Some(s), Some(la)) = (start_dt, last_active.and_then(to_local_naive)) {
        if la > s {
            return fmt_local(la);
        }
    }
    match start_dt {
        Some(s) => format!("{}T23:59:59", s.date().format("%Y-%m-%d")),
        // Unparseable start: keep the frame-free date prefix if there is one.
        None => format!("{}T23:59:59", start.get(..10).unwrap_or(start)),
    }
}

/// Chronological sort key: parsed local time when possible, else the raw
/// string (ISO strings sort chronologically within one frame).
fn sort_key(ts: &str) -> (Option<NaiveDateTime>, String) {
    (to_local_naive(ts), ts.to_string())
}

/// Additively add sync-metadata columns to pre-existing local databases and
/// backfill identity + timestamps so an offline history merges cleanly once
/// sync is turned on. All changes are non-destructive.
fn migrate_sync_columns(c: &Connection) -> Result<(), String> {
    let ensure_column = |table: &str, column: &str, decl: &str| -> Result<(), String> {
        let existing: Vec<String> = {
            let mut stmt = c
                .prepare(&format!("PRAGMA table_info({})", table))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if !existing.iter().any(|name| name == column) {
            c.execute(
                &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    };

    ensure_column("shifts", "uuid", "TEXT")?;
    ensure_column("shifts", "updated_at", "TEXT")?;
    ensure_column("shifts", "deleted", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column("shifts", "deleted_at", "TEXT")?;
    ensure_column("shifts", "project_uuid", "TEXT")?;
    // auto_closed_at + started_from are synced; last_active_at is a local-only
    // liveness heartbeat used to retro-close a shift the app couldn't clock out.
    ensure_column("shifts", "auto_closed_at", "TEXT")?;
    ensure_column("shifts", "started_from", "TEXT")?;
    ensure_column("shifts", "last_active_at", "TEXT")?;
    // Report metadata (0.9.0): free-text note per shift (synced).
    ensure_column("shifts", "note", "TEXT")?;
    ensure_column("off_days", "uuid", "TEXT")?;
    ensure_column("off_days", "updated_at", "TEXT")?;
    ensure_column("off_days", "deleted", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column("off_days", "deleted_at", "TEXT")?;
    // Why the day is off (synced): NULL = plain off day, else e.g. "vacation".
    ensure_column("off_days", "reason", "TEXT")?;
    // Report metadata (0.9.0): per-project billing rate + currency (synced).
    ensure_column("projects", "rate", "TEXT")?;
    ensure_column("projects", "currency", "TEXT")?;

    let now = sync_now();
    // Backfill identity + timestamps for rows created before sync existed.
    let shift_ids: Vec<i64> = {
        let mut stmt = c
            .prepare("SELECT id FROM shifts WHERE uuid IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for id in shift_ids {
        c.execute(
            "UPDATE shifts SET uuid = ?1, updated_at = COALESCE(updated_at, ?2) WHERE id = ?3",
            params![new_uuid(), now, id],
        )
        .map_err(|e| e.to_string())?;
    }

    let off_day_dates: Vec<String> = {
        let mut stmt = c
            .prepare("SELECT date FROM off_days WHERE uuid IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for date in off_day_dates {
        c.execute(
            "UPDATE off_days SET uuid = ?1, updated_at = COALESCE(updated_at, ?2) WHERE date = ?3",
            params![new_uuid(), now, date],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── Shift types & commands ──────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Shift {
    pub id: i64,
    pub uuid: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub project_uuid: Option<String>,
    pub started_from: Option<String>,
    pub last_active_at: Option<String>,
    pub note: Option<String>,
    pub auto_closed_at: Option<String>,
}

const SHIFT_COLUMNS: &str =
    "id, uuid, start_time, end_time, project_uuid, started_from, last_active_at, note, auto_closed_at";

fn map_shift(row: &rusqlite::Row<'_>) -> rusqlite::Result<Shift> {
    Ok(Shift {
        id: row.get(0)?,
        uuid: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        start_time: row.get(2)?,
        end_time: row.get(3)?,
        project_uuid: row.get(4)?,
        started_from: row.get(5)?,
        last_active_at: row.get(6)?,
        note: row.get(7)?,
        auto_closed_at: row.get(8)?,
    })
}

/// Result of a retro-close: the shift the app couldn't cleanly clock out was
/// closed to its last known active time. Returned so the UI can notify.
#[derive(Debug, Serialize, Clone)]
pub struct StaleClose {
    pub id: i64,
    pub uuid: String,
    pub start_time: String,
    pub end_time: String,
}

fn active_shift_in(c: &Connection) -> Result<Option<Shift>, String> {
    c.query_row(
        &format!(
            "SELECT {} FROM shifts WHERE end_time IS NULL AND deleted = 0 \
             ORDER BY start_time DESC LIMIT 1",
            SHIFT_COLUMNS
        ),
        [],
        map_shift,
    )
    .optional()
    .map_err(err)
}

fn shift_by_id_in(c: &Connection, id: i64) -> Result<Option<Shift>, String> {
    c.query_row(
        &format!("SELECT {} FROM shifts WHERE id = ?1 AND deleted = 0", SHIFT_COLUMNS),
        params![id],
        map_shift,
    )
    .optional()
    .map_err(err)
}

fn open_shift_count_in(c: &Connection, except_uuid: Option<&str>) -> Result<i64, String> {
    c.query_row(
        "SELECT COUNT(*) FROM shifts WHERE end_time IS NULL AND deleted = 0 \
         AND (?1 IS NULL OR uuid IS NOT ?1)",
        params![except_uuid],
        |row| row.get(0),
    )
    .map_err(err)
}

pub fn get_active_shift_row() -> Result<Option<Shift>, String> {
    active_shift_in(&conn()?)
}

pub fn start_shift_row() -> Result<bool, String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    // Guard: at most one open shift (also enforced by a unique index).
    if open_shift_count_in(&tx, None)? > 0 {
        return Ok(false);
    }
    let project = current_project_in(&tx)?;
    let now = chrono_now();
    tx.execute(
        "INSERT INTO shifts (uuid, start_time, project_uuid, updated_at, deleted, started_from, last_active_at) \
         VALUES (?1, ?2, ?3, ?4, 0, 'desktop', ?2)",
        params![new_uuid(), now, project, sync_now()],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(true)
}

/// Liveness heartbeat: stamp last_active_at on the open shift THIS machine is
/// tracking (start_shift and the project-switch split set last_active_at; a
/// shift synced in from another device has it NULL and is left alone, so a
/// shift running on the web is never kept "alive" by this machine).
/// Local-only (not synced); does not bump updated_at, so it creates no sync
/// churn.
pub fn heartbeat_active_shift_row() -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE shifts SET last_active_at = ?1 \
         WHERE end_time IS NULL AND deleted = 0 AND last_active_at IS NOT NULL",
        params![chrono_now()],
    )
    .map_err(err)?;
    Ok(())
}

/// If a desktop-origin shift is still open but its heartbeat has gone stale
/// (the app was killed without clocking out), retro-close it to its last known
/// active time and flag it (auto_closed_at) for review. Scoped to
/// started_from = 'desktop' so a shift still running on another device is never
/// truncated. Returns the closed shift when it acted, else None.
pub fn reconcile_stale_desktop_shift_row(stale_minutes: i64) -> Result<Option<StaleClose>, String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let active = match active_shift_in(&tx)? {
        Some(s) => s,
        None => return Ok(None),
    };
    if active.started_from.as_deref() != Some("desktop") {
        return Ok(None);
    }
    // Only close a shift THIS machine actually tracked: last_active_at is
    // local-only, so a null here means the shift was synced in from another
    // device (which may still be running it) — never truncate that.
    let reference = match active.last_active_at.clone() {
        Some(r) => r,
        None => return Ok(None),
    };
    let parsed = match NaiveDateTime::parse_from_str(&reference, "%Y-%m-%dT%H:%M:%S") {
        Ok(dt) => dt,
        Err(_) => return Ok(None), // unknown format: don't guess
    };
    let now = chrono::Local::now().naive_local();
    if (now - parsed).num_minutes() <= stale_minutes {
        return Ok(None); // still fresh — a live session, leave it open
    }
    let ts = sync_now();
    tx.execute(
        "UPDATE shifts SET end_time = ?1, auto_closed_at = ?2, updated_at = ?2 \
         WHERE id = ?3 AND end_time IS NULL",
        params![reference, ts, active.id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(Some(StaleClose {
        id: active.id,
        uuid: active.uuid,
        start_time: active.start_time,
        end_time: reference,
    }))
}

/// Explicit clock-out: end whatever shift is open (also one started on
/// another device).
pub fn end_shift_row() -> Result<bool, String> {
    end_open_shift(false)
}

/// Clock-out on system suspend: end the open shift only when THIS machine is
/// tracking it (last_active_at set). A shift that runs on another device is
/// left open.
pub fn end_local_shift_row() -> Result<bool, String> {
    end_open_shift(true)
}

fn end_open_shift(local_only: bool) -> Result<bool, String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let active = match active_shift_in(&tx)? {
        Some(s) => s,
        None => return Ok(false),
    };
    if local_only && active.last_active_at.is_none() {
        return Ok(false);
    }
    tx.execute(
        "UPDATE shifts SET end_time = ?1, updated_at = ?2 WHERE id = ?3",
        params![chrono_now(), sync_now(), active.id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(true)
}

pub fn get_all_shifts_rows() -> Result<Vec<Shift>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(&format!(
            "SELECT {} FROM shifts WHERE deleted = 0 ORDER BY start_time DESC",
            SHIFT_COLUMNS
        ))
        .map_err(err)?;
    let rows = stmt.query_map([], map_shift).map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn add_shift_manual_row(start_time: &str, end_time: &str, note: Option<&str>) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO shifts (uuid, start_time, end_time, note, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![new_uuid(), start_time, end_time, note, sync_now()],
    )
    .map_err(err)?;
    Ok(())
}

/// Set (or clear) the free-text note on a shift, bumping updated_at so the
/// change wins the last-write-wins merge on the next sync.
pub fn set_shift_note_row(shift_id: i64, note: Option<&str>) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE shifts SET note = ?1, updated_at = ?2 WHERE id = ?3",
        params![note, sync_now(), shift_id],
    )
    .map_err(err)?;
    Ok(())
}

pub fn delete_shift_row(shift_id: i64) -> Result<(), String> {
    let c = conn()?;
    let now = sync_now();
    c.execute(
        "UPDATE shifts SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, shift_id],
    )
    .map_err(err)?;
    Ok(())
}

/// "Looks right": the user reviewed an auto-closed shift and keeps its times.
pub fn clear_auto_closed_row(shift_id: i64) -> Result<(), String> {
    let c = conn()?;
    let changed = c
        .execute(
            "UPDATE shifts SET auto_closed_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted = 0",
            params![sync_now(), shift_id],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err("not_found".to_string());
    }
    Ok(())
}

// ── Timeline editing: move boundaries, fill gaps, undo ─────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShiftTimeChange {
    pub id: i64,
    pub start_time: String,
    pub end_time: Option<String>,
}

/// One interval of a shift, in local time, for overlap checks.
struct Span {
    id: i64,
    start: NaiveDateTime,
    end: NaiveDateTime,
}

/// All non-deleted shifts as local-time intervals. The open shift runs to
/// now (or to its start, if that lies in the future). Rows whose times
/// can't be parsed are left out (nothing to compare).
fn spans_in(c: &Connection) -> Result<Vec<Span>, String> {
    let now = chrono::Local::now().naive_local();
    let mut stmt = c
        .prepare("SELECT id, start_time, end_time FROM shifts WHERE deleted = 0")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(err)?;
    let mut spans = Vec::new();
    for row in rows {
        let (id, s, e) = row.map_err(err)?;
        let Some(start) = to_local_naive(&s) else { continue };
        let end = match e {
            Some(e) => match to_local_naive(&e) {
                Some(end) => end,
                None => continue,
            },
            None => now.max(start),
        };
        spans.push(Span { id, start, end });
    }
    Ok(spans)
}

/// Move the start/end of one or more shifts atomically. Several changes let
/// the UI move a boundary shared by two touching shifts in one step. The
/// FINAL state is validated: start < end for closed shifts; end None only for
/// the shift that is open right now (editing a running shift's start); no
/// overlap with any other non-deleted shift (the open shift counts as running
/// to now). Times are stored as naive local "%Y-%m-%dT%H:%M:%S" (UTC/offset
/// input is converted). Each changed row gets a fresh updated_at and loses its
/// auto_closed_at flag (editing the times is the review).
/// Errors: "not_found", "invalid_range", "overlap".
pub fn update_shift_times_row(changes: &[ShiftTimeChange]) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let now = chrono::Local::now().naive_local();

    // Final state per id (a repeated id: the last change wins).
    let mut finals: Vec<(i64, NaiveDateTime, Option<NaiveDateTime>)> = Vec::new();
    for change in changes {
        let row = shift_by_id_in(&tx, change.id)?.ok_or_else(|| "not_found".to_string())?;
        let start = to_local_naive(&change.start_time).ok_or_else(|| "invalid_range".to_string())?;
        let end = match &change.end_time {
            Some(e) => {
                let end = to_local_naive(e).ok_or_else(|| "invalid_range".to_string())?;
                if start >= end {
                    return Err("invalid_range".to_string());
                }
                Some(end)
            }
            None => {
                // Only the running shift may stay open, and it can't start in
                // the future.
                if row.end_time.is_some() || start > now {
                    return Err("invalid_range".to_string());
                }
                None
            }
        };
        finals.retain(|(id, _, _)| *id != change.id);
        finals.push((change.id, start, end));
    }

    let mut spans = spans_in(&tx)?;
    spans.retain(|span| !finals.iter().any(|(id, _, _)| *id == span.id));
    for (id, start, end) in &finals {
        spans.push(Span { id: *id, start: *start, end: end.unwrap_or_else(|| now.max(*start)) });
    }
    for (id, _, _) in &finals {
        let me = spans.iter().find(|s| s.id == *id).expect("own span");
        let (ms, me_end) = (me.start, me.end);
        if spans
            .iter()
            .any(|other| other.id != *id && other.start < me_end && ms < other.end)
        {
            return Err("overlap".to_string());
        }
    }

    let ts = sync_now();
    for (id, start, end) in &finals {
        tx.execute(
            "UPDATE shifts SET start_time = ?1, end_time = ?2, auto_closed_at = NULL, updated_at = ?3 \
             WHERE id = ?4",
            params![fmt_local(*start), end.map(fmt_local), ts, id],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)
}

/// Create closed shifts in the GAPS of [range_start, range_end): every part
/// of the range not covered by a non-deleted shift (the open shift covers
/// its start to now). The range is clipped at now, so nothing is created in
/// the future. New rows: started_from 'desktop', last_active_at NULL. Then
/// touching same-project, same-note shifts on the affected days are merged.
/// Returns the uuids of the created rows (for undo; a created row that was
/// merged into a neighbour is already tombstoned, which is harmless to
/// remove again).
pub fn fill_range_row(
    range_start: &str,
    range_end: &str,
    project_uuid: Option<&str>,
    note: Option<&str>,
) -> Result<Vec<String>, String> {
    let start = to_local_naive(range_start).ok_or_else(|| "invalid_range".to_string())?;
    let end = to_local_naive(range_end).ok_or_else(|| "invalid_range".to_string())?;
    if start >= end {
        return Err("invalid_range".to_string());
    }
    let now = chrono::Local::now().naive_local();
    let end = end.min(now);
    if start >= end {
        return Ok(Vec::new());
    }

    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let mut occupied: Vec<(NaiveDateTime, NaiveDateTime)> = spans_in(&tx)?
        .into_iter()
        .filter(|s| s.start < end && s.end > start)
        .map(|s| (s.start, s.end))
        .collect();
    occupied.sort();

    let mut gaps = Vec::new();
    let mut cursor = start;
    for (s, e) in occupied {
        if s > cursor {
            gaps.push((cursor, s.min(end)));
        }
        if e > cursor {
            cursor = e;
        }
        if cursor >= end {
            break;
        }
    }
    if cursor < end {
        gaps.push((cursor, end));
    }

    let note = normalized_note(note);
    let ts = sync_now();
    let mut created = Vec::new();
    for (gs, ge) in gaps {
        if gs >= ge {
            continue;
        }
        let uuid = new_uuid();
        tx.execute(
            "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, note, updated_at, deleted, started_from) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'desktop')",
            params![uuid, fmt_local(gs), fmt_local(ge), project_uuid, note, ts],
        )
        .map_err(err)?;
        created.push(uuid);
    }
    if !created.is_empty() {
        coalesce_adjacent_shifts_in(&tx, start, end)?;
    }
    tx.commit().map_err(err)?;
    Ok(created)
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshot {
    pub uuid: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub project_uuid: Option<String>,
    pub note: Option<String>,
    pub auto_closed_at: Option<String>,
}

/// Undo: tombstone every uuid in `remove_uuids`, then put each snapshot row
/// back exactly (all fields, deleted = 0), inserting it if it no longer
/// exists. One transaction; fails with "open_conflict" (and changes nothing)
/// if the result would hold two open shifts.
///
/// started_from is immutable and kept. A row restored as OPEN that this
/// machine was tracking (last_active_at set) gets a fresh heartbeat, so the
/// stale check doesn't close it right away; an inserted open row counts as
/// tracked here.
pub fn restore_shifts_row(snapshot: &[ShiftSnapshot], remove_uuids: &[String]) -> Result<(), String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let ts = sync_now();
    let now_local = chrono_now();

    for uuid in remove_uuids {
        tx.execute(
            "UPDATE shifts SET deleted = 1, deleted_at = ?1, updated_at = ?1 \
             WHERE uuid = ?2 AND deleted = 0",
            params![ts, uuid],
        )
        .map_err(err)?;
    }

    // Closed rows first, so closing shift A before reopening shift B never
    // looks like two open shifts on the way.
    let mut ordered: Vec<&ShiftSnapshot> = snapshot.iter().collect();
    ordered.sort_by_key(|s| s.end_time.is_none());

    for snap in ordered {
        if snap.end_time.is_none() && open_shift_count_in(&tx, Some(&snap.uuid))? > 0 {
            return Err("open_conflict".to_string());
        }
        let exists: bool = tx
            .prepare("SELECT 1 FROM shifts WHERE uuid = ?1")
            .and_then(|mut s| s.exists(params![snap.uuid]))
            .map_err(err)?;
        if exists {
            tx.execute(
                "UPDATE shifts SET start_time = ?2, end_time = ?3, project_uuid = ?4, note = ?5, \
                 auto_closed_at = ?6, deleted = 0, deleted_at = NULL, updated_at = ?7, \
                 last_active_at = CASE WHEN ?3 IS NULL AND last_active_at IS NOT NULL THEN ?8 \
                                       ELSE last_active_at END \
                 WHERE uuid = ?1",
                params![
                    snap.uuid,
                    snap.start_time,
                    snap.end_time,
                    snap.project_uuid,
                    snap.note,
                    snap.auto_closed_at,
                    ts,
                    now_local
                ],
            )
            .map_err(err)?;
        } else {
            let last_active: Option<&str> = if snap.end_time.is_none() { Some(&now_local) } else { None };
            tx.execute(
                "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, note, auto_closed_at, \
                 updated_at, deleted, started_from, last_active_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'desktop', ?8)",
                params![
                    snap.uuid,
                    snap.start_time,
                    snap.end_time,
                    snap.project_uuid,
                    snap.note,
                    snap.auto_closed_at,
                    ts,
                    last_active
                ],
            )
            .map_err(err)?;
        }
    }
    if open_shift_count_in(&tx, None)? > 1 {
        return Err("open_conflict".to_string());
    }
    tx.commit().map_err(err)
}

// ── Off-day commands ────────────────────────────────────────────────

/// One live off day as the UI sees it. `reason` is None for a plain off day,
/// else a short code such as "vacation", "sick", "holiday" or "other" (the UI
/// owns the labels).
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct OffDay {
    pub date: String,
    pub reason: Option<String>,
}

/// Longest accepted off-day reason code (same rule as the server).
const OFF_DAY_REASON_MAX_LEN: usize = 32;

/// An off-day reason is None or 1–32 characters of `a-z` and `_` — the same
/// check the server makes, so a reason set here always syncs.
fn validate_off_day_reason(reason: Option<&str>) -> Result<(), String> {
    match reason {
        None => Ok(()),
        Some(r)
            if !r.is_empty()
                && r.len() <= OFF_DAY_REASON_MAX_LEN
                && r.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            Ok(())
        }
        Some(_) => Err("invalid_reason".to_string()),
    }
}

pub fn get_off_days_rows() -> Result<Vec<OffDay>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT date, reason FROM off_days WHERE deleted = 0 ORDER BY date DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(OffDay { date: row.get(0)?, reason: row.get(1)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_off_day_row(date: &str) -> Result<(), String> {
    let c = conn()?;
    // Upsert onto the (possibly tombstoned) row for this date so that
    // add / delete / re-add stays a single row and resurrects cleanly.
    // A new or re-added day is a plain off day (reason NULL); a day that is
    // already off keeps its reason.
    c.execute(
        "INSERT INTO off_days (date, uuid, updated_at, deleted, deleted_at, reason) \
         VALUES (?1, ?2, ?3, 0, NULL, NULL) \
         ON CONFLICT(date) DO UPDATE SET \
           reason = CASE WHEN off_days.deleted != 0 THEN NULL ELSE off_days.reason END, \
           deleted = 0, deleted_at = NULL, updated_at = ?3",
        params![date, new_uuid(), sync_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set why `date` is off (None = plain off day). Marks the date as an off day
/// first if it is not one, or resurrects its tombstone. Bumps updated_at so
/// the change wins the next sync. Errors: "invalid_reason".
pub fn set_off_day_reason_row(date: &str, reason: Option<&str>) -> Result<(), String> {
    validate_off_day_reason(reason)?;
    let c = conn()?;
    c.execute(
        "INSERT INTO off_days (date, uuid, updated_at, deleted, deleted_at, reason) \
         VALUES (?1, ?2, ?3, 0, NULL, ?4) \
         ON CONFLICT(date) DO UPDATE SET \
           reason = ?4, deleted = 0, deleted_at = NULL, updated_at = ?3",
        params![date, new_uuid(), sync_now(), reason],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_off_day_row(date: &str) -> Result<(), String> {
    let c = conn()?;
    let now = sync_now();
    c.execute(
        "UPDATE off_days SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE date = ?2",
        params![now, date],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Project commands ────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Project {
    pub uuid: String,
    pub name: String,
    pub color: Option<String>,
    pub archived: bool,
    pub rate: Option<String>,
    pub currency: Option<String>,
}

/// Colours offered for new projects (same palette and order as the UI).
const PROJECT_PALETTE: [&str; 10] = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
];

/// The sticky "current project" that new clock-ins are attributed to.
/// Stored as a config value; empty string means "Unassigned".
pub fn current_project_uuid() -> Result<Option<String>, String> {
    current_project_in(&conn()?)
}

fn current_project_in(c: &Connection) -> Result<Option<String>, String> {
    Ok(get_config_in(c, "current_project_uuid")?.filter(|v| !v.trim().is_empty()))
}

pub fn get_projects_rows() -> Result<Vec<Project>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(
            "SELECT uuid, name, color, archived, rate, currency FROM projects \
             WHERE deleted = 0 ORDER BY name COLLATE NOCASE",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                uuid: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                archived: row.get::<_, i64>(3)? != 0,
                rate: row.get(4)?,
                currency: row.get(5)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

pub fn create_project_row(name: &str, color: Option<&str>) -> Result<Project, String> {
    let c = conn()?;
    let uuid = new_uuid();
    insert_project_in(&c, &uuid, name, color)?;
    Ok(Project {
        uuid,
        name: name.to_string(),
        color: color.map(|s| s.to_string()),
        archived: false,
        rate: None,
        currency: None,
    })
}

fn insert_project_in(c: &Connection, uuid: &str, name: &str, color: Option<&str>) -> Result<(), String> {
    c.execute(
        "INSERT INTO projects (uuid, name, color, archived, updated_at, deleted) \
         VALUES (?1, ?2, ?3, 0, ?4, 0)",
        params![uuid, name, color, sync_now()],
    )
    .map_err(err)?;
    Ok(())
}

pub fn update_project_row(
    uuid: &str,
    name: &str,
    color: Option<&str>,
    archived: bool,
    rate: Option<&str>,
    currency: Option<&str>,
) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE projects SET name = ?2, color = ?3, archived = ?4, rate = ?5, currency = ?6, \
         updated_at = ?7 WHERE uuid = ?1",
        params![uuid, name, color, archived as i64, rate, currency, sync_now()],
    )
    .map_err(err)?;
    Ok(())
}

/// Tombstone a project. Its shifts are detached (project_uuid = NULL, so they
/// show as "Unassigned"), and it stops being the current project. One
/// transaction.
pub fn delete_project_row(uuid: &str) -> Result<(), String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let now = sync_now();
    tx.execute(
        "UPDATE projects SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE uuid = ?2",
        params![now, uuid],
    )
    .map_err(err)?;
    // Detach the project from any shifts so they revert to "Unassigned"
    // instead of pointing at a deleted project.
    tx.execute(
        "UPDATE shifts SET project_uuid = NULL, updated_at = ?1 \
         WHERE project_uuid = ?2 AND deleted = 0",
        params![now, uuid],
    )
    .map_err(err)?;
    if current_project_in(&tx)?.as_deref() == Some(uuid) {
        set_config_in(&tx, "current_project_uuid", "")?;
    }
    tx.commit().map_err(err)
}

/// Undo a project delete: bring the tombstoned row back. Shifts detached by
/// the delete are NOT re-attached here (the UI restores them with
/// restore_shifts from its own snapshot).
pub fn restore_project_row(uuid: &str) -> Result<(), String> {
    let c = conn()?;
    let changed = c
        .execute(
            "UPDATE projects SET deleted = 0, deleted_at = NULL, updated_at = ?1 WHERE uuid = ?2",
            params![sync_now(), uuid],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err("not_found".to_string());
    }
    Ok(())
}

/// Set the sticky current project. If a shift is active and its project
/// differs, auto-split: close the running segment now and open a fresh one on
/// the new project. Returns true when a split occurred.
pub fn set_current_project_row(project_uuid: Option<&str>) -> Result<bool, String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    set_config_in(&tx, "current_project_uuid", project_uuid.unwrap_or(""))?;

    let active = match active_shift_in(&tx)? {
        Some(s) => s,
        None => return tx.commit().map_err(err).map(|_| false),
    };
    if active.project_uuid.as_deref() == project_uuid {
        return tx.commit().map_err(err).map(|_| false);
    }

    let now = chrono::Local::now().naive_local();
    let now_local = fmt_local(now);
    let ts = sync_now();

    // A shift younger than a minute is just retagged: a quick correction
    // right after clock-in shouldn't leave a few-second fragment behind.
    let young = to_local_naive(&active.start_time)
        .map(|start| (now - start).num_seconds() < RETAG_WINDOW_SECONDS)
        .unwrap_or(false);
    if young {
        tx.execute(
            "UPDATE shifts SET project_uuid = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_uuid, ts, active.id],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        return Ok(false);
    }

    tx.execute(
        "UPDATE shifts SET end_time = ?1, updated_at = ?2 WHERE id = ?3",
        params![now_local, ts, active.id],
    )
    .map_err(err)?;
    // Guard: the split must leave exactly one open shift.
    if open_shift_count_in(&tx, None)? > 0 {
        return Err("open_conflict".to_string());
    }
    // The new segment continues the same tracking session: same origin, and
    // a fresh heartbeat so stale recovery can close it if the app dies.
    let origin = active.started_from.clone().unwrap_or_else(|| "desktop".to_string());
    tx.execute(
        "INSERT INTO shifts (uuid, start_time, project_uuid, updated_at, deleted, started_from, last_active_at) \
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?2)",
        params![new_uuid(), now_local, project_uuid, ts, origin],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(true)
}

/// Shifts younger than this are retagged instead of split on a project switch.
const RETAG_WINDOW_SECONDS: i64 = 60;

/// Retroactively assign a project to an entire existing shift.
pub fn set_shift_project_row(shift_id: i64, project_uuid: Option<&str>) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE shifts SET project_uuid = ?1, updated_at = ?2 WHERE id = ?3",
        params![project_uuid, sync_now(), shift_id],
    )
    .map_err(err)?;
    Ok(())
}

/// Closed, non-deleted shifts that overlap [from, to) in local time, sorted by
/// start. The SQL pre-filter on the raw strings is widened by a day so rows
/// in another frame (UTC "Z") are not missed; the exact test uses parsed
/// local times.
#[allow(clippy::type_complexity)]
fn closed_shifts_overlapping_in(
    c: &Connection,
    from: NaiveDateTime,
    to: NaiveDateTime,
) -> Result<Vec<(Shift, NaiveDateTime, NaiveDateTime)>, String> {
    let lo = fmt_local(from - chrono::Duration::days(1));
    let hi = fmt_local(to + chrono::Duration::days(1));
    let mut stmt = c
        .prepare(&format!(
            "SELECT {} FROM shifts WHERE deleted = 0 AND end_time IS NOT NULL \
             AND start_time < ?2 AND end_time > ?1",
            SHIFT_COLUMNS
        ))
        .map_err(err)?;
    let rows = stmt.query_map(params![lo, hi], map_shift).map_err(err)?;
    let mut out = Vec::new();
    for row in rows {
        let shift = row.map_err(err)?;
        let (Some(s), Some(e)) = (
            to_local_naive(&shift.start_time),
            shift.end_time.as_deref().and_then(to_local_naive),
        ) else {
            continue;
        };
        if s < to && e > from {
            out.push((shift, s, e));
        }
    }
    out.sort_by_key(|(_, s, _)| *s);
    Ok(out)
}

/// Assign a project to a time window, splitting any closed shifts that straddle
/// the window so only the covered portion is retagged. This is the primitive
/// behind the draggable timeline. Boundaries are local "%Y-%m-%dT%H:%M:%S"
/// strings (UTC/offset input is converted). Returns the number of shifts
/// touched.
///
/// Every piece of a split shift keeps its note and started_from. The
/// auto_closed_at flag ("check this end time") moves to the piece that keeps
/// the original END time, because that is the time it asks about. A split
/// shift's pieces are written in the naive local frame.
pub fn assign_project_to_range_row(
    range_start: &str,
    range_end: &str,
    project_uuid: Option<&str>,
) -> Result<u32, String> {
    let (Some(from), Some(to)) = (to_local_naive(range_start), to_local_naive(range_end)) else {
        return Ok(0);
    };
    if from >= to {
        return Ok(0);
    }
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;
    let overlapping = closed_shifts_overlapping_in(&tx, from, to)?;

    let ts = sync_now();
    let target = project_uuid.map(|s| s.to_string());
    let mut affected = 0u32;

    for (shift, s, e) in overlapping {
        if shift.project_uuid == target {
            continue; // already on the target project: nothing to split
        }
        let overlap_start = s.max(from);
        let overlap_end = e.min(to);
        if overlap_start >= overlap_end {
            continue;
        }

        // Up to three segments: [s, overlap_start) keep, [overlap_start,
        // overlap_end) = target, [overlap_end, e) keep.
        let mut segments: Vec<(NaiveDateTime, NaiveDateTime, Option<String>)> = Vec::new();
        if s < overlap_start {
            segments.push((s, overlap_start, shift.project_uuid.clone()));
        }
        segments.push((overlap_start, overlap_end, target.clone()));
        if overlap_end < e {
            segments.push((overlap_end, e, shift.project_uuid.clone()));
        }
        let last = segments.len() - 1;
        let flag_for = |i: usize| if i == last { shift.auto_closed_at.clone() } else { None };

        let (fs, fe, fp) = &segments[0];
        // Unsplit row: keep its original strings (no frame rewrite).
        let (first_start, first_end) = if segments.len() == 1 {
            (shift.start_time.clone(), shift.end_time.clone().unwrap_or_default())
        } else {
            (fmt_local(*fs), fmt_local(*fe))
        };
        tx.execute(
            "UPDATE shifts SET start_time = ?2, end_time = ?3, project_uuid = ?4, auto_closed_at = ?5, \
             updated_at = ?6 WHERE id = ?1",
            params![shift.id, first_start, first_end, fp, flag_for(0), ts],
        )
        .map_err(err)?;
        for (i, (ss, se, sp)) in segments.iter().enumerate().skip(1) {
            tx.execute(
                "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, note, started_from, \
                 auto_closed_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
                params![
                    new_uuid(),
                    fmt_local(*ss),
                    fmt_local(*se),
                    sp,
                    shift.note,
                    shift.started_from,
                    flag_for(i),
                    ts
                ],
            )
            .map_err(err)?;
        }
        affected += 1;
    }

    if affected > 0 {
        coalesce_adjacent_shifts_in(&tx, from, to)?;
    }
    tx.commit().map_err(err)?;
    Ok(affected)
}

/// Merge back-to-back shifts that share the same project AND the same note
/// (no note on both counts as equal), so that assigning then removing a range
/// doesn't leave the day fragmented into adjacent identical segments. Only
/// exactly-contiguous closed shifts are merged. Only shifts that overlap the
/// local days covering [from, to] are considered, so old history is never
/// rewritten. The merged row keeps the newest auto_closed_at of the chain, so
/// no review flag is lost. Runs inside the caller's transaction.
fn coalesce_adjacent_shifts_in(c: &Connection, from: NaiveDateTime, to: NaiveDateTime) -> Result<(), String> {
    let (from, to) = if from <= to { (from, to) } else { (to, from) };
    let day_start = from.date().and_hms_opt(0, 0, 0).expect("midnight");
    let day_end = (to.date() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .expect("midnight");
    let shifts = closed_shifts_overlapping_in(c, day_start, day_end)?;

    let ts = sync_now();
    let mut i = 0;
    while i < shifts.len() {
        let (keep, _, keep_end) = &shifts[i];
        let keep_note = normalized_note(keep.note.as_deref());
        let mut merged_end = *keep_end;
        let mut merged_end_str = keep.end_time.clone();
        let mut flag = keep.auto_closed_at.clone();
        let mut to_delete: Vec<i64> = Vec::new();

        let mut j = i + 1;
        while j < shifts.len() {
            let (cand, cstart, cend) = &shifts[j];
            if *cstart == merged_end
                && cand.project_uuid == keep.project_uuid
                && normalized_note(cand.note.as_deref()) == keep_note
            {
                merged_end = *cend;
                merged_end_str = cand.end_time.clone();
                if cand.auto_closed_at > flag {
                    flag = cand.auto_closed_at.clone();
                }
                to_delete.push(cand.id);
                j += 1;
            } else {
                break;
            }
        }

        if !to_delete.is_empty() {
            c.execute(
                "UPDATE shifts SET end_time = ?1, auto_closed_at = ?2, updated_at = ?3 WHERE id = ?4",
                params![merged_end_str, flag, ts, keep.id],
            )
            .map_err(err)?;
            for id in to_delete {
                c.execute(
                    "UPDATE shifts SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![ts, id],
                )
                .map_err(err)?;
            }
        }
        i = j;
    }
    Ok(())
}

/// Notes are compared trimmed; an empty note equals no note.
fn normalized_note(note: Option<&str>) -> Option<String> {
    note.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string)
}

// ── Config commands ─────────────────────────────────────────────────

pub fn get_config_row(key: &str) -> Result<Option<String>, String> {
    get_config_in(&conn()?, key)
}

fn get_config_in(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT value FROM config WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(err)
}

pub fn set_config_row(key: &str, value: &str) -> Result<(), String> {
    set_config_in(&conn()?, key, value)
}

fn set_config_in(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(err)?;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

const LOCAL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

fn chrono_now() -> String {
    chrono::Local::now().format(LOCAL_FORMAT).to_string()
}

fn fmt_local(dt: NaiveDateTime) -> String {
    dt.format(LOCAL_FORMAT).to_string()
}

/// Parse a shift timestamp into naive LOCAL time. Desktop rows are naive
/// local ("2026-10-01T09:00:00", maybe with fractional seconds); web rows can
/// be UTC ("...Z") or carry an offset — those are converted to local time.
/// Returns None for anything else. Fractional seconds are dropped.
pub fn to_local_naive(ts: &str) -> Option<NaiveDateTime> {
    use chrono::Timelike;
    let ts = ts.trim();
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(ts, format) {
            return dt.with_nanosecond(0);
        }
    }
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .and_then(|dt| dt.with_timezone(&chrono::Local).naive_local().with_nanosecond(0))
}

/// Canonical UTC microsecond timestamp for sync metadata. Byte-for-byte
/// comparable with the server's timestamps so last-write-wins is unambiguous.
pub fn sync_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.6f+00:00")
        .to_string()
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── Full-state sync support ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SyncShift {
    pub uuid: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub project_uuid: Option<String>,
    pub note: Option<String>,
    pub updated_at: String,
    pub deleted: bool,
    pub deleted_at: Option<String>,
    pub auto_closed_at: Option<String>,
    pub started_from: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncOffDay {
    pub uuid: String,
    pub date: String,
    pub reason: Option<String>,
    pub updated_at: String,
    pub deleted: bool,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncProject {
    pub uuid: String,
    pub name: String,
    pub color: Option<String>,
    pub archived: bool,
    pub rate: Option<String>,
    pub currency: Option<String>,
    pub updated_at: String,
    pub deleted: bool,
    pub deleted_at: Option<String>,
}

/// All local shifts including tombstones, for pushing to the server.
pub fn get_all_shifts_for_sync() -> Result<Vec<SyncShift>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(
            "SELECT uuid, start_time, end_time, project_uuid, updated_at, deleted, deleted_at, \
             auto_closed_at, started_from, note FROM shifts WHERE uuid IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncShift {
                uuid: row.get(0)?,
                start_time: row.get(1)?,
                end_time: row.get(2)?,
                project_uuid: row.get(3)?,
                updated_at: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                deleted: row.get::<_, i64>(5)? != 0,
                deleted_at: row.get(6)?,
                auto_closed_at: row.get(7)?,
                started_from: row.get(8)?,
                note: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// All local off-days including tombstones, for pushing to the server.
pub fn get_all_off_days_for_sync() -> Result<Vec<SyncOffDay>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(
            "SELECT uuid, date, updated_at, deleted, deleted_at, reason \
             FROM off_days WHERE uuid IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncOffDay {
                uuid: row.get(0)?,
                date: row.get(1)?,
                updated_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                deleted: row.get::<_, i64>(3)? != 0,
                deleted_at: row.get(4)?,
                reason: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Apply a server shift to the local DB with last-write-wins semantics.
/// Keyed by uuid; only overwrites when the incoming record is strictly newer,
/// which protects a concurrent local edit made during the sync round-trip.
///
/// The local DB allows at most one open shift (unique index). The caller
/// applies closed/deleted rows before open ones, so a close of shift A always
/// lands before an open shift B. If an incoming OPEN row still collides with
/// a different local open shift (e.g. a clock-in here during the round-trip),
/// that row is skipped for this round: the next sync pushes both, the server
/// keeps one open, and the following apply converges.
pub fn apply_synced_shift(shift: &SyncShift) -> Result<(), String> {
    let c = conn()?;
    let local_updated: Option<String> = c
        .query_row(
            "SELECT updated_at FROM shifts WHERE uuid = ?1",
            params![shift.uuid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let would_be_open = shift.end_time.is_none() && !shift.deleted;
    let wins = match &local_updated {
        None => true,
        Some(local) => shift.updated_at > *local,
    };
    if wins && would_be_open && open_shift_count_in(&c, Some(&shift.uuid))? > 0 {
        eprintln!("sync: deferring open shift {} (another shift is open locally)", shift.uuid);
        return Ok(());
    }

    match local_updated {
        None => {
            c.execute(
                "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, updated_at, deleted, deleted_at, \
                 auto_closed_at, started_from, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    shift.uuid,
                    shift.start_time,
                    shift.end_time,
                    shift.project_uuid,
                    shift.updated_at,
                    shift.deleted as i64,
                    shift.deleted_at,
                    shift.auto_closed_at,
                    shift.started_from,
                    shift.note
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if shift.updated_at > local => {
            c.execute(
                "UPDATE shifts SET start_time = ?2, end_time = ?3, project_uuid = ?4, updated_at = ?5, \
                 deleted = ?6, deleted_at = ?7, auto_closed_at = ?8, started_from = COALESCE(started_from, ?9), \
                 note = ?10 WHERE uuid = ?1",
                params![
                    shift.uuid,
                    shift.start_time,
                    shift.end_time,
                    shift.project_uuid,
                    shift.updated_at,
                    shift.deleted as i64,
                    shift.deleted_at,
                    shift.auto_closed_at,
                    shift.started_from,
                    shift.note
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(_) => {}
    }
    Ok(())
}

/// Apply a server off-day to the local DB with last-write-wins semantics,
/// keyed by date so tombstones resurrect the same row.
pub fn apply_synced_off_day(off_day: &SyncOffDay) -> Result<(), String> {
    let c = conn()?;
    let local_updated: Option<String> = c
        .query_row(
            "SELECT updated_at FROM off_days WHERE date = ?1",
            params![off_day.date],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    match local_updated {
        None => {
            c.execute(
                "INSERT INTO off_days (date, uuid, updated_at, deleted, deleted_at, reason) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    off_day.date,
                    off_day.uuid,
                    off_day.updated_at,
                    off_day.deleted as i64,
                    off_day.deleted_at,
                    off_day.reason
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if off_day.updated_at > local => {
            c.execute(
                "UPDATE off_days SET updated_at = ?2, deleted = ?3, deleted_at = ?4, reason = ?5 \
                 WHERE date = ?1",
                params![
                    off_day.date,
                    off_day.updated_at,
                    off_day.deleted as i64,
                    off_day.deleted_at,
                    off_day.reason
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(_) => {}
    }
    Ok(())
}

/// All local projects including tombstones, for pushing to the server.
pub fn get_all_projects_for_sync() -> Result<Vec<SyncProject>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(
            "SELECT uuid, name, color, archived, updated_at, deleted, deleted_at, rate, currency \
             FROM projects WHERE uuid IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncProject {
                uuid: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                archived: row.get::<_, i64>(3)? != 0,
                updated_at: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                deleted: row.get::<_, i64>(5)? != 0,
                deleted_at: row.get(6)?,
                rate: row.get(7)?,
                currency: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Apply a server project to the local DB with last-write-wins semantics,
/// keyed by uuid.
pub fn apply_synced_project(project: &SyncProject) -> Result<(), String> {
    let c = conn()?;
    let local_updated: Option<String> = c
        .query_row(
            "SELECT updated_at FROM projects WHERE uuid = ?1",
            params![project.uuid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    match local_updated {
        None => {
            c.execute(
                "INSERT INTO projects (uuid, name, color, archived, updated_at, deleted, deleted_at, rate, currency) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    project.uuid,
                    project.name,
                    project.color,
                    project.archived as i64,
                    project.updated_at,
                    project.deleted as i64,
                    project.deleted_at,
                    project.rate,
                    project.currency
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if project.updated_at > local => {
            c.execute(
                "UPDATE projects SET name = ?2, color = ?3, archived = ?4, updated_at = ?5, \
                 deleted = ?6, deleted_at = ?7, rate = ?8, currency = ?9 WHERE uuid = ?1",
                params![
                    project.uuid,
                    project.name,
                    project.color,
                    project.archived as i64,
                    project.updated_at,
                    project.deleted as i64,
                    project.deleted_at,
                    project.rate,
                    project.currency
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(_) => {}
    }
    Ok(())
}

/// Garbage-collect tombstones that were deleted before `cutoff` (a canonical
/// UTC timestamp). Keeps the local DB from growing without bound while leaving
/// a wide enough window that a long-offline peer won't resurrect the row.
pub fn gc_tombstones(cutoff: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "DELETE FROM shifts WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "DELETE FROM off_days WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "DELETE FROM projects WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Import ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub shifts_imported: usize,
    pub shifts_skipped: usize,
    pub offdays_imported: usize,
    pub offdays_skipped: usize,
}

/// Split CSV text into records (RFC 4180): cells may be quoted; a quoted cell
/// can hold commas, newlines and doubled quotes (""). Cells are returned
/// unquoted; whitespace around unquoted cells is trimmed.
fn parse_csv(content: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false; // the current cell started with a quote
    let mut in_quotes = false;
    let mut chars = content.chars().peekable();

    let finish_cell = |cell: &mut String, quoted: &mut bool, record: &mut Vec<String>| {
        let value = if *quoted { std::mem::take(cell) } else { std::mem::take(cell).trim().to_string() };
        record.push(value);
        *quoted = false;
    };

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                cell.push(ch);
            }
            continue;
        }
        match ch {
            '"' if cell.trim().is_empty() && !quoted => {
                cell.clear();
                quoted = true;
                in_quotes = true;
            }
            ',' => finish_cell(&mut cell, &mut quoted, &mut record),
            '\r' => {}
            '\n' => {
                finish_cell(&mut cell, &mut quoted, &mut record);
                records.push(std::mem::take(&mut record));
            }
            _ => cell.push(ch),
        }
    }
    if !cell.is_empty() || quoted || !record.is_empty() {
        finish_cell(&mut cell, &mut quoted, &mut record);
        records.push(record);
    }
    // Drop blank lines.
    records.retain(|r| r.iter().any(|c| !c.is_empty()));
    records
}

/// Column positions in the [Shifts] section. The current export writes
/// `ID,Start Time,End Time,Duration (Hours),Project,Note`; older files only
/// have ID,Start,End(,Duration) — then the fixed layout is used.
struct ShiftColumns {
    start: usize,
    end: usize,
    project: Option<usize>,
    note: Option<usize>,
}

impl ShiftColumns {
    fn legacy() -> Self {
        ShiftColumns { start: 1, end: 2, project: None, note: None }
    }

    fn from_header(header: &[String]) -> Self {
        let find = |name: &str| header.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
        let legacy = Self::legacy();
        ShiftColumns {
            start: find("Start Time").unwrap_or(legacy.start),
            end: find("End Time").unwrap_or(legacy.end),
            project: find("Project"),
            note: find("Note"),
        }
    }
}

/// Find a project by name (case-insensitive, archived included) or create it
/// with the first palette colour not used by another project.
fn project_for_import(
    c: &Connection,
    name: &str,
    cache: &mut std::collections::HashMap<String, String>,
) -> Result<String, String> {
    let key = name.to_lowercase();
    if let Some(uuid) = cache.get(&key) {
        return Ok(uuid.clone());
    }
    let existing: Option<String> = c
        .query_row(
            "SELECT uuid FROM projects WHERE deleted = 0 AND lower(name) = lower(?1) \
             ORDER BY archived, updated_at DESC LIMIT 1",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    let uuid = match existing {
        Some(uuid) => uuid,
        None => {
            let used: Vec<String> = {
                let mut stmt = c
                    .prepare("SELECT lower(color) FROM projects WHERE deleted = 0 AND color IS NOT NULL")
                    .map_err(err)?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(err)?
            };
            let color = PROJECT_PALETTE
                .iter()
                .find(|c| !used.iter().any(|u| u == *c))
                .copied()
                .unwrap_or(PROJECT_PALETTE[used.len() % PROJECT_PALETTE.len()]);
            let uuid = new_uuid();
            insert_project_in(c, &uuid, name, Some(color))?;
            uuid
        }
    };
    cache.insert(key, uuid.clone());
    Ok(uuid)
}

/// Import a CSV export. Shifts are matched by start time (an existing start
/// time is skipped). Rows without an end time are skipped too: an export's
/// running shift belongs to the machine it was exported from, and an
/// imported open shift could never be heartbeat- or stale-closed here.
/// One transaction.
pub fn import_csv(content: &str) -> Result<ImportResult, String> {
    let mut c = conn()?;
    let tx = write_tx(&mut c)?;

    let mut section = ""; // "", "shifts", or "offdays"
    let mut columns = ShiftColumns::legacy();
    let mut projects: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut shifts_imported: usize = 0;
    let mut shifts_skipped: usize = 0;
    let mut offdays_imported: usize = 0;
    let mut offdays_skipped: usize = 0;

    for record in parse_csv(content) {
        let first = record[0].trim();

        // Section headers
        if first == "[Shifts]" {
            section = "shifts";
            columns = ShiftColumns::legacy();
            continue;
        }
        if first == "[Off Days]" {
            section = "offdays";
            continue;
        }

        // Header row (also starts a shifts section in the legacy format
        // without section markers).
        if (section.is_empty() || section == "shifts") && first == "ID" {
            section = "shifts";
            columns = ShiftColumns::from_header(&record);
            continue;
        }
        if section == "offdays" && first == "Date" {
            continue;
        }

        match section {
            "shifts" => {
                let cell = |i: usize| record.get(i).map(|v| v.trim()).unwrap_or("");
                let start_raw = cell(columns.start);
                if start_raw.is_empty() {
                    continue;
                }
                let end_raw = cell(columns.end);
                if end_raw.is_empty() {
                    shifts_skipped += 1;
                    continue;
                }

                // Normalise timestamps: strip microseconds (.123456)
                let start_norm = normalise_timestamp(start_raw);
                let end_norm = normalise_timestamp(end_raw);

                // Duplicate check by start_time
                let exists: bool = tx
                    .prepare("SELECT 1 FROM shifts WHERE start_time = ?1")
                    .and_then(|mut s| s.exists(params![&start_norm]))
                    .map_err(err)?;
                if exists {
                    shifts_skipped += 1;
                    continue;
                }

                let project_uuid = match columns.project.map(|i| record.get(i).map(|v| v.trim()).unwrap_or("")) {
                    Some(name) if !name.is_empty() => Some(project_for_import(&tx, name, &mut projects)?),
                    _ => None,
                };
                let note = columns
                    .note
                    .and_then(|i| record.get(i))
                    .and_then(|n| normalized_note(Some(n)));

                tx.execute(
                    "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, note, updated_at, \
                     deleted, started_from) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'desktop')",
                    params![new_uuid(), &start_norm, &end_norm, project_uuid, note, sync_now()],
                )
                .map_err(err)?;
                shifts_imported += 1;
            }
            "offdays" => {
                // INSERT OR IGNORE handles duplicates
                let changed = tx
                    .execute(
                        "INSERT OR IGNORE INTO off_days (date, uuid, updated_at, deleted) \
                         VALUES (?1, ?2, ?3, 0)",
                        params![first, new_uuid(), sync_now()],
                    )
                    .map_err(err)?;
                if changed > 0 {
                    offdays_imported += 1;
                } else {
                    offdays_skipped += 1;
                }
            }
            _ => {
                // Unknown section, skip
            }
        }
    }

    tx.commit().map_err(err)?;
    Ok(ImportResult {
        shifts_imported,
        shifts_skipped,
        offdays_imported,
        offdays_skipped,
    })
}

/// Strip fractional seconds from ISO timestamps for consistency, keeping any
/// zone suffix. "2025-01-01T08:00:00.123456" → "2025-01-01T08:00:00",
/// "2025-01-01T08:00:00.000Z" → "2025-01-01T08:00:00Z".
fn normalise_timestamp(ts: &str) -> String {
    match ts.find('.') {
        Some(pos) => {
            let rest = &ts[pos + 1..];
            let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            format!("{}{}", &ts[..pos], &rest[digits..])
        }
        None => ts.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Point this test thread at a fresh temp database.
    fn setup() {
        let path = std::env::temp_dir().join(format!("tsw-db-test-{}.db", new_uuid()));
        TEST_DB_PATH.with(|p| *p.borrow_mut() = Some(path));
        init_db().unwrap();
    }

    fn ago(minutes: i64) -> String {
        fmt_local(chrono::Local::now().naive_local() - chrono::Duration::minutes(minutes))
    }

    fn insert(
        start: &str,
        end: Option<&str>,
        project: Option<&str>,
        note: Option<&str>,
        started_from: Option<&str>,
        last_active: Option<&str>,
    ) -> i64 {
        let c = conn().unwrap();
        c.execute(
            "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, note, started_from, \
             last_active_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'old', 0)",
            params![new_uuid(), start, end, project, note, started_from, last_active],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn get(id: i64) -> (Shift, String, bool) {
        let c = conn().unwrap();
        let shift = c
            .query_row(&format!("SELECT {} FROM shifts WHERE id = ?1", SHIFT_COLUMNS), params![id], map_shift)
            .unwrap();
        let (updated, deleted): (String, i64) = c
            .query_row("SELECT updated_at, deleted FROM shifts WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        (shift, updated, deleted != 0)
    }

    fn live() -> Vec<Shift> {
        let mut all = get_all_shifts_rows().unwrap();
        all.sort_by(|a, b| a.start_time.cmp(&b.start_time));
        all
    }

    #[test]
    fn to_local_naive_handles_frames() {
        let naive = to_local_naive("2026-03-01T09:00:00").unwrap();
        assert_eq!(fmt_local(naive), "2026-03-01T09:00:00");
        assert_eq!(fmt_local(to_local_naive("2026-03-01T09:00:00.123456").unwrap()), "2026-03-01T09:00:00");
        let utc = to_local_naive("2026-03-01T09:00:00Z").unwrap();
        let expected = chrono::DateTime::parse_from_rfc3339("2026-03-01T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Local)
            .naive_local();
        assert_eq!(utc, expected);
        assert!(to_local_naive("2026-03-01T09:00:00.000+02:00").is_some());
        assert!(to_local_naive("garbage").is_none());
    }

    #[test]
    fn split_keeps_origin_and_heartbeat() {
        setup();
        let id = insert(&ago(120), None, None, None, Some("web"), None);
        assert!(set_current_project_row(Some("p1")).unwrap());
        let (old, _, _) = get(id);
        assert!(old.end_time.is_some());
        let active = get_active_shift_row().unwrap().unwrap();
        assert_ne!(active.id, id);
        assert_eq!(active.project_uuid.as_deref(), Some("p1"));
        assert_eq!(active.started_from.as_deref(), Some("web"));
        assert!(active.last_active_at.is_some());
        assert_eq!(current_project_uuid().unwrap().as_deref(), Some("p1"));
    }

    #[test]
    fn young_shift_is_retagged_not_split() {
        setup();
        assert!(start_shift_row().unwrap());
        let c = conn().unwrap();
        c.execute("UPDATE shifts SET start_time = ?1", params![fmt_local(
            chrono::Local::now().naive_local() - chrono::Duration::seconds(30)
        )])
        .unwrap();
        assert!(!set_current_project_row(Some("p2")).unwrap());
        let all = live();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].project_uuid.as_deref(), Some("p2"));
        assert!(all[0].end_time.is_none());
    }

    #[test]
    fn heartbeat_only_touches_locally_tracked_shift() {
        setup();
        let id = insert(&ago(30), None, None, None, Some("web"), None);
        heartbeat_active_shift_row().unwrap();
        assert!(get(id).0.last_active_at.is_none());
        // Not tracked here: suspend must not end it.
        assert!(!end_local_shift_row().unwrap());
        assert!(get(id).0.end_time.is_none());

        let c = conn().unwrap();
        c.execute("UPDATE shifts SET last_active_at = '2000-01-01T00:00:00' WHERE id = ?1", params![id])
            .unwrap();
        heartbeat_active_shift_row().unwrap();
        assert_ne!(get(id).0.last_active_at.as_deref(), Some("2000-01-01T00:00:00"));
        assert!(end_local_shift_row().unwrap());
        assert!(get(id).0.end_time.is_some());
    }

    #[test]
    fn stale_desktop_shift_is_closed_to_last_heartbeat() {
        setup();
        let beat = ago(30);
        let id = insert(&ago(120), None, None, None, Some("desktop"), Some(&beat));
        let closed = reconcile_stale_desktop_shift_row(11).unwrap().unwrap();
        assert_eq!(closed.id, id);
        assert_eq!(closed.end_time, beat);
        let (s, _, _) = get(id);
        assert_eq!(s.end_time.as_deref(), Some(beat.as_str()));
        assert!(s.auto_closed_at.is_some());
        assert!(reconcile_stale_desktop_shift_row(11).unwrap().is_none());
    }

    #[test]
    fn single_open_shift_is_enforced() {
        setup();
        assert!(start_shift_row().unwrap());
        assert!(!start_shift_row().unwrap());
        let c = conn().unwrap();
        let second = c.execute(
            "INSERT INTO shifts (uuid, start_time, deleted) VALUES ('x', '2026-01-01T08:00:00', 0)",
            [],
        );
        assert!(second.is_err(), "unique index must reject a second open shift");
    }

    #[test]
    fn migration_closes_duplicate_open_shifts() {
        setup();
        let c = conn().unwrap();
        c.execute(&format!("DROP INDEX {}", SINGLE_OPEN_INDEX), []).unwrap();
        let old = insert("2026-01-05T08:00:00", None, None, None, Some("desktop"), Some("2026-01-05T12:30:00"));
        let older = insert("2026-01-04T08:00:00", None, None, None, Some("web"), None);
        let newest = insert("2026-01-06T08:00:00", None, None, None, Some("desktop"), None);
        migrate_single_open_shift(&c).unwrap();
        assert!(get(newest).0.end_time.is_none());
        let (o, _, _) = get(old);
        assert_eq!(o.end_time.as_deref(), Some("2026-01-05T12:30:00"));
        assert!(o.auto_closed_at.is_some());
        assert_eq!(get(older).0.end_time.as_deref(), Some("2026-01-04T23:59:59"));
    }

    #[test]
    fn coalesce_respects_notes_and_scope() {
        setup();
        let a = insert("2026-02-02T09:00:00", Some("2026-02-02T10:00:00"), Some("p"), Some("x"), None, None);
        let b = insert("2026-02-02T10:00:00", Some("2026-02-02T11:00:00"), Some("p"), Some("y"), None, None);
        let c1 = insert("2026-02-02T11:00:00", Some("2026-02-02T12:00:00"), Some("p"), Some("y"), None, None);
        // Touching identical pair on another day: out of scope, untouched.
        let d = insert("2026-01-10T09:00:00", Some("2026-01-10T10:00:00"), None, None, None, None);
        let e = insert("2026-01-10T10:00:00", Some("2026-01-10T11:00:00"), None, None, None, None);
        let conn_ = conn().unwrap();
        coalesce_adjacent_shifts_in(
            &conn_,
            to_local_naive("2026-02-02T09:30:00").unwrap(),
            to_local_naive("2026-02-02T09:45:00").unwrap(),
        )
        .unwrap();
        assert!(!get(a).2, "different note: kept");
        assert_eq!(get(b).0.end_time.as_deref(), Some("2026-02-02T12:00:00"));
        assert!(get(c1).2, "same note: merged away");
        assert!(!get(d).2 && !get(e).2);
        assert_eq!(get(d).1, "old", "out-of-scope rows keep updated_at");
    }

    #[test]
    fn assign_range_copies_note_origin_and_moves_flag() {
        setup();
        let id = insert("2026-03-03T09:00:00", Some("2026-03-03T17:00:00"), None, Some("work"), Some("web"), None);
        conn().unwrap()
            .execute("UPDATE shifts SET auto_closed_at = 'flag' WHERE id = ?1", params![id])
            .unwrap();
        let n = assign_project_to_range_row("2026-03-03T11:00:00", "2026-03-03T12:00:00", Some("p")).unwrap();
        assert_eq!(n, 1);
        let all = live();
        assert_eq!(all.len(), 3);
        for s in &all {
            assert_eq!(s.note.as_deref(), Some("work"));
            assert_eq!(s.started_from.as_deref(), Some("web"));
        }
        assert_eq!(all[1].project_uuid.as_deref(), Some("p"));
        assert_eq!(all[0].auto_closed_at, None);
        assert_eq!(all[1].auto_closed_at, None);
        assert_eq!(all[2].auto_closed_at.as_deref(), Some("flag"));
        assert_eq!(all[2].end_time.as_deref(), Some("2026-03-03T17:00:00"));

        // Removing the project again merges the pieces back into one.
        assign_project_to_range_row("2026-03-03T11:00:00", "2026-03-03T12:00:00", None).unwrap();
        let all = live();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].end_time.as_deref(), Some("2026-03-03T17:00:00"));
        assert_eq!(all[0].auto_closed_at.as_deref(), Some("flag"));
    }

    #[test]
    fn update_shift_times_validates_final_state() {
        setup();
        let a = insert("2026-04-01T09:00:00", Some("2026-04-01T12:00:00"), None, None, None, None);
        let b = insert("2026-04-01T12:00:00", Some("2026-04-01T15:00:00"), None, None, None, None);
        conn().unwrap()
            .execute("UPDATE shifts SET auto_closed_at = 'flag' WHERE id = ?1", params![b])
            .unwrap();
        let change = |id, s: &str, e: Option<&str>| ShiftTimeChange {
            id,
            start_time: s.to_string(),
            end_time: e.map(str::to_string),
        };

        // Moving only one side of a shared boundary overlaps.
        assert_eq!(
            update_shift_times_row(&[change(a, "2026-04-01T09:00:00", Some("2026-04-01T13:00:00"))]),
            Err("overlap".to_string())
        );
        // Moving both sides at once is fine.
        update_shift_times_row(&[
            change(a, "2026-04-01T09:00:00", Some("2026-04-01T13:00:00")),
            change(b, "2026-04-01T13:00:00", Some("2026-04-01T15:00:00")),
        ])
        .unwrap();
        assert_eq!(get(a).0.end_time.as_deref(), Some("2026-04-01T13:00:00"));
        assert_eq!(get(b).0.start_time, "2026-04-01T13:00:00");
        assert!(get(b).0.auto_closed_at.is_none());
        assert_ne!(get(b).1, "old");

        assert_eq!(
            update_shift_times_row(&[change(a, "2026-04-01T14:00:00", Some("2026-04-01T13:00:00"))]),
            Err("invalid_range".to_string())
        );
        assert_eq!(
            update_shift_times_row(&[change(a, "2026-04-01T09:00:00", None)]),
            Err("invalid_range".to_string())
        );
        assert_eq!(
            update_shift_times_row(&[change(9999, "2026-04-01T09:00:00", Some("2026-04-01T10:00:00"))]),
            Err("not_found".to_string())
        );

        // The running shift: its start may move, but not into another shift.
        let open = insert(&ago(60), None, None, None, Some("desktop"), Some(&ago(1)));
        update_shift_times_row(&[change(open, &ago(90), None)]).unwrap();
        assert!(get(open).0.end_time.is_none());
        let before = insert(&ago(200), Some(&ago(100)), None, None, None, None);
        assert_eq!(
            update_shift_times_row(&[change(open, &ago(150), None)]),
            Err("overlap".to_string())
        );
        let _ = before;
    }

    #[test]
    fn fill_range_only_fills_gaps() {
        setup();
        insert("2026-05-01T10:00:00", Some("2026-05-01T11:00:00"), Some("p"), None, None, None);
        let created = fill_range_row("2026-05-01T09:00:00", "2026-05-01T12:00:00", Some("q"), Some("n")).unwrap();
        assert_eq!(created.len(), 2);
        let all = live();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].start_time, "2026-05-01T09:00:00");
        assert_eq!(all[0].end_time.as_deref(), Some("2026-05-01T10:00:00"));
        assert_eq!(all[2].start_time, "2026-05-01T11:00:00");
        assert_eq!(all[2].end_time.as_deref(), Some("2026-05-01T12:00:00"));
        assert_eq!(all[0].started_from.as_deref(), Some("desktop"));
        assert!(all[0].last_active_at.is_none());
        // Full range now occupied: nothing to do.
        assert!(fill_range_row("2026-05-01T09:00:00", "2026-05-01T12:00:00", None, None).unwrap().is_empty());
        // The open shift counts as occupied up to now; the future is clipped.
        setup();
        start_shift_row().unwrap();
        conn().unwrap().execute("UPDATE shifts SET start_time = ?1", params![ago(30)]).unwrap();
        let created = fill_range_row(&ago(60), &fmt_local(
            chrono::Local::now().naive_local() + chrono::Duration::hours(2)
        ), None, None).unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(live().len(), 2);
    }

    #[test]
    fn restore_shifts_undoes_a_split() {
        setup();
        let id = insert(&ago(120), None, None, Some("n"), Some("desktop"), Some(&ago(2)));
        let snap = {
            let s = get(id).0;
            ShiftSnapshot {
                uuid: s.uuid.clone(),
                start_time: s.start_time.clone(),
                end_time: None,
                project_uuid: None,
                note: s.note.clone(),
                auto_closed_at: None,
            }
        };
        assert!(set_current_project_row(Some("p")).unwrap());
        let new_uuid_ = get_active_shift_row().unwrap().unwrap().uuid;

        // Restoring the old open shift without removing the new one conflicts.
        assert_eq!(
            restore_shifts_row(std::slice::from_ref(&snap), &[]),
            Err("open_conflict".to_string())
        );
        assert_eq!(get_active_shift_row().unwrap().unwrap().uuid, new_uuid_, "rolled back");

        restore_shifts_row(&[snap], &[new_uuid_]).unwrap();
        let all = live();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, id);
        assert!(all[0].end_time.is_none());
        assert!(all[0].project_uuid.is_none());
    }

    #[test]
    fn restore_shifts_inserts_missing_rows() {
        setup();
        let snap = ShiftSnapshot {
            uuid: "gone".to_string(),
            start_time: "2026-06-01T09:00:00".to_string(),
            end_time: Some("2026-06-01T10:00:00".to_string()),
            project_uuid: None,
            note: Some("back".to_string()),
            auto_closed_at: Some("flag".to_string()),
        };
        restore_shifts_row(&[snap], &[]).unwrap();
        let all = live();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].uuid, "gone");
        assert_eq!(all[0].auto_closed_at.as_deref(), Some("flag"));
    }

    #[test]
    fn project_delete_and_restore() {
        setup();
        let p = create_project_row("Client", Some("#3b82f6")).unwrap();
        let id = insert("2026-06-02T09:00:00", Some("2026-06-02T10:00:00"), Some(&p.uuid), None, None, None);
        set_config_row("current_project_uuid", &p.uuid).unwrap();
        delete_project_row(&p.uuid).unwrap();
        assert!(get_projects_rows().unwrap().is_empty());
        assert!(get(id).0.project_uuid.is_none(), "delete detaches shifts");
        assert!(current_project_uuid().unwrap().is_none());
        restore_project_row(&p.uuid).unwrap();
        assert_eq!(get_projects_rows().unwrap().len(), 1);
        assert_eq!(restore_project_row("nope"), Err("not_found".to_string()));
    }

    #[test]
    fn clear_auto_closed_drops_flag() {
        setup();
        let id = insert("2026-06-03T09:00:00", Some("2026-06-03T10:00:00"), None, None, None, None);
        conn().unwrap()
            .execute("UPDATE shifts SET auto_closed_at = 'flag' WHERE id = ?1", params![id])
            .unwrap();
        clear_auto_closed_row(id).unwrap();
        assert!(get(id).0.auto_closed_at.is_none());
        assert_ne!(get(id).1, "old");
        assert_eq!(clear_auto_closed_row(424242), Err("not_found".to_string()));
    }

    #[test]
    fn sync_apply_defers_conflicting_open_shift() {
        setup();
        let local = insert(&ago(10), None, None, None, Some("desktop"), Some(&ago(1)));
        let incoming = |uuid: &str, end: Option<&str>| SyncShift {
            uuid: uuid.to_string(),
            start_time: "2026-07-01T09:00:00".to_string(),
            end_time: end.map(str::to_string),
            project_uuid: None,
            note: None,
            updated_at: sync_now(),
            deleted: false,
            deleted_at: None,
            auto_closed_at: None,
            started_from: Some("web".to_string()),
        };
        apply_synced_shift(&incoming("remote-open", None)).unwrap();
        assert_eq!(live().len(), 1, "deferred, local open shift kept");
        assert_eq!(get_active_shift_row().unwrap().unwrap().id, local);

        // Closed rows still apply.
        apply_synced_shift(&incoming("remote-closed", Some("2026-07-01T10:00:00"))).unwrap();
        assert_eq!(live().len(), 2);
    }

    #[test]
    fn csv_import_reads_project_and_quoted_note() {
        setup();
        create_project_row("Existing", Some("#3b82f6")).unwrap();
        let csv = "[Shifts]\n\
ID,Start Time,End Time,Duration (Hours),Project,Note\n\
1,2026-08-01T09:00:00,2026-08-01T10:00:00,1.00,existing,\"Call, with \"\"quotes\"\"\nand a newline\"\n\
2,2026-08-02T09:00:00,2026-08-02T10:00:00,1.00,New One,\n\
3,2026-08-03T09:00:00,,,,\n\
\n\
[Off Days]\n\
Date\n\
\"2026-08-05\"\n";
        let result = import_csv(csv).unwrap();
        assert_eq!(result.shifts_imported, 2);
        assert_eq!(result.shifts_skipped, 1, "open row skipped");
        assert_eq!(result.offdays_imported, 1);
        let projects = get_projects_rows().unwrap();
        assert_eq!(projects.len(), 2);
        let existing = projects.iter().find(|p| p.name == "Existing").unwrap();
        let created = projects.iter().find(|p| p.name == "New One").unwrap();
        assert_eq!(created.color.as_deref(), Some("#10b981"), "first unused palette colour");
        let all = live();
        assert_eq!(all[0].project_uuid.as_deref(), Some(existing.uuid.as_str()));
        assert_eq!(all[0].note.as_deref(), Some("Call, with \"quotes\"\nand a newline"));
        assert_eq!(all[0].started_from.as_deref(), Some("desktop"));
        assert!(!all[0].uuid.is_empty());
        assert_eq!(all[1].project_uuid.as_deref(), Some(created.uuid.as_str()));
        assert!(all[1].note.is_none());
        assert_eq!(
            get_off_days_rows().unwrap(),
            vec![OffDay { date: "2026-08-05".to_string(), reason: None }]
        );

        // Re-import skips duplicates.
        let again = import_csv(csv).unwrap();
        assert_eq!(again.shifts_imported, 0);
    }

    #[test]
    fn csv_import_legacy_layout() {
        setup();
        let csv = "ID,Start Time,End Time,Duration (Hours)\n\
1,2026-09-01T09:00:00.123456,2026-09-01T17:00:00,8.00\n";
        let result = import_csv(csv).unwrap();
        assert_eq!(result.shifts_imported, 1);
        let all = live();
        assert_eq!(all[0].start_time, "2026-09-01T09:00:00");
        assert!(all[0].project_uuid.is_none());
        assert_eq!(normalise_timestamp("2026-04-07T08:00:00.000Z"), "2026-04-07T08:00:00Z");
    }

    fn off_day_row(date: &str) -> (Option<String>, i64, String) {
        conn()
            .unwrap()
            .query_row(
                "SELECT reason, deleted, updated_at FROM off_days WHERE date = ?1",
                params![date],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    #[test]
    fn off_day_reason_set_add_remove() {
        setup();
        let day = |date: &str, reason: Option<&str>| OffDay {
            date: date.to_string(),
            reason: reason.map(str::to_string),
        };

        // Painting a plain off day: no reason.
        add_off_day_row("2026-08-03").unwrap();
        assert_eq!(get_off_days_rows().unwrap(), vec![day("2026-08-03", None)]);

        // Setting a reason on an existing day bumps updated_at.
        let before = off_day_row("2026-08-03").2;
        set_off_day_reason_row("2026-08-03", Some("vacation")).unwrap();
        let (reason, deleted, after) = off_day_row("2026-08-03");
        assert_eq!((reason.as_deref(), deleted), (Some("vacation"), 0));
        assert!(after > before, "updated_at must move forward");

        // Re-adding a live day keeps its reason.
        add_off_day_row("2026-08-03").unwrap();
        assert_eq!(get_off_days_rows().unwrap(), vec![day("2026-08-03", Some("vacation"))]);

        // A reason on a date that is not off yet makes it an off day.
        set_off_day_reason_row("2026-08-04", Some("sick")).unwrap();
        assert_eq!(
            get_off_days_rows().unwrap(),
            vec![day("2026-08-04", Some("sick")), day("2026-08-03", Some("vacation"))]
        );

        // Clearing the reason keeps the off day.
        set_off_day_reason_row("2026-08-04", None).unwrap();
        assert_eq!(get_off_days_rows().unwrap()[0], day("2026-08-04", None));

        // Remove, then re-add: the tombstone comes back as a plain off day.
        remove_off_day_row("2026-08-03").unwrap();
        assert_eq!(get_off_days_rows().unwrap(), vec![day("2026-08-04", None)]);
        add_off_day_row("2026-08-03").unwrap();
        assert_eq!(off_day_row("2026-08-03").0, None);

        // A reason on a tombstone resurrects it with that reason.
        remove_off_day_row("2026-08-03").unwrap();
        set_off_day_reason_row("2026-08-03", Some("holiday")).unwrap();
        assert_eq!(off_day_row("2026-08-03").0.as_deref(), Some("holiday"));
        assert_eq!(off_day_row("2026-08-03").1, 0);

        // Bad values are rejected and change nothing.
        for bad in ["", "Vacation", "sick-leave", "vacation ", "ä", &"a".repeat(33)] {
            assert_eq!(
                set_off_day_reason_row("2026-08-03", Some(bad)),
                Err("invalid_reason".to_string()),
                "{bad:?}"
            );
        }
        assert_eq!(off_day_row("2026-08-03").0.as_deref(), Some("holiday"));
        assert!(set_off_day_reason_row("2026-08-05", Some(&"a_".repeat(16))).is_ok());
    }

    #[test]
    fn off_day_reason_syncs_last_write_wins() {
        setup();
        set_off_day_reason_row("2026-08-03", Some("vacation")).unwrap();
        let pushed = get_all_off_days_for_sync().unwrap();
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0].reason.as_deref(), Some("vacation"));

        let remote = |reason: Option<&str>, updated_at: &str| SyncOffDay {
            uuid: pushed[0].uuid.clone(),
            date: "2026-08-03".to_string(),
            reason: reason.map(str::to_string),
            updated_at: updated_at.to_string(),
            deleted: false,
            deleted_at: None,
        };
        // Older server write: ignored.
        apply_synced_off_day(&remote(Some("sick"), "2000-01-01T00:00:00.000000+00:00")).unwrap();
        assert_eq!(off_day_row("2026-08-03").0.as_deref(), Some("vacation"));
        // Newer server write: taken, reason included (also clearing it).
        apply_synced_off_day(&remote(Some("sick"), "2999-01-01T00:00:00.000000+00:00")).unwrap();
        assert_eq!(off_day_row("2026-08-03").0.as_deref(), Some("sick"));
        apply_synced_off_day(&remote(None, "2999-01-02T00:00:00.000000+00:00")).unwrap();
        assert_eq!(off_day_row("2026-08-03").0, None);
        // A new date from the server arrives with its reason.
        let mut other = remote(Some("holiday"), "2026-08-01T00:00:00.000000+00:00");
        other.date = "2026-08-10".to_string();
        other.uuid = new_uuid();
        apply_synced_off_day(&other).unwrap();
        assert_eq!(off_day_row("2026-08-10").0.as_deref(), Some("holiday"));
    }

    #[test]
    fn migration_adds_off_day_reason_column() {
        // A database from before the reason column existed.
        let path = std::env::temp_dir().join(format!("tsw-db-test-{}.db", new_uuid()));
        TEST_DB_PATH.with(|p| *p.borrow_mut() = Some(path));
        conn()
            .unwrap()
            .execute_batch(
                "CREATE TABLE off_days (date TEXT PRIMARY KEY, uuid TEXT, updated_at TEXT, \
                 deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
                 INSERT INTO off_days (date, uuid, updated_at, deleted) \
                 VALUES ('2026-08-03', 'u-1', '2026-08-01T00:00:00.000000+00:00', 0);",
            )
            .unwrap();
        // Runs twice: the migration must be idempotent.
        init_db().unwrap();
        init_db().unwrap();
        assert_eq!(
            get_off_days_rows().unwrap(),
            vec![OffDay { date: "2026-08-03".to_string(), reason: None }]
        );
        set_off_day_reason_row("2026-08-03", Some("other")).unwrap();
        assert_eq!(get_off_days_rows().unwrap()[0].reason.as_deref(), Some("other"));
    }

    /// The UI's undo, end to end: snapshot the day, paint (assign or fill),
    /// work out which rows the paint created, restore — the day must be
    /// exactly as before. Randomised over many days and strokes.
    #[test]
    fn undo_restores_paint_exactly() {
        let mut seed: u64 = 0x5eed_1234;
        let mut rnd = |n: u64| { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) % n };
        let day = (chrono::Local::now().naive_local() - chrono::Duration::days(1)).date();
        let at = |q: u64| fmt_local(day.and_hms_opt(6, 0, 0).unwrap() + chrono::Duration::minutes((q * 15) as i64));
        let projects = [None, Some("pa"), Some("pb")];
        let notes = [None, Some("x"), Some("y")];
        for round in 0..400 {
            setup();
            // Up to 6 closed shifts on a 15-minute grid, some touching.
            let mut q = rnd(8);
            for _ in 0..rnd(7) {
                let len = 1 + rnd(8);
                insert(&at(q), Some(&at(q + len)), projects[rnd(3) as usize], notes[rnd(3) as usize], Some("desktop"), None);
                q += len + if rnd(2) == 0 { 0 } else { rnd(6) };
            }
            let state = || {
                let mut v: Vec<(String, String, Option<String>, Option<String>, Option<String>)> = get_all_shifts_rows().unwrap()
                    .into_iter().map(|s| (s.uuid, s.start_time, s.end_time, s.project_uuid, s.note)).collect();
                v.sort();
                v
            };
            let before_rows = get_all_shifts_rows().unwrap();
            let before = state();
            let a = rnd(40);
            let b = a + 1 + rnd(20);
            let project = projects[rnd(3) as usize];
            if rnd(2) == 0 {
                assign_project_to_range_row(&at(a), &at(b), project).unwrap();
            } else {
                let _ = fill_range_row(&at(a), &at(b), project, None);
            }
            let known: std::collections::HashSet<String> = before_rows.iter().map(|s| s.uuid.clone()).collect();
            let created: Vec<String> = get_all_shifts_rows().unwrap().into_iter()
                .filter(|s| !known.contains(&s.uuid)).map(|s| s.uuid).collect();
            let snapshot: Vec<ShiftSnapshot> = before_rows.iter().map(|s| ShiftSnapshot {
                uuid: s.uuid.clone(), start_time: s.start_time.clone(), end_time: s.end_time.clone(),
                project_uuid: s.project_uuid.clone(), note: s.note.clone(), auto_closed_at: s.auto_closed_at.clone(),
            }).collect();
            restore_shifts_row(&snapshot, &created).unwrap();
            assert_eq!(state(), before, "round {round}: undo did not restore the day");
        }
    }

    /// Paint a day into projects, then remove them again (Del on each block):
    /// the pieces merge back into one unassigned shift.
    #[test]
    fn removing_projects_merges_pieces_back() {
        setup();
        let day = (chrono::Local::now().naive_local() - chrono::Duration::days(1)).date();
        let at = |h: u32, m: u32| fmt_local(day.and_hms_opt(h, m, 0).unwrap());
        insert(&at(9, 0), Some(&at(17, 0)), None, None, Some("desktop"), None);
        assign_project_to_range_row(&at(10, 0), &at(12, 0), Some("pa")).unwrap();
        assign_project_to_range_row(&at(13, 0), &at(15, 0), Some("pb")).unwrap();
        assert_eq!(get_all_shifts_rows().unwrap().len(), 5);
        for s in get_all_shifts_rows().unwrap() {
            if s.project_uuid.is_some() {
                assign_project_to_range_row(&s.start_time, s.end_time.as_deref().unwrap(), None).unwrap();
            }
        }
        let all = get_all_shifts_rows().unwrap();
        assert_eq!(all.len(), 1, "pieces did not merge back: {all:?}");
        assert_eq!(all[0].start_time, at(9, 0));
        assert_eq!(all[0].end_time.as_deref(), Some(at(17, 0).as_str()));
    }
}
