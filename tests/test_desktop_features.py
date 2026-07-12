"""Tests verifying Phase A desktop-parity features are correctly wired."""
import json


def _read(path: str) -> str:
    with open(path, "r") as f:
        return f.read()


# ── Auto-sync ────────────────────────────────────────────────────────

def test_auto_sync_on_startup():
    """Boot sequence calls performSync() after loadSettings."""
    src = _read("desktop/src/main.ts")
    boot_idx = src.index("loadSettings().then")
    sync_idx = src.index("performSync()", boot_idx)
    assert sync_idx > boot_idx


def test_auto_sync_on_clock_out():
    """Clock-out handler fires performSync() after endShift."""
    src = _read("desktop/src/main.ts")
    assert "performSync()" in src
    # performSync is called in the clock button handler after wasClockedIn check
    clock_handler_idx = src.index("wasClockedIn")
    sync_idx = src.index("performSync()", clock_handler_idx)
    assert sync_idx > clock_handler_idx


# ── Notifications ────────────────────────────────────────────────────

def test_notification_plugin_registered():
    """tauri-plugin-notification is in Cargo.toml and capabilities."""
    cargo = _read("desktop/src-tauri/Cargo.toml")
    assert "tauri-plugin-notification" in cargo

    with open("desktop/src-tauri/capabilities/default.json", "r") as f:
        caps = json.load(f)
    assert "notification:default" in caps["permissions"]


def test_notification_on_clock_events():
    """Notifications fire on clock-in and clock-out."""
    src = _read("desktop/src/main.ts")
    assert 'notify("Clocked In"' in src
    assert 'notify("Clocked Out"' in src


def test_notifications_use_linux_native_command_and_non_linux_plugin_api():
    """Linux notifications should bypass the plugin's runtime path while other platforms keep the plugin API."""
    src = _read("desktop/src/main.ts")
    main_rs = _read("desktop/src-tauri/src/main.rs")
    notification_rs = _read("desktop/src-tauri/src/notification.rs")

    assert 'invoke("show_native_notification"' in src
    assert 'native-linux-notifications-unsupported' in src
    assert 'console.warn("Desktop notification failed", error);' in src
    assert 'from "@tauri-apps/plugin-notification"' in src
    assert 'sendNotification({ title, body });' in src
    assert "show_native_notification" in main_rs
    assert "mod notification;" in main_rs
    assert 'Command::new("notify-send")' in notification_rs
    assert 'const APP_NAME: &str = "TrackSuite Work";' in notification_rs
    assert 'const APP_ICON: &str = "tracksuite-work-desktop";' in notification_rs
    assert 'command.arg("--app-name").arg(APP_NAME);' in notification_rs
    assert 'command.arg("-i").arg(APP_ICON);' in notification_rs
    assert 'command.arg("-a").arg(APP_NAME);' not in notification_rs
    assert 'string:desktop-entry:' not in notification_rs
    assert "org.freedesktop.Notifications" in notification_rs
    assert "zbus::Connection::session()" in notification_rs
    assert 'Err("native-linux-notifications-unsupported".to_string())' in notification_rs
    assert 'Notification.permission' not in src
    assert 'new Notification(' not in src


def test_notification_on_sync():
    """Sync failures notify the user; success is surfaced via status text.

    Sync now runs automatically (startup, every mutation, window focus, and a
    periodic background loop), so a success notification on each run would be
    noise. Success feedback is the inline "Synced" status instead.
    """
    src = _read("desktop/src/main.ts")
    assert 'notify("Sync Failed"' in src
    assert "Synced ✓" in src


# ── Autostart ────────────────────────────────────────────────────────

def test_autostart_plugin_registered():
    """tauri-plugin-autostart is in Cargo.toml and capabilities."""
    cargo = _read("desktop/src-tauri/Cargo.toml")
    assert "tauri-plugin-autostart" in cargo

    with open("desktop/src-tauri/capabilities/default.json", "r") as f:
        caps = json.load(f)
    assert "autostart:default" in caps["permissions"]


def test_autostart_settings_toggle():
    """Settings UI has an autostart checkbox wired to the app's autostart bridge."""
    src = _read("desktop/src/main.ts")
    assert "cfg-autostart" in src
    assert "autostartEnable" in src
    assert "autostartDisable" in src


