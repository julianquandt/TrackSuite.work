use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::PathBuf;

fn db_path() -> PathBuf {
    let data_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("work-time-app");
    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("data.db")
}

fn conn() -> Result<Connection, String> {
    Connection::open(db_path()).map_err(|e| e.to_string())
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
            last_active_at TEXT
        );
        CREATE TABLE IF NOT EXISTS off_days (
            date TEXT PRIMARY KEY,
            uuid TEXT,
            updated_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS projects (
            uuid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

    migrate_sync_columns(&c)?;
    Ok(())
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
    ensure_column("off_days", "uuid", "TEXT")?;
    ensure_column("off_days", "updated_at", "TEXT")?;
    ensure_column("off_days", "deleted", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column("off_days", "deleted_at", "TEXT")?;

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
    pub start_time: String,
    pub end_time: Option<String>,
    pub project_uuid: Option<String>,
    pub started_from: Option<String>,
    pub last_active_at: Option<String>,
}

/// Result of a retro-close: the shift the app couldn't cleanly clock out was
/// closed to its last known active time. Returned so the UI can notify.
#[derive(Debug, Serialize, Clone)]
pub struct StaleClose {
    pub start_time: String,
    pub end_time: String,
}

pub fn get_active_shift_row() -> Result<Option<Shift>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT id, start_time, end_time, project_uuid, started_from, last_active_at FROM shifts WHERE end_time IS NULL AND deleted = 0")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok(Shift {
                id: row.get(0)?,
                start_time: row.get(1)?,
                end_time: row.get(2)?,
                project_uuid: row.get(3)?,
                started_from: row.get(4)?,
                last_active_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(s)) => Ok(Some(s)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

pub fn start_shift_row() -> Result<bool, String> {
    if get_active_shift_row()?.is_some() {
        return Ok(false);
    }
    let project = current_project_uuid()?;
    let c = conn()?;
    let now = chrono_now();
    c.execute(
        "INSERT INTO shifts (uuid, start_time, project_uuid, updated_at, deleted, started_from, last_active_at) \
         VALUES (?1, ?2, ?3, ?4, 0, 'desktop', ?2)",
        params![new_uuid(), now, project, sync_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Liveness heartbeat: stamp the open shift's last_active_at with the current
/// local time. Local-only (not synced); used to retro-close a shift the app
/// couldn't clock out (missed suspend / crash / power loss). Does not bump
/// updated_at, so it creates no sync churn.
pub fn heartbeat_active_shift_row() -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE shifts SET last_active_at = ?1 WHERE end_time IS NULL AND deleted = 0",
        params![chrono_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// If a desktop-origin shift is still open but its heartbeat has gone stale
/// (the app was killed without clocking out), retro-close it to its last known
/// active time and flag it (auto_closed_at) for review. Scoped to
/// started_from = 'desktop' so a shift still running on another device is never
/// truncated. Returns the closed shift when it acted, else None.
pub fn reconcile_stale_desktop_shift_row(stale_minutes: i64) -> Result<Option<StaleClose>, String> {
    let active = match get_active_shift_row()? {
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
    let parsed = match chrono::NaiveDateTime::parse_from_str(&reference, "%Y-%m-%dT%H:%M:%S") {
        Ok(dt) => dt,
        Err(_) => return Ok(None), // unknown format: don't guess
    };
    let now = chrono::Local::now().naive_local();
    if (now - parsed).num_minutes() <= stale_minutes {
        return Ok(None); // still fresh — a live session, leave it open
    }
    let c = conn()?;
    let ts = sync_now();
    c.execute(
        "UPDATE shifts SET end_time = ?1, auto_closed_at = ?2, updated_at = ?2 WHERE id = ?3",
        params![reference, ts, active.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(StaleClose {
        start_time: active.start_time,
        end_time: reference,
    }))
}

pub fn end_shift_row() -> Result<bool, String> {
    let active = match get_active_shift_row()? {
        Some(s) => s,
        None => return Ok(false),
    };
    let c = conn()?;
    let now = chrono_now();
    c.execute(
        "UPDATE shifts SET end_time = ?1, updated_at = ?2 WHERE id = ?3",
        params![now, sync_now(), active.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn get_all_shifts_rows() -> Result<Vec<Shift>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT id, start_time, end_time, project_uuid, started_from, last_active_at FROM shifts WHERE deleted = 0 ORDER BY start_time DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Shift {
                id: row.get(0)?,
                start_time: row.get(1)?,
                end_time: row.get(2)?,
                project_uuid: row.get(3)?,
                started_from: row.get(4)?,
                last_active_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_shift_manual_row(start_time: &str, end_time: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO shifts (uuid, start_time, end_time, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, 0)",
        params![new_uuid(), start_time, end_time, sync_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_shift_row(shift_id: i64) -> Result<(), String> {
    let c = conn()?;
    let now = sync_now();
    c.execute(
        "UPDATE shifts SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, shift_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Off-day commands ────────────────────────────────────────────────

pub fn get_off_days_rows() -> Result<Vec<String>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT date FROM off_days WHERE deleted = 0 ORDER BY date DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn add_off_day_row(date: &str) -> Result<(), String> {
    let c = conn()?;
    // Upsert onto the (possibly tombstoned) row for this date so that
    // add / delete / re-add stays a single row and resurrects cleanly.
    c.execute(
        "INSERT INTO off_days (date, uuid, updated_at, deleted, deleted_at) \
         VALUES (?1, ?2, ?3, 0, NULL) \
         ON CONFLICT(date) DO UPDATE SET deleted = 0, deleted_at = NULL, updated_at = ?3",
        params![date, new_uuid(), sync_now()],
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
}

/// The sticky "current project" that new clock-ins are attributed to.
/// Stored as a config value; empty string means "Unassigned".
pub fn current_project_uuid() -> Result<Option<String>, String> {
    Ok(get_config_row("current_project_uuid")?.filter(|v| !v.trim().is_empty()))
}

pub fn get_projects_rows() -> Result<Vec<Project>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare(
            "SELECT uuid, name, color, archived FROM projects \
             WHERE deleted = 0 ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                uuid: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                archived: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn create_project_row(name: &str, color: Option<&str>) -> Result<Project, String> {
    let c = conn()?;
    let uuid = new_uuid();
    c.execute(
        "INSERT INTO projects (uuid, name, color, archived, updated_at, deleted) \
         VALUES (?1, ?2, ?3, 0, ?4, 0)",
        params![uuid, name, color, sync_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(Project {
        uuid,
        name: name.to_string(),
        color: color.map(|s| s.to_string()),
        archived: false,
    })
}

pub fn update_project_row(
    uuid: &str,
    name: &str,
    color: Option<&str>,
    archived: bool,
) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE projects SET name = ?2, color = ?3, archived = ?4, updated_at = ?5 WHERE uuid = ?1",
        params![uuid, name, color, archived as i64, sync_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_project_row(uuid: &str) -> Result<(), String> {
    let c = conn()?;
    let now = sync_now();
    c.execute(
        "UPDATE projects SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE uuid = ?2",
        params![now, uuid],
    )
    .map_err(|e| e.to_string())?;
    // Detach the project from any shifts so they revert to "Unassigned"
    // instead of pointing at a deleted project.
    c.execute(
        "UPDATE shifts SET project_uuid = NULL, updated_at = ?1 \
         WHERE project_uuid = ?2 AND deleted = 0",
        params![now, uuid],
    )
    .map_err(|e| e.to_string())?;
    if current_project_uuid()?.as_deref() == Some(uuid) {
        set_config_row("current_project_uuid", "")?;
    }
    Ok(())
}

/// Set the sticky current project. If a shift is active and its project
/// differs, auto-split: close the running segment now and open a fresh one on
/// the new project. Returns true when a split occurred.
pub fn set_current_project_row(project_uuid: Option<&str>) -> Result<bool, String> {
    set_config_row("current_project_uuid", project_uuid.unwrap_or(""))?;

    let active = match get_active_shift_row()? {
        Some(s) => s,
        None => return Ok(false),
    };
    if active.project_uuid.as_deref() == project_uuid {
        return Ok(false);
    }

    let c = conn()?;
    let now_local = chrono_now();
    let ts = sync_now();

    // If no time has elapsed yet, just retag the open shift (avoids a
    // zero-duration segment when you correct the project right after clock-in).
    if active.start_time == now_local {
        c.execute(
            "UPDATE shifts SET project_uuid = ?1, updated_at = ?2 WHERE id = ?3",
            params![project_uuid, ts, active.id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(false);
    }

    c.execute(
        "UPDATE shifts SET end_time = ?1, updated_at = ?2 WHERE id = ?3",
        params![now_local, ts, active.id],
    )
    .map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO shifts (uuid, start_time, project_uuid, updated_at, deleted) \
         VALUES (?1, ?2, ?3, ?4, 0)",
        params![new_uuid(), now_local, project_uuid, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Retroactively assign a project to an entire existing shift.
pub fn set_shift_project_row(shift_id: i64, project_uuid: Option<&str>) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "UPDATE shifts SET project_uuid = ?1, updated_at = ?2 WHERE id = ?3",
        params![project_uuid, sync_now(), shift_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Assign a project to a time window, splitting any closed shifts that straddle
/// the window so only the covered portion is retagged. This is the primitive
/// behind the draggable timeline. Boundaries are local "%Y-%m-%dT%H:%M:%S"
/// strings (fixed width, so lexicographic comparison equals chronological).
/// Returns the number of shifts touched.
pub fn assign_project_to_range_row(
    range_start: &str,
    range_end: &str,
    project_uuid: Option<&str>,
) -> Result<u32, String> {
    if range_start >= range_end {
        return Ok(0);
    }
    let c = conn()?;
    let overlapping: Vec<(i64, String, String, Option<String>)> = {
        let mut stmt = c
            .prepare(
                "SELECT id, start_time, end_time, project_uuid FROM shifts \
                 WHERE deleted = 0 AND end_time IS NOT NULL \
                 AND start_time < ?2 AND end_time > ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![range_start, range_end], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    let ts = sync_now();
    let target = project_uuid.map(|s| s.to_string());
    let mut affected = 0u32;

    for (id, s, e, orig_project) in overlapping {
        let overlap_start = if s.as_str() > range_start { s.clone() } else { range_start.to_string() };
        let overlap_end = if e.as_str() < range_end { e.clone() } else { range_end.to_string() };
        if overlap_start >= overlap_end {
            continue;
        }

        // Up to three segments: [s, overlap_start) keep, [overlap_start,
        // overlap_end) = target, [overlap_end, e) keep.
        let mut segments: Vec<(String, String, Option<String>)> = Vec::new();
        if s < overlap_start {
            segments.push((s.clone(), overlap_start.clone(), orig_project.clone()));
        }
        segments.push((overlap_start.clone(), overlap_end.clone(), target.clone()));
        if overlap_end < e {
            segments.push((overlap_end.clone(), e.clone(), orig_project.clone()));
        }

        let (fs, fe, fp) = &segments[0];
        c.execute(
            "UPDATE shifts SET start_time = ?2, end_time = ?3, project_uuid = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, fs, fe, fp, ts],
        )
        .map_err(|e| e.to_string())?;
        for (ss, se, sp) in &segments[1..] {
            c.execute(
                "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, updated_at, deleted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![new_uuid(), ss, se, sp, ts],
            )
            .map_err(|e| e.to_string())?;
        }
        affected += 1;
    }

    coalesce_adjacent_shifts_row()?;
    Ok(affected)
}

/// Merge back-to-back shifts that share the same project into one, so that
/// assigning then removing a range doesn't leave the day fragmented into
/// several adjacent identical segments. Only exactly-contiguous, same-project,
/// closed shifts are merged (a gap or project change keeps them separate).
pub fn coalesce_adjacent_shifts_row() -> Result<(), String> {
    let c = conn()?;
    let shifts: Vec<(i64, String, String, Option<String>)> = {
        let mut stmt = c
            .prepare(
                "SELECT id, start_time, end_time, project_uuid FROM shifts \
                 WHERE deleted = 0 AND end_time IS NOT NULL ORDER BY start_time",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    let ts = sync_now();
    let mut i = 0;
    while i < shifts.len() {
        let (keep_id, _, ref keep_end, ref keep_proj) = shifts[i];
        let mut merged_end = keep_end.clone();
        let mut to_delete: Vec<i64> = Vec::new();

        let mut j = i + 1;
        while j < shifts.len() {
            let (cid, ref cstart, ref cend, ref cproj) = shifts[j];
            if *cstart == merged_end && cproj == keep_proj {
                merged_end = cend.clone();
                to_delete.push(cid);
                j += 1;
            } else {
                break;
            }
        }

        if !to_delete.is_empty() {
            c.execute(
                "UPDATE shifts SET end_time = ?1, updated_at = ?2 WHERE id = ?3",
                params![merged_end, ts, keep_id],
            )
            .map_err(|e| e.to_string())?;
            for id in to_delete {
                c.execute(
                    "UPDATE shifts SET deleted = 1, deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![ts, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        i = j;
    }
    Ok(())
}

// ── Config commands ─────────────────────────────────────────────────

pub fn get_config_row(key: &str) -> Result<Option<String>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT value FROM config WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![key], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

pub fn set_config_row(key: &str, value: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

fn chrono_now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
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
             auto_closed_at, started_from FROM shifts WHERE uuid IS NOT NULL",
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
            "SELECT uuid, date, updated_at, deleted, deleted_at \
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
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Apply a server shift to the local DB with last-write-wins semantics.
/// Keyed by uuid; only overwrites when the incoming record is strictly newer,
/// which protects a concurrent local edit made during the sync round-trip.
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

    match local_updated {
        None => {
            c.execute(
                "INSERT INTO shifts (uuid, start_time, end_time, project_uuid, updated_at, deleted, deleted_at, \
                 auto_closed_at, started_from) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    shift.uuid,
                    shift.start_time,
                    shift.end_time,
                    shift.project_uuid,
                    shift.updated_at,
                    shift.deleted as i64,
                    shift.deleted_at,
                    shift.auto_closed_at,
                    shift.started_from
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if shift.updated_at > local => {
            c.execute(
                "UPDATE shifts SET start_time = ?2, end_time = ?3, project_uuid = ?4, updated_at = ?5, \
                 deleted = ?6, deleted_at = ?7, auto_closed_at = ?8, started_from = COALESCE(started_from, ?9) \
                 WHERE uuid = ?1",
                params![
                    shift.uuid,
                    shift.start_time,
                    shift.end_time,
                    shift.project_uuid,
                    shift.updated_at,
                    shift.deleted as i64,
                    shift.deleted_at,
                    shift.auto_closed_at,
                    shift.started_from
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
                "INSERT INTO off_days (date, uuid, updated_at, deleted, deleted_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    off_day.date,
                    off_day.uuid,
                    off_day.updated_at,
                    off_day.deleted as i64,
                    off_day.deleted_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if off_day.updated_at > local => {
            c.execute(
                "UPDATE off_days SET updated_at = ?2, deleted = ?3, deleted_at = ?4 WHERE date = ?1",
                params![
                    off_day.date,
                    off_day.updated_at,
                    off_day.deleted as i64,
                    off_day.deleted_at
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
            "SELECT uuid, name, color, archived, updated_at, deleted, deleted_at \
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
                "INSERT INTO projects (uuid, name, color, archived, updated_at, deleted, deleted_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    project.uuid,
                    project.name,
                    project.color,
                    project.archived as i64,
                    project.updated_at,
                    project.deleted as i64,
                    project.deleted_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(local) if project.updated_at > local => {
            c.execute(
                "UPDATE projects SET name = ?2, color = ?3, archived = ?4, updated_at = ?5, \
                 deleted = ?6, deleted_at = ?7 WHERE uuid = ?1",
                params![
                    project.uuid,
                    project.name,
                    project.color,
                    project.archived as i64,
                    project.updated_at,
                    project.deleted as i64,
                    project.deleted_at
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

pub fn import_csv(content: &str) -> Result<ImportResult, String> {
    let c = conn()?;

    let mut section = ""; // "", "shifts", or "offdays"
    let mut shifts_imported: usize = 0;
    let mut shifts_skipped: usize = 0;
    let mut offdays_imported: usize = 0;
    let mut offdays_skipped: usize = 0;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        // Section headers
        if line == "[Shifts]" {
            section = "shifts";
            continue;
        }
        if line == "[Off Days]" {
            section = "offdays";
            continue;
        }

        // Legacy format without section headers: first line is shift header
        if section.is_empty() && line.starts_with("ID,") {
            section = "shifts";
            continue;
        }

        // Skip header rows
        if section == "shifts" && line.starts_with("ID,") {
            continue;
        }
        if section == "offdays" && line == "Date" {
            continue;
        }

        match section {
            "shifts" => {
                let cols: Vec<&str> = line.splitn(4, ',').collect();
                if cols.len() < 3 {
                    continue;
                }
                let start_time = cols[1].trim();
                let end_time_raw = cols[2].trim();
                let end_time = if end_time_raw.is_empty() { None } else { Some(end_time_raw) };

                // Normalise timestamps: strip microseconds (.123456)
                let start_norm = normalise_timestamp(start_time);
                let end_norm = end_time.map(normalise_timestamp);

                // Duplicate check by start_time
                let exists: bool = c
                    .prepare("SELECT 1 FROM shifts WHERE start_time = ?1")
                    .and_then(|mut s| {
                        s.exists(rusqlite::params![&start_norm])
                    })
                    .map_err(|e| e.to_string())?;

                if exists {
                    shifts_skipped += 1;
                } else {
                    c.execute(
                        "INSERT INTO shifts (uuid, start_time, end_time, updated_at, deleted) \
                         VALUES (?1, ?2, ?3, ?4, 0)",
                        rusqlite::params![new_uuid(), &start_norm, &end_norm, sync_now()],
                    )
                    .map_err(|e| e.to_string())?;
                    shifts_imported += 1;
                }
            }
            "offdays" => {
                let date = line.trim_matches('"');
                // INSERT OR IGNORE handles duplicates
                let changed = c
                    .execute(
                        "INSERT OR IGNORE INTO off_days (date, uuid, updated_at, deleted) \
                         VALUES (?1, ?2, ?3, 0)",
                        rusqlite::params![date, new_uuid(), sync_now()],
                    )
                    .map_err(|e| e.to_string())?;
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

    Ok(ImportResult {
        shifts_imported,
        shifts_skipped,
        offdays_imported,
        offdays_skipped,
    })
}

/// Strip microsecond precision from ISO timestamps for consistency.
/// "2025-01-01T08:00:00.123456" → "2025-01-01T08:00:00"
fn normalise_timestamp(ts: &str) -> String {
    match ts.find('.') {
        Some(pos) => ts[..pos].to_string(),
        None => ts.to_string(),
    }
}
