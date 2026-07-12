import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
from .database import end_shift, get_active_shift
from .notifications import send_notification

def on_prepare_for_sleep(sleep_starting):
    if sleep_starting:
        active = get_active_shift()
        if active:
            end_shift()
            send_notification("Auto Clocked Out", "System is suspending. Shift ended.")

def start_suspend_listener():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    bus.add_signal_receiver(
        on_prepare_for_sleep,
        signal_name="PrepareForSleep",
        dbus_interface="org.freedesktop.login1.Manager",
        bus_name="org.freedesktop.login1"
    )
    # This keeps running in the background if the main loop is running
