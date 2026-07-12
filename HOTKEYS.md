# Hotkey Setup (Ubuntu 24.04 Wayland)

To toggle clock-in/out with a system-wide hotkey:

1. Open **Settings**.
2. Go to **Keyboard** -> **Keyboard Shortcuts** -> **View and Customise Shortcuts**.
3. Scroll to the bottom and select **Custom Shortcuts**.
4. Click **Add Shortcut**.
5. **Name**: `Work Time Toggle`
6. **Command**: `python3 -m work_time_app.cli --toggle`
   *(Absolute path recommended: `/usr/bin/python3 /path/to/app/work_time_app/cli.py --toggle`)*
7. **Shortcut**: Press your desired keys (e.g., `Super+Shift+C`).

## How it works
This CLI command connects to the same SQLite database as the GUI app and sends a desktop notification upon success.
