"""Administrative CLI — manage accounts from the server's terminal.

The reason this exists: a self-hosted instance can run with web signup switched
off entirely (``WORK_TIME_SIGNUP_MODE=closed``), which is the sane default for a
single-user deployment. The account then has to come from somewhere, and that
somewhere is here.

Run it from the deployment directory with the service's virtualenv, and with the
same environment the service uses (``WORK_TIME_ENCRYPTION_KEY`` above all — the
email and TOTP secret are encrypted at rest, so the wrong key makes the account
unusable)::

    cd /opt/work-time-app
    sudo -u www-data env $(grep -v '^#' /etc/work-time-backend.env | xargs) \\
        ./venv_server/bin/python -m app_server.cli create-user --email me@example.com

Commands: create-user, list-users, delete-user, reset-password, reset-2fa,
recovery-codes.
"""

from __future__ import annotations

import argparse
import getpass
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from typing import Optional

# The maintenance sweep is a service concern; a short-lived CLI must not start
# a background timer thread. Set before importing main, which starts it at
# import time.
os.environ.setdefault("WORK_TIME_DISABLE_MAINTENANCE", "1")

from .auth import (  # noqa: E402  (import after the env guard above, deliberately)
    build_totp_uri,
    encrypt_secret,
    generate_totp_secret,
    hash_email,
    hash_password,
)
from . import main as server  # noqa: E402
from .models import ApiKey, Shift, User, UserSession  # noqa: E402


# ── Terminal helpers ─────────────────────────────────────────────────

def _print_header(title: str) -> None:
    print()
    print(title)
    print("─" * len(title))


def _prompt_password(confirm: bool = True) -> str:
    while True:
        password = getpass.getpass("Password (min 8 chars): ")
        if len(password) < 8:
            print("  Too short — at least 8 characters.", file=sys.stderr)
            continue
        if confirm and password != getpass.getpass("Repeat password: "):
            print("  Passwords did not match.", file=sys.stderr)
            continue
        return password


def _print_qr(uri: str) -> bool:
    """Render the otpauth URI as a QR code in the terminal, if we can.

    Tries the ``qrcode`` Python package, then the ``qrencode`` binary. Both are
    optional — neither is a dependency of the server — and the manual secret
    printed alongside always works, so failure here is not an error.
    """
    try:
        import qrcode  # type: ignore

        qr = qrcode.QRCode(border=1)
        qr.add_data(uri)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
        return True
    except Exception:
        pass

    if shutil.which("qrencode"):
        try:
            subprocess.run(["qrencode", "-t", "ANSIUTF8", uri], check=True)
            return True
        except subprocess.SubprocessError:
            pass
    return False


def _print_enrollment(email: str, secret: str, recovery_codes: list[str]) -> None:
    uri = build_totp_uri(secret, email)

    _print_header(f"Two-factor setup for {email}")
    if not _print_qr(uri):
        print("(No QR renderer available — install `qrencode` or `pip install qrcode`,")
        print(" or just type the setup key below into your authenticator app.)")
        print()
    print(f"  Setup key : {secret}")
    print(f"  otpauth   : {uri}")
    print()
    print("  Add it in Google Authenticator / 1Password / Aegis / Bitwarden etc.")
    print("  ('Enter a setup key' if you can't scan the QR code.)")

    _print_header("Recovery codes — store these offline, each works once")
    for index in range(0, len(recovery_codes), 2):
        print("   " + "   ".join(recovery_codes[index:index + 2]))
    print()
    print("  They are shown ONCE. Sign in with one if the authenticator is lost.")
    print()


def _find_user(db, email: str) -> Optional[User]:
    return db.query(User).filter(User.email_hash == hash_email(email)).first()


# ── Commands ─────────────────────────────────────────────────────────

