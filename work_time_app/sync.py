import requests
import threading
from .database import get_all_shifts, get_off_days, get_config, set_config
from datetime import datetime

class SyncManager:
    def __init__(self):
        self.server_url = get_config("server_url")
        self.api_key = get_config("api_key")
        self.user_id = get_config("user_id")

    def is_configured(self):
        return all([self.server_url, self.api_key, self.user_id])

    def sync(self):
        if not self.is_configured():
            return False

        try:
            headers = {"X-API-KEY": self.api_key}
            user_id = int(self.user_id)
            
            # 1. Sync Shifts
            shifts = get_all_shifts()
            response = requests.get(f"{self.server_url}/shifts/?user_id={user_id}", headers=headers)
            response.raise_for_status()
            
            server_shifts = response.json()
            server_start_times = {s["start_time"] for s in server_shifts}
            
            for local_shift in shifts:
                if local_shift["start_time"] not in server_start_times:
                    payload = {
                        "user_id": user_id,
                        "start_time": local_shift["start_time"],
                        "end_time": local_shift["end_time"]
                    }
                    resp = requests.post(f"{self.server_url}/shifts/", json=payload, headers=headers)
                    resp.raise_for_status()

            # 2. Sync Off-Days
            off_days = get_off_days()
            response = requests.get(f"{self.server_url}/off-days/?user_id={user_id}", headers=headers)
            response.raise_for_status()
            
            server_off_days = response.json()
            server_dates = {d["date"] for d in server_off_days}
            
            for local_date in off_days:
                if local_date not in server_dates:
                    payload = {
                        "user_id": user_id,
                        "date": local_date
                    }
                    resp = requests.post(f"{self.server_url}/off-days/", json=payload, headers=headers)
                    resp.raise_for_status()

            set_config("last_synced_at", datetime.now().isoformat())
            return True
        except requests.exceptions.RequestException as e:
            print(f"Sync failed: {e}")
            return False

    def sync_background(self, callback=None):
        """Runs the sync process in a separate thread."""
        def run():
            success = self.sync()
            if callback:
                callback(success)
        
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread
