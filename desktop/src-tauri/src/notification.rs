#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::io::ErrorKind;
    use std::process::Command;

    use zbus::zvariant::OwnedValue;

    const APP_NAME: &str = "TrackSuite Work";
    const APP_ICON: &str = "tracksuite-work-desktop";

    #[zbus::proxy(
        interface = "org.freedesktop.Notifications",
        default_service = "org.freedesktop.Notifications",
        default_path = "/org/freedesktop/Notifications"
    )]
    trait Notifications {
        fn notify(
            &self,
            app_name: &str,
            replaces_id: u32,
            app_icon: &str,
            summary: &str,
            body: &str,
            actions: Vec<String>,
            hints: HashMap<String, OwnedValue>,
            expire_timeout: i32,
        ) -> zbus::Result<u32>;
    }

    async fn try_notify_send(title: String, body: Option<String>) -> Result<bool, String> {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut command = Command::new("notify-send");
            command.arg("--app-name").arg(APP_NAME);
            command.arg("-i").arg(APP_ICON);
            command.arg(&title);
            if let Some(body) = body {
                command.arg(body);
            }
            command.status()
        })
        .await
        .map_err(|e| e.to_string())?;

        match result {
            Ok(status) => Ok(status.success()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn show(title: String, body: Option<String>) -> Result<(), String> {
        if try_notify_send(title.clone(), body.clone()).await? {
            return Ok(());
        }

        let conn = zbus::Connection::session()
            .await
            .map_err(|e| e.to_string())?;
        let proxy = NotificationsProxy::new(&conn)
            .await
            .map_err(|e| e.to_string())?;

        // Avoid the Tauri notification plugin's Linux path, which can block inside Tokio.
        let _: u32 = proxy
            .notify(
                APP_NAME,
                0,
                APP_ICON,
                &title,
                body.as_deref().unwrap_or(""),
                Vec::new(),
                HashMap::new(),
                5_000,
            )
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

#[cfg(target_os = "linux")]
pub async fn show(title: String, body: Option<String>) -> Result<(), String> {
    linux::show(title, body).await
}

#[cfg(not(target_os = "linux"))]
pub async fn show(_title: String, _body: Option<String>) -> Result<(), String> {
    Err("native-linux-notifications-unsupported".to_string())
}