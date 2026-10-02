#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

mod autostart;
mod db;
mod notification;
mod push_sync;
mod sync_api;
mod suspend;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, Theme, WebviewWindow, WindowEvent,
};

static ICON_IDLE_LIGHT: &[u8] = include_bytes!("../icons/icon-idle.png");
static ICON_IDLE_DARK: &[u8] = include_bytes!("../icons/icon-idle-dark.png");
static ICON_TRACKING_LIGHT: &[u8] = include_bytes!("../icons/icon-tracking.png");
static ICON_TRACKING_DARK: &[u8] = include_bytes!("../icons/icon-tracking-dark.png");
const AUTO_RESUME_PENDING_KEY: &str = "auto_resume_pending";
const TRAY_TOOLTIP: &str = "TrackSuite.work";
/// Label of the main window. tauri.conf.json and capabilities/default.json
/// use the same label, so a re-created window keeps its permissions.
const MAIN_WINDOW: &str = "main";
/// CLI flag: clock in/out like the tray item (for a global hotkey).
const TOGGLE_ARG: &str = "--toggle";
/// A shift whose heartbeat is older than this many minutes counts as dead.
const STALE_MINUTES: i64 = 11;
/// Background loop period: heartbeat, stale check and sync.
const BACKGROUND_TICK_SECS: u64 = 300;

/// The last shift the background loop auto-closed, kept until the UI takes it.
/// The loop can fire before the webview listens (first tick runs at startup),
/// so the event alone could be lost.
struct PendingAutoClose(Mutex<Option<db::StaleClose>>);

/// True while a hidden main window is being destroyed so that a fresh one can
/// be built. Tauri frees the "main" label only when the old window is really
/// gone (RunEvent Destroyed), so the new window is built from there.
struct RecreateMainWindow(AtomicBool);

struct TrayState {
    clock_item: tauri::menu::MenuItem<tauri::Wry>,
    tracking: bool,
}

fn app_icon_bytes(theme: Theme) -> &'static [u8] {
    match theme {
        Theme::Dark => ICON_IDLE_DARK,
        _ => ICON_IDLE_LIGHT,
    }
}

fn tray_icon_bytes(theme: Theme, tracking: bool) -> &'static [u8] {
    match (matches!(theme, Theme::Dark), tracking) {
        (true, true) => ICON_TRACKING_DARK,
        (true, false) => ICON_IDLE_DARK,
        (false, true) => ICON_TRACKING_LIGHT,
        (false, false) => ICON_IDLE_LIGHT,
    }
}

fn current_system_theme(app: &AppHandle) -> Theme {
    app.get_webview_window(MAIN_WINDOW)
        .and_then(|window| window.theme().ok())
        .unwrap_or(Theme::Light)
}

fn set_window_icon_for_theme(app: &AppHandle, theme: Theme) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let icon = Image::from_bytes(app_icon_bytes(theme)).map_err(|e: tauri::Error| e.to_string())?;
        window.set_icon(icon).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn set_tray_icon_for_theme(app: &AppHandle, theme: Theme, tracking: bool) -> Result<(), String> {
    let icon = Image::from_bytes(tray_icon_bytes(theme, tracking)).map_err(|e: tauri::Error| e.to_string())?;
    if let Some(tray_icon) = app.tray_by_id("main") {
        tray_icon.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn apply_system_theme_icons(app: &AppHandle, theme: Theme) -> Result<(), String> {
    let tracking = {
        let state = app.state::<Mutex<TrayState>>();
        let tray = state.lock().map_err(|e| e.to_string())?;
        tray.tracking
    };

    set_window_icon_for_theme(app, theme)?;
    set_tray_icon_for_theme(app, theme, tracking)
}

/// Build the main window from its tauri.conf.json entry ("create": false, so
/// Tauri does not build it on its own) and attach its event handlers:
/// closing hides the window to the tray (the webview keeps running there —
/// the focus timer and its notifications live in JS), and a system theme
/// change swaps the window and tray icons.
fn build_main_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .visible(visible)
        .build()?;

    let theme = window.theme().unwrap_or(Theme::Light);
    if let Ok(icon) = Image::from_bytes(app_icon_bytes(theme)) {
        let _ = window.set_icon(icon);
    }

    let win = window.clone();
    let icon_app = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = win.hide();
        }
        WindowEvent::ThemeChanged(theme) => {
            let _ = apply_system_theme_icons(&icon_app, *theme);
        }
        _ => {}
    });
    Ok(window)
}