def test_auto_resume_settings_are_present_and_persisted():
    """Settings UI exposes suspend auto-resume controls and persists them through config storage."""
    src = _read("desktop/src/main.ts")
    storage = _read("desktop/src/lib/storage.ts")
    domain = _read("desktop/src/lib/domain.ts")

    assert "cfg-auto-resume-enabled" in src
    assert "cfg-auto-resume-start" in src
    assert "cfg-auto-resume-end" in src
    assert "saveAutoResumeConfigFromInputs" in src
    assert "getAutoResumeConfig" in storage
    assert "saveAutoResumeConfig" in storage
    assert '"auto_resume_config"' in storage
    assert "DEFAULT_AUTO_RESUME_CONFIG" in domain


def test_auto_resume_only_uses_same_day_suspend_resume_flow():
    """Suspend auto-resume should require a suspend-origin marker, a resume event, and a same-day guard."""
    src = _read("desktop/src/main.ts")
    suspend_rs = _read("desktop/src-tauri/src/suspend.rs")
    main_rs = _read("desktop/src-tauri/src/main.rs")

    assert 'listen("system-suspend"' in src
    assert 'listen("system-resume"' in src
    assert "auto_resume_pending" in src
    assert "consumeAutoResumePending" in src
    assert "pending.date !== localDateKey(now)" in src
    assert 'notify("Auto Clock-In"' in src
    assert 'notify("Auto Clock-Out"' in src
    assert "system-resume" in suspend_rs
    assert "clear_auto_resume_pending" in main_rs
    assert "AUTO_RESUME_PENDING_KEY" in main_rs


def test_flatpak_autostart_backend_uses_xdg_config_and_flatpak_run():
    """Flatpak autostart writes to the bound XDG config path and launches via flatpak run."""
    rs = _read("desktop/src-tauri/src/autostart.rs")
    assert 'dirs::config_dir()' in rs
    assert 'join("autostart")' in rs
    assert 'Exec=flatpak run --command={} {}' in rs
    assert 'dirs::home_dir().unwrap().join(".config").join("autostart")' not in rs


def test_linux_native_autostart_rejects_workspace_binaries_and_cleans_stale_entries():
    """Native Linux autostart should not persist dev target binaries after login."""
    rs = _read("desktop/src-tauri/src/autostart.rs")
    assert 'const LINUX_AUTOSTART_FILE: &str = "TrackSuite.work.desktop";' in rs
    assert 'cleanup_linux_autostart()' in rs
    assert 'Autostart is only supported from packaged Linux builds' in rs
    assert 'display.contains("/desktop/src-tauri/target/debug/")' in rs
    assert 'display.contains("/desktop/src-tauri/target/release/")' in rs
    assert 'absolute_exec_target_missing(exec)' in rs


# ── Enhanced tray ────────────────────────────────────────────────────

def test_tray_clock_toggle():
    """Tray menu toggles tracking directly in Rust, updates tray state, and notifies."""
    rs = _read("desktop/src-tauri/src/main.rs")
    assert '"clock"' in rs
    assert "start_shift_row" in rs
    assert "end_shift_row" in rs
    assert "set_tray_tracking_state" in rs
    assert 'notify_async("Clocked In"' in rs
    assert 'notify_async("Clocked Out"' in rs


def test_tray_sync_item():
    """Tray menu has a Sync Now item that performs sync natively from Rust."""
    rs = _read("desktop/src-tauri/src/main.rs")
    assert '"sync"' in rs
    assert "push_sync::perform_push_sync" in rs
    assert "mod push_sync;" in rs


def test_tray_dynamic_icon():
    """Tray icon changes between idle and tracking states."""
    rs = _read("desktop/src-tauri/src/main.rs")
    assert "ICON_IDLE_LIGHT" in rs
    assert "ICON_IDLE_DARK" in rs
    assert "ICON_TRACKING_LIGHT" in rs
    assert "ICON_TRACKING_DARK" in rs
    assert "current_system_theme" in rs
    assert "update_tray_icon" in rs

    # Frontend calls the icon update
    src = _read("desktop/src/main.ts")
    assert "update_tray_icon" in src


