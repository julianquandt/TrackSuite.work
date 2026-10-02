from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, tzinfo
from functools import lru_cache
import json
import logging
import os
import threading
import time
import uuid as uuid_lib
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from sqlalchemy import create_engine, event, func, or_, text
from sqlalchemy.orm import Session, sessionmaker
from starlette.responses import JSONResponse

from .auth import (
    access_token_expires_in_seconds,
    build_totp_uri,
    create_access_token,
    decode_access_token,
    decrypt_secret,
    encrypt_secret,
    generate_api_key,
    generate_recovery_codes,
    generate_refresh_token,
    generate_session_id,
    generate_token,
    generate_totp_secret,
    hash_api_key,
    hash_email,
    hash_password,
    hash_recovery_code,
    hash_refresh_token,
    hash_token,
    is_encrypted_secret,
    needs_reencryption,
    validate_auth_configuration,
    verify_password,
    verify_recovery_code,
    verify_totp,
    verify_totp_step,
)
from . import instance, mailer, releases
from .models import (
    ApiKey,
    AuthRateLimit,
    Base,
    OffDay,
    Project,
    RecoveryCode,
    Shift,
    User,
    UserSession,
)


# ── Database ─────────────────────────────────────────────────────────

DB_FILE = os.environ.get("WORK_TIME_DB_FILE", "./work_time_server.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_FILE}"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    # Overwrite freed pages so "deleted" plaintext isn't left recoverable in
    # the DB file's free list (defence-in-depth for erasure / breach exposure).
    cursor.execute("PRAGMA secure_delete=ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime) -> str:
    return dt.isoformat()


def sync_now() -> str:
    """Canonical UTC microsecond timestamp used for all sync metadata.

    Fixed format so it sorts lexicographically and compares identically to
    the desktop client's timestamps: ``2026-07-11T12:00:00.123456+00:00``.
    """
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_uuid() -> str:
    return str(uuid_lib.uuid4())


# ── Security/limits constants ────────────────────────────────────────
PASSWORD_MAX_LENGTH = 1024
# Bumped whenever the Terms/Privacy Policy materially change; recorded per user
# at registration so you can prove which version each account accepted. Keep in
# step with VITE_LEGAL_EFFECTIVE_DATE, the date shown on the published pages.
CURRENT_TOS_VERSION = os.environ.get("WORK_TIME_TOS_VERSION", "2026-07-27")
# Largest accepted request body (bytes). The desktop pushes its FULL local
# state to /sync/ each time, so this must fit a heavy user's entire history
# (tens of thousands of shifts) — it only exists to stop a memory-exhaustion
# DoS (hundreds of MB) on the single worker, not to bound normal use.
MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
# Field length caps for stored strings (defence against unbounded storage).
MAX_NOTE_LENGTH = 10000
MAX_NAME_LENGTH = 200
MAX_UUID_LENGTH = 64
MAX_TIMESTAMP_LENGTH = 40
MAX_SHORT_FIELD_LENGTH = 64
# How long tombstones (deleted rows) are retained before hard purge. Must be
# comfortably longer than any realistic offline window for a sync client.
TOMBSTONE_RETENTION_DAYS = 180
# Absolute session lifetime cap regardless of refresh activity.
SESSION_ABSOLUTE_MAX_DAYS = 90
# Grace window in which replay of a just-rotated refresh token is treated as a
# benign concurrent-refresh race (multi-tab / retry) rather than theft.
REFRESH_REUSE_GRACE_SECONDS = 60
# Grace period after a session expires/is revoked before its row (with IP + UA)
# is purged.
SESSION_PURGE_GRACE_DAYS = 30
# Unconfirmed (never-enrolled) accounts are swept after this many hours.
UNENROLLED_ACCOUNT_TTL_HOURS = 48
# Email-verification link lifetime.
EMAIL_VERIFICATION_TTL_HOURS = 24
# Storage-limitation: warn an inactive account after this long, then delete it a
# grace period after the warning email. Long by default so it rarely fires;
# tune via env. Disabled entirely if the value is 0.
INACTIVE_ACCOUNT_WARN_DAYS = int(os.environ.get("WORK_TIME_INACTIVE_WARN_DAYS", "0"))
INACTIVE_ACCOUNT_DELETE_GRACE_DAYS = int(
    os.environ.get("WORK_TIME_INACTIVE_DELETE_GRACE_DAYS", "30")
)


# ── Audit logging (breach-notification readiness, Art. 33/34) ─────────
# Structured, PII-light security events to stdout/journald. Never logs
# passwords, tokens, OTPs, or note/PII content — only the actor (user id),
# client IP, and event name. Configure journald retention on the host.
audit_logger = logging.getLogger("tracksuite.audit")
if not audit_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    audit_logger.addHandler(_handler)
    audit_logger.setLevel(logging.INFO)
    audit_logger.propagate = False


def audit(event: str, *, user_id: Optional[int] = None, ip: Optional[str] = None, **fields) -> None:
    parts = [f"event={event}"]
    if user_id is not None:
        parts.append(f"user_id={user_id}")
    if ip:
        parts.append(f"ip={ip}")
    for key, value in fields.items():
        parts.append(f"{key}={value}")
    audit_logger.info(" ".join(parts))


def sync_ts_greater(a: Optional[str], b: Optional[str]) -> bool:
    """True if timestamp ``a`` is strictly newer than ``b`` (None = oldest)."""
    if a is None:
        return False
    if b is None:
        return True
    return a > b


def sanitized_sync_ts(value: Optional[str]) -> str:
    """Clamp a client-supplied sync timestamp so it can't poison last-write-wins
    (H4). An unparseable value, or one implausibly far in the future, is capped
    to just past 'now' — a record can't win every future merge with 9999-... or
    a non-ISO string that sorts above real timestamps."""
    cap = datetime.now(timezone.utc) + timedelta(minutes=5)
    parsed = None
    if value:
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            parsed = None
    if parsed is None:
        return sync_now()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed > cap:
        parsed = cap
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds")


def parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value)


@lru_cache(maxsize=1)
def report_timezone() -> tzinfo:
    """Timezone the wall-clock ("naive") shift timestamps are written in.

    The desktop app stores local wall-clock time (``2026-07-15T09:00:00``)
    while the web app stores UTC (``2026-07-15T07:00:00Z``); the same shift can
    carry one of each when it is started on one and closed on the other. To
    compare them the server has to know which zone the naive half means. Set
    ``WORK_TIME_REPORT_TIMEZONE`` (IANA name) when the server does not run in
    the same zone as the user, e.g. a UTC VPS serving a Europe/Berlin user."""
    name = os.getenv("WORK_TIME_REPORT_TIMEZONE")
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc


def to_local_naive(value: Optional[str], tz: tzinfo) -> Optional[datetime]:
    """Shift timestamp as local wall clock in ``tz``, or None if unparseable.

    Naive input is taken at face value (already local); offset-aware input is
    converted into ``tz`` first, so mixed-frame shifts subtract cleanly and land
    on the day the user actually worked. Mirrors how the clients read these
    strings back with ``new Date(...)``."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone(tz).replace(tzinfo=None)


def _add_sync_columns(conn, table: str) -> None:
    """Additively add sync-metadata columns to an existing entity table."""
    columns = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
    if "uuid" not in columns:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN uuid VARCHAR NULL"))
    if "updated_at" not in columns:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN updated_at VARCHAR NULL"))
    if "deleted" not in columns:
        conn.execute(
            text(f"ALTER TABLE {table} ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0")
        )
    if "deleted_at" not in columns:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN deleted_at VARCHAR NULL"))


def ensure_schema() -> None:
    validate_auth_configuration()
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        user_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(users)"))
        }
        if "pending_totp_secret" not in user_columns:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN pending_totp_secret VARCHAR NULL")
            )
        if "mfa_enrolled_at" not in user_columns:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN mfa_enrolled_at VARCHAR NULL")
            )

        # ── Sync metadata migration for shifts and off_days ──────────────
        _add_sync_columns(conn, "shifts")
        _add_sync_columns(conn, "off_days")

        # Optional project attribution on shifts (NULL = unassigned).
        shift_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(shifts)"))
        }
        if "project_uuid" not in shift_columns:
            conn.execute(text("ALTER TABLE shifts ADD COLUMN project_uuid VARCHAR NULL"))
        if "auto_closed_at" not in shift_columns:
            conn.execute(text("ALTER TABLE shifts ADD COLUMN auto_closed_at VARCHAR NULL"))
        if "started_from" not in shift_columns:
            conn.execute(text("ALTER TABLE shifts ADD COLUMN started_from VARCHAR NULL"))
        # Report metadata (0.9.0): free-text note per shift.
        if "note" not in shift_columns:
            conn.execute(text("ALTER TABLE shifts ADD COLUMN note VARCHAR NULL"))

        # Off-day reason (vacation, sick leave, ...): NULL = plain off day.
        off_day_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(off_days)"))
        }
        if "reason" not in off_day_columns:
            conn.execute(text("ALTER TABLE off_days ADD COLUMN reason VARCHAR NULL"))

        # Report metadata (0.9.0): per-project billing rate + currency.
        project_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(projects)"))
        }
        if "rate" not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN rate VARCHAR NULL"))
        if "currency" not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN currency VARCHAR NULL"))

        # Report profile (0.9.0): encrypted JSON blob on the user row.
        user_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(users)"))
        }
        if "profile_encrypted" not in user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN profile_encrypted VARCHAR NULL"))
        if "profile_updated_at" not in user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN profile_updated_at VARCHAR NULL"))
        # Synced weekly work schedule (0.9.1): target hours per weekday.
        if "work_schedule" not in user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN work_schedule VARCHAR NULL"))
        if "work_schedule_updated_at" not in user_columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN work_schedule_updated_at VARCHAR NULL"))

        # Security/privacy hardening (0.9.3): encrypted-email lookup hash, TOTP
        # replay guard, consent record.
        user_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(users)"))
        }
        for col, ddl in (
            ("email_hash", "VARCHAR NULL"),
            ("last_totp_step", "INTEGER NULL"),
            ("tos_accepted_at", "VARCHAR NULL"),
            ("tos_version", "VARCHAR NULL"),
            ("email_verified_at", "VARCHAR NULL"),
            ("email_verification_hash", "VARCHAR NULL"),
            ("email_verification_expires_at", "VARCHAR NULL"),
            ("inactivity_warned_at", "VARCHAR NULL"),
            ("password_reset_hash", "VARCHAR NULL"),
            ("password_reset_expires_at", "VARCHAR NULL"),
        ):
            if col not in user_columns:
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} {ddl}"))
                # Grandfather all pre-existing users as email-verified so the new
                # login/enrollment gate never locks out established accounts.
                if col == "email_verified_at":
                    conn.execute(
                        text("UPDATE users SET email_verified_at = created_at "
                             "WHERE email_verified_at IS NULL")
                    )

        api_key_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(api_keys)"))
        }
        for col, ddl in (("last_used_at", "VARCHAR NULL"), ("expires_at", "VARCHAR NULL")):
            if col not in api_key_columns:
                conn.execute(text(f"ALTER TABLE api_keys ADD COLUMN {col} {ddl}"))

        session_columns = {
            row[1] for row in conn.execute(text("PRAGMA table_info(sessions)"))
        }
        for col, ddl in (
            ("prev_refresh_token_hash", "VARCHAR NULL"),
            ("absolute_expires_at", "VARCHAR NULL"),
        ):
            if col not in session_columns:
                conn.execute(text(f"ALTER TABLE sessions ADD COLUMN {col} {ddl}"))

        backfill_ts = sync_now()
        # Backfill identity + timestamps for pre-existing rows.
        shift_ids = [
            r[0] for r in conn.execute(text("SELECT id FROM shifts WHERE uuid IS NULL")).fetchall()
        ]
        for shift_id in shift_ids:
            conn.execute(
                text("UPDATE shifts SET uuid = :u, updated_at = COALESCE(updated_at, :t) WHERE id = :i"),
                {"u": new_uuid(), "t": backfill_ts, "i": shift_id},
            )
        off_day_ids = [
            r[0] for r in conn.execute(text("SELECT id FROM off_days WHERE uuid IS NULL")).fetchall()
        ]
        for off_day_id in off_day_ids:
            conn.execute(
                text("UPDATE off_days SET uuid = :u, updated_at = COALESCE(updated_at, :t) WHERE id = :i"),
                {"u": new_uuid(), "t": backfill_ts, "i": off_day_id},
            )

        # Collapse pre-existing duplicate off-days into their lowest id so a
        # unique (user_id, date) constraint can be enforced. Duplicates are
        # semantically identical facts, so this loses no real data.
        duplicate_groups = conn.execute(
            text(
                "SELECT user_id, date FROM off_days "
                "GROUP BY user_id, date HAVING COUNT(*) > 1"
            )
        ).fetchall()
        for user_id, date_value in duplicate_groups:
            ids = [
                r[0]
                for r in conn.execute(
                    text(
                        "SELECT id FROM off_days WHERE user_id = :u AND date = :d "
                        "ORDER BY id"
                    ),
                    {"u": user_id, "d": date_value},
                )
            ]
            for extra_id in ids[1:]:
                conn.execute(
                    text("DELETE FROM off_days WHERE id = :i"), {"i": extra_id}
                )

        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_off_days_user_date "
                "ON off_days (user_id, date)"
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_shifts_user_uuid "
                "ON shifts (user_id, uuid)"
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_user_uuid "
                "ON projects (user_id, uuid)"
            )
        )

    _migrate_encrypt_at_rest()


def _migrate_encrypt_at_rest() -> None:
    """Encrypt pre-existing plaintext PII in place and backfill email hashes.

    Runs at startup (synchronously, before the app serves) so an at-rest
    guarantee applies to legacy rows, not just new writes. Idempotent: skips
    already-encrypted values. Also re-encrypts anything still under an old key
    (WORK_TIME_OLD_ENCRYPTION_KEYS) so a key rotation converges — after which
    the old keys can be dropped. Raw SQL is used deliberately to bypass the
    EncryptedString TypeDecorator and control exactly what is (re)written."""
    with engine.begin() as conn:
        # TOTP secrets (columns are plain String, encrypted via helpers).
        for row in conn.execute(
            text("SELECT id, totp_secret, pending_totp_secret, mfa_enrolled_at, created_at FROM users")
        ).fetchall():
            uid, totp, pending, enrolled, created = row
            updates: dict[str, object] = {}
            if totp and not is_encrypted_secret(totp):
                updates["totp_secret"] = encrypt_secret(totp)
                if not enrolled:
                    updates["mfa_enrolled_at"] = created
            elif needs_reencryption(totp):
                updates["totp_secret"] = encrypt_secret(decrypt_secret(totp))
            if pending and not is_encrypted_secret(pending):
                updates["pending_totp_secret"] = encrypt_secret(pending)
            elif needs_reencryption(pending):
                updates["pending_totp_secret"] = encrypt_secret(decrypt_secret(pending))
            if updates:
                sets = ", ".join(f"{k} = :{k}" for k in updates)
                conn.execute(text(f"UPDATE users SET {sets} WHERE id = :id"), {**updates, "id": uid})

        # Email: encrypt + backfill the keyed lookup hash.
        for uid, email, email_hash in conn.execute(
            text("SELECT id, email, email_hash FROM users")
        ).fetchall():
            if email is None:
                continue
            plain = email if not is_encrypted_secret(email) else decrypt_secret(email)
            updates = {}
            if not is_encrypted_secret(email) or needs_reencryption(email):
                updates["email"] = encrypt_secret(plain)
            if not email_hash:
                updates["email_hash"] = hash_email(plain)
            if updates:
                sets = ", ".join(f"{k} = :{k}" for k in updates)
                conn.execute(text(f"UPDATE users SET {sets} WHERE id = :id"), {**updates, "id": uid})

        # Free-text / identifying columns on other tables.
        for table, col in (
            ("shifts", "note"),
            ("projects", "name"),
            ("projects", "rate"),
            ("api_keys", "name"),
            ("sessions", "label"),
            ("users", "work_schedule"),
            ("users", "profile_encrypted"),
        ):
            for rid, value in conn.execute(
                text(f"SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != ''")
            ).fetchall():
                if not is_encrypted_secret(value):
                    new_value = encrypt_secret(value)
                elif needs_reencryption(value):
                    new_value = encrypt_secret(decrypt_secret(value))
                else:
                    continue
                conn.execute(
                    text(f"UPDATE {table} SET {col} = :v WHERE id = :i"),
                    {"v": new_value, "i": rid},
                )

        # Enforce email uniqueness on the hash column at the DB level for
        # upgraded databases too (fresh tables get it from the model). Safe now
        # that every existing row has a backfilled email_hash above.
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_hash "
                "ON users (email_hash)"
            )
        )


ensure_schema()


# ── App & middleware ─────────────────────────────────────────────────


@lru_cache(maxsize=1)
def trusted_proxies() -> set[str]:
    value = os.environ.get("WORK_TIME_TRUSTED_PROXIES", "127.0.0.1,::1")
    return {item.strip() for item in value.split(",") if item.strip()}


def get_client_ip(request: Request) -> str:
    client_host = request.client.host if request.client else "unknown"
    if client_host in trusted_proxies():
        forwarded = request.headers.get("x-forwarded-for", "").strip()
        if forwarded:
            # Take the RIGHT-most hop that isn't itself a trusted proxy: that is
            # the address our trusted proxy actually observed. The left-most
            # entries are client-supplied and spoofable, so using them would let
            # an attacker rotate a fake IP to evade per-IP throttling.
            hops = [h.strip() for h in forwarded.split(",") if h.strip()]
            for hop in reversed(hops):
                if hop not in trusted_proxies():
                    return hop
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
    return client_host


def ip_rate_limit_key(request: Request) -> str:
    return get_client_ip(request)


limiter = Limiter(key_func=ip_rate_limit_key)


# ── Per-user in-process rate limiter for authenticated data endpoints ─────
# The server runs a single worker, so an in-memory sliding window is sufficient
# and avoids a DB write per request. Buckets reset on restart (acceptable for
# abuse throttling). Keyed by authenticated user id so one user can't starve
# others by hammering /sync/ (B7).
_rate_buckets: dict[str, deque] = defaultdict(deque)
_rate_lock = threading.Lock()


def enforce_rate_limit(bucket: str, user_id: int, limit: int, window_seconds: int) -> None:
    key = f"{bucket}:{user_id}"
    now = time.monotonic()
    cutoff = now - window_seconds
    with _rate_lock:
        times = _rate_buckets[key]
        while times and times[0] < cutoff:
            times.popleft()
        if len(times) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Please slow down.",
            )
        times.append(now)

app = FastAPI(title="Work Time Tracker API")
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429, content={"detail": "Rate limit exceeded"}
    )


@app.middleware("http")
async def limit_request_body_size(request: Request, call_next):
    """Reject oversized bodies before FastAPI buffers/parses them, so a single
    huge POST to /sync/ can't exhaust the single worker's memory (B6). The
    reverse proxy should also set LimitRequestBody as defence in depth."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_REQUEST_BODY_BYTES:
                return JSONResponse(
                    status_code=413, content={"detail": "Request body too large"}
                )
        except ValueError:
            return JSONResponse(
                status_code=400, content={"detail": "Invalid Content-Length header"}
            )
    return await call_next(request)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Auth/session helpers ─────────────────────────────────────────────


def build_auth_rate_limit_specs(scope: str, principal: str, client_ip: str) -> list[tuple[str, int, int, int]]:
    normalized_principal = principal.strip().lower()
    if scope == "register":
        return [
            (f"{scope}:account:{normalized_principal}", 4, 3600, 3600),
            (f"{scope}:combo:{normalized_principal}:{client_ip}", 4, 3600, 3600),
            (f"{scope}:ip:{client_ip}", 20, 3600, 3600),
        ]

    return [
        (f"{scope}:account:{normalized_principal}", 10, 900, 1800),
        (f"{scope}:combo:{normalized_principal}:{client_ip}", 10, 900, 1800),
        (f"{scope}:ip:{client_ip}", 50, 900, 1800),
    ]


def assert_auth_flow_allowed(db: Session, specs: list[tuple[str, int, int, int]]) -> None:
    now = utcnow()
    dirty = False
    for key, _, window_seconds, _ in specs:
        row = db.get(AuthRateLimit, key)
        if not row:
            continue

        window_started_at = parse_timestamp(row.window_started_at)
        blocked_until = parse_timestamp(row.blocked_until)

        if blocked_until and blocked_until > now:
            retry_after = max(1, int((blocked_until - now).total_seconds()))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many authentication attempts. Retry in {retry_after} seconds.",
            )

        if not window_started_at or window_started_at + timedelta(seconds=window_seconds) <= now:
            row.attempts = 0
            row.window_started_at = to_iso(now)
            row.blocked_until = None
            dirty = True

    if dirty:
        db.commit()