def cmd_create_user(args: argparse.Namespace) -> int:
    email = args.email.strip().lower()
    password = args.password or _prompt_password()
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 1

    with server.SessionLocal() as db:
        if _find_user(db, email) is not None:
            print(f"An account for {email} already exists. "
                  f"Use reset-password / reset-2fa, or delete-user first.", file=sys.stderr)
            return 1

        secret = generate_totp_secret()
        now = server.to_iso(server.utcnow())
        # Created straight into the fully-active state: enrolled and verified.
        # There is no email round-trip to complete — the operator standing at
        # this terminal *is* the proof of address ownership.
        user = User(
            email=email,
            email_hash=hash_email(email),
            password_hash=hash_password(password),
            totp_secret=encrypt_secret(secret),
            pending_totp_secret=None,
            mfa_enrolled_at=now,
            created_at=now,
            email_verified_at=now,
            tos_accepted_at=now,
            tos_version=server.CURRENT_TOS_VERSION,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        user_id = user.id
        recovery_codes = server.replace_recovery_codes(db, user_id)
        db.commit()

    print(f"\nCreated account #{user_id} for {email}.")
    _print_enrollment(email, secret, recovery_codes)
    return 0


def _parse_utc(value: Optional[str]) -> Optional[datetime]:
    """Parse a stored timestamp; a value without an offset is UTC."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _last_activity(db, user_id: int) -> Optional[datetime]:
    """Latest sign of use: a login refresh (web or app), a sync with an API
    key, or a change to the user's shifts. Reads only what is stored anyway."""
    stamps = [r[0] for r in db.query(UserSession.last_used_at).filter(UserSession.user_id == user_id)]
    stamps += [r[0] for r in db.query(ApiKey.last_used_at).filter(ApiKey.user_id == user_id)]
    stamps += [r[0] for r in db.query(Shift.updated_at).filter(Shift.user_id == user_id)]
    parsed = [dt for dt in map(_parse_utc, stamps) if dt]
    return max(parsed) if parsed else None


def cmd_list_users(args: argparse.Namespace) -> int:
    with server.SessionLocal() as db:
        users = db.query(User).order_by(User.id).all()
        if not users:
            print("No accounts on this instance.")
            return 0
        print(f"{'ID':>4}  {'EMAIL':<38} {'STATE':<12} {'CREATED':<19}  LAST ACTIVE (UTC)")
        for user in users:
            if user.mfa_enrolled_at and user.email_verified_at:
                state = "active"
            elif not user.mfa_enrolled_at:
                state = "no-2fa"
            else:
                state = "unverified"
            last = _last_activity(db, user.id)
            last_text = last.strftime("%Y-%m-%d %H:%M") if last else "never"
            print(f"{user.id:>4}  {user.email:<38} {state:<12} {(user.created_at or '')[:19]:<19}  {last_text}")
    return 0


def cmd_delete_user(args: argparse.Namespace) -> int:
    email = args.email.strip().lower()
    with server.SessionLocal() as db:
        user = _find_user(db, email)
        if user is None:
            print(f"No account for {email}.", file=sys.stderr)
            return 1
        user_id = user.id
        if not args.yes:
            print(f"This permanently deletes account #{user_id} ({email}) and ALL of its")
            print("shifts, projects, off-days, API keys and sessions. It cannot be undone.")
            if input("Type the email address to confirm: ").strip().lower() != email:
                print("Aborted.")
                return 1
        server.hard_delete_user(db, user_id)
    print(f"Deleted account #{user_id} ({email}).")
    return 0


def cmd_reset_password(args: argparse.Namespace) -> int:
    email = args.email.strip().lower()
    password = args.password or _prompt_password()
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 1
    with server.SessionLocal() as db:
        user = _find_user(db, email)
        if user is None:
            print(f"No account for {email}.", file=sys.stderr)
            return 1
        user.password_hash = hash_password(password)
        user.password_reset_hash = None
        user.password_reset_expires_at = None
        revoked = server.revoke_all_user_sessions(db, user.id)
        db.commit()
    print(f"Password updated for {email}. Signed out of {revoked} session(s).")
    return 0


def cmd_reset_2fa(args: argparse.Namespace) -> int:
    """Issue a fresh TOTP secret and recovery codes — the lost-phone escape hatch
    on an instance with no email configured."""
    email = args.email.strip().lower()
    with server.SessionLocal() as db:
        user = _find_user(db, email)
        if user is None:
            print(f"No account for {email}.", file=sys.stderr)
            return 1
        secret = generate_totp_secret()
        user.totp_secret = encrypt_secret(secret)
        user.pending_totp_secret = None
        user.mfa_enrolled_at = server.to_iso(server.utcnow())
        user.last_totp_step = None
        revoked = server.revoke_all_user_sessions(db, user.id)
        recovery_codes = server.replace_recovery_codes(db, user.id)
        db.commit()
    print(f"\nTwo-factor reset for {email}. Signed out of {revoked} session(s).")
    print("The old authenticator entry and old recovery codes no longer work.")
    _print_enrollment(email, secret, recovery_codes)
    return 0


def cmd_recovery_codes(args: argparse.Namespace) -> int:
    email = args.email.strip().lower()
    with server.SessionLocal() as db:
        user = _find_user(db, email)
        if user is None:
            print(f"No account for {email}.", file=sys.stderr)
            return 1
        recovery_codes = server.replace_recovery_codes(db, user.id)
        db.commit()
    _print_header(f"New recovery codes for {email} — the previous set is now void")
    for index in range(0, len(recovery_codes), 2):
        print("   " + "   ".join(recovery_codes[index:index + 2]))
    print()
    return 0


# ── Entry point ──────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app_server.cli",
        description="Manage TrackSuite accounts on this server.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def with_email(name: str, help_text: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text, description=help_text)
        sp.add_argument("--email", required=True, help="Account email address.")
        return sp

    create = with_email("create-user", "Create a fully active account with 2FA.")
    create.add_argument("--password", help="Password (prompted for if omitted — "
                                           "prefer the prompt so it stays out of shell history).")
    create.set_defaults(func=cmd_create_user)

    listing = sub.add_parser("list-users", help="List accounts on this instance.",
                             description="List accounts on this instance.")
    listing.set_defaults(func=cmd_list_users)

    delete = with_email("delete-user", "Permanently delete an account and all its data.")
    delete.add_argument("--yes", action="store_true", help="Skip the confirmation prompt.")
    delete.set_defaults(func=cmd_delete_user)

    pwd = with_email("reset-password", "Set a new password and sign the user out everywhere.")
    pwd.add_argument("--password", help="New password (prompted for if omitted).")
    pwd.set_defaults(func=cmd_reset_password)

    with_email("reset-2fa", "Issue a new TOTP secret + recovery codes (lost authenticator).") \
        .set_defaults(func=cmd_reset_2fa)

    with_email("recovery-codes", "Issue a fresh set of recovery codes.") \
        .set_defaults(func=cmd_recovery_codes)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