/// Build a visible main window off the event-loop thread. On Windows,
/// building a webview from an event handler deadlocks (WebView2), and the
/// tray, single-instance and run-loop handlers all call this.
fn spawn_build_main_window(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || match build_main_window(&app, true) {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("could not open the main window: {error}"),
    });
}

/// Bring the main window to the front ("Open" in the tray, tray click, a
/// second launch, the macOS Dock icon).
///
/// Linux: GTK (seen on Wayland) leaves the title-bar buttons (minimise,
/// maximise, close) dead on a window that was hidden with hide() and shown
/// again with show(), until the user double-clicks the title bar. So a hidden
/// main window is never shown again on Linux: it is destroyed and a fresh,
/// visible one is built (see RecreateMainWindow and the Destroyed handler in
/// main()). The new webview reloads; the UI restores its state from the
/// database and localStorage. A visible window (maybe minimised) is only
/// un-minimised and focused.
fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        spawn_build_main_window(app);
        return;
    };

    #[cfg(target_os = "linux")]
    {
        if window.is_visible().unwrap_or(false) {
            let _ = window.unminimize();
            let _ = window.set_focus();
            return;
        }
        let recreate = app.state::<RecreateMainWindow>();
        recreate.0.store(true, Ordering::SeqCst);
        if window.destroy().is_err() {
            // Could not destroy: fall back to show(), buttons may be dead.
            recreate.0.store(false, Ordering::SeqCst);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn set_tray_tracking_state(app: &AppHandle, tracking: bool) -> Result<(), String> {
    let label = if tracking { "Clock Out" } else { "Clock In" };
    {
        let state = app.state::<Mutex<TrayState>>();
        let mut tray = state.lock().map_err(|e| e.to_string())?;
        tray.tracking = tracking;
        tray.clock_item.set_text(label).map_err(|e| e.to_string())?;
    }

    set_tray_icon_for_theme(app, current_system_theme(app), tracking)
}

fn notify_async(app: &AppHandle, title: &str, body: Option<String>) {
    let title = title.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = notification::show(app, title, body).await {
            eprintln!("notification failed: {error}");
        }
    });
}

/// Run a full sync in the background without notifications. Emits
/// "tray-data-changed" when it synced; failures stay silent.
fn spawn_silent_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(push_sync::SyncStatus::Synced) = push_sync::perform_push_sync().await {
            let _ = app.emit("tray-data-changed", ());
        }
    });
}

/// Clock in when idle, clock out when tracking — the tray "Clock In/Out"
/// item, a second launch with --toggle, and a first launch with --toggle all
/// use this. Notifies, emits "tray-data-changed", then syncs in the
/// background.
fn toggle_tracking(app: &AppHandle) {
    let active_shift = db::get_active_shift_row().ok().flatten();
    let was_tracking = active_shift.is_some();
    let result = if was_tracking { end_shift() } else { start_shift() };

    if let Ok(true) = result {
        let _ = set_tray_tracking_state(app, !was_tracking);
        if was_tracking {
            let body = active_shift
                .as_ref()
                .and_then(|shift| format_tracked_duration(&shift.start_time))
                .map(|duration| format!("Tracked {}", duration))
                .or_else(|| Some("Time tracking ended".to_string()));
            notify_async(app, "Clocked Out", body);
        } else {
            notify_async(app, "Clocked In", Some("Time tracking started".to_string()));
        }
        let _ = app.emit("tray-data-changed", ());
        spawn_silent_sync(app);
    }
}

