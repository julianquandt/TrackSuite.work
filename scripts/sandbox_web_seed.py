#!/usr/bin/env python3
"""Sandbox account for scripts/sandbox-web.sh — LOCAL TEST SERVER ONLY.

First run: registers a test account on the local server, enrols its
authenticator (the secret is kept in the sandbox folder), and adds sample data:
projects, a week of shifts with notes, an off day with a reason, a schedule.
Every run: signs in and prints a dev-login URL that hands the session to the
web app (that route only exists in the Vite dev server).

Usage: sandbox_web_seed.py <sandbox-dir> [base-url]
"""
import datetime as dt
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pyotp

SANDBOX = Path(sys.argv[1])
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8007"
ACCOUNT = SANDBOX / "account.json"
EMAIL, PASSWORD = "sandbox@example.com", "sandbox-password-123"


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def login(secret):
    status, data = call("POST", "/auth/login", {
        "email": EMAIL, "password": PASSWORD, "otp": pyotp.TOTP(secret).now(), "device_name": "sandbox",
    })
    if status != 200:
        sys.exit(f"Sandbox login failed ({status}): {data}")
    return data


def create_account():
    status, reg = call("POST", "/auth/register", {"email": EMAIL, "password": PASSWORD})
    if status != 201:
        sys.exit(f"Could not create the sandbox account ({status}): {reg}\n"
                 f"Start fresh with: scripts/sandbox-web.sh reset")
    secret = reg["totp_secret"]
    status, enrol = call("POST", "/auth/mfa/confirm-enrollment", {
        "email": EMAIL, "password": PASSWORD, "otp": pyotp.TOTP(secret).now(), "device_name": "sandbox",
    })
    if status != 200:
        sys.exit(f"Could not enrol the sandbox account ({status}): {enrol}")
    ACCOUNT.write_text(json.dumps({"email": EMAIL, "totp_secret": secret}))
    return secret


def seed(token):
    _, a = call("POST", "/projects/", {"name": "Client A", "color": "#3b82f6"}, token)
    _, b = call("POST", "/projects/", {"name": "Internal", "color": "#10b981"}, token)
    _, c = call("POST", "/projects/", {"name": "Research", "color": "#f59e0b"}, token)
    today = dt.date.today()

    def at(day, h, m=0):
        return f"{day.isoformat()}T{h:02d}:{m:02d}:00"

    # The last 7 days (today only up to the morning, so nothing is in the future).
    for back in range(7, 0, -1):
        day = today - dt.timedelta(days=back)
        if day.weekday() >= 5:
            continue
        call("POST", "/shifts/", {"start_time": at(day, 8, 30), "end_time": at(day, 10, 45), "project_uuid": a["uuid"], "note": "client work", "started_from": "web"}, token)
        call("POST", "/shifts/", {"start_time": at(day, 10, 45), "end_time": at(day, 12, 15), "project_uuid": b["uuid"], "started_from": "web"}, token)
        call("POST", "/shifts/", {"start_time": at(day, 13), "end_time": at(day, 16, 30), "project_uuid": None, "started_from": "web"}, token)
        if back % 3 == 0:
            call("POST", "/shifts/", {"start_time": at(day, 16, 30), "end_time": at(day, 17, 30), "project_uuid": c["uuid"], "note": "reading", "started_from": "web"}, token)
    call("POST", "/shifts/", {"start_time": at(today, 7), "end_time": at(today, 8), "project_uuid": a["uuid"], "started_from": "web"}, token)
    call("POST", "/off-days/", {"date": (today + dt.timedelta(days=3)).isoformat(), "reason": "vacation"}, token)
    call("PUT", "/work-schedule/", {"schedule": {"mon": 8, "tue": 8, "wed": 8, "thu": 8, "fri": 6, "sat": 0, "sun": 0}}, token)


def main():
    SANDBOX.mkdir(parents=True, exist_ok=True)
    if ACCOUNT.exists():
        secret = json.loads(ACCOUNT.read_text())["totp_secret"]
        session = login(secret)
    else:
        secret = create_account()
        session = login(secret)
        seed(session["access_token"])
        print("Created the sandbox account with sample data.", file=sys.stderr)
    query = urllib.parse.urlencode({"access": session["access_token"], "refresh": session["refresh_token"], "mode": "full"})
    print(f"#/dev-login?{query}")


if __name__ == "__main__":
    main()