def record_auth_flow_failure(db: Session, specs: list[tuple[str, int, int, int]]) -> None:
    now = utcnow()
    for key, limit, window_seconds, block_seconds in specs:
        row = db.get(AuthRateLimit, key)
        if row is None:
            row = AuthRateLimit(
                key=key,
                attempts=0,
                window_started_at=to_iso(now),
                blocked_until=None,
            )
            db.add(row)

        window_started_at = parse_timestamp(row.window_started_at)
        if not window_started_at or window_started_at + timedelta(seconds=window_seconds) <= now:
            row.attempts = 0
            row.window_started_at = to_iso(now)
            row.blocked_until = None

        row.attempts += 1
        if row.attempts >= limit:
            row.blocked_until = to_iso(now + timedelta(seconds=block_seconds))

    db.commit()


def clear_auth_flow_failures(db: Session, specs: list[tuple[str, int, int, int]]) -> None:
    for key, _, _, _ in specs:
        # Keep the per-IP counter: clearing it on every success would let an
        # attacker who succeeds each time (mass registration/enumeration from one
        # IP) evade the durable per-IP cap (M3). Only account/combo keys clear.
        if ":ip:" in key:
            continue
        row = db.get(AuthRateLimit, key)
        if row is not None:
            db.delete(row)
    db.commit()


def session_is_active(session: UserSession) -> bool:
    if session.revoked_at:
        return False
    now = utcnow()
    expires_at = parse_timestamp(session.expires_at)
    if not (expires_at and expires_at > now):
        return False
    # Absolute lifetime cap: a session can't be refreshed forever.
    absolute_expires_at = parse_timestamp(session.absolute_expires_at)
    if absolute_expires_at and absolute_expires_at <= now:
        return False
    return True


def session_label_from_request(request: Request, explicit_label: Optional[str]) -> str:
    if explicit_label and explicit_label.strip():
        return explicit_label.strip()[:120]

    user_agent = request.headers.get("user-agent", "").strip()
    if user_agent:
        return user_agent[:120]
    return "Browser session"