/// One background tick: stale check first (a heartbeat would hide a dead
/// session), then the heartbeat, then a silent sync.
async fn background_tick(app: &AppHandle) {
    match db::reconcile_stale_desktop_shift_row(STALE_MINUTES) {
        Ok(Some(closed)) => {
            let _ = set_tray_tracking_state(app, false);
            if let Ok(mut pending) = app.state::<PendingAutoClose>().0.lock() {
                *pending = Some(closed.clone());
            }
            let _ = app.emit("shift-auto-closed", closed);
            let _ = app.emit("tray-data-changed", ());
        }
        Ok(None) => {}
        Err(error) => eprintln!("stale check failed: {error}"),
    }
    if let Err(error) = db::heartbeat_active_shift_row() {
        eprintln!("heartbeat failed: {error}");
    }
    if let Ok(push_sync::SyncStatus::Synced) = push_sync::perform_push_sync().await {
        let _ = app.emit("tray-data-changed", ());
    }
}

fn format_tracked_duration(start_time: &str) -> Option<String> {
    let start = chrono::NaiveDateTime::parse_from_str(start_time, "%Y-%m-%dT%H:%M:%S").ok()?;
    let duration = chrono::Local::now().naive_local() - start;
    let total_minutes = duration.num_minutes().max(0);
    let hours = total_minutes / 60;
    let minutes = total_minutes % 60;

    Some(if minutes > 0 {
        format!("{}h {}m", hours, minutes)
    } else {
        format!("{}h", hours)
    })
}

fn clear_auto_resume_pending() -> Result<(), String> {
    db::set_config_row(AUTO_RESUME_PENDING_KEY, "")
}

// ── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
fn get_active_shift() -> Result<Option<db::Shift>, String> {
    db::get_active_shift_row()
}

#[tauri::command]
fn get_all_shifts() -> Result<Vec<db::Shift>, String> {
    db::get_all_shifts_rows()
}

#[tauri::command]
fn heartbeat_active_shift() -> Result<(), String> {
    db::heartbeat_active_shift_row()
}

/// Take (and clear) the shift the background loop auto-closed, if the UI has
/// not handled it yet. Call on startup and when "shift-auto-closed" fires;
/// act only on Some, so the close is handled exactly once.
#[tauri::command]
fn take_auto_closed_shift(app: AppHandle) -> Result<Option<db::StaleClose>, String> {
    let state = app.state::<PendingAutoClose>();
    let mut pending = state.0.lock().map_err(|e| e.to_string())?;
    Ok(pending.take())
}

#[tauri::command]
fn reconcile_stale_desktop_shift(stale_minutes: i64) -> Result<Option<db::StaleClose>, String> {
    db::reconcile_stale_desktop_shift_row(stale_minutes)
}

/// Whether the in-app updater can actually replace this install. Tauri can
/// self-update an AppImage (Linux), .app/.dmg (macOS) and the Windows
/// installers, but NOT a .deb/.rpm/Flatpak, which the system package manager
/// owns — attempting it just hangs on an unwritable /usr.
#[tauri::command]
fn is_self_updatable() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("APPIMAGE").is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Whether this install is managed by our apt repository — i.e. the user added
/// the source list from the download page. The .list file is world-readable and
/// we run unconfined as the user, so this is a plain read (no sudo). When true,
/// updates come via `apt upgrade`, so the UI points there instead of fetching a
/// .deb. A false positive is harmless: if the repo is configured, apt upgrades it.
#[tauri::command]
fn is_apt_managed() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/etc/apt/sources.list.d/tracksuite-work.list").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Open a URL or local file path in the system default handler (browser for
/// URLs, package installer for a downloaded .deb/.rpm).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Download the matching package (.deb/.rpm) for a package-managed Linux
/// install and return its local path for a manual install.
#[tauri::command]
async fn download_update_package() -> Result<String, String> {
    push_sync::download_latest_package().await
}

/// Save a generated report file (e.g. CSV) to the user's Downloads directory
/// and return its full path. The webview can't write files directly, so report
/// exports round-trip through here (mirrors how update packages are saved).
#[tauri::command]
fn save_download_file(name: String, contents: String) -> Result<String, String> {
    // Keep the basename only, so a crafted name can't escape the target dir.
    let base = std::path::Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "report.csv".to_string());
    let dir = dirs::download_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(base);
    std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn start_shift() -> Result<bool, String> {
    let started = db::start_shift_row()?;
    if started {
        clear_auto_resume_pending()?;
    }
    Ok(started)
}

#[tauri::command]
fn end_shift() -> Result<bool, String> {
    let ended = db::end_shift_row()?;
    if ended {
        clear_auto_resume_pending()?;
    }
    Ok(ended)
}

/// Clock-out on system suspend: ends the open shift only when THIS machine
/// is tracking it. Does not touch auto_resume_pending (the suspend flow sets
/// it).
#[tauri::command]
fn end_local_shift() -> Result<bool, String> {
    db::end_local_shift_row()
}

#[tauri::command]
fn update_shift_times(changes: Vec<db::ShiftTimeChange>) -> Result<(), String> {
    db::update_shift_times_row(&changes)
}

#[tauri::command]
fn fill_range(
    range_start: String,
    range_end: String,
    project_uuid: Option<String>,
    note: Option<String>,
) -> Result<Vec<String>, String> {
    db::fill_range_row(&range_start, &range_end, project_uuid.as_deref(), note.as_deref())
}

#[tauri::command]
fn restore_shifts(snapshot: Vec<db::ShiftSnapshot>, remove_uuids: Vec<String>) -> Result<(), String> {
    db::restore_shifts_row(&snapshot, &remove_uuids)
}

#[tauri::command]
fn restore_project(uuid: String) -> Result<(), String> {
    db::restore_project_row(&uuid)
}

#[tauri::command]
fn clear_auto_closed(shift_id: i64) -> Result<(), String> {
    db::clear_auto_closed_row(shift_id)
}

#[tauri::command]
fn add_manual_shift(start_time: String, end_time: String, note: Option<String>) -> Result<(), String> {
    db::add_shift_manual_row(&start_time, &end_time, note.as_deref())
}

#[tauri::command]
fn set_shift_note(shift_id: i64, note: Option<String>) -> Result<(), String> {
    db::set_shift_note_row(shift_id, note.as_deref())
}

#[tauri::command]
fn delete_shift(shift_id: i64) -> Result<(), String> {
    db::delete_shift_row(shift_id)
}

/// Live off days, newest first: `[{ date: "YYYY-MM-DD", reason: string | null }]`.
#[tauri::command]
fn get_off_days() -> Result<Vec<db::OffDay>, String> {
    db::get_off_days_rows()
}

/// Set why `date` is off (null = plain off day); marks the date as an off day
/// if it is not one. Errors: "invalid_reason".
#[tauri::command]
fn set_off_day_reason(date: String, reason: Option<String>) -> Result<(), String> {
    db::set_off_day_reason_row(&date, reason.as_deref())
}

#[tauri::command]
fn add_off_day(date: String) -> Result<(), String> {
    db::add_off_day_row(&date)
}

#[tauri::command]
fn remove_off_day(date: String) -> Result<(), String> {
    db::remove_off_day_row(&date)
}

// ── Project commands ────────────────────────────────────────────────

#[tauri::command]
fn get_projects() -> Result<Vec<db::Project>, String> {
    db::get_projects_rows()
}

#[tauri::command]
fn create_project(name: String, color: Option<String>) -> Result<db::Project, String> {
    db::create_project_row(&name, color.as_deref())
}

#[tauri::command]
fn update_project(
    uuid: String,
    name: String,
    color: Option<String>,
    archived: bool,
    rate: Option<String>,
    currency: Option<String>,
) -> Result<(), String> {
    db::update_project_row(
        &uuid,
        &name,
        color.as_deref(),
        archived,
        rate.as_deref(),
        currency.as_deref(),
    )
}

#[tauri::command]
fn delete_project(uuid: String) -> Result<(), String> {
    db::delete_project_row(&uuid)
}

#[tauri::command]
fn get_current_project() -> Result<Option<String>, String> {
    db::current_project_uuid()
}

#[tauri::command]
fn set_current_project(project_uuid: Option<String>) -> Result<bool, String> {
    db::set_current_project_row(project_uuid.as_deref())
}

#[tauri::command]
fn set_shift_project(shift_id: i64, project_uuid: Option<String>) -> Result<(), String> {
    db::set_shift_project_row(shift_id, project_uuid.as_deref())
}

#[tauri::command]
fn assign_project_to_range(
    range_start: String,
    range_end: String,
    project_uuid: Option<String>,
) -> Result<u32, String> {
    db::assign_project_to_range_row(&range_start, &range_end, project_uuid.as_deref())
}