def test_tray_icon_files_exist():
    """Both icon variants exist."""
    import os
    assert os.path.exists("desktop/src-tauri/icons/icon-idle.png")
    assert os.path.exists("desktop/src-tauri/icons/icon-idle-dark.png")
    assert os.path.exists("desktop/src-tauri/icons/icon-tracking.png")
    assert os.path.exists("desktop/src-tauri/icons/icon-tracking-dark.png")


def test_tray_frontend_listeners():
    """Frontend refreshes after tray-originated data changes and when the window regains focus."""
    src = _read("desktop/src/main.ts")
    assert 'listen("tray-data-changed"' in src
    assert 'window.addEventListener("focus"' in src
    assert "scheduleRefresh" in src


def test_flatpak_release_metadata_includes_login1_policy():
    """The GitHub Actions Flatpak packaging step includes system bus access for logind."""
    workflow = _read(".github/workflows/build.yml")
    assert "[System Bus Policy]" in workflow
    assert "org.freedesktop.login1=talk" in workflow


def test_release_workflow_syncs_desktop_version_from_tag():
    """Release workflows should rewrite desktop app metadata from the Git tag before building assets."""
    workflow = _read(".github/workflows/build.yml")
    assert 'APP_VERSION=${GITHUB_REF_NAME#v}' in workflow
    assert 'npm --prefix desktop version "$APP_VERSION" --no-git-tag-version --allow-same-version' in workflow
    assert "desktop/src-tauri/tauri.conf.json" in workflow
    assert "desktop/src-tauri/Cargo.toml" in workflow
    assert 'TrackSuite.work_${APP_VERSION}_x86_64.flatpak' in workflow


def test_release_workflow_keeps_latest_json_but_hides_raw_signatures():
    """The public release publishes latest.json but drops the standalone .sig assets."""
    workflow = _read(".github/workflows/build.yml")
    assert "includeUpdaterJson: true" in workflow
    # publish_public drops the raw signatures before creating the public release,
    # while latest.json (which embeds the signatures) is kept and re-pointed.
    assert "rm -f dist/*.sig" in workflow
    assert "dist/latest.json" in workflow


def test_release_workflow_publishes_clean_snapshot_to_public_repo():
    """Releases mirror to the public repo with a clean single-commit source snapshot."""
    workflow = _read(".github/workflows/build.yml")
    assert "publish_public" in workflow
    assert "julianquandt/TrackSuite.work" in workflow
    assert "git archive" in workflow          # source snapshot without history
    assert 'rm -rf "$snap/.github" "$snap/conductor"' in workflow  # internal files excluded
    assert "PUBLIC_TOKEN" in workflow


def test_release_workflow_adds_macos_setfile_to_path_for_dmg_bundles():
    """macOS release builds should expose Xcode's SetFile binary so Tauri's DMG helper script can run on CI."""
    workflow = _read(".github/workflows/build.yml")
    assert "Ensure macOS developer tools are on PATH" in workflow
    assert 'DEVELOPER_BIN="$(xcode-select -p)/usr/bin"' in workflow
    assert 'test -x "$DEVELOPER_BIN/SetFile"' in workflow
    assert 'echo "$DEVELOPER_BIN" >> "$GITHUB_PATH"' in workflow


def test_flatpak_release_uses_valid_app_id():
    """Flatpak packaging uses a valid app ID without a hyphen in a non-final segment."""
    workflow = _read(".github/workflows/build.yml")
    manifest = _read("packaging/linux/com.tracksuite-work.desktop.yml")
    metainfo = _read("packaging/linux/com.tracksuite-work.desktop.metainfo.xml")
    autostart = _read("desktop/src-tauri/src/autostart.rs")

    assert "name=com.tracksuite.work.desktop" in workflow
    assert "name=com.tracksuite-work.desktop" not in workflow
    assert "app-id: com.tracksuite.work.desktop" in manifest
    assert "app-id: com.tracksuite-work.desktop" not in manifest
    assert "<id>com.tracksuite.work.desktop</id>" in metainfo
    assert "<id>com.tracksuite-work.desktop</id>" not in metainfo
    assert 'const FLATPAK_APP_ID: &str = "com.tracksuite.work.desktop";' in autostart


