import argparse
import sys
from .database import init_db, start_shift, end_shift, get_active_shift
from .notifications import send_notification

def handle_toggle():
    init_db()
    active = get_active_shift()
    if active:
        if end_shift():
            send_notification("Clocked Out", "You have finished your shift.")
        else:
            print("Failed to end shift.")
    else:
        if start_shift():
            send_notification("Clocked In", "Your shift has started.")
        else:
            print("Failed to start shift.")

def main():
    parser = argparse.ArgumentParser(description="Work Time App CLI")
    parser.add_argument("--toggle", action="store_true", help="Toggle clock-in/out")
    parser.add_argument("--status", action="store_true", help="Show current status")
    
    args = parser.parse_args()
    
    if args.toggle:
        handle_toggle()
    elif args.status:
        init_db()
        active = get_active_shift()
        if active:
            print(f"Active shift since {active['start_time']}")
        else:
            print("No active shift.")
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