#[tauri::command]
fn get_config(key: String) -> Result<Option<String>, String> {
    db::get_config_row(&key)
}

#[tauri::command]
fn set_config(key: String, value: String) -> Result<(), String> {
    db::set_config_row(&key, &value)
}

#[tauri::command]
fn import_csv(content: String) -> Result<db::ImportResult, String> {
    db::import_csv(&content)
}

#[tauri::command]
fn autostart_is_enabled(app: AppHandle) -> Result<bool, String> {
    autostart::is_enabled(&app)
}

#[tauri::command]
fn autostart_enable(app: AppHandle) -> Result<(), String> {
    autostart::enable(&app)
}

#[tauri::command]
fn autostart_disable(app: AppHandle) -> Result<(), String> {
    autostart::disable(&app)
}

#[tauri::command]
async fn show_native_notification(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    notification::show(app, title, body).await
}

/// Full bidirectional last-write-wins sync, callable from the UI. Returns a
/// short status string ("synced" / "not_configured") or an error message.
#[tauri::command]
async fn sync_now() -> Result<String, String> {
    match push_sync::perform_push_sync().await {
        Ok(push_sync::SyncStatus::NotConfigured) => Ok("not_configured".to_string()),
        Ok(push_sync::SyncStatus::Synced) => Ok("synced".to_string()),
        Err(message) => Err(message),
    }
}

// ── Tray commands ───────────────────────────────────────────────────

#[tauri::command]
fn update_tray_label(app: AppHandle, label: String) -> Result<(), String> {
    let state = app.state::<Mutex<TrayState>>();
    let tray = state.lock().map_err(|e| e.to_string())?;
    tray.clock_item
        .set_text(&label)
        .map_err(|e| e.to_string())
}