def recovery_code_count(db: Session, user_id: int) -> int:
    return db.query(RecoveryCode).filter(
        RecoveryCode.user_id == user_id,
        RecoveryCode.used_at.is_(None),
    ).count()


def replace_recovery_codes(db: Session, user_id: int) -> list[str]:
    db.query(RecoveryCode).filter(RecoveryCode.user_id == user_id).delete()
    now = to_iso(utcnow())
    recovery_codes = generate_recovery_codes()
    for code in recovery_codes:
        db.add(
            RecoveryCode(
                user_id=user_id,
                code_hash=hash_recovery_code(code),
                created_at=now,
                used_at=None,
            )
        )
    db.commit()
    return recovery_codes


def consume_recovery_code(db: Session, user_id: int, recovery_code: str) -> bool:
    rows = db.query(RecoveryCode).filter(
        RecoveryCode.user_id == user_id,
        RecoveryCode.used_at.is_(None),
    ).all()
    for row in rows:
        if verify_recovery_code(recovery_code, row.code_hash):
            row.used_at = to_iso(utcnow())
            db.commit()
            return True
    return False


@lru_cache(maxsize=1)
def _dummy_password_hash() -> str:
    """A throwaway Argon2 hash used to spend the same CPU on a login for a
    non-existent account as for a real one, so response timing doesn't reveal
    which emails are registered (LOW-2)."""
    return hash_password("timing-equalizer-not-a-real-password")


def verify_login_password(user: Optional[User], password: str) -> bool:
    """Constant-ish-time password check: always runs an Argon2 verify, even when
    the account doesn't exist, to avoid an enumeration timing oracle."""
    if user is None:
        verify_password(password, _dummy_password_hash())
        return False
    return verify_password(password, user.password_hash)


def require_email_verified(user: User) -> None:
    """Block token issuance until the email address is confirmed (anti-squatting
    + ensures we can reach the owner). Existing accounts were grandfathered
    verified by the migration, so this only gates new registrations. Inactive
    when no mail provider is configured (registrations auto-verify then)."""
    if not mailer.mail_enabled():
        return
    if not user.email_verified_at:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Verify your email address first — check your inbox for the confirmation link.",
        )


def verify_and_consume_totp(db: Session, user: User, code: str) -> bool:
    """Verify a TOTP against the user's ACTIVE secret and reject replay of a
    code already accepted within its window (M8). Persists the accepted step."""
    step = verify_totp_step(code, user.totp_secret)
    if step is None:
        return False
    if user.last_totp_step is not None and step <= user.last_totp_step:
        return False  # already used this (or an earlier) code — replay
    user.last_totp_step = step
    db.commit()
    return True


def revoke_session(session: UserSession) -> None:
    if not session.revoked_at:
        session.revoked_at = to_iso(utcnow())


def revoke_all_user_sessions(db: Session, user_id: int, except_session_id: Optional[str] = None) -> int:
    sessions = db.query(UserSession).filter(UserSession.user_id == user_id).all()
    revoked = 0
    for session in sessions:
        if except_session_id and session.id == except_session_id:
            continue
        if not session.revoked_at:
            revoke_session(session)
            revoked += 1
    db.commit()
    return revoked


def create_session_tokens(
    db: Session,
    user: User,
    request: Request,
    label: Optional[str] = None,
    session: Optional[UserSession] = None,
) -> tuple[UserSession, str, str]:
    now = utcnow()
    refresh_token = generate_refresh_token()
    refresh_token_hash = hash_refresh_token(refresh_token)
    absolute_cap = now + timedelta(days=SESSION_ABSOLUTE_MAX_DAYS)

    if session is None:
        rolling_expiry = now + timedelta(days=30)
        session = UserSession(
            id=generate_session_id(),
            user_id=user.id,
            refresh_token_hash=refresh_token_hash,
            prev_refresh_token_hash=None,
            created_at=to_iso(now),
            last_used_at=to_iso(now),
            expires_at=to_iso(min(rolling_expiry, absolute_cap)),
            absolute_expires_at=to_iso(absolute_cap),
            revoked_at=None,
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("user-agent", "")[:255] or None,
            label=session_label_from_request(request, label),
        )
        db.add(session)
    else:
        # Rotation: remember the outgoing token hash so a later replay of it is
        # detected as theft (H2). The absolute cap set at creation is preserved.
        session.prev_refresh_token_hash = session.refresh_token_hash
        session.refresh_token_hash = refresh_token_hash
        session.last_used_at = to_iso(now)
        created_at = parse_timestamp(session.created_at) or now
        hard_cap = parse_timestamp(session.absolute_expires_at) or (
            created_at + timedelta(days=SESSION_ABSOLUTE_MAX_DAYS)
        )
        session.absolute_expires_at = to_iso(hard_cap)
        session.expires_at = to_iso(min(now + timedelta(days=30), hard_cap))
        session.ip_address = get_client_ip(request)
        session.user_agent = request.headers.get("user-agent", "")[:255] or None
        session.label = session_label_from_request(request, label)

    db.commit()
    db.refresh(session)

    access_token = create_access_token(user.id, user.email, session.id)
    return session, access_token, refresh_token


@dataclass
class BearerSessionContext:
    user: User
    session: UserSession


# ── Auth dependencies ────────────────────────────────────────────────


bearer_scheme = HTTPBearer(auto_error=False)
api_key_header = APIKeyHeader(name="X-API-KEY", auto_error=False)


def get_current_bearer_context(
    request: Request,
    bearer: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> BearerSessionContext:
    if not bearer or not bearer.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    try:
        payload = decode_access_token(bearer.credentials)
        if payload.get("type") != "access":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid session token",
            )
        user_id = int(payload["sub"])
        session_id = str(payload["sid"])
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    session = db.query(UserSession).filter(UserSession.id == session_id).first()
    if not session or session.user_id != user_id or not session_is_active(session):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired or revoked",
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    session.last_used_at = to_iso(utcnow())
    db.commit()
    return BearerSessionContext(user=user, session=session)


def is_version_at_least(val: Optional[str], min_val: str) -> bool:
    if not val:
        return False
    try:
        clean_val = val.strip().lstrip("v")
        clean_min = min_val.strip().lstrip("v")
        val_parts = [int(x) for x in clean_val.split(".")]
        min_parts = [int(x) for x in clean_min.split(".")]
        max_len = max(len(val_parts), len(min_parts))
        val_parts += [0] * (max_len - len(val_parts))
        min_parts += [0] * (max_len - len(min_parts))
        return val_parts >= min_parts
    except Exception:
        return False


def get_current_user_id(
    request: Request,
    bearer: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    x_api_key: Optional[str] = Depends(api_key_header),
    db: Session = Depends(get_db),
) -> int:
    if bearer and bearer.credentials:
        uid = get_current_bearer_context(request=request, bearer=bearer, db=db).user.id
        enforce_rate_limit("all", uid, limit=600, window_seconds=60)
        return uid

    if x_api_key:
        hashed = hash_api_key(x_api_key)
        key_row = db.query(ApiKey).filter(ApiKey.key_hash == hashed).first()
        if key_row:
            expires_at = parse_timestamp(key_row.expires_at)
            if expires_at and expires_at <= utcnow():
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="API key has expired",
                )
            if request.method in ("POST", "PUT", "DELETE"):
                app_version = request.headers.get("x-app-version")
                if not is_version_at_least(app_version, "0.8.1"):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Desktop app upgrade required to v0.8.1 or newer to push data."
                    )
            # Track usage so a leaked/stale key is visible to the owner.
            key_row.last_used_at = to_iso(utcnow())
            db.commit()
            enforce_rate_limit("all", key_row.user_id, limit=600, window_seconds=60)
            return key_row.user_id
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid API key",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
    )


def limit_sync_push(user_id: int = Depends(get_current_user_id)) -> int:
    """Tighter per-user cap for the expensive full-state sync merge."""
    enforce_rate_limit("sync-push", user_id, limit=20, window_seconds=60)
    return user_id


# ── Pydantic schemas ────────────────────────────────────────────────


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    # Only consulted on instances running WORK_TIME_SIGNUP_MODE=restricted with
    # invite codes configured; ignored otherwise.
    invite_code: Optional[str] = Field(default=None, max_length=200)


class ConfirmEnrollmentRequest(BaseModel):
    email: EmailStr
    password: str
    otp: str
    device_name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    otp: str
    device_name: Optional[str] = None


class RecoveryLoginRequest(BaseModel):
    email: EmailStr
    password: str
    recovery_code: str
    device_name: Optional[str] = None


class RefreshRequest(BaseModel):
    refresh_token: str


class SessionInfo(BaseModel):
    id: str
    label: Optional[str]
    ip_address: Optional[str]
    user_agent: Optional[str]
    created_at: str
    last_used_at: str
    expires_at: str
    revoked_at: Optional[str] = None
    current: bool = False


class AuthTokensResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    session: SessionInfo


class EnrollmentCompleteResponse(BaseModel):
    recovery_codes: List[str]
    # When email verification is still pending, no session is issued yet — the
    # user activates the account via the verification link, then signs in.
    verification_pending: bool = False
    # Token fields are present only when the account is already active
    # (verified, or a no-email deployment) — then the user is logged straight in.
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    token_type: str = "bearer"
    expires_in: Optional[int] = None
    session: Optional[SessionInfo] = None


class LogoutAllResponse(BaseModel):
    revoked_sessions: int


class RecoveryCodesResponse(BaseModel):
    recovery_codes: List[str]
    remaining_count: int


class RecoveryCodesStatusResponse(BaseModel):
    remaining_count: int


class RegenerateRecoveryCodesRequest(BaseModel):
    password: str
    otp: str


class MfaResetStartRequest(BaseModel):
    password: str
    otp: str


class MfaResetStartResponse(BaseModel):
    totp_secret: str
    totp_uri: str


class MfaResetConfirmRequest(BaseModel):
    otp: str


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=PASSWORD_MAX_LENGTH)
    otp: str


class DeleteAccountRequest(BaseModel):
    password: str
    otp: str


class VerifyEmailRequest(BaseModel):
    token: str = Field(max_length=256)


class VerifyEmailResponse(BaseModel):
    email: str
    enrolled: bool


class PasswordResetConfirmRequest(BaseModel):
    token: str = Field(max_length=256)
    new_password: str = Field(min_length=8, max_length=PASSWORD_MAX_LENGTH)
    otp: Optional[str] = None
    recovery_code: Optional[str] = None


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class GenericMessageResponse(BaseModel):
    detail: str


class InstanceConfigResponse(BaseModel):
    instance_name: str
    signup_mode: str
    signup_open: bool
    invite_required: bool
    allowed_email_domains: List[str]
    email_enabled: bool
    tos_version: str


class ReleaseAsset(BaseModel):
    name: str
    browser_download_url: str
    size: int


class LatestReleaseResponse(BaseModel):
    tag_name: str
    html_url: str
    published_at: str
    assets: List[ReleaseAsset]


class TosStatusResponse(BaseModel):
    current_version: str
    accepted_version: Optional[str]
    accepted_at: Optional[str]
    acceptance_required: bool


class AcceptTosRequest(BaseModel):
    version: str = Field(max_length=64)


class RegisterResponse(BaseModel):
    id: int
    email: str
    created_at: str
    totp_secret: str
    totp_uri: str


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(max_length=MAX_NAME_LENGTH)


class ApiKeyCreateResponse(BaseModel):
    id: int
    name: str
    key: str
    created_at: str


