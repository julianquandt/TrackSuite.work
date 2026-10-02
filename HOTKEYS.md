# Global Hotkey for Clock In/Out

TrackSuite.work can clock you in or out from a system-wide keyboard shortcut.
The shortcut runs the app with the `--toggle` argument:

- If the app is already running, the running app clocks in or out (the same
  as **Clock In / Clock Out** in the tray menu). No second copy starts.
- If the app is not running, it starts in the tray (no window), clocks in or
  out, and keeps running.

You get a notification either way, and the change syncs right away.

## Which command to use

| How you installed TrackSuite.work | Command |
| --- | --- |
| `.deb` / `.rpm` / apt repository | `tracksuite-work-desktop --toggle` |
| AppImage | `/full/path/to/TrackSuite.work.AppImage --toggle` |
| Flatpak | `flatpak run com.tracksuite.work.desktop --toggle` |

## Ubuntu / GNOME setup

1. Open **Settings**.
2. Go to **Keyboard** -> **Keyboard Shortcuts** -> **View and Customise Shortcuts**.
3. Scroll to the bottom and select **Custom Shortcuts**.
4. Click **Add Shortcut**.
5. **Name**: `TrackSuite.work Clock In/Out`
6. **Command**: the command from the table above, for example
   `tracksuite-work-desktop --toggle`
7. **Shortcut**: press your desired keys (e.g., `Super+Shift+C`).

Other desktops (KDE, Xfce, ...) have a similar "custom shortcut" setting that
runs a command.

## Do not use the old Python script

Older versions of this guide used `python3 -m work_time_app.cli --toggle`.
That script belongs to the legacy Python app. It writes shifts without the
fields that sync needs, so those shifts do not sync correctly and are not
protected against shifts that run on forever. Replace that shortcut with the
command above.
