import gi
gi.require_version('Notify', '0.7')
from gi.repository import Notify

_initialized = False

def _ensure_init():
    global _initialized
    if not _initialized:
        Notify.init("Work Time App")
        _initialized = True

def send_notification(summary, body):
    _ensure_init()
    n = Notify.Notification.new(summary, body, "appointment-new-symbolic")
    n.show()