class ApiKeyListItem(BaseModel):
    id: int
    name: str
    created_at: str
    last_used_at: Optional[str] = None
    expires_at: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class ShiftCreate(BaseModel):
    start_time: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    end_time: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)
    uuid: Optional[str] = Field(default=None, max_length=MAX_UUID_LENGTH)
    project_uuid: Optional[str] = Field(default=None, max_length=MAX_UUID_LENGTH)
    started_from: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    note: Optional[str] = Field(default=None, max_length=MAX_NOTE_LENGTH)


class ShiftUpdate(ShiftCreate):
    # Explicit "Looks right" on an auto-closed shift: drop the review flag even
    # though the times did not change. Editing the times also drops it.
    clear_auto_closed: Optional[bool] = None


class ShiftResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    start_time: str
    end_time: Optional[str] = None
    project_uuid: Optional[str] = None
    note: Optional[str] = None
    updated_at: Optional[str] = None
    deleted: bool = False
    auto_closed_at: Optional[str] = None
    started_from: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    name: str = Field(max_length=MAX_NAME_LENGTH)
    color: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    uuid: Optional[str] = Field(default=None, max_length=MAX_UUID_LENGTH)
    rate: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    currency: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=MAX_NAME_LENGTH)
    color: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    archived: Optional[bool] = None
    rate: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    currency: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)


class ProjectResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    name: str
    color: Optional[str] = None
    archived: bool = False
    rate: Optional[str] = None
    currency: Optional[str] = None
    updated_at: Optional[str] = None
    deleted: bool = False
    model_config = ConfigDict(from_attributes=True)


# Off-day reason: None (plain off day) or a short lowercase code such as
# "vacation", "sick", "holiday", "other". The clients own the labels; the server
# only checks the shape. The desktop app validates the same way.
OFF_DAY_REASON_MAX_LENGTH = 32
OFF_DAY_REASON_PATTERN = r"^[a-z_]+$"


def _off_day_reason_field() -> Any:
    return Field(
        default=None,
        min_length=1,
        max_length=OFF_DAY_REASON_MAX_LENGTH,
        pattern=OFF_DAY_REASON_PATTERN,
    )


class OffDayCreate(BaseModel):
    date: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    uuid: Optional[str] = Field(default=None, max_length=MAX_UUID_LENGTH)
    reason: Optional[str] = _off_day_reason_field()


class OffDayUpdate(BaseModel):
    reason: Optional[str] = _off_day_reason_field()


class OffDayResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    date: str
    reason: Optional[str] = None
    updated_at: Optional[str] = None
    deleted: bool = False
    model_config = ConfigDict(from_attributes=True)


# The report profile is an opaque JSON object (name, company, address,
# letterhead, default currency, custom fields …). The server stores it
# Fernet-encrypted at rest and never inspects its shape, so the web app can
# evolve the fields without backend changes.
PROFILE_MAX_BYTES = 64 * 1024


class ProfileResponse(BaseModel):
    profile: Optional[Dict[str, Any]] = None
    profile_updated_at: Optional[str] = None


class ProfileUpdate(BaseModel):
    profile: Dict[str, Any]


# The weekly work schedule is a small JSON object of target hours per weekday
# (e.g. {"mon": 7.2, ..., "sun": 0}). Stored in the clear; last-write-wins by
# work_schedule_updated_at. Kept separate from the report profile so a device
# can sync its schedule without touching the (encrypted) letterhead.
WORK_SCHEDULE_MAX_BYTES = 4 * 1024


class WorkScheduleResponse(BaseModel):
    schedule: Optional[Dict[str, Any]] = None
    schedule_updated_at: Optional[str] = None


class WorkScheduleUpdate(BaseModel):
    schedule: Dict[str, Any]


# ── Full-state sync schemas ──────────────────────────────────────────


class SyncShift(BaseModel):
    uuid: str = Field(max_length=MAX_UUID_LENGTH)
    start_time: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    end_time: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)
    project_uuid: Optional[str] = Field(default=None, max_length=MAX_UUID_LENGTH)
    note: Optional[str] = Field(default=None, max_length=MAX_NOTE_LENGTH)
    updated_at: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    deleted: bool = False
    deleted_at: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)
    auto_closed_at: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)
    started_from: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)


class SyncOffDay(BaseModel):
    uuid: str = Field(max_length=MAX_UUID_LENGTH)
    date: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    # Optional so older clients that don't send it keep syncing.
    reason: Optional[str] = _off_day_reason_field()
    updated_at: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    deleted: bool = False
    deleted_at: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)


class SyncProject(BaseModel):
    uuid: str = Field(max_length=MAX_UUID_LENGTH)
    name: str = Field(max_length=MAX_NAME_LENGTH)
    color: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    archived: bool = False
    rate: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    currency: Optional[str] = Field(default=None, max_length=MAX_SHORT_FIELD_LENGTH)
    updated_at: str = Field(max_length=MAX_TIMESTAMP_LENGTH)
    deleted: bool = False
    deleted_at: Optional[str] = Field(default=None, max_length=MAX_TIMESTAMP_LENGTH)


# Cap list sizes so a single push can't smuggle an unbounded number of rows.
# High enough to hold a very long history (the client syncs full state), low
# enough to bound worst-case work per request.
MAX_SYNC_ITEMS = 200000


class SyncPushRequest(BaseModel):
    shifts: List[SyncShift] = Field(default=[], max_length=MAX_SYNC_ITEMS)
    off_days: List[SyncOffDay] = Field(default=[], max_length=MAX_SYNC_ITEMS)
    projects: List[SyncProject] = Field(default=[], max_length=MAX_SYNC_ITEMS)


class SyncStateResponse(BaseModel):
    shifts: List[SyncShift]
    off_days: List[SyncOffDay]
    projects: List[SyncProject]
    server_time: str


def build_session_info(session: UserSession, current_session_id: Optional[str] = None) -> SessionInfo:
    return SessionInfo(
        id=session.id,
        label=session.label,
        ip_address=session.ip_address,
        user_agent=session.user_agent,
        created_at=session.created_at,
        last_used_at=session.last_used_at,
        expires_at=session.expires_at,
        revoked_at=session.revoked_at,
        current=session.id == current_session_id,
    )


def build_auth_tokens_response(
    session: UserSession,
    access_token: str,
    refresh_token: str,
    current_session_id: Optional[str] = None,
) -> AuthTokensResponse:
    return AuthTokensResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=access_token_expires_in_seconds(),
        session=build_session_info(session, current_session_id=current_session_id or session.id),
    )


# ── Data erasure & retention ─────────────────────────────────────────


def hard_delete_user(db: Session, user_id: int) -> None:
    """Irreversibly delete a user and every row scoped to them. No FK cascades
    exist, so each table is cleared explicitly (GDPR Art. 17)."""
    user = db.get(User, user_id)
    # Capture the plaintext email before deletion — the auth rate-limit rows are
    # keyed on the normalized email, so we need it to purge those too.
    email = user.email.strip().lower() if user and user.email else None
    db.query(Shift).filter(Shift.user_id == user_id).delete(synchronize_session=False)
    db.query(OffDay).filter(OffDay.user_id == user_id).delete(synchronize_session=False)
    db.query(Project).filter(Project.user_id == user_id).delete(synchronize_session=False)
    db.query(ApiKey).filter(ApiKey.user_id == user_id).delete(synchronize_session=False)
    db.query(RecoveryCode).filter(RecoveryCode.user_id == user_id).delete(synchronize_session=False)
    db.query(UserSession).filter(UserSession.user_id == user_id).delete(synchronize_session=False)
    if user:
        db.delete(user)
    if email:
        db.query(AuthRateLimit).filter(
            AuthRateLimit.key.like(f"%:{email}:%"),
        ).delete(synchronize_session=False)
        db.query(AuthRateLimit).filter(
            AuthRateLimit.key.like(f"%:{email}"),
        ).delete(synchronize_session=False)
    db.commit()


def purge_expired_data() -> Dict[str, int]:
    """Retention sweep (storage limitation): drop old tombstones, stale sessions
    with their IP/UA, aged rate-limit rows, and never-enrolled accounts."""
    counts: Dict[str, int] = {}
    now = utcnow()
    tomb_cutoff = to_iso(now - timedelta(days=TOMBSTONE_RETENTION_DAYS))
    session_cutoff = to_iso(now - timedelta(days=SESSION_PURGE_GRACE_DAYS))
    ratelimit_cutoff = to_iso(now - timedelta(days=1))
    unenrolled_cutoff = to_iso(now - timedelta(hours=UNENROLLED_ACCOUNT_TTL_HOURS))
    with SessionLocal() as db:
        counts["shifts"] = db.query(Shift).filter(
            Shift.deleted.is_(True), Shift.deleted_at < tomb_cutoff
        ).delete(synchronize_session=False)
        counts["projects"] = db.query(Project).filter(
            Project.deleted.is_(True), Project.deleted_at < tomb_cutoff
        ).delete(synchronize_session=False)
        counts["off_days"] = db.query(OffDay).filter(
            OffDay.deleted.is_(True), OffDay.deleted_at < tomb_cutoff
        ).delete(synchronize_session=False)
        # Sessions expired or revoked past the grace window (removes retained
        # IP + user-agent, which are personal data).
        counts["sessions"] = db.query(UserSession).filter(
            or_(
                UserSession.expires_at < session_cutoff,
                UserSession.revoked_at < session_cutoff,
            )
        ).delete(synchronize_session=False)
        # Aged auth rate-limit rows (they embed email + IP).
        counts["rate_limits"] = db.query(AuthRateLimit).filter(
            AuthRateLimit.window_started_at < ratelimit_cutoff
        ).delete(synchronize_session=False)
        db.commit()
        # Incomplete accounts (not both enrolled AND verified) hold no data (login
        # is gated on both), so sweeping them is safe and also auto-frees any
        # email a squatter grabbed but never fully activated.
        stale = db.query(User).filter(
            or_(User.mfa_enrolled_at.is_(None), User.email_verified_at.is_(None)),
            User.created_at < unenrolled_cutoff,
        ).all()
        counts["incomplete_users"] = len(stale)
        for user in stale:
            hard_delete_user(db, user.id)

        # Storage limitation for long-inactive *active* accounts (opt-in; needs
        # email so users can be warned first). Disabled unless WORK_TIME_INACTIVE
        # _WARN_DAYS > 0. Warn once, then delete after a grace period if still
        # inactive; a login in between clears the warning.
        counts["inactivity_warned"] = 0
        counts["inactivity_deleted"] = 0
        if INACTIVE_ACCOUNT_WARN_DAYS > 0 and mailer.mail_enabled():
            warn_cutoff = to_iso(now - timedelta(days=INACTIVE_ACCOUNT_WARN_DAYS))
            candidates = db.query(User).filter(
                User.mfa_enrolled_at.is_not(None),
                User.email_verified_at.is_not(None),
                User.inactivity_warned_at.is_(None),
            ).all()
            for user in candidates:
                last_used = db.query(func.max(UserSession.last_used_at)).filter(
                    UserSession.user_id == user.id
                ).scalar()
                last_activity = last_used or user.created_at
                if last_activity < warn_cutoff:
                    user.inactivity_warned_at = to_iso(now)
                    mailer.send_inactivity_warning_email(
                        user.email, INACTIVE_ACCOUNT_DELETE_GRACE_DAYS
                    )
                    counts["inactivity_warned"] += 1
            db.commit()

            delete_cutoff = to_iso(now - timedelta(days=INACTIVE_ACCOUNT_DELETE_GRACE_DAYS))
            warned = db.query(User).filter(
                User.inactivity_warned_at.is_not(None),
                User.inactivity_warned_at < delete_cutoff,
            ).all()
            for user in warned:
                last_used = db.query(func.max(UserSession.last_used_at)).filter(
                    UserSession.user_id == user.id
                ).scalar()
                if not last_used or last_used < user.inactivity_warned_at:
                    audit("inactivity_deleted", user_id=user.id)
                    hard_delete_user(db, user.id)
                    counts["inactivity_deleted"] += 1
                else:
                    user.inactivity_warned_at = None  # reactivated → clear warning
                    db.commit()
    # Drop accumulated per-user throttle buckets (ephemeral 60s-window counters);
    # bounds memory for a long-running process with many distinct users.
    with _rate_lock:
        _rate_buckets.clear()
    return counts


_maintenance_stop = threading.Event()


def _maintenance_loop() -> None:  # pragma: no cover - background timer
    # Run soon after boot, then daily.
    while not _maintenance_stop.wait(60):
        try:
            purge_expired_data()
        except Exception:
            pass
        _maintenance_stop.wait(24 * 3600)


def start_maintenance_thread() -> None:
    if os.environ.get("WORK_TIME_DISABLE_MAINTENANCE") == "1":
        return
    thread = threading.Thread(target=_maintenance_loop, daemon=True)
    thread.start()


# ── Root ─────────────────────────────────────────────────────────────


@app.get("/")
async def read_root():
    return {"status": "ok", "message": "Work Time Tracker API"}


@app.get("/meta/instance", response_model=InstanceConfigResponse)
def get_instance_config(db: Session = Depends(get_db)):
    """Public, non-secret description of how this deployment is configured.

    The web app fetches this once at startup so one build can serve the public
    site, a company instance (invite/domain-gated signup) and a single-user
    instance (no signup at all). Invite codes are never exposed.
    """
    return InstanceConfigResponse(
        **instance.public_config(
            user_count=db.query(func.count(User.id)).scalar() or 0,
            email_enabled=mailer.mail_enabled(),
            tos_version=CURRENT_TOS_VERSION,
        )
    )


@app.get("/meta/releases/latest", response_model=LatestReleaseResponse)
def get_latest_release():
    """Installer URLs for the download page, fetched server-side.

    The browser must not call GitHub itself: that would transmit every
    visitor's IP to a US company automatically on page load, and would need a
    `connect-src` exception in the CSP. Cached, so one server call serves
    everyone instead of each visitor spending the anonymous rate limit.
    """
    release = releases.latest_release()
    if release is None:
        # The download page falls back to a plain "latest release" link, which
        # is why this is a soft 503 rather than an error worth alarming on.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Release information is temporarily unavailable.",
        )
    return LatestReleaseResponse(**release)


# ── Auth endpoints ───────────────────────────────────────────────────


@app.post("/auth/register", response_model=RegisterResponse,
          status_code=status.HTTP_201_CREATED)
@limiter.limit("20/hour")
def register(body: RegisterRequest, request: Request,
             db: Session = Depends(get_db)):
    specs = build_auth_rate_limit_specs("register", body.email, get_client_ip(request))
    assert_auth_flow_allowed(db, specs)

    if len(body.password) < 8:
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be at least 8 characters",
        )
    if len(body.password) > PASSWORD_MAX_LENGTH:
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Password must be at most {PASSWORD_MAX_LENGTH} characters",
        )
    existing = db.query(User).filter(User.email_hash == hash_email(body.email)).first()

    # Instance policy (self-hosted single-user / company deployments) is checked
    # BEFORE the duplicate-email check: on a closed instance every registration
    # attempt must look identical, so a 409 can't be used to probe for accounts.
    rejection = instance.signup_rejection_reason(
        body.email,
        body.invite_code,
        user_count=db.query(func.count(User.id)).scalar() or 0,
        creates_new_user=existing is None,
    )
    if rejection is not None:
        record_auth_flow_failure(db, specs)
        audit("register_rejected", ip=get_client_ip(request), mode=instance.signup_mode())
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=rejection)

    if existing is not None and existing.mfa_enrolled_at and existing.email_verified_at:
        # A *fully active* account (enrolled + verified) owns the address — that's
        # the only thing that blocks it, and it's never reset (it may hold data).
        # Send people to sign-in / password-reset instead. An incomplete account
        # can't log in, so it has no data and is safely reset below — which is
        # also how a squatter's unverified claim gets cleared. (In no-email
        # deployments accounts auto-verify at registration, which is why the
        # claim is on enrolled+verified, not verified alone.)
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have an account with this email. Sign in, or reset your password.",
        )

    raw_totp_secret = generate_totp_secret()
    now = utcnow()
    now_iso = to_iso(now)
    # Without a mail provider we can't verify email, so auto-verify (the gate is
    # simply inactive) — a self-hoster without Resend still onboards users.
    verify_by_email = mailer.mail_enabled()

    if existing is not None:
        # Re-registration of an unverified (⇒ data-less) account: reset in place.
        user = existing
        user.password_hash = hash_password(body.password)
        user.totp_secret = ""
        user.pending_totp_secret = encrypt_secret(raw_totp_secret)
        user.mfa_enrolled_at = None
        user.last_totp_step = None
        user.tos_accepted_at = now_iso
        user.tos_version = CURRENT_TOS_VERSION
        user.email_verified_at = None if verify_by_email else now_iso
        user.email_verification_hash = None
        user.email_verification_expires_at = None
    else:
        user = User(
            email=body.email,
            email_hash=hash_email(body.email),
            password_hash=hash_password(body.password),
            totp_secret="",
            pending_totp_secret=encrypt_secret(raw_totp_secret),
            mfa_enrolled_at=None,
            created_at=now_iso,
            tos_accepted_at=now_iso,
            tos_version=CURRENT_TOS_VERSION,
            email_verified_at=None if verify_by_email else now_iso,
        )
        db.add(user)
    db.commit()
    db.refresh(user)
    clear_auth_flow_failures(db, specs)
    # NOTE: the verification email is sent after 2FA setup (confirm-enrollment),
    # so a verification link only ever exists for an already-enrolled account.
    audit("register", user_id=user.id, ip=get_client_ip(request))
    return RegisterResponse(
        id=user.id,
        email=user.email,
        created_at=user.created_at,
        totp_secret=raw_totp_secret,
        totp_uri=build_totp_uri(raw_totp_secret, user.email),
    )


@app.post("/auth/mfa/confirm-enrollment", response_model=EnrollmentCompleteResponse)
@limiter.limit("30/hour")
def confirm_enrollment(
    body: ConfirmEnrollmentRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    specs = build_auth_rate_limit_specs("enroll", body.email, get_client_ip(request))
    assert_auth_flow_allowed(db, specs)

    user = db.query(User).filter(User.email_hash == hash_email(body.email)).first()
    if not verify_login_password(user, body.password):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    # NOTE: email verification is NOT required here — 2FA is set up first, then
    # the account is activated by verifying the email (verify-last).
    if not user.mfa_enrolled_at and not user.pending_totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending MFA enrollment was found for this account",
        )

    # Idempotent-ish: if already enrolled, verify against the active secret so a
    # repeated call (double submit) doesn't error.
    secret_to_check = user.pending_totp_secret or user.totp_secret
    if not verify_totp(body.otp, secret_to_check):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    if user.pending_totp_secret:
        user.totp_secret = user.pending_totp_secret
        user.pending_totp_secret = None
        user.mfa_enrolled_at = to_iso(utcnow())
        user.last_totp_step = None
    db.commit()

    recovery_codes = replace_recovery_codes(db, user.id)
    clear_auth_flow_failures(db, specs)
    audit("enrollment_complete", user_id=user.id, ip=get_client_ip(request))

    if not user.email_verified_at:
        # Verify-last: send the activation email now (first time there's a link),
        # and don't issue a session until the email is verified.
        token = generate_token()
        user.email_verification_hash = hash_token(token)
        user.email_verification_expires_at = to_iso(
            utcnow() + timedelta(hours=EMAIL_VERIFICATION_TTL_HOURS)
        )
        db.commit()
        mailer.send_verification_email(user.email, token)
        return EnrollmentCompleteResponse(recovery_codes=recovery_codes, verification_pending=True)

    # Already verified (e.g. no-email deployment): log the user straight in.
    session, access_token, refresh_token = create_session_tokens(
        db, user, request, body.device_name
    )
    return EnrollmentCompleteResponse(
        recovery_codes=recovery_codes,
        **build_auth_tokens_response(session, access_token, refresh_token).model_dump(),
    )


@app.post("/auth/verify-email", response_model=VerifyEmailResponse)
@limiter.limit("30/hour")
def verify_email(body: VerifyEmailRequest, request: Request,
                 db: Session = Depends(get_db)):
    user = db.query(User).filter(
        User.email_verification_hash == hash_token(body.token)
    ).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or already-used verification link.",
        )
    expires_at = parse_timestamp(user.email_verification_expires_at)
    if expires_at and expires_at <= utcnow():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Verification link has expired. Request a new one.",
        )
    user.email_verified_at = to_iso(utcnow())
    user.email_verification_hash = None
    user.email_verification_expires_at = None
    db.commit()
    audit("email_verified", user_id=user.id, ip=get_client_ip(request))
    # Return the address + whether 2FA is still needed, so the client can move
    # straight into authenticator setup for this account.
    return VerifyEmailResponse(email=user.email, enrolled=bool(user.mfa_enrolled_at))


@app.post("/auth/password-reset/request", response_model=GenericMessageResponse)
@limiter.limit("5/hour")
def request_password_reset(body: ResendVerificationRequest, request: Request,
                           db: Session = Depends(get_db)):
    """Email a password-reset link. Generic response either way (no enumeration).
    Only fully-active accounts (verified + enrolled) get a link."""
    user = db.query(User).filter(User.email_hash == hash_email(body.email)).first()
    if user is not None and user.email_verified_at and user.mfa_enrolled_at:
        token = generate_token()
        user.password_reset_hash = hash_token(token)
        user.password_reset_expires_at = to_iso(utcnow() + timedelta(hours=1))
        db.commit()
        mailer.send_password_reset_email(user.email, token)
        audit("password_reset_requested", user_id=user.id, ip=get_client_ip(request))
    return GenericMessageResponse(
        detail="If that email has an account, a password-reset link is on its way."
    )


@app.post("/auth/password-reset/confirm", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("10/hour")
def confirm_password_reset(body: PasswordResetConfirmRequest, request: Request,
                           db: Session = Depends(get_db)):
    """Set a new password from a reset link. Requires a second factor (current
    authenticator code OR a recovery code) so a stolen inbox alone can't take
    over the account. Revokes all sessions."""
    user = db.query(User).filter(
        User.password_reset_hash == hash_token(body.token)
    ).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or already-used reset link.",
        )
    expires_at = parse_timestamp(user.password_reset_expires_at)
    if expires_at and expires_at <= utcnow():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reset link has expired. Request a new one.",
        )

    second_factor_ok = False
    if body.otp and verify_totp(body.otp, user.totp_secret):
        second_factor_ok = True
    elif body.recovery_code and consume_recovery_code(db, user.id, body.recovery_code):
        second_factor_ok = True
    if not second_factor_ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Enter a valid authenticator code or a recovery code to reset your password.",
        )

    user.password_hash = hash_password(body.new_password)
    user.password_reset_hash = None
    user.password_reset_expires_at = None
    user.last_totp_step = None
    db.commit()
    revoke_all_user_sessions(db, user.id)
    audit("password_reset", user_id=user.id, ip=get_client_ip(request))
    mailer.send_password_changed_email(user.email)
    return None


@app.post("/auth/resend-verification", response_model=GenericMessageResponse)
@limiter.limit("5/hour")
def resend_verification(body: ResendVerificationRequest, request: Request,
                        db: Session = Depends(get_db)):
    # Generic response either way so this doesn't reveal whether an address is
    # registered or already verified.
    user = db.query(User).filter(User.email_hash == hash_email(body.email)).first()
    if user is not None and not user.email_verified_at:
        token = generate_token()
        user.email_verification_hash = hash_token(token)
        user.email_verification_expires_at = to_iso(
            utcnow() + timedelta(hours=EMAIL_VERIFICATION_TTL_HOURS)
        )
        db.commit()
        mailer.send_verification_email(body.email, token)
    return GenericMessageResponse(
        detail="If that address needs verification, a new link is on its way."
    )


@app.post("/auth/login", response_model=AuthTokensResponse)
@limiter.limit("50/15minute")
def login(body: LoginRequest, request: Request,
          db: Session = Depends(get_db)):
    specs = build_auth_rate_limit_specs("login", body.email, get_client_ip(request))
    assert_auth_flow_allowed(db, specs)

    user = db.query(User).filter(User.email_hash == hash_email(body.email)).first()
    if not verify_login_password(user, body.password):
        record_auth_flow_failure(db, specs)
        audit("login_failed", user_id=user.id if user else None, ip=get_client_ip(request), reason="password")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    require_email_verified(user)

    if not user.totp_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Complete MFA enrollment before logging in",
        )

    if not verify_and_consume_totp(db, user, body.otp):
        record_auth_flow_failure(db, specs)
        audit("login_failed", user_id=user.id, ip=get_client_ip(request), reason="otp")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    session, access_token, refresh_token = create_session_tokens(
        db, user, request, body.device_name
    )
    clear_auth_flow_failures(db, specs)
    audit("login_success", user_id=user.id, ip=get_client_ip(request))
    return build_auth_tokens_response(session, access_token, refresh_token)


@app.post("/auth/login/recovery", response_model=AuthTokensResponse)
@limiter.limit("50/15minute")
def login_with_recovery_code(
    body: RecoveryLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    specs = build_auth_rate_limit_specs("recovery-login", body.email, get_client_ip(request))
    assert_auth_flow_allowed(db, specs)

    user = db.query(User).filter(User.email_hash == hash_email(body.email)).first()
    if not verify_login_password(user, body.password):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or recovery code",
        )

    require_email_verified(user)

    if not consume_recovery_code(db, user.id, body.recovery_code):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or recovery code",
        )

    session, access_token, refresh_token = create_session_tokens(
        db, user, request, body.device_name
    )
    clear_auth_flow_failures(db, specs)
    return build_auth_tokens_response(session, access_token, refresh_token)


