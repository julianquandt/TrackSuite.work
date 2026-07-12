import gi
gi.require_version('Gtk', '3.0') # AppIndicator3 still uses GTK3 usually
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gtk, AyatanaAppIndicator3 as AppIndicator
from .database import start_shift, end_shift, get_active_shift
from .notifications import send_notification
from .sync import SyncManager

class WorkTimeIndicator:
    def __init__(self, open_dashboard_callback):
        self.open_dashboard_callback = open_dashboard_callback
        self.sync_manager = SyncManager()
        self.indicator = AppIndicator.Indicator.new(
            "work-time-app",
            "appointment-new-symbolic",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS
        )
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.update_menu()

    def update_menu(self):
        menu = Gtk.Menu()
        
        active = get_active_shift()
        
        # Toggle Item
        toggle_label = "Clock Out" if active else "Clock In"
        item_toggle = Gtk.MenuItem(label=toggle_label)
        item_toggle.connect("activate", self.on_toggle)
        menu.append(item_toggle)
        
        # Dashboard Item
        item_dash = Gtk.MenuItem(label="Open Dashboard")
        item_dash.connect("activate", lambda _: self.open_dashboard_callback())
        menu.append(item_dash)
        
        # Sync Item (only if configured)
        if self.sync_manager.is_configured():
            item_sync = Gtk.MenuItem(label="Sync Now")
            item_sync.connect("activate", self.on_sync)
            menu.append(item_sync)
        
        menu.append(Gtk.SeparatorMenuItem())
        
        # Quit Item
        item_quit = Gtk.MenuItem(label="Quit")
        item_quit.connect("activate", Gtk.main_quit)
        menu.append(item_quit)
        
        menu.show_all()
        self.indicator.set_menu(menu)
        
        # Update icon based on status
        if active:
            # Use a green/active indicator
            self.indicator.set_icon_full("emblem-default-symbolic", "Working")
        else:
            # Use a gray/inactive indicator  
            self.indicator.set_icon_full("appointment-new-symbolic", "Off")

    def on_toggle(self, _):
        active = get_active_shift()
        if active:
            end_shift()
            send_notification("Clocked Out", "Shift ended.")
            # Trigger auto-sync on clock-out
            self.sync_manager = SyncManager()
            if self.sync_manager.is_configured():
                self.sync_manager.sync_background()
        else:
            start_shift()
            send_notification("Clocked In", "Shift started.")
        self.update_menu()

    def on_sync(self, _):
        # Update config in case it changed in dashboard
        self.sync_manager = SyncManager()
        
        def sync_done(success):
            if success:
                send_notification("Sync Successful", "Data pushed to server.")
            else:
                send_notification("Sync Failed", "Check server URL and API Key.")
        
        if self.sync_manager.is_configured():
            self.sync_manager.sync_background(callback=sync_done)
        else:
            send_notification("Sync Failed", "Server not configured.")
