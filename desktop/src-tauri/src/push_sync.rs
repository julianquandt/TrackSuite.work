use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::db;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncStatus {
    NotConfigured,
    Synced,
}

/// Tombstones older than this are garbage-collected locally after a successful
/// sync. Kept wide so a peer that was offline for a while won't resurrect a
/// deleted record on its next sync.
const TOMBSTONE_TTL_DAYS: i64 = 90;

#[derive(Debug, Deserialize)]
struct RemoteSyncShift {
    uuid: String,
    start_time: String,
    end_time: Option<String>,
    #[serde(default)]
    project_uuid: Option<String>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteSyncOffDay {
    uuid: String,
    date: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteSyncProject {
    uuid: String,
    name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteSyncState {
    #[serde(default)]
    shifts: Vec<RemoteSyncShift>,
    #[serde(default)]
    off_days: Vec<RemoteSyncOffDay>,
    #[serde(default)]
    projects: Vec<RemoteSyncProject>,
}

fn normalize_server_url(server_url: &str) -> String {
    server_url.trim().trim_end_matches('/').to_string()
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("TrackSuite.work Desktop")
        .build()
        .map_err(|e| e.to_string())
}

async fn send_request(
    method: Method,
    client: &Client,
    server_url: &str,
    path: &str,
    api_key: &str,
    body: Option<Value>,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{}", server_url, path);

    let mut request = client.request(method, &url);
    if !api_key.trim().is_empty() {
        request = request.header("X-API-KEY", api_key);
    }
    request = request.header("X-App-Version", env!("CARGO_PKG_VERSION"));
    if let Some(body) = body {
        request = request.json(&body);
    }

    request.send().await.map_err(|e| e.to_string())
}

async fn error_message(response: reqwest::Response) -> Result<String, String> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body_bytes = response.bytes().await.map_err(|e| e.to_string())?;

    if content_type.contains("application/json") {
        if let Ok(value) = serde_json::from_slice::<Value>(&body_bytes) {
            if let Some(detail) = value.get("detail").and_then(|value| value.as_str()) {
                return Ok(detail.to_string());
            }
        }
    }

    let text = String::from_utf8_lossy(&body_bytes).trim().to_string();
    Ok(if text.is_empty() {
        format!("Request failed with status {}", status)
    } else {
        text
    })
}

/// Full-state, bidirectional, last-write-wins sync.
///
/// The client POSTs its entire local state (including tombstones); the server
/// merges by last-write-wins and returns its authoritative merged state, which
/// the client then mirrors locally (also last-write-wins, to protect a change
/// made during the round-trip). Convergent regardless of ordering.
pub async fn perform_push_sync() -> Result<SyncStatus, String> {
    let server_url = db::get_config_row("server_url")?.unwrap_or_default();
    let api_key = db::get_config_row("api_key")?.unwrap_or_default();

    if server_url.trim().is_empty() || api_key.trim().is_empty() {
        return Ok(SyncStatus::NotConfigured);
    }

    let server_url = normalize_server_url(&server_url);
    let client = build_client()?;

    // 1. Gather the full local state (including tombstones).
    let local_shifts = db::get_all_shifts_for_sync()?;
    let local_off_days = db::get_all_off_days_for_sync()?;
    let local_projects = db::get_all_projects_for_sync()?;

    let shifts_payload: Vec<Value> = local_shifts
        .iter()
        .map(|s| {
            json!({
                "uuid": s.uuid,
                "start_time": s.start_time,
                "end_time": s.end_time,
                "project_uuid": s.project_uuid,
                "updated_at": s.updated_at,
                "deleted": s.deleted,
                "deleted_at": s.deleted_at,
            })
        })
        .collect();
    let off_days_payload: Vec<Value> = local_off_days
        .iter()
        .map(|o| {
            json!({
                "uuid": o.uuid,
                "date": o.date,
                "updated_at": o.updated_at,
                "deleted": o.deleted,
                "deleted_at": o.deleted_at,
            })
        })
        .collect();
    let projects_payload: Vec<Value> = local_projects
        .iter()
        .map(|p| {
            json!({
                "uuid": p.uuid,
                "name": p.name,
                "color": p.color,
                "archived": p.archived,
                "updated_at": p.updated_at,
                "deleted": p.deleted,
                "deleted_at": p.deleted_at,
            })
        })
        .collect();

    // 2. Push to /sync/ and receive the merged authoritative state.
    let response = send_request(
        Method::POST,
        &client,
        &server_url,
        "/sync/",
        &api_key,
        Some(json!({
            "shifts": shifts_payload,
            "off_days": off_days_payload,
            "projects": projects_payload,
        })),
    )
    .await?;

    if !response.status().is_success() {
        return Err(error_message(response).await?);
    }

    let state: RemoteSyncState = response.json().await.map_err(|e| e.to_string())?;

    // 3. Mirror the merged state locally (last-write-wins per record).
    //    Apply projects first so a shift's project reference is present.
    for project in &state.projects {
        db::apply_synced_project(&db::SyncProject {
            uuid: project.uuid.clone(),
            name: project.name.clone(),
            color: project.color.clone(),
            archived: project.archived,
            updated_at: project.updated_at.clone(),
            deleted: project.deleted,
            deleted_at: project.deleted_at.clone(),
        })?;
    }
    for shift in &state.shifts {
        db::apply_synced_shift(&db::SyncShift {
            uuid: shift.uuid.clone(),
            start_time: shift.start_time.clone(),
            end_time: shift.end_time.clone(),
            project_uuid: shift.project_uuid.clone(),
            updated_at: shift.updated_at.clone(),
            deleted: shift.deleted,
            deleted_at: shift.deleted_at.clone(),
        })?;
    }
    for off_day in &state.off_days {
        db::apply_synced_off_day(&db::SyncOffDay {
            uuid: off_day.uuid.clone(),
            date: off_day.date.clone(),
            updated_at: off_day.updated_at.clone(),
            deleted: off_day.deleted,
            deleted_at: off_day.deleted_at.clone(),
        })?;
    }

    // 4. Record the sync and garbage-collect old tombstones.
    db::set_config_row("last_synced_at", &db::sync_now())?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(TOMBSTONE_TTL_DAYS))
        .format("%Y-%m-%dT%H:%M:%S%.6f+00:00")
        .to_string();
    db::gc_tombstones(&cutoff)?;

    Ok(SyncStatus::Synced)
}
