import os
import sys

# Disable GTK portal before importing GTK to avoid bwrap sandboxing issues
os.environ["GTK_USE_PORTAL"] = "0"

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw
from .dashboard import Dashboard

def main():
    app = Adw.Application(application_id="org.example.WorkTimeApp")
    def on_activate(app):
        win = Dashboard(application=app)
        win.present()
    app.connect("activate", on_activate)
    app.run(None)

if __name__ == "__main__":
    main()
