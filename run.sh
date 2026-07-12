#!/bin/bash
# Ensure DBus session is available for system tray
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi

# Disable GTK portals to avoid bwrap issues
export GTK_USE_PORTAL=0
# Disable WebKit sandbox which uses bwrap
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

export PYTHONPATH=$PYTHONPATH:$(pwd)
python3 -m work_time_app.main
