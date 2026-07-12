import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
gi.require_version('WebKit', '6.0')
from gi.repository import WebKit, Gtk, Adw
import json
from datetime import datetime, timedelta
from ..database import get_all_shifts, get_off_days

def get_graph_html(data_labels, data_values, off_days_indices, include_holidays=False):
    bg_color_off = "'rgba(46, 204, 113, 0.5)'" if include_holidays else "'rgba(231, 76, 60, 0.5)'"
    border_color_off = "'rgba(46, 204, 113, 1)'" if include_holidays else "'rgba(231, 76, 60, 1)'"
    
    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
            body {{ font-family: sans-serif; background: #f6f6f6; }}
            canvas {{ max-width: 100%; height: 400px; }}
        </style>
    </head>
    <body>
        <canvas id="workChart"></canvas>
        <script>
            const ctx = document.getElementById('workChart').getContext('2d');
            const offIndices = {json.dumps(off_days_indices)};
            
            new Chart(ctx, {{
                type: 'bar',
                data: {{
                    labels: {json.dumps(data_labels)},
                    datasets: [{{
                        label: 'Hours Worked',
                        data: {json.dumps(data_values)},
                        backgroundColor: {json.dumps(data_labels)}.map((_, i) => 
                            offIndices.includes(i) ? {bg_color_off} : 'rgba(52, 152, 219, 0.5)'
                        ),
                        borderColor: {json.dumps(data_labels)}.map((_, i) => 
                            offIndices.includes(i) ? {border_color_off} : 'rgba(52, 152, 219, 1)'
                        ),
                        borderWidth: 1
                    }}]
                }},
                options: {{
                    scales: {{
                        y: {{ beginAtZero: true, title: {{ display: true, text: 'Hours' }} }}
                    }}
                }}
            }});
        </script>
    </body>
    </html>
    """

class GraphView(Gtk.Box):
    def __init__(self):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.webview = WebKit.WebView()
        self.webview.set_hexpand(True)
        self.webview.set_vexpand(True)
        self.append(self.webview)
        self.refresh()

    def refresh(self, timeframe_unit="days", timeframe_count=7, granularity="day", include_holidays=False):
        shifts = get_all_shifts()
        off_days = get_off_days()
        data = {}
        now = datetime.now()
        
        # Determine the time range to query
        if timeframe_unit == "days":
            start_date = now - timedelta(days=timeframe_count)
        elif timeframe_unit == "weeks":
            start_date = now - timedelta(weeks=timeframe_count)
        elif timeframe_unit == "months":
            start_date = now - timedelta(days=timeframe_count*30)
        else:
            start_date = now - timedelta(days=7)
        
        # Filter shifts within range
        relevant_shifts = [s for s in shifts 
                          if datetime.fromisoformat(s['start_time']) >= start_date]
        
        # Group by granularity
        if granularity == "day":
            # Create buckets for each day in range
            current = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
            while current <= now:
                key = current.strftime('%Y-%m-%d')
                data[key] = 0
                if include_holidays and key in off_days and current.weekday() < 5:
                    data[key] += 7.2
                current += timedelta(days=1)
            
            for s in relevant_shifts:
                date_str = datetime.fromisoformat(s['start_time']).strftime('%Y-%m-%d')
                if date_str in data:
                    end = datetime.fromisoformat(s['end_time']) if s['end_time'] else datetime.now()
                    data[date_str] += (end - datetime.fromisoformat(s['start_time'])).total_seconds() / 3600
        
        elif granularity == "week":
            current = start_date
            weeks_seen = set()
            while current <= now:
                week_key = current.strftime('%Y-W%U')
                if week_key not in weeks_seen:
                    data[week_key] = 0
                    weeks_seen.add(week_key)
                
                if include_holidays and current.strftime('%Y-%m-%d') in off_days and current.weekday() < 5:
                    data[week_key] += 7.2
                    
                current += timedelta(days=1)
            
            for s in relevant_shifts:
                week_key = datetime.fromisoformat(s['start_time']).strftime('%Y-W%U')
                if week_key in data:
                    end = datetime.fromisoformat(s['end_time']) if s['end_time'] else datetime.now()
                    data[week_key] += (end - datetime.fromisoformat(s['start_time'])).total_seconds() / 3600
        
        elif granularity == "month":
            current = start_date
            months_seen = set()
            while current <= now:
                month_key = current.strftime('%Y-%m')
                if month_key not in months_seen:
                    data[month_key] = 0
                    months_seen.add(month_key)
                
                if include_holidays and current.strftime('%Y-%m-%d') in off_days and current.weekday() < 5:
                    data[month_key] += 7.2
                    
                current += timedelta(days=1)
            
            for s in relevant_shifts:
                month_key = datetime.fromisoformat(s['start_time']).strftime('%Y-%m')
                if month_key in data:
                    end = datetime.fromisoformat(s['end_time']) if s['end_time'] else datetime.now()
                    data[month_key] += (end - datetime.fromisoformat(s['start_time'])).total_seconds() / 3600
        
        labels = sorted(data.keys())
        values = [round(data[l], 2) for l in labels]
        
        # Calculate which bars contain off days
        off_days_indices = []
        if granularity == "day":
            for i, label in enumerate(labels):
                if label in off_days:
                    off_days_indices.append(i)
        
        html = get_graph_html(labels, values, off_days_indices, include_holidays)
        self.webview.load_html(html, None)
