import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib
from datetime import datetime, timedelta
from ..database import get_all_shifts, get_active_shift, export_to_csv, add_off_day, remove_off_day, get_off_days, delete_shift, add_shift_manual, get_config, set_config
from .graphs import GraphView
import os

class Dashboard(Adw.Window):
    def __init__(self, **kwargs):
        super().__init__(title="Work Time Dashboard", default_width=800, default_height=700, **kwargs)
        self.set_icon_name("office-calendar")
        self.history_rows = []
        
        # Main Layout
        self.main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        
        # Header Bar
        self.header_bar = Adw.HeaderBar()
        
        # View Switcher
        self.view_switcher_title = Adw.ViewSwitcherTitle()
        self.header_bar.set_title_widget(self.view_switcher_title)
        
        self.main_box.append(self.header_bar)
        
        # Scrolled Window for content
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_vexpand(True)
        self.main_box.append(scrolled)

        self.view_stack = Adw.ViewStack()
        self.view_switcher_title.set_stack(self.view_stack)
        scrolled.set_child(self.view_stack)
        
        # Main Page
        page_main = Adw.StatusPage(title="My Working Hours", icon_name="appointment-new-symbolic")
        
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_top(32)
        box.set_margin_bottom(32)
        box.set_margin_start(32)
        box.set_margin_end(32)
        
        # ... (rest of main page setup)
        
        # Stats Group
        group = Adw.PreferencesGroup(title="Weekly Progress")
        
        self.weekly_label = Adw.ActionRow(title="Worked this week", subtitle="0.0 hours / 36.0 hours")
        self.level_bar = Gtk.LevelBar()
        self.level_bar.set_max_value(36.0)
        self.level_bar.set_min_value(0.0)
        self.level_bar.set_size_request(-1, 8)
        
        group.add(self.weekly_label)
        
        # Export Button
        export_row = Adw.ActionRow(title="Export Data", subtitle="Download shift history as CSV")
        export_btn = Gtk.Button(label="Export", valign=Gtk.Align.CENTER)
        export_btn.connect("clicked", self.on_export_clicked)
        export_row.add_suffix(export_btn)
        group.add(export_row)

        # Off Days Button
        off_days_row = Adw.ActionRow(title="Off Days", subtitle="Manage holidays and sick leave")
        off_days_btn = Gtk.Button(label="Calendar", valign=Gtk.Align.CENTER)
        off_days_btn.connect("clicked", self.on_calendar_clicked)
        off_days_row.add_suffix(off_days_btn)
        group.add(off_days_row)
        
        # Add Shift Manually Button
        add_shift_row = Adw.ActionRow(title="Add Shift", subtitle="Manually enter a past shift")
        add_shift_btn = Gtk.Button(label="Add", valign=Gtk.Align.CENTER)
        add_shift_btn.connect("clicked", self.on_add_shift_clicked)
        add_shift_row.add_suffix(add_shift_btn)
        group.add(add_shift_row)

        box.append(group)
        box.append(self.level_bar)
        
        # Averages Section
        avg_group = Adw.PreferencesGroup(title="Averages")
        
        # Timeframe selector for averages
        avg_timeframe_row = Adw.ActionRow(title="Calculate over", subtitle="Select time period for averages")
        avg_timeframe_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        self.avg_count = Gtk.SpinButton.new_with_range(1, 365, 1)
        self.avg_count.set_value(4)
        self.avg_count.connect("value-changed", self.on_avg_timeframe_changed)
        self.avg_unit = Gtk.DropDown.new_from_strings(["Days", "Weeks", "Months", "Year to Date"])
        self.avg_unit.connect("notify::selected", self.on_avg_timeframe_changed)
        avg_timeframe_box.append(self.avg_count)
        avg_timeframe_box.append(self.avg_unit)
        avg_timeframe_row.add_suffix(avg_timeframe_box)
        avg_group.add(avg_timeframe_row)
        
        # Include holidays switch
        self.include_holidays_row = Adw.ActionRow(title="Include Holidays", subtitle="Treat off-days as worked hours (7.2h) for averages")
        self.include_holidays_switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.include_holidays_switch.set_active(False)
        self.include_holidays_switch.connect("state-set", self.on_avg_timeframe_changed)
        self.include_holidays_row.add_suffix(self.include_holidays_switch)
        avg_group.add(self.include_holidays_row)
        
        # Average daily hours
        self.avg_daily_row = Adw.ActionRow(title="Avg. Daily Hours", subtitle="0.0 hours")
        avg_group.add(self.avg_daily_row)
        
        # Average weekly hours
        self.avg_weekly_row = Adw.ActionRow(title="Avg. Weekly Hours", subtitle="0.0 hours")
        avg_group.add(self.avg_weekly_row)
        
        # Overtime Balance
        self.overtime_balance_row = Adw.ActionRow(title="Overtime Balance", subtitle="0.0 hours")
        avg_group.add(self.overtime_balance_row)
        
        box.append(avg_group)
        
        # Graph Section
        graph_group = Adw.PreferencesGroup(title="Trends")
        
        # Timeframe Selector
        row_timeframe = Adw.ActionRow(title="Show Last", subtitle="Number and unit of time periods")
        timeframe_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        self.timeframe_count = Gtk.SpinButton.new_with_range(1, 365, 1)
        self.timeframe_count.set_value(7)
        self.timeframe_count.connect("value-changed", self.on_timeframe_changed)
        self.timeframe_unit = Gtk.DropDown.new_from_strings(["Days", "Weeks", "Months"])
        self.timeframe_unit.connect("notify::selected", self.on_timeframe_changed)
        timeframe_box.append(self.timeframe_count)
        timeframe_box.append(self.timeframe_unit)
        row_timeframe.add_suffix(timeframe_box)
        graph_group.add(row_timeframe)
        
        # Bar Granularity Selector
        row_granularity = Adw.ActionRow(title="Group By", subtitle="How to aggregate data in bars")
        self.bar_granularity = Gtk.DropDown.new_from_strings(["Day", "Week", "Month"])
        self.bar_granularity.connect("notify::selected", self.on_granularity_changed)
        row_granularity.add_suffix(self.bar_granularity)
        graph_group.add(row_granularity)

        self.graph = GraphView()
        self.graph.set_size_request(-1, 400) # Ensure it has height
        graph_group.add(self.graph)
        box.append(graph_group)
        
        # History Group
        self.history_group = Adw.PreferencesGroup(title="Recent Shifts")
        box.append(self.history_group)
        
        page_main.set_child(box)
        self.view_stack.add_titled_with_icon(page_main, "dashboard", "Dashboard", "appointment-new-symbolic")
        
        # Settings Page
        self.setup_settings_page()
        
        self.set_content(self.main_box)
        self.refresh_stats()
        self.refresh_averages()

    def setup_settings_page(self):
        page_settings = Adw.StatusPage(title="Settings", icon_name="emblem-system-symbolic")
        
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_top(32)
        box.set_margin_bottom(32)
        box.set_margin_start(32)
        box.set_margin_end(32)
        
        server_group = Adw.PreferencesGroup(title="Server Integration")
        
        # Server URL
        self.server_url_row = Adw.EntryRow(title="Server URL")
        self.server_url_row.set_text(get_config("server_url") or "")
        self.server_url_row.connect("changed", self.on_setting_changed, "server_url")
        server_group.add(self.server_url_row)
        
        # API Key
        self.api_key_row = Adw.PasswordEntryRow(title="API Key")
        self.api_key_row.set_text(get_config("api_key") or "")
        self.api_key_row.connect("changed", self.on_setting_changed, "api_key")
        server_group.add(self.api_key_row)
        
        # User ID
        self.user_id_row = Adw.EntryRow(title="User ID")
        self.user_id_row.set_text(get_config("user_id") or "")
        self.user_id_row.connect("changed", self.on_setting_changed, "user_id")
        server_group.add(self.user_id_row)
        
        box.append(server_group)
        
        page_settings.set_child(box)
        self.view_stack.add_titled_with_icon(page_settings, "settings", "Settings", "emblem-system-symbolic")

    def on_setting_changed(self, entry, key):
        set_config(key, entry.get_text())
        
    def on_export_clicked(self, _):
        dialog = Gtk.FileDialog(title="Save CSV")
        dialog.save(self, None, self.on_export_dialog_ready)

    def on_export_dialog_ready(self, dialog, result):
        try:
            file = dialog.save_finish(result)
            if file:
                export_to_csv(file.get_path())
        except Exception as e:
            print(f"Export failed: {e}")

    def on_timeframe_changed(self, *args):
        count = int(self.timeframe_count.get_value())
        unit_idx = self.timeframe_unit.get_selected()
        granularity_idx = self.bar_granularity.get_selected()
        
        unit_map = ["days", "weeks", "months"]
        granularity_map = ["day", "week", "month"]
        
        include_holidays = getattr(self, 'include_holidays_switch', None)
        inc_hols = include_holidays.get_active() if include_holidays else False
        
        self.graph.refresh(timeframe_unit=unit_map[unit_idx], timeframe_count=count, 
                          granularity=granularity_map[granularity_idx], include_holidays=inc_hols)
    
    def on_granularity_changed(self, *args):
        self.on_timeframe_changed()

    def on_avg_timeframe_changed(self, *args):
        unit_idx = self.avg_unit.get_selected()
        if unit_idx == 3:  # Year to Date
            self.avg_count.set_visible(False)
        else:
            self.avg_count.set_visible(True)
        self.refresh_averages()
        self.on_timeframe_changed()

    def refresh_averages(self):
        shifts = get_all_shifts()
        off_days = get_off_days()
        now = datetime.now()
        
        # End of calculation period is end of last week (Saturday 23:59:59)
        # Week starts on Sunday (to match graph using %U)
        # Current week is excluded as it's not complete
        days_since_sunday = (now.weekday() + 1) % 7  # Sunday = 0
        end_of_last_week = now - timedelta(days=days_since_sunday + 1)
        end_of_last_week = end_of_last_week.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        count = int(self.avg_count.get_value())
        unit_idx = self.avg_unit.get_selected()
        include_holidays = self.include_holidays_switch.get_active()
        
        # Calculate start date based on selection (going back from end of last week)
        if unit_idx == 0:  # Days
            start_date = end_of_last_week - timedelta(days=count - 1)
        elif unit_idx == 1:  # Weeks
            start_date = end_of_last_week - timedelta(weeks=count) + timedelta(days=1)
        elif unit_idx == 2:  # Months
            start_date = end_of_last_week - timedelta(days=count * 30)
        else:  # Year to Date (but still excluding current week)
            start_date = datetime(now.year, 1, 1)
        
        start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Collect hours per day and per week
        hours_per_day = {}  # date_str -> hours
        hours_per_week = {}  # week_key -> hours
        
        # Track actual hours worked for Overtime calculation
        total_actual_hours = 0
        
        first_shift_date = None
        for shift in shifts:
            st = datetime.fromisoformat(shift['start_time'])
            if first_shift_date is None or st < first_shift_date:
                first_shift_date = st
                
        if first_shift_date:
            first_shift_date = first_shift_date.replace(hour=0, minute=0, second=0, microsecond=0)
        
        for shift in shifts:
            start = datetime.fromisoformat(shift['start_time'])
            end = datetime.fromisoformat(shift['end_time']) if shift['end_time'] else None
            
            # Skip shifts without end time (active) or outside our period
            if end is None:
                continue
            if start < start_date or start > end_of_last_week:
                continue
                
            duration_hours = (end - start).total_seconds() / 3600
            total_actual_hours += duration_hours
            
            # Add to daily total
            day_str = start.strftime("%Y-%m-%d")
            hours_per_day[day_str] = hours_per_day.get(day_str, 0) + duration_hours
            
            # Add to weekly total (week key = year-week number, %U = Sunday start)
            week_key = start.strftime("%Y-W%U")
            hours_per_week[week_key] = hours_per_week.get(week_key, 0) + duration_hours

        # Process expected hours and holidays
        expected_hours = 0
        current_day = start_date
        
        # Start expected hours calculation from the first shift date if it's later than start_date
        if first_shift_date and current_day < first_shift_date:
            current_day = first_shift_date
            
        while current_day <= end_of_last_week:
            # Monday to Friday (0 to 4)
            if current_day.weekday() < 5:
                day_str = current_day.strftime("%Y-%m-%d")
                is_off_day = day_str in off_days
                
                if not is_off_day:
                    expected_hours += 7.2
                else:
                    # It's an off day during the week
                    if include_holidays:
                        # Add virtual hours for the average calculation
                        hours_per_day[day_str] = hours_per_day.get(day_str, 0) + 7.2
                        week_key = current_day.strftime("%Y-W%U")
                        hours_per_week[week_key] = hours_per_week.get(week_key, 0) + 7.2
            
            current_day += timedelta(days=1)
        
        # Calculate averages based on days/weeks actually worked (plus holidays if toggled)
        days_worked = len(hours_per_day)
        weeks_worked = len(hours_per_week)
        total_hours_for_avg = sum(hours_per_day.values())
        
        avg_daily = total_hours_for_avg / days_worked if days_worked > 0 else 0
        avg_weekly = total_hours_for_avg / weeks_worked if weeks_worked > 0 else 0
        
        # Overtime Balance calculation
        # Compare actual worked hours against the expected hours (excluding holidays)
        overtime_balance = total_actual_hours - expected_hours
        
        # Update UI
        self.avg_daily_row.set_subtitle(f"{avg_daily:.2f} hours")
        self.avg_weekly_row.set_subtitle(f"{avg_weekly:.2f} hours")
        sign = "+" if overtime_balance > 0 else ""
        self.overtime_balance_row.set_subtitle(f"{sign}{overtime_balance:.2f} hours")

    def on_add_shift_clicked(self, _):
        dialog = Gtk.Window(title="Add Shift Manually", transient_for=self, modal=True, default_width=400, default_height=300)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=15)
        box.set_margin_top(20)
        box.set_margin_bottom(20)
        box.set_margin_start(20)
        box.set_margin_end(20)
        
        # Instructions
        instructions = Gtk.Label(label="Enter the date and times for the shift you want to add")
        instructions.set_wrap(True)
        box.append(instructions)
        
        # Date input
        date_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        date_label = Gtk.Label(label="Date:")
        date_label.set_width_chars(15)
        date_label.set_xalign(0)
        date_entry = Gtk.Entry()
        date_entry.set_placeholder_text("YYYY-MM-DD")
        date_entry.set_text(datetime.now().strftime("%Y-%m-%d"))
        date_row.append(date_label)
        date_row.append(date_entry)
        box.append(date_row)
        
        # Start time input
        start_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        start_label = Gtk.Label(label="Start Time:")
        start_label.set_width_chars(15)
        start_label.set_xalign(0)
        start_entry = Gtk.Entry()
        start_entry.set_placeholder_text("HH:MM")
        start_row.append(start_label)
        start_row.append(start_entry)
        box.append(start_row)
        
        # End time input
        end_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        end_label = Gtk.Label(label="End Time:")
        end_label.set_width_chars(15)
        end_label.set_xalign(0)
        end_entry = Gtk.Entry()
        end_entry.set_placeholder_text("HH:MM")
        end_row.append(end_label)
        end_row.append(end_entry)
        box.append(end_row)
        
        # Status label
        status_label = Gtk.Label(label="")
        status_label.set_wrap(True)
        box.append(status_label)
        
        # Buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        btn_box.set_halign(Gtk.Align.CENTER)
        
        add_btn = Gtk.Button(label="Add Shift")
        def on_add(_):
            try:
                date_str = date_entry.get_text().strip()
                start_time_str = start_entry.get_text().strip()
                end_time_str = end_entry.get_text().strip()
                
                # Validate and construct datetime strings
                datetime.strptime(date_str, "%Y-%m-%d")  # Validate date format
                datetime.strptime(start_time_str, "%H:%M")  # Validate time format
                datetime.strptime(end_time_str, "%H:%M")  # Validate time format
                
                start_datetime = f"{date_str}T{start_time_str}:00"
                end_datetime = f"{date_str}T{end_time_str}:00"
                
                # Validate that end is after start
                start_dt = datetime.fromisoformat(start_datetime)
                end_dt = datetime.fromisoformat(end_datetime)
                if end_dt <= start_dt:
                    status_label.set_text("Error: End time must be after start time")
                    return
                
                add_shift_manual(start_datetime, end_datetime)
                self.refresh_stats()
                self.on_timeframe_changed()
                status_label.set_text("Shift added successfully!")
                
                # Clear inputs
                start_entry.set_text("")
                end_entry.set_text("")
            except ValueError as e:
                status_label.set_text(f"Error: Invalid format. Use YYYY-MM-DD and HH:MM")
            except Exception as e:
                status_label.set_text(f"Error: {e}")
        
        add_btn.connect("clicked", on_add)
        btn_box.append(add_btn)
        
        close_btn = Gtk.Button(label="Close")
        close_btn.connect("clicked", lambda _: dialog.close())
        btn_box.append(close_btn)
        
        box.append(btn_box)
        dialog.set_child(box)
        dialog.present()

    def on_calendar_clicked(self, _):
        dialog = Gtk.Window(title="Manage Off Days", transient_for=self, modal=True, default_width=400, default_height=450)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_margin_start(10)
        box.set_margin_end(10)
        
        calendar = Gtk.Calendar()
        
        # Mark off days in calendar
        off_days = get_off_days()
        for od in off_days:
            try:
                od_dt = datetime.strptime(od, "%Y-%m-%d")
                calendar.mark_day(od_dt.day)
            except:
                pass
        
        box.append(calendar)
        
        # Range selection state
        range_state = {"start": None, "end": None}
        
        # Status label
        status_label = Gtk.Label(label="Click a date to toggle single day, or click two dates to select a range")
        status_label.set_wrap(True)
        box.append(status_label)
        
        # Date range display
        date_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        date_box.set_halign(Gtk.Align.CENTER)
        start_label = Gtk.Label(label="Start: --")
        end_label = Gtk.Label(label="End: --")
        date_box.append(start_label)
        date_box.append(Gtk.Label(label=" → "))
        date_box.append(end_label)
        box.append(date_box)
        
        # Calendar day selected handler
        def on_day_selected(cal):
            dt = cal.get_date()
            date_str = dt.format("%Y-%m-%d")
            
            if range_state["start"] is None:
                # First click - set start
                range_state["start"] = date_str
                range_state["end"] = None
                start_label.set_text(f"Start: {date_str}")
                end_label.set_text("End: --")
                status_label.set_text("Click another date to complete the range, or click 'Toggle' for single day")
            elif range_state["end"] is None and date_str != range_state["start"]:
                # Second click - set end
                range_state["end"] = date_str
                end_label.set_text(f"End: {date_str}")
                status_label.set_text("Range selected! Click 'Toggle Range' to apply")
            else:
                # Reset and start new selection
                range_state["start"] = date_str
                range_state["end"] = None
                start_label.set_text(f"Start: {date_str}")
                end_label.set_text("End: --")
                status_label.set_text("Click another date to complete the range, or click 'Toggle' for single day")
        
        calendar.connect("day-selected", on_day_selected)
        
        # Buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        btn_box.set_halign(Gtk.Align.CENTER)
        
        toggle_single_btn = Gtk.Button(label="Toggle Single Day")
        def on_toggle_single(_):
            if range_state["start"]:
                current_off_days = get_off_days()
                date_str = range_state["start"]
                try:
                    dt = datetime.strptime(date_str, "%Y-%m-%d")
                    if date_str in current_off_days:
                        remove_off_day(date_str)
                        calendar.unmark_day(dt.day)
                    else:
                        add_off_day(date_str)
                        calendar.mark_day(dt.day)
                    self.refresh_stats()
                    self.on_timeframe_changed()
                    status_label.set_text(f"Toggled {date_str}")
                except Exception as e:
                    status_label.set_text(f"Error: {e}")
        
        toggle_single_btn.connect("clicked", on_toggle_single)
        btn_box.append(toggle_single_btn)
        
        toggle_range_btn = Gtk.Button(label="Toggle Range")
        def on_toggle_range(_):
            if range_state["start"] and range_state["end"]:
                try:
                    start = datetime.strptime(range_state["start"], "%Y-%m-%d")
                    end = datetime.strptime(range_state["end"], "%Y-%m-%d")
                    
                    # Ensure start < end
                    if start > end:
                        start, end = end, start
                    
                    current = start
                    count = 0
                    while current <= end:
                        date_str = current.strftime("%Y-%m-%d")
                        current_off_days = get_off_days()
                        if date_str in current_off_days:
                            remove_off_day(date_str)
                            calendar.unmark_day(current.day)
                        else:
                            add_off_day(date_str)
                            calendar.mark_day(current.day)
                        current += timedelta(days=1)
                        count += 1
                    
                    self.refresh_stats()
                    self.on_timeframe_changed()
                    status_label.set_text(f"Toggled {count} days")
                    
                    # Reset selection
                    range_state["start"] = None
                    range_state["end"] = None
                    start_label.set_text("Start: --")
                    end_label.set_text("End: --")
                except Exception as e:
                    status_label.set_text(f"Error: {e}")
            else:
                status_label.set_text("Please select both start and end dates")
        
        toggle_range_btn.connect("clicked", on_toggle_range)
        btn_box.append(toggle_range_btn)
        
        close_btn = Gtk.Button(label="Close")
        close_btn.connect("clicked", lambda _: dialog.close())
        btn_box.append(close_btn)
        
        box.append(btn_box)
        dialog.set_child(box)
        dialog.present()

    def refresh_stats(self):
        shifts = get_all_shifts()
        off_days = get_off_days()
        now = datetime.now()
        start_of_week = now - timedelta(days=now.weekday())
        start_of_week = start_of_week.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_week = start_of_week + timedelta(days=6, hours=23, minutes=59, seconds=59)
        
        weekly_seconds = 0
        off_days_this_week = 0
        
        for od in off_days:
            od_dt = datetime.strptime(od, "%Y-%m-%d")
            if start_of_week <= od_dt <= end_of_week:
                off_days_this_week += 1
                
        # Target calculation: 36h per week, assume 5 working days normally.
        # If one day is off, reduce target by 7.2 hours.
        weekly_target = 36.0 - (off_days_this_week * 7.2)
        weekly_target = max(0, weekly_target)
        
        for shift in shifts:
            start = datetime.fromisoformat(shift['start_time'])
            end = datetime.fromisoformat(shift['end_time']) if shift['end_time'] else datetime.now()
            duration = (end - start).total_seconds()
            
            if start >= start_of_week:
                weekly_seconds += duration
                
        weekly_hours = weekly_seconds / 3600
        self.weekly_label.set_title(f"Worked this week (Target: {weekly_target:.1f}h)")
        self.weekly_label.set_subtitle(f"{weekly_hours:.2f} hours")
        # Set level bar max to the actual weekly target (adjusted for off days)
        self.level_bar.set_max_value(max(weekly_target, weekly_hours) if weekly_target > 0 else max(36.0, weekly_hours))
        self.level_bar.set_value(weekly_hours)
        
        # Add a custom target marker or just use colors
        # For now, let's just update the label.
        for row in self.history_rows:
            self.history_group.remove(row)
        self.history_rows = []

        # Combine shifts and off days for history
        history_items = []
        for s in shifts:
            start = datetime.fromisoformat(s['start_time'])
            end = datetime.fromisoformat(s['end_time']) if s['end_time'] else None
            history_items.append(('shift', start, end, s['id']))
        
        for od in off_days:
            dt = datetime.strptime(od, "%Y-%m-%d")
            history_items.append(('off', dt, None, None))
            
        history_items.sort(key=lambda x: x[1], reverse=True)

        for item_type, start, end, shift_id in history_items[:10]: # Show last 10
            row = Adw.ActionRow()
            row.set_title(start.strftime("%A, %b %d"))
            
            if item_type == 'shift':
                if end:
                    duration = (end - start).total_seconds() / 3600
                    row.set_subtitle(f"{start.strftime('%H:%M')} - {end.strftime('%H:%M')} ({duration:.2f}h)")
                else:
                    row.set_subtitle(f"{start.strftime('%H:%M')} - Now (Active)")
                
                # Add delete button for shifts
                delete_btn = Gtk.Button()
                delete_btn.set_icon_name("user-trash-symbolic")
                delete_btn.set_valign(Gtk.Align.CENTER)
                delete_btn.set_tooltip_text("Delete this shift")
                delete_btn.add_css_class("destructive-action")
                
                def on_delete(btn, sid=shift_id):
                    delete_shift(sid)
                    self.refresh_stats()
                
                delete_btn.connect("clicked", on_delete)
                row.add_suffix(delete_btn)
            else:
                row.set_subtitle("Day Off / Holiday")
                row.add_prefix(Gtk.Image.new_from_icon_name("calendar-ignore-symbolic"))
            
            self.history_group.add(row)
            self.history_rows.append(row)
