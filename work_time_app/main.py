import os
import sys

# Disable GTK portal before importing GTK to avoid bwrap sandboxing issues
os.environ["GTK_USE_PORTAL"] = "0"

import gi
gi.require_version('Gtk', '3.0') # For AppIndicator
from gi.repository import Gtk, GLib
import threading
import subprocess

from .database import init_db
from .indicator import WorkTimeIndicator
from .suspend_handler import start_suspend_listener
from .sync import SyncManager

class WorkTimeApp:
    def __init__(self):
        init_db()
        
        # Start suspend listener
        # Note: dbus-python and GLib main loop work together
        start_suspend_listener()
        
        # Indicator uses GTK3. 
        # Dashboard (GTK4) will be launched as a subprocess to avoid version conflict.
        self.indicator = WorkTimeIndicator(self.open_dashboard)
        
        # Trigger auto-sync on startup
        sync_manager = SyncManager()
        if sync_manager.is_configured():
            sync_manager.sync_background()

    def open_dashboard(self):
        # Fire and forget subprocess to avoid GTK version conflict
        env = os.environ.copy()
        # Ensure we can find the package
        current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if current_dir not in env.get("PYTHONPATH", ""):
            env["PYTHONPATH"] = current_dir + ":" + env.get("PYTHONPATH", "")
        
        # Disable GTK portal to avoid bwrap sandboxing issues
        env["GTK_USE_PORTAL"] = "0"
            
        subprocess.Popen([sys.executable, "-m", "work_time_app.ui.dashboard_run"], env=env)

    def run(self):
        Gtk.main()

def main():
    app = WorkTimeApp()
    app.run()

def main():
    app = WorkTimeApp()
    app.run()

if __name__ == "__main__":
    main()