@app.post("/auth/refresh", response_model=AuthTokensResponse)
@limiter.limit("100/hour")
def refresh_auth_session(
    body: RefreshRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    presented_hash = hash_refresh_token(body.refresh_token)
    session = db.query(UserSession).filter(
        UserSession.refresh_token_hash == presented_hash
    ).first()
    if session is None:
        # The presented token isn't current. If it matches a session's
        # *previous* (already-rotated) hash, decide between a benign race and
        # theft by how long ago rotation happened:
        #   • within a short grace window → a concurrent refresh (two tabs, a
        #     network retry): just 401 so the client re-authenticates, as before.
        #   • after the grace window → a delayed replay of a rotated token, the
        #     classic stolen-refresh signal: revoke the whole session family.
        compromised = db.query(UserSession).filter(
            UserSession.prev_refresh_token_hash == presented_hash
        ).first()
        if compromised is not None:
            rotated_at = parse_timestamp(compromised.last_used_at)
            recent = rotated_at and (utcnow() - rotated_at) < timedelta(
                seconds=REFRESH_REUSE_GRACE_SECONDS
            )
            if not recent:
                revoke_all_user_sessions(db, compromised.user_id)
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Refresh token reuse detected; all sessions were revoked. Please sign in again.",
                )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )
    if not session_is_active(session):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    user = db.query(User).filter(User.id == session.user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    session, access_token, refresh_token = create_session_tokens(
        db, user, request, session=session, label=session.label
    )
    return build_auth_tokens_response(session, access_token, refresh_token)


@app.get("/auth/sessions", response_model=List[SessionInfo])
def list_sessions(
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    sessions = db.query(UserSession).filter(
        UserSession.user_id == context.user.id
    ).all()
    sessions.sort(key=lambda item: item.last_used_at, reverse=True)
    return [
        build_session_info(session, current_session_id=context.session.id)
        for session in sessions
    ]


@app.delete("/auth/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_named_session(
    session_id: str,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    session = db.query(UserSession).filter(
        UserSession.id == session_id,
        UserSession.user_id == context.user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    revoke_session(session)
    db.commit()
    return None


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    revoke_session(context.session)
    db.commit()
    return None


@app.post("/auth/logout-all", response_model=LogoutAllResponse)
def logout_all(
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    revoked = revoke_all_user_sessions(db, context.user.id)
    return LogoutAllResponse(revoked_sessions=revoked)


@app.post("/auth/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChangeRequest,
    request: Request,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    """Change the account password (current password + OTP required). Revokes
    every other session so a compromised password can't keep a foothold."""
    if not verify_password(body.current_password, context.user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    # Session-authenticated sensitive action: plain TOTP check (no step-consume,
    # so it doesn't collide with a login's code in the same window).
    if not verify_totp(body.otp, context.user.totp_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    context.user.password_hash = hash_password(body.new_password)
    email = context.user.email
    db.commit()
    revoke_all_user_sessions(db, context.user.id, except_session_id=context.session.id)
    audit("password_changed", user_id=context.user.id, ip=get_client_ip(request))
    mailer.send_password_changed_email(email)
    return None


@app.get("/account/export")
def export_account_data(
    request: Request,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    """Machine-readable export of everything held for the account (Art. 15/20).
    Decrypted for the owner over their authenticated session."""
    audit("account_export", user_id=context.user.id, ip=get_client_ip(request))
    user = context.user
    shifts = db.query(Shift).filter(Shift.user_id == user.id).all()
    off_days = db.query(OffDay).filter(OffDay.user_id == user.id).all()
    projects = db.query(Project).filter(Project.user_id == user.id).all()
    sessions = db.query(UserSession).filter(UserSession.user_id == user.id).all()
    api_keys = db.query(ApiKey).filter(ApiKey.user_id == user.id).all()

    profile = None
    if user.profile_encrypted:
        try:
            profile = json.loads(decrypt_secret(user.profile_encrypted))
        except Exception:
            profile = None
    schedule = None
    if user.work_schedule:
        try:
            schedule = json.loads(user.work_schedule)
        except Exception:
            schedule = None

    return {
        "exported_at": sync_now(),
        "account": {
            "id": user.id,
            "email": user.email,
            "created_at": user.created_at,
            "mfa_enrolled_at": user.mfa_enrolled_at,
            "tos_accepted_at": user.tos_accepted_at,
            "tos_version": user.tos_version,
        },
        "report_profile": profile,
        "work_schedule": schedule,
        "shifts": [_serialize_sync_shift(s).model_dump() for s in shifts if s.uuid],
        "off_days": [_serialize_sync_off_day(o).model_dump() for o in off_days if o.uuid],
        "projects": [_serialize_sync_project(p).model_dump() for p in projects if p.uuid],
        "sessions": [
            {
                "label": s.label,
                "ip_address": s.ip_address,
                "user_agent": s.user_agent,
                "created_at": s.created_at,
                "last_used_at": s.last_used_at,
                "expires_at": s.expires_at,
                "revoked_at": s.revoked_at,
            }
            for s in sessions
        ],
        "api_keys": [
            {"name": k.name, "created_at": k.created_at, "last_used_at": k.last_used_at}
            for k in api_keys
        ],
    }


@app.post("/account/delete", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    body: DeleteAccountRequest,
    request: Request,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    """Irreversibly delete the account and all its data (Art. 17). Requires
    password + OTP re-verification."""
    if not verify_password(body.password, context.user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    if not verify_totp(body.otp, context.user.totp_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    user_id = context.user.id
    email = context.user.email  # capture before deletion for the confirmation email
    hard_delete_user(db, user_id)
    # Reclaim freed pages so the erased plaintext doesn't linger in the file.
    # The deletion is already committed; a VACUUM failure must not fail the call.
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("VACUUM")
    except Exception:
        pass
    audit("account_deleted", user_id=user_id, ip=get_client_ip(request))
    mailer.send_account_deleted_email(email)
    return None


def _tos_status(user: User) -> TosStatusResponse:
    accepted = user.tos_version or None
    return TosStatusResponse(
        current_version=CURRENT_TOS_VERSION,
        accepted_version=accepted,
        accepted_at=user.tos_accepted_at,
        acceptance_required=accepted != CURRENT_TOS_VERSION,
    )


@app.get("/auth/tos", response_model=TosStatusResponse)
def get_tos_status(
    context: BearerSessionContext = Depends(get_current_bearer_context),
):
    """Which terms this account accepted, and whether that is still current.

    The Terms promise registered users notice before a material change takes
    effect; this is how the app knows to show it. Deliberately read-only and
    non-blocking — the prompt is notice, not a gate, so an account that hasn't
    re-accepted keeps working (and keeps being able to export or delete).
    """
    return _tos_status(context.user)


@app.post("/auth/tos/accept", response_model=TosStatusResponse)
def accept_tos(
    body: AcceptTosRequest,
    request: Request,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    # The version travels in the body so a tab left open since before an update
    # can't blind-accept terms it never displayed — it gets told to reload.
    if body.version != CURRENT_TOS_VERSION:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="These terms are out of date. Reload the page to read the current version.",
        )
    context.user.tos_accepted_at = to_iso(utcnow())
    context.user.tos_version = CURRENT_TOS_VERSION
    db.commit()
    audit(
        "tos_accepted",
        user_id=context.user.id,
        ip=get_client_ip(request),
        version=CURRENT_TOS_VERSION,
    )
    return _tos_status(context.user)


@app.get("/auth/recovery-codes/status", response_model=RecoveryCodesStatusResponse)
def recovery_codes_status(
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    return RecoveryCodesStatusResponse(
        remaining_count=recovery_code_count(db, context.user.id)
    )


@app.post("/auth/recovery-codes/regenerate", response_model=RecoveryCodesResponse)
def regenerate_recovery_codes(
    body: RegenerateRecoveryCodesRequest,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    if not verify_password(body.password, context.user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    if not verify_totp(body.otp, context.user.totp_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )

    recovery_codes = replace_recovery_codes(db, context.user.id)
    return RecoveryCodesResponse(
        recovery_codes=recovery_codes,
        remaining_count=len(recovery_codes),
    )


@app.post("/auth/mfa/reset/start", response_model=MfaResetStartResponse)
def start_mfa_reset(
    body: MfaResetStartRequest,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    if not verify_password(body.password, context.user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )
    if not verify_totp(body.otp, context.user.totp_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password or authenticator code",
        )

    raw_totp_secret = generate_totp_secret()
    context.user.pending_totp_secret = encrypt_secret(raw_totp_secret)
    db.commit()
    return MfaResetStartResponse(
        totp_secret=raw_totp_secret,
        totp_uri=build_totp_uri(raw_totp_secret, context.user.email),
    )


@app.post("/auth/mfa/reset/confirm", response_model=RecoveryCodesResponse)
def confirm_mfa_reset(
    body: MfaResetConfirmRequest,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    if not context.user.pending_totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending authenticator reset is in progress",
        )
    if not verify_totp(body.otp, context.user.pending_totp_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticator code",
        )

    context.user.totp_secret = context.user.pending_totp_secret
    context.user.pending_totp_secret = None
    context.user.mfa_enrolled_at = to_iso(utcnow())
    context.user.last_totp_step = None
    email = context.user.email
    db.commit()

    revoke_all_user_sessions(db, context.user.id, except_session_id=context.session.id)
    recovery_codes = replace_recovery_codes(db, context.user.id)
    audit("mfa_reset", user_id=context.user.id)
    mailer.send_security_alert_email(
        email,
        "Your TrackSuite.work authenticator was reset",
        "<p>Your two-factor authenticator was just reset and other sessions were "
        "signed out. If this wasn't you, use a recovery code to regain access and "
        "change your password immediately.</p>",
    )
    return RecoveryCodesResponse(
        recovery_codes=recovery_codes,
        remaining_count=len(recovery_codes),
    )


# ── API key endpoints ────────────────────────────────────────────────


@app.post("/auth/api-keys", response_model=ApiKeyCreateResponse,
          status_code=status.HTTP_201_CREATED)
def create_api_key(
    body: ApiKeyCreateRequest,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    raw_key = generate_api_key()
    key_row = ApiKey(
        user_id=context.user.id,
        key_hash=hash_api_key(raw_key),
        name=body.name,
        created_at=to_iso(utcnow()),
    )
    db.add(key_row)
    db.commit()
    db.refresh(key_row)
    audit("api_key_created", user_id=context.user.id, key_id=key_row.id)
    return ApiKeyCreateResponse(
        id=key_row.id,
        name=key_row.name,
        key=raw_key,
        created_at=key_row.created_at,
    )


@app.get("/auth/api-keys", response_model=List[ApiKeyListItem])
def list_api_keys(
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    return db.query(ApiKey).filter(ApiKey.user_id == context.user.id).all()


@app.delete("/auth/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_api_key(
    key_id: int,
    context: BearerSessionContext = Depends(get_current_bearer_context),
    db: Session = Depends(get_db),
):
    key_row = db.query(ApiKey).filter(
        ApiKey.id == key_id, ApiKey.user_id == context.user.id
    ).first()
    if not key_row:
        raise HTTPException(status_code=404, detail="API key not found")
    db.delete(key_row)
    db.commit()
    return None


# ── Data endpoints (scoped to authenticated user) ────────────────────


@app.post("/shifts/", response_model=ShiftResponse,
          status_code=status.HTTP_201_CREATED)
def create_shift(
    shift: ShiftCreate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    # Upsert by client-supplied uuid when present; otherwise fall back to the
    # legacy natural key (start_time) so older clients keep working.
    existing = None
    if shift.uuid:
        existing = db.query(Shift).filter(
            Shift.user_id == user_id, Shift.uuid == shift.uuid
        ).first()
    if existing is None:
        existing = db.query(Shift).filter(
            Shift.user_id == user_id,
            Shift.start_time == shift.start_time,
            Shift.deleted.is_(False),
        ).first()

    if existing:
        existing.start_time = shift.start_time
        if shift.end_time:
            existing.end_time = shift.end_time
        existing.project_uuid = shift.project_uuid
        existing.note = shift.note
        existing.deleted = False
        existing.deleted_at = None
        existing.updated_at = sync_now()
        if shift.uuid and not existing.uuid:
            existing.uuid = shift.uuid
        db.flush()
        reconcile_open_shifts(db, user_id)
        db.commit()
        db.refresh(existing)
        return existing

    db_shift = Shift(
        user_id=user_id,
        uuid=shift.uuid or new_uuid(),
        start_time=shift.start_time,
        end_time=shift.end_time,
        project_uuid=shift.project_uuid,
        note=shift.note,
        updated_at=sync_now(),
        deleted=False,
        started_from=shift.started_from,
    )
    db.add(db_shift)
    db.flush()
    reconcile_open_shifts(db, user_id)
    db.commit()
    db.refresh(db_shift)
    return db_shift


@app.get("/shifts/", response_model=List[ShiftResponse])
def get_shifts(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    return db.query(Shift).filter(
        Shift.user_id == user_id, Shift.deleted.is_(False)
    ).all()


@app.delete("/shifts/{shift_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shift(
    shift_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_shift = db.query(Shift).filter(
        Shift.id == shift_id, Shift.user_id == user_id
    ).first()
    if not db_shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    db_shift.deleted = True
    db_shift.deleted_at = sync_now()
    db_shift.updated_at = db_shift.deleted_at
    # Scrub free-text PII from the tombstone: a deleted row only needs identity
    # + deletion metadata to sync, so the note must not linger in the DB.
    db_shift.note = None
    db.commit()
    return None


@app.put("/shifts/{shift_id}", response_model=ShiftResponse)
def update_shift(
    shift_id: int,
    shift_update: ShiftUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_shift = db.query(Shift).filter(
        Shift.id == shift_id, Shift.user_id == user_id
    ).first()
    if not db_shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    old_start, old_end = db_shift.start_time, db_shift.end_time
    db_shift.start_time = shift_update.start_time
    # Treat an omitted end_time as "unchanged" rather than reopening the shift
    # (M7); only an explicitly-sent value updates it.
    if "end_time" in shift_update.model_fields_set:
        db_shift.end_time = shift_update.end_time
    if "project_uuid" in shift_update.model_fields_set:
        db_shift.project_uuid = shift_update.project_uuid
    if "note" in shift_update.model_fields_set:
        db_shift.note = shift_update.note
    # The auto-close flag asks the user to check the END TIME. Only a change to
    # the shift's times (or an explicit "looks right") answers that; stamping a
    # note or project must keep the warning visible.
    times_changed = (
        db_shift.start_time != old_start or db_shift.end_time != old_end
    )
    if times_changed or shift_update.clear_auto_closed:
        db_shift.auto_closed_at = None
    db_shift.updated_at = sync_now()
    db.flush()
    # A REST edit can leave two shifts open (e.g. clearing an end_time); collapse
    # back to a single open shift like create/sync do (M7).
    reconcile_open_shifts(db, user_id)
    db.commit()
    db.refresh(db_shift)
    return db_shift



@app.post("/off-days/", response_model=OffDayResponse,
          status_code=status.HTTP_201_CREATED)
def create_off_day(
    off_day: OffDayCreate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    # An off-day is keyed by its date: upsert onto the existing row (which may
    # be a tombstone) so add / delete / re-add stays a single row per date.
    existing = db.query(OffDay).filter(
        OffDay.user_id == user_id, OffDay.date == off_day.date
    ).first()
    if existing:
        # A sent reason always wins. Without one, re-adding a tombstone starts
        # as a plain off day, and re-adding a live day keeps its reason.
        if "reason" in off_day.model_fields_set:
            existing.reason = off_day.reason
        elif existing.deleted:
            existing.reason = None
        existing.deleted = False
        existing.deleted_at = None
        existing.updated_at = sync_now()
        if off_day.uuid and not existing.uuid:
            existing.uuid = off_day.uuid
        db.commit()
        db.refresh(existing)
        return existing

    db_off_day = OffDay(
        user_id=user_id,
        uuid=off_day.uuid or new_uuid(),
        date=off_day.date,
        reason=off_day.reason,
        updated_at=sync_now(),
        deleted=False,
    )
    db.add(db_off_day)
    db.commit()
    db.refresh(db_off_day)
    return db_off_day


@app.get("/off-days/", response_model=List[OffDayResponse])
def get_off_days(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    return db.query(OffDay).filter(
        OffDay.user_id == user_id, OffDay.deleted.is_(False)
    ).all()


@app.put("/off-days/{off_day_id}", response_model=OffDayResponse)
def update_off_day(
    off_day_id: int,
    off_day_update: OffDayUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_off_day = db.query(OffDay).filter(
        OffDay.id == off_day_id,
        OffDay.user_id == user_id,
        OffDay.deleted.is_(False),
    ).first()
    if not db_off_day:
        raise HTTPException(status_code=404, detail="Off day not found")
    db_off_day.reason = off_day_update.reason
    db_off_day.updated_at = sync_now()
    db.commit()
    db.refresh(db_off_day)
    return db_off_day


@app.delete("/off-days/{off_day_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_off_day(
    off_day_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_off_day = db.query(OffDay).filter(
        OffDay.id == off_day_id, OffDay.user_id == user_id
    ).first()
    if not db_off_day:
        raise HTTPException(status_code=404, detail="Off day not found")
    db_off_day.deleted = True
    db_off_day.deleted_at = sync_now()
    db_off_day.updated_at = db_off_day.deleted_at
    db.commit()
    return None


# ── Report profile endpoints ─────────────────────────────────────────


@app.get("/profile/", response_model=ProfileResponse)
def get_profile(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.profile_encrypted:
        return ProfileResponse(profile=None, profile_updated_at=None)
    try:
        raw = decrypt_secret(user.profile_encrypted)
        profile = json.loads(raw)
    except Exception:
        # Corrupt / key-rotated blob: surface as empty rather than 500 so the
        # user can just re-save a fresh profile.
        return ProfileResponse(profile=None, profile_updated_at=user.profile_updated_at)
    return ProfileResponse(profile=profile, profile_updated_at=user.profile_updated_at)


@app.put("/profile/", response_model=ProfileResponse)
def update_profile(
    body: ProfileUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    raw = json.dumps(body.profile, separators=(",", ":"))
    if len(raw.encode("utf-8")) > PROFILE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Profile is too large.")
    user.profile_encrypted = encrypt_secret(raw)
    user.profile_updated_at = sync_now()
    db.commit()
    return ProfileResponse(profile=body.profile, profile_updated_at=user.profile_updated_at)


# ── Work-schedule endpoints ──────────────────────────────────────────


@app.get("/work-schedule/", response_model=WorkScheduleResponse)
def get_work_schedule(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.work_schedule:
        return WorkScheduleResponse(schedule=None, schedule_updated_at=None)
    try:
        schedule = json.loads(user.work_schedule)
    except Exception:
        # Corrupt blob: surface as empty rather than 500; the client can re-save.
        return WorkScheduleResponse(schedule=None, schedule_updated_at=user.work_schedule_updated_at)
    return WorkScheduleResponse(schedule=schedule, schedule_updated_at=user.work_schedule_updated_at)


@app.put("/work-schedule/", response_model=WorkScheduleResponse)
def update_work_schedule(
    body: WorkScheduleUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    raw = json.dumps(body.schedule, separators=(",", ":"))
    if len(raw.encode("utf-8")) > WORK_SCHEDULE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Work schedule is too large.")
    user.work_schedule = raw
    user.work_schedule_updated_at = sync_now()
    db.commit()
    return WorkScheduleResponse(schedule=body.schedule, schedule_updated_at=user.work_schedule_updated_at)


# ── Project endpoints ────────────────────────────────────────────────


@app.post("/projects/", response_model=ProjectResponse,
          status_code=status.HTTP_201_CREATED)
def create_project(
    project: ProjectCreate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    existing = None
    if project.uuid:
        existing = db.query(Project).filter(
            Project.user_id == user_id, Project.uuid == project.uuid
        ).first()
    if existing:
        existing.name = project.name
        existing.color = project.color
        existing.rate = project.rate
        existing.currency = project.currency
        existing.deleted = False
        existing.deleted_at = None
        existing.updated_at = sync_now()
        db.commit()
        db.refresh(existing)
        return existing

    db_project = Project(
        user_id=user_id,
        uuid=project.uuid or new_uuid(),
        name=project.name,
        color=project.color,
        rate=project.rate,
        currency=project.currency,
        archived=False,
        updated_at=sync_now(),
        deleted=False,
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)
    return db_project


@app.get("/projects/", response_model=List[ProjectResponse])
def get_projects(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    return db.query(Project).filter(
        Project.user_id == user_id, Project.deleted.is_(False)
    ).all()


@app.put("/projects/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: int,
    body: ProjectUpdate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_project = db.query(Project).filter(
        Project.id == project_id, Project.user_id == user_id
    ).first()
    if not db_project:
        raise HTTPException(status_code=404, detail="Project not found")
    if "name" in body.model_fields_set and body.name is not None:
        db_project.name = body.name
    if "color" in body.model_fields_set:
        db_project.color = body.color
    if "archived" in body.model_fields_set and body.archived is not None:
        db_project.archived = body.archived
    if "rate" in body.model_fields_set:
        db_project.rate = body.rate
    if "currency" in body.model_fields_set:
        db_project.currency = body.currency
    db_project.updated_at = sync_now()
    db.commit()
    db.refresh(db_project)
    return db_project


@app.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_project = db.query(Project).filter(
        Project.id == project_id, Project.user_id == user_id
    ).first()
    if not db_project:
        raise HTTPException(status_code=404, detail="Project not found")
    now = sync_now()
    db_project.deleted = True
    db_project.deleted_at = now
    db_project.updated_at = now
    # Scrub identifying/billing PII from the tombstone (name → "" keeps the
    # column non-null for old desktop deserializers; rate cleared).
    db_project.name = ""
    db_project.rate = None
    # Detach the project from any shifts so they revert to "Unassigned"
    # instead of referencing a deleted project.
    if db_project.uuid:
        db.query(Shift).filter(
            Shift.user_id == user_id,
            Shift.project_uuid == db_project.uuid,
            Shift.deleted.is_(False),
        ).update(
            {Shift.project_uuid: None, Shift.updated_at: now},
            synchronize_session=False,
        )
    db.commit()
    return None


# ── Full-state sync endpoint (used by the local-first desktop client) ─


def _serialize_sync_shift(shift: Shift) -> SyncShift:
    # Tombstones carry no content: a deleted row only needs its identity +
    # deletion metadata to propagate, so the note (free-text PII) is withheld.
    deleted = bool(shift.deleted)
    return SyncShift(
        uuid=shift.uuid,
        start_time=shift.start_time,
        end_time=shift.end_time,
        project_uuid=shift.project_uuid,
        note=None if deleted else shift.note,
        updated_at=shift.updated_at or "",
        deleted=deleted,
        deleted_at=shift.deleted_at,
        auto_closed_at=shift.auto_closed_at,
        started_from=shift.started_from,
    )


def _serialize_sync_off_day(off_day: OffDay) -> SyncOffDay:
    return SyncOffDay(
        uuid=off_day.uuid,
        date=off_day.date,
        reason=off_day.reason,
        updated_at=off_day.updated_at or "",
        deleted=bool(off_day.deleted),
        deleted_at=off_day.deleted_at,
    )


def _serialize_sync_project(project: Project) -> SyncProject:
    # Tombstones carry no content. name stays a string ("" not null) so older
    # desktop clients — whose deserializer requires a non-optional name — keep
    # working; rate (billing PII) is withheld entirely.
    deleted = bool(project.deleted)
    return SyncProject(
        uuid=project.uuid,
        name="" if deleted else project.name,
        color=project.color,
        archived=bool(project.archived),
        rate=None if deleted else project.rate,
        currency=project.currency,
        updated_at=project.updated_at or "",
        deleted=deleted,
        deleted_at=project.deleted_at,
    )


def _end_of_start_day(start_time: str) -> str:
    """23:59:59 on the shift's own start date, preserving the original
    timestamp's timezone frame (Z / +HH:MM / -HH:MM / naive) so the bounded
    shift stays within its start day and never goes negative."""
    date_part = start_time[:10]
    tail = start_time[10:]  # "T08:59:34.123Z" | "T08:59:34+00:00" | "T08:59:34"
    tz = ""
    if tail.endswith("Z"):
        tz = "Z"
    elif "+" in tail:
        tz = "+" + tail.split("+", 1)[1]
    else:
        idx = tail.rfind("-")  # any '-' after the leading 'T' is an offset
        if idx > 0:
            tz = tail[idx:]
    return f"{date_part}T23:59:59{tz}"


def reconcile_open_shifts(db: Session, user_id: int) -> None:
    """Enforce at most one open shift per user.

    Cross-device races and pre-0.8 clients could leave several shifts open at
    once; when eventually closed to "now" they became month-spanning. Here the
    server keeps the most recently started open shift active and auto-closes the
    rest to the end of their own start day, flagging them (``auto_closed_at``) so
    clients can surface them for the user to correct. Idempotent; a no-op unless
    two or more open shifts exist. Does not commit."""
    open_shifts = (
        db.query(Shift)
        .filter(
            Shift.user_id == user_id,
            Shift.end_time.is_(None),
            Shift.deleted.is_(False),
        )
        .order_by(Shift.start_time.asc(), Shift.id.asc())
        .all()
    )
    if len(open_shifts) <= 1:
        return
    ts = sync_now()
    for shift in open_shifts[:-1]:  # keep the most recently started one open
        shift.end_time = _end_of_start_day(shift.start_time)
        shift.auto_closed_at = ts
        shift.updated_at = ts


def _full_sync_state(db: Session, user_id: int) -> SyncStateResponse:
    shifts = db.query(Shift).filter(Shift.user_id == user_id).all()
    off_days = db.query(OffDay).filter(OffDay.user_id == user_id).all()
    projects = db.query(Project).filter(Project.user_id == user_id).all()
    return SyncStateResponse(
        shifts=[_serialize_sync_shift(s) for s in shifts if s.uuid],
        off_days=[_serialize_sync_off_day(o) for o in off_days if o.uuid],
        projects=[_serialize_sync_project(p) for p in projects if p.uuid],
        server_time=sync_now(),
    )


@app.get("/sync/", response_model=SyncStateResponse)
def get_sync_state(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    return _full_sync_state(db, user_id)


@app.post("/sync/", response_model=SyncStateResponse)
def push_sync_state(
    body: SyncPushRequest,
    user_id: int = Depends(limit_sync_push),
    db: Session = Depends(get_db),
):
    """Merge the client's full local state (last-write-wins) and return the
    server's authoritative merged state, including tombstones."""
    for incoming in body.shifts:
        # Clamp the client timestamp so it can't poison last-write-wins (H4).
        inc_ts = sanitized_sync_ts(incoming.updated_at)
        row = db.query(Shift).filter(
            Shift.user_id == user_id, Shift.uuid == incoming.uuid
        ).first()
        if row is None and not incoming.deleted:
            # First-sync reconciliation: a shift that predates sync may already
            # exist here under a different backfilled uuid. Match it by its
            # natural key (start_time) and adopt the client's uuid so both
            # sides converge on one identity instead of duplicating.
            legacy = db.query(Shift).filter(
                Shift.user_id == user_id,
                Shift.start_time == incoming.start_time,
                Shift.deleted.is_(False),
            ).first()
            if legacy is not None:
                legacy.uuid = incoming.uuid
                row = legacy
        if row is None:
            # Don't materialize a tombstone for a row we never had (nothing for
            # other devices to learn; avoids deleted-row amplification).
            if incoming.deleted:
                continue
            db.add(Shift(
                user_id=user_id,
                uuid=incoming.uuid,
                start_time=incoming.start_time,
                end_time=incoming.end_time,
                project_uuid=incoming.project_uuid,
                note=incoming.note,
                updated_at=inc_ts,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
                auto_closed_at=incoming.auto_closed_at,
                started_from=incoming.started_from,
            ))
        elif sync_ts_greater(inc_ts, row.updated_at):
            row.start_time = incoming.start_time
            row.end_time = incoming.end_time
            row.project_uuid = incoming.project_uuid
            # Scrub the note when the winning write is a deletion.
            row.note = None if incoming.deleted else incoming.note
            row.updated_at = inc_ts
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at
            # A newer client write owns the flag: clients that don't know the
            # field send None, which clears it once the user edits the shift
            # (i.e. addresses the auto-close); the web app round-trips it.
            row.auto_closed_at = incoming.auto_closed_at
            # Origin is immutable metadata: only backfill it, never overwrite.
            if row.started_from is None:
                row.started_from = incoming.started_from

    for incoming in body.projects:
        inc_ts = sanitized_sync_ts(incoming.updated_at)
        row = db.query(Project).filter(
            Project.user_id == user_id, Project.uuid == incoming.uuid
        ).first()
        if row is None:
            if incoming.deleted:
                continue
            db.add(Project(
                user_id=user_id,
                uuid=incoming.uuid,
                name=incoming.name,
                color=incoming.color,
                archived=incoming.archived,
                rate=incoming.rate,
                currency=incoming.currency,
                updated_at=inc_ts,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
            ))
        elif sync_ts_greater(inc_ts, row.updated_at):
            # Scrub identifying/billing PII when the winning write is a deletion.
            row.name = "" if incoming.deleted else incoming.name
            row.color = incoming.color
            row.archived = incoming.archived
            row.rate = None if incoming.deleted else incoming.rate
            row.currency = incoming.currency
            row.updated_at = inc_ts
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at

    for incoming in body.off_days:
        inc_ts = sanitized_sync_ts(incoming.updated_at)
        # Off-days merge on (user_id, date), resurrecting tombstones.
        row = db.query(OffDay).filter(
            OffDay.user_id == user_id, OffDay.date == incoming.date
        ).first()
        if row is None:
            if incoming.deleted:
                continue
            db.add(OffDay(
                user_id=user_id,
                uuid=incoming.uuid,
                date=incoming.date,
                reason=incoming.reason,
                updated_at=inc_ts,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
            ))
        elif sync_ts_greater(inc_ts, row.updated_at):
            # The newer write carries the reason. An older client does not
            # send the field: keep the stored reason, except when it re-adds a
            # deleted day, which starts again as a plain off day.
            if "reason" in incoming.model_fields_set:
                row.reason = incoming.reason
            elif row.deleted and not incoming.deleted:
                row.reason = None
            row.updated_at = inc_ts
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at

    # Collapse any multiple-open-shift state (cross-device race / old clients)
    # down to a single open shift before returning the authoritative state.
    db.flush()
    reconcile_open_shifts(db, user_id)
    db.commit()
    return _full_sync_state(db, user_id)


@app.get("/stats/daily-hours/", response_model=Dict[str, float])
def get_daily_hours(
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    shifts = (
        db.query(Shift)
        .filter(
            Shift.user_id == user_id,
            Shift.deleted.is_(False),
            Shift.end_time.is_not(None),
        )
        .all()
    )
    tz = report_timezone()
    daily_totals: Dict[str, float] = {}
    for shift in shifts:
        if not shift.end_time:
            continue
        start = to_local_naive(shift.start_time, tz)
        end = to_local_naive(shift.end_time, tz)
        if start is None or end is None or end < start:
            continue
        duration_hours = (end - start).total_seconds() / 3600
        date_str = start.strftime("%Y-%m-%d")
        daily_totals[date_str] = daily_totals.get(date_str, 0) + duration_hours
    return {key: round(value, 2) for key, value in daily_totals.items()}

# Kick off the background retention sweep (disabled in tests via
# WORK_TIME_DISABLE_MAINTENANCE=1).
start_maintenance_thread()