def test_debian_metainfo_links_component_to_package_name():
    """Debian AppStream metadata should name the package so GNOME Software can map the app back to the removable .deb."""
    metainfo = _read("packaging/linux/com.tracksuite.work.desktop.deb.metainfo.xml")

    assert "<id>com.tracksuite.work.desktop</id>" in metainfo
    assert "<pkgname>track-suite-work</pkgname>" in metainfo
    assert "<launchable type=\"desktop-id\">TrackSuite.work.desktop</launchable>" in metainfo


def test_desktop_sync_uses_native_command_instead_of_http_plugin():
    """Desktop sync should use a Tauri command instead of the HTTP plugin's runtime path."""
    api = _read("desktop/src/lib/api.ts")
    main_rs = _read("desktop/src-tauri/src/main.rs")
    cargo = _read("desktop/src-tauri/Cargo.toml")

    assert 'from "@tauri-apps/plugin-http"' not in api
    assert 'invoke<NativeApiResult>("sync_api_request"' in api
    assert "mod sync_api;" in main_rs
    assert "sync_api::sync_api_request" in main_rs
    assert "tauri-plugin-http" not in cargo


def test_off_day_range_ui_present():
    """Desktop UI supports toggling a range of off-days, not just single dates."""
    src = _read("desktop/src/main.ts")
    assert "inp-offday-start" in src
    assert "inp-offday-end" in src
    assert "Toggle range" in src
    assert "inclusiveDateRange" in src


def test_linux_suspend_listener_uses_tauri_runtime():
    """Linux suspend listener avoids spinning up a nested Tokio runtime."""
    rs = _read("desktop/src-tauri/src/suspend.rs")
    assert "tauri::async_runtime::spawn" in rs
    assert "block_on(async move" not in rs


def test_desktop_sync_ui_is_api_key_only():
    """Desktop settings only collect the API base URL and sync API key."""
    src = _read("desktop/src/main.ts")
    assert "cfg-url" in src
    assert "cfg-key" in src
    assert "Generate and manage sync API keys in the TrackSuite.work web dashboard" in src
    assert "auth-email" not in src
    assert "btn-register" not in src
    assert "btn-login" not in src
    assert "btn-generate-key" not in src
    assert "auth-key-list" not in src


def test_work_schedule_settings_are_present_and_persisted():
    """Desktop settings expose configurable per-day scheduled hours and persist them."""
    src = _read("desktop/src/main.ts")
    storage = _read("desktop/src/lib/storage.ts")
    schedule = _read("desktop/src/lib/workSchedule.ts")

    assert "cfg-hours-mon" in src
    assert "cfg-hours-fri" in src
    assert "btn-save-schedule" in src
    assert "schedule-summary" in src
    assert "getWorkSchedule" in storage
    assert "saveWorkSchedule" in storage
    assert '"work_schedule"' in storage
    assert "DEFAULT_WORK_SCHEDULE" in schedule
    assert "weeklyTargetHours" in schedule
    assert "workingDays" in schedule


def test_desktop_uses_shared_work_schedule_instead_of_hardcoded_weekday_hours():
    """Dashboard and statistics should derive targets from the saved per-day schedule instead of equal weekday hours."""
    src = _read("desktop/src/main.ts")

    assert "getAdjustedWeeklyTargetHours" in src
    assert "getTargetHoursForDate" in src
    assert "getWeeklyTargetHours" in src
    assert "(weekTotal / 36)" not in src
    assert "Math.max(0, 36 - weekOffDays * 7.2)" not in src
    assert "cfg-workday-mon" not in src


def test_desktop_no_longer_stores_auth_session():
    """Desktop no longer persists a separate JWT account session."""
    src = _read("desktop/src/lib/storage.ts")
    assert "auth_email" not in src
    assert "auth_jwt" not in src
    assert "getAuthSession" not in src
    assert "saveAuthSession" not in src


def test_sync_no_longer_uses_manual_user_id():
    """Desktop sync uses authenticated API keys and no longer relies on user_id config."""
    src = _read("desktop/src/main.ts")
    assert "cfg-uid" not in src
    assert "user_id=" not in src
    assert 'body: { date }' in _read("desktop/src/lib/api.ts")
    assert 'body: { start_time: shift.startTime, end_time: shift.endTime }' in _read("desktop/src/lib/api.ts")
