use tauri::{AppHandle, Emitter};

/// Start listening for system suspend and resume events and emit them to the frontend.
pub fn start_listener(app: AppHandle) {
    #[cfg(target_os = "linux")]
    linux::listen(app);

    #[cfg(target_os = "macos")]
    macos::listen(app);

    #[cfg(target_os = "windows")]
    windows::listen(app);
}

// ── Linux: D-Bus PrepareForSleep ────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use futures_util::StreamExt;

    #[zbus::proxy(
        interface = "org.freedesktop.login1.Manager",
        default_service = "org.freedesktop.login1",
        default_path = "/org/freedesktop/login1"
    )]
    trait Login1Manager {
        #[zbus(signal)]
        fn prepare_for_sleep(&self, going_to_sleep: bool) -> zbus::Result<()>;
    }

    pub fn listen(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = watch_prepare_for_sleep(app).await {
                eprintln!("suspend listener unavailable: {e}");
            }
        });
    }

    async fn watch_prepare_for_sleep(app: AppHandle) -> zbus::Result<()> {
        let conn = zbus::Connection::system().await?;
        let proxy = Login1ManagerProxy::new(&conn).await?;
        let mut stream = proxy.receive_prepare_for_sleep().await?;
        while let Some(signal) = stream.next().await {
            if let Ok(args) = signal.args() {
                if args.going_to_sleep {
                    let _ = app.emit("system-suspend", ());
                } else {
                    let _ = app.emit("system-resume", ());
                }
            }
        }
        Ok(())
    }
}

// ── macOS: NSWorkspace willSleepNotification ────────────────────────

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod macos {
    use super::*;

    pub fn listen(app: AppHandle) {
        std::thread::spawn(move || {
            unsafe {
                use cocoa::base::{id, nil};
                use cocoa::foundation::NSString as CocoaNSString;
                use objc::runtime::Class;

                let workspace_cls = Class::get("NSWorkspace").expect("NSWorkspace");
                let workspace: id = objc::msg_send![workspace_cls, sharedWorkspace];
                let nc: id = objc::msg_send![workspace, notificationCenter];

                let sleep_name = CocoaNSString::alloc(nil)
                    .init_str("NSWorkspaceWillSleepNotification");
                let wake_name = CocoaNSString::alloc(nil)
                    .init_str("NSWorkspaceDidWakeNotification");

                let sleep_app = app.clone();
                let sleep_block = block::ConcreteBlock::new(move |_notif: id| {
                    let _ = sleep_app.emit("system-suspend", ());
                });
                let sleep_block = sleep_block.copy();

                let wake_app = app.clone();
                let wake_block = block::ConcreteBlock::new(move |_notif: id| {
                    let _ = wake_app.emit("system-resume", ());
                });
                let wake_block = wake_block.copy();

                let _: id = objc::msg_send![
                    nc,
                    addObserverForName: sleep_name
                    object: nil
                    queue: nil
                    usingBlock: &*sleep_block
                ];

                let _: id = objc::msg_send![
                    nc,
                    addObserverForName: wake_name
                    object: nil
                    queue: nil
                    usingBlock: &*wake_block
                ];

                // Run this thread's run loop to receive notifications
                let runloop_cls = Class::get("NSRunLoop").expect("NSRunLoop");
                let current: id = objc::msg_send![runloop_cls, currentRunLoop];
                let _: () = objc::msg_send![current, run];
            }
        });
    }
}

// ── Windows: hidden window listening for WM_POWERBROADCAST ──────────

#[cfg(target_os = "windows")]
mod windows {
    use super::*;

    pub fn listen(app: AppHandle) {
        std::thread::spawn(move || {
            unsafe { run_power_listener(app) }
        });
    }

    unsafe fn run_power_listener(app: AppHandle) {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;

        const PBT_APMSUSPEND: usize = 0x0004;
        const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

        // Store AppHandle in thread-local for the wndproc callback
        thread_local! {
            static APP: std::cell::RefCell<Option<AppHandle>> = std::cell::RefCell::new(None);
        }
        APP.with(|a| *a.borrow_mut() = Some(app));

        unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
            if msg == WM_POWERBROADCAST {
                APP.with(|a| {
                    if let Some(ref app) = *a.borrow() {
                        if wp == PBT_APMSUSPEND {
                            let _ = app.emit("system-suspend", ());
                        } else if wp == PBT_APMRESUMEAUTOMATIC {
                            let _ = app.emit("system-resume", ());
                        }
                    }
                });
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }

        let class_name: Vec<u16> = OsStr::new("TrackSuite.workPower\0").encode_wide().collect();
        let h_instance = GetModuleHandleW(ptr::null());

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: h_instance,
            hIcon: ptr::null_mut(),
            hCursor: ptr::null_mut(),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: ptr::null_mut(),
        };

        RegisterClassExW(&wc);

        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
            ptr::null_mut(), ptr::null_mut(), h_instance, ptr::null(),
        );

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