/// Tray tooltip: "TrackSuite.work — <text>", or just "TrackSuite.work" for an
/// empty text. (Linux tray hosts mostly ignore tooltips.)
#[tauri::command]
fn set_tray_tooltip(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim();
    let tooltip = if text.is_empty() {
        TRAY_TOOLTIP.to_string()
    } else {
        format!("{} — {}", TRAY_TOOLTIP, text)
    };
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_tray_icon(app: AppHandle, tracking: bool) -> Result<(), String> {
    {
        let state = app.state::<Mutex<TrayState>>();
        let mut tray = state.lock().map_err(|e| e.to_string())?;
        tray.tracking = tracking;
    }

    set_tray_icon_for_theme(&app, current_system_theme(&app), tracking)
}

// ── Entry point ─────────────────────────────────────────────────────

fn main() {
    db::init_db().expect("failed to initialise local database");

    let launch_args: Vec<String> = std::env::args().collect();
    let toggle_on_launch = launch_args.iter().any(|a| a == TOGGLE_ARG);
    let start_hidden = toggle_on_launch || launch_args.iter().any(|a| a == autostart::HIDDEN_ARG);

    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch hands its arguments to
        // this process and exits before anything else starts (no second
        // tray, heartbeat or sync loop).
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                // A D-Bus name under the Flatpak app id, so the sandbox lets
                // us own it (Linux only; ignored elsewhere).
                .dbus_id("com.tracksuite.work.desktop")
                .callback(|app, args, _cwd| {
                    if args.iter().any(|a| a == TOGGLE_ARG) {
                        toggle_tracking(app);
                    } else if !args.iter().any(|a| a == autostart::HIDDEN_ARG) {
                        show_main_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RecreateMainWindow(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            get_active_shift,
            get_all_shifts,
            heartbeat_active_shift,
            take_auto_closed_shift,
            reconcile_stale_desktop_shift,
            is_self_updatable,
            is_apt_managed,
            open_url,
            download_update_package,
            save_download_file,
            start_shift,
            end_shift,
            end_local_shift,
            update_shift_times,
            fill_range,
            restore_shifts,
            restore_project,
            clear_auto_closed,
            add_manual_shift,
            set_shift_note,
            delete_shift,
            get_off_days,
            add_off_day,
            set_off_day_reason,
            remove_off_day,
            get_projects,
            create_project,
            update_project,
            delete_project,
            get_current_project,
            set_current_project,
            set_shift_project,
            assign_project_to_range,
            get_config,
            set_config,
            import_csv,
            autostart_is_enabled,
            autostart_enable,
            autostart_disable,
            show_native_notification,
            sync_now,
            sync_api::sync_api_request,
            update_tray_label,
            update_tray_icon,
            set_tray_tooltip,
        ])
        .setup(move |app| {
            autostart::cleanup(app.handle()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            let initial_tracking = db::get_active_shift_row().ok().flatten().is_some();

            // Determine initial clock label
            let initial_label = if initial_tracking {
                "Clock Out"
            } else {
                "Clock In"
            };

            let clock_item = MenuItemBuilder::with_id("clock", initial_label).build(app)?;
            let sync_item = MenuItemBuilder::with_id("sync", "Sync Now").build(app)?;
            let open = MenuItemBuilder::with_id("open", "Open TrackSuite.work").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&clock_item, &sync_item])
                .separator()
                .items(&[&open, &quit])
                .build()?;

            app.manage(PendingAutoClose(Mutex::new(None)));
            app.manage(Mutex::new(TrayState {
                clock_item: clock_item.clone(),
                tracking: initial_tracking,
            }));

            // The main window has "create": false in tauri.conf.json; build it
            // here. It starts hidden for an autostart (--hidden) or hotkey
            // (--toggle) launch, which stay in the tray.
            let main_window = build_main_window(app.handle(), !start_hidden)?;
            let initial_theme = main_window.theme().unwrap_or(Theme::Light);
            let initial_icon_bytes = tray_icon_bytes(initial_theme, initial_tracking);
            let initial_icon = Image::from_bytes(initial_icon_bytes)
                .expect("embedded icon");

            TrayIconBuilder::with_id("main")
                .icon(initial_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip(TRAY_TOOLTIP)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "clock" => toggle_tracking(app),
                    "sync"  => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match push_sync::perform_push_sync().await {
                                Ok(push_sync::SyncStatus::NotConfigured) => {
                                    let _ = notification::show(
                                        app.clone(),
                                        "Sync Not Configured".to_string(),
                                        Some("Add API Base URL and API key in Settings".to_string()),
                                    )
                                    .await;
                                }
                                Ok(push_sync::SyncStatus::Synced) => {
                                    let _ = notification::show(
                                        app.clone(),
                                        "Sync Complete".to_string(),
                                        Some("All data pushed to server".to_string()),
                                    )
                                    .await;
                                    let _ = app.emit("tray-data-changed", ());
                                }
                                Err(message) => {
                                    let _ = notification::show(
                                        app.clone(),
                                        "Sync Failed".to_string(),
                                        Some(message),
                                    )
                                    .await;
                                }
                            }
                        });
                    }
                    "open"  => show_main_window(app),
                    "quit"  => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_main_window(&app);
                    }
                })
                .build(app)?;

            apply_system_theme_icons(app.handle(), initial_theme)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            // Start system suspend listener
            suspend::start_listener(app.handle().clone());

            if toggle_on_launch {
                toggle_tracking(app.handle());
            }

            // Background loop, first tick right away, then every 5 minutes:
            // stale-shift check + heartbeat (independent of the webview, which
            // may be throttled while hidden) and a silent sync so changes made
            // elsewhere (e.g. a shift closed on the web app) reconcile while
            // the app sits idle. Sync is a no-op when not configured.
            let loop_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    background_tick(&loop_app).await;
                    tokio::time::sleep(std::time::Duration::from_secs(BACKGROUND_TICK_SECS)).await;
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building TrackSuite.work desktop shell");

    app.run(|app, event| match event {
        // The app lives in the tray, so it must not exit when its last
        // window goes away — that happens on purpose when show_main_window
        // re-creates the main window on Linux. Only a programmatic exit
        // (tray "Quit" → app.exit(0), the updater's restart) has a code.
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        // The old main window is gone and its label is free: build the
        // fresh one show_main_window asked for.
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == MAIN_WINDOW => {
            if app.state::<RecreateMainWindow>().0.swap(false, Ordering::SeqCst) {
                spawn_build_main_window(app);
            }
        }
        // macOS: clicking the Dock icon while the window is hidden (e.g. after
        // a --hidden autostart) brings the window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => show_main_window(app),
        _ => {}
    });
}