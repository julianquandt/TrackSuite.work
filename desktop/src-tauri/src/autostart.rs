#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

use tauri::AppHandle;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt;

#[cfg(target_os = "linux")]
const FLATPAK_APP_ID: &str = "com.tracksuite.work.desktop";
#[cfg(target_os = "linux")]
const FLATPAK_COMMAND: &str = "tracksuite-work-desktop";
#[cfg(target_os = "linux")]
const LINUX_AUTOSTART_FILE: &str = "TrackSuite.work.desktop";
#[cfg(target_os = "linux")]
const FLATPAK_AUTOSTART_FILE: &str = "com.tracksuite.work.desktop.desktop";
#[cfg(target_os = "linux")]
const LEGACY_FLATPAK_AUTOSTART_FILES: [&str; 2] = [
    "com.tracksuite-work.desktop.desktop",
    "tracksuite-work-desktop.desktop",
];

pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        if is_flatpak() {
            return Ok(flatpak_autostart_files()?.iter().any(|path| path.exists()));
        }

        cleanup_linux_autostart()?;
        Ok(linux_autostart_file()?.exists())
    }

    #[cfg(not(target_os = "linux"))]
    {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}

pub fn enable(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        if is_flatpak() {
            return enable_flatpak();
        }

        enable_linux_autostart()
    }

    #[cfg(not(target_os = "linux"))]
    {
        app.autolaunch().enable().map_err(|e| e.to_string())
    }
}

pub fn disable(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        if is_flatpak() {
            return disable_flatpak();
        }

        disable_linux_autostart()
    }

    #[cfg(not(target_os = "linux"))]
    {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

pub fn cleanup(_app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if is_flatpak() {
            return Ok(());
        }

        cleanup_linux_autostart()
    }

    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists()
}

#[cfg(target_os = "linux")]
fn flatpak_app_id() -> String {
    std::env::var("FLATPAK_ID").unwrap_or_else(|_| FLATPAK_APP_ID.to_string())
}

#[cfg(target_os = "linux")]
fn flatpak_autostart_dir() -> Result<std::path::PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join("autostart"))
        .ok_or_else(|| "XDG config directory is unavailable".to_string())
}

#[cfg(target_os = "linux")]
fn linux_autostart_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join("autostart"))
        .ok_or_else(|| "XDG config directory is unavailable".to_string())
}

#[cfg(target_os = "linux")]
fn linux_autostart_file() -> Result<PathBuf, String> {
    Ok(linux_autostart_dir()?.join(LINUX_AUTOSTART_FILE))
}

#[cfg(target_os = "linux")]
fn flatpak_autostart_file() -> Result<std::path::PathBuf, String> {
    Ok(flatpak_autostart_dir()?.join(FLATPAK_AUTOSTART_FILE))
}

#[cfg(target_os = "linux")]
fn flatpak_autostart_files() -> Result<Vec<std::path::PathBuf>, String> {
    let dir = flatpak_autostart_dir()?;
    let mut files = vec![dir.join(FLATPAK_AUTOSTART_FILE)];
    files.extend(LEGACY_FLATPAK_AUTOSTART_FILES.iter().map(|file| dir.join(file)));
    Ok(files)
}

#[cfg(target_os = "linux")]
fn linux_autostart_entry(exec_path: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
Type=Application\n\
Version=1.0\n\
Name=TrackSuite.work\n\
GenericName=Work Time Tracker\n\
Comment=Cross-platform work time tracking desktop app\n\
Exec={}\n\
Icon=tracksuite-work-desktop\n\
Categories=Utility;Office;\n\
Keywords=time;tracking;productivity;\n\
StartupNotify=true\n\
StartupWMClass=tracksuite-work-desktop\n\
Terminal=false\n\
X-GNOME-Autostart-enabled=true\n",
        desktop_entry_exec(exec_path),
    )
}

#[cfg(target_os = "linux")]
fn flatpak_autostart_entry() -> String {
    format!(
        "[Desktop Entry]\n\
Type=Application\n\
Version=1.0\n\
Name=TrackSuite.work\n\
GenericName=Work Time Tracker\n\
Comment=Cross-platform work time tracking desktop app\n\
Exec=flatpak run --command={} {}\n\
Icon={}\n\
Categories=Utility;Office;\n\
Keywords=time;tracking;productivity;\n\
StartupNotify=true\n\
StartupWMClass={}\n\
Terminal=false\n\
X-Flatpak={}\n\
X-GNOME-Autostart-enabled=true\n",
        FLATPAK_COMMAND,
        flatpak_app_id(),
        flatpak_app_id(),
        FLATPAK_COMMAND,
        flatpak_app_id(),
    )
}

#[cfg(target_os = "linux")]
fn enable_flatpak() -> Result<(), String> {
    let dir = flatpak_autostart_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(flatpak_autostart_file()?, flatpak_autostart_entry()).map_err(|e| e.to_string())?;

    for legacy_file in flatpak_autostart_files()?.into_iter().skip(1) {
        if legacy_file.exists() {
            fs::remove_file(legacy_file).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn disable_flatpak() -> Result<(), String> {
    for file in flatpak_autostart_files()? {
        if file.exists() {
            fs::remove_file(file).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn enable_linux_autostart() -> Result<(), String> {
    cleanup_linux_autostart()?;

    let exec_path = std::env::current_exe().map_err(|e| e.to_string())?;
    if looks_like_dev_binary(&exec_path) {
        return Err("Autostart is only supported from packaged Linux builds, not workspace target binaries.".to_string());
    }

    let dir = linux_autostart_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(linux_autostart_file()?, linux_autostart_entry(&exec_path)).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn disable_linux_autostart() -> Result<(), String> {
    let file = linux_autostart_file()?;
    if file.exists() {
        fs::remove_file(file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn cleanup_linux_autostart() -> Result<(), String> {
    let file = linux_autostart_file()?;
    if !file.exists() {
        return Ok(());
    }

    let entry = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let Some(exec) = entry.lines().find_map(|line| line.strip_prefix("Exec=").map(str::trim)) else {
        return Ok(());
    };

    if looks_like_dev_exec(exec) || absolute_exec_target_missing(exec) {
        fs::remove_file(file).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn looks_like_dev_exec(exec: &str) -> bool {
    exec.split_whitespace()
        .next()
        .map(Path::new)
        .is_some_and(looks_like_dev_binary)
}

#[cfg(target_os = "linux")]
fn absolute_exec_target_missing(exec: &str) -> bool {
    exec.split_whitespace()
        .next()
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .is_some_and(|path| !path.exists())
}

#[cfg(target_os = "linux")]
fn looks_like_dev_binary(path: &Path) -> bool {
    let display = path.to_string_lossy();
    display.contains("/desktop/src-tauri/target/debug/")
        || display.contains("/desktop/src-tauri/target/release/")
}

#[cfg(target_os = "linux")]
fn desktop_entry_exec(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace(' ', "\\ ")
}