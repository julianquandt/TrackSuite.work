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

use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Theme,
};

static ICON_IDLE_LIGHT: &[u8] = include_bytes!("../icons/icon-idle.png");
static ICON_IDLE_DARK: &[u8] = include_bytes!("../icons/icon-idle-dark.png");
static ICON_TRACKING_LIGHT: &[u8] = include_bytes!("../icons/icon-tracking.png");
static ICON_TRACKING_DARK: &[u8] = include_bytes!("../icons/icon-tracking-dark.png");
const AUTO_RESUME_PENDING_KEY: &str = "auto_resume_pending";

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
    app.get_webview_window("main")
        .and_then(|window| window.theme().ok())
        .unwrap_or(Theme::Light)
}

fn set_window_icon_for_theme(app: &AppHandle, theme: Theme) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
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

fn notify_async(title: &str, body: Option<String>) {
    let title = title.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = notification::show(title, body).await {
            eprintln!("notification failed: {error}");
        }
    });
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

#[tauri::command]
fn add_manual_shift(start_time: String, end_time: String) -> Result<(), String> {
    db::add_shift_manual_row(&start_time, &end_time)
}

#[tauri::command]
fn delete_shift(shift_id: i64) -> Result<(), String> {
    db::delete_shift_row(shift_id)
}

#[tauri::command]
fn get_off_days() -> Result<Vec<String>, String> {
    db::get_off_days_rows()
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
) -> Result<(), String> {
    db::update_project_row(&uuid, &name, color.as_deref(), archived)
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
async fn show_native_notification(title: String, body: Option<String>) -> Result<(), String> {
    notification::show(title, body).await
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

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_active_shift,
            get_all_shifts,
            start_shift,
            end_shift,
            add_manual_shift,
            delete_shift,
            get_off_days,
            add_off_day,
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
        ])
        .setup(|app| {
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

            app.manage(Mutex::new(TrayState {
                clock_item: clock_item.clone(),
                tracking: initial_tracking,
            }));

            let main_window = app.get_webview_window("main")
                .expect("main window not found");
            let initial_theme = main_window.theme().unwrap_or(Theme::Light);
            let initial_icon_bytes = tray_icon_bytes(initial_theme, initial_tracking);
            let initial_icon = Image::from_bytes(initial_icon_bytes)
                .expect("embedded icon");

            TrayIconBuilder::with_id("main")
                .icon(initial_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("TrackSuite.work")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "clock" => {
                        let active_shift = db::get_active_shift_row().ok().flatten();
                        let was_tracking = active_shift.is_some();
                        let result = if was_tracking {
                            end_shift()
                        } else {
                            start_shift()
                        };

                        if let Ok(true) = result {
                            let _ = set_tray_tracking_state(app, !was_tracking);
                            if was_tracking {
                                let body = active_shift
                                    .as_ref()
                                    .and_then(|shift| format_tracked_duration(&shift.start_time))
                                    .map(|duration| format!("Tracked {}", duration))
                                    .or_else(|| Some("Time tracking ended".to_string()));
                                notify_async("Clocked Out", body);
                            } else {
                                notify_async("Clocked In", Some("Time tracking started".to_string()));
                            }
                            let _ = app.emit("tray-data-changed", ());
                        }
                    }
                    "sync"  => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match push_sync::perform_push_sync().await {
                                Ok(push_sync::SyncStatus::NotConfigured) => {
                                    let _ = notification::show(
                                        "Sync Not Configured".to_string(),
                                        Some("Add API Base URL and API key in Settings".to_string()),
                                    )
                                    .await;
                                }
                                Ok(push_sync::SyncStatus::Synced) => {
                                    let _ = notification::show(
                                        "Sync Complete".to_string(),
                                        Some("All data pushed to server".to_string()),
                                    )
                                    .await;
                                    let _ = app.emit("tray-data-changed", ());
                                }
                                Err(message) => {
                                    let _ = notification::show(
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

            // Intercept window close → hide to tray instead of quitting
            let win = main_window.clone();
            let icon_app = app.handle().clone();
            main_window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                    tauri::WindowEvent::ThemeChanged(theme) => {
                        let _ = apply_system_theme_icons(&icon_app, *theme);
                    }
                    _ => {}
                }
            });

            // Start system suspend listener
            suspend::start_listener(app.handle().clone());

            // Periodic background sync so changes made elsewhere (e.g. a shift
            // closed on the web app) reconcile even while the desktop app sits
            // idle. No-op when sync isn't configured.
            let sync_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    if let Ok(push_sync::SyncStatus::Synced) =
                        push_sync::perform_push_sync().await
                    {
                        let _ = sync_app.emit("tray-data-changed", ());
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TrackSuite.work desktop shell");
}