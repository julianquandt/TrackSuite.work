from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import os
import uuid as uuid_lib
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, ConfigDict, EmailStr
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from starlette.responses import JSONResponse

from .auth import (
    access_token_expires_in_seconds,
    build_totp_uri,
    create_access_token,
    decode_access_token,
    encrypt_secret,
    generate_api_key,
    generate_recovery_codes,
    generate_refresh_token,
    generate_session_id,
    generate_totp_secret,
    hash_api_key,
    hash_password,
    hash_recovery_code,
    hash_refresh_token,
    is_encrypted_secret,
    validate_auth_configuration,
    verify_password,
    verify_recovery_code,
    verify_totp,
)
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


def sync_ts_greater(a: Optional[str], b: Optional[str]) -> bool:
    """True if timestamp ``a`` is strictly newer than ``b`` (None = oldest)."""
    if a is None:
        return False
    if b is None:
        return True
    return a > b


def parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value)


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

    with SessionLocal() as db:
        migrated = False
        for user in db.query(User).all():
            if user.totp_secret and not is_encrypted_secret(user.totp_secret):
                user.totp_secret = encrypt_secret(user.totp_secret)
                if not user.mfa_enrolled_at:
                    user.mfa_enrolled_at = user.created_at
                migrated = True
            if user.pending_totp_secret and not is_encrypted_secret(user.pending_totp_secret):
                user.pending_totp_secret = encrypt_secret(user.pending_totp_secret)
                migrated = True
        if migrated:
            db.commit()


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
            return forwarded.split(",")[0].strip()
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return real_ip
    return client_host


def ip_rate_limit_key(request: Request) -> str:
    return get_client_ip(request)


limiter = Limiter(key_func=ip_rate_limit_key)

app = FastAPI(title="Work Time Tracker API")
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429, content={"detail": "Rate limit exceeded"}
    )


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
        row = db.get(AuthRateLimit, key)
        if row is not None:
            db.delete(row)
    db.commit()


def session_is_active(session: UserSession) -> bool:
    if session.revoked_at:
        return False
    expires_at = parse_timestamp(session.expires_at)
    return bool(expires_at and expires_at > utcnow())


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

    if session is None:
        session = UserSession(
            id=generate_session_id(),
            user_id=user.id,
            refresh_token_hash=refresh_token_hash,
            created_at=to_iso(now),
            last_used_at=to_iso(now),
            expires_at=to_iso(now + timedelta(days=30)),
            revoked_at=None,
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("user-agent", "")[:255] or None,
            label=session_label_from_request(request, label),
        )
        db.add(session)
    else:
        session.refresh_token_hash = refresh_token_hash
        session.last_used_at = to_iso(now)
        session.expires_at = to_iso(now + timedelta(days=30))
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
        return get_current_bearer_context(request=request, bearer=bearer, db=db).user.id

    if x_api_key:
        hashed = hash_api_key(x_api_key)
        key_row = db.query(ApiKey).filter(ApiKey.key_hash == hashed).first()
        if key_row:
            if request.method in ("POST", "PUT", "DELETE"):
                app_version = request.headers.get("x-app-version")
                if not is_version_at_least(app_version, "0.8.1"):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Desktop app upgrade required to v0.8.1 or newer to push data."
                    )
            return key_row.user_id
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid API key",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
    )


# ── Pydantic schemas ────────────────────────────────────────────────


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str


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


class EnrollmentCompleteResponse(AuthTokensResponse):
    recovery_codes: List[str]


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


class RegisterResponse(BaseModel):
    id: int
    email: str
    created_at: str
    totp_secret: str
    totp_uri: str


class ApiKeyCreateRequest(BaseModel):
    name: str


class ApiKeyCreateResponse(BaseModel):
    id: int
    name: str
    key: str
    created_at: str


class ApiKeyListItem(BaseModel):
    id: int
    name: str
    created_at: str
    model_config = ConfigDict(from_attributes=True)


class ShiftCreate(BaseModel):
    start_time: str
    end_time: Optional[str] = None
    uuid: Optional[str] = None
    project_uuid: Optional[str] = None


class ShiftResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    start_time: str
    end_time: Optional[str] = None
    project_uuid: Optional[str] = None
    updated_at: Optional[str] = None
    deleted: bool = False
    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    name: str
    color: Optional[str] = None
    uuid: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    archived: Optional[bool] = None


class ProjectResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    name: str
    color: Optional[str] = None
    archived: bool = False
    updated_at: Optional[str] = None
    deleted: bool = False
    model_config = ConfigDict(from_attributes=True)


class OffDayCreate(BaseModel):
    date: str
    uuid: Optional[str] = None


class OffDayResponse(BaseModel):
    id: int
    user_id: int
    uuid: Optional[str] = None
    date: str
    updated_at: Optional[str] = None
    deleted: bool = False
    model_config = ConfigDict(from_attributes=True)


# ── Full-state sync schemas ──────────────────────────────────────────


class SyncShift(BaseModel):
    uuid: str
    start_time: str
    end_time: Optional[str] = None
    project_uuid: Optional[str] = None
    updated_at: str
    deleted: bool = False
    deleted_at: Optional[str] = None


class SyncOffDay(BaseModel):
    uuid: str
    date: str
    updated_at: str
    deleted: bool = False
    deleted_at: Optional[str] = None


class SyncProject(BaseModel):
    uuid: str
    name: str
    color: Optional[str] = None
    archived: bool = False
    updated_at: str
    deleted: bool = False
    deleted_at: Optional[str] = None


class SyncPushRequest(BaseModel):
    shifts: List[SyncShift] = []
    off_days: List[SyncOffDay] = []
    projects: List[SyncProject] = []


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


# ── Root ─────────────────────────────────────────────────────────────


@app.get("/")
async def read_root():
    return {"status": "ok", "message": "Work Time Tracker API"}


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
    if db.query(User).filter(User.email == body.email).first():
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    raw_totp_secret = generate_totp_secret()
    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        totp_secret="",
        pending_totp_secret=encrypt_secret(raw_totp_secret),
        mfa_enrolled_at=None,
        created_at=to_iso(utcnow()),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    clear_auth_flow_failures(db, specs)
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

    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.password_hash):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    if not user.pending_totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending MFA enrollment was found for this account",
        )

    if not verify_totp(body.otp, user.pending_totp_secret):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    user.totp_secret = user.pending_totp_secret
    user.pending_totp_secret = None
    user.mfa_enrolled_at = to_iso(utcnow())
    db.commit()

    recovery_codes = replace_recovery_codes(db, user.id)
    session, access_token, refresh_token = create_session_tokens(
        db, user, request, body.device_name
    )
    clear_auth_flow_failures(db, specs)
    return EnrollmentCompleteResponse(
        **build_auth_tokens_response(session, access_token, refresh_token).model_dump(),
        recovery_codes=recovery_codes,
    )


@app.post("/auth/login", response_model=AuthTokensResponse)
@limiter.limit("50/15minute")
def login(body: LoginRequest, request: Request,
          db: Session = Depends(get_db)):
    specs = build_auth_rate_limit_specs("login", body.email, get_client_ip(request))
    assert_auth_flow_allowed(db, specs)

    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.password_hash):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    if not user.totp_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Complete MFA enrollment before logging in",
        )

    if not verify_totp(body.otp, user.totp_secret):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or authenticator code",
        )

    session, access_token, refresh_token = create_session_tokens(
        db, user, request, body.device_name
    )
    clear_auth_flow_failures(db, specs)
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

    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.password_hash):
        record_auth_flow_failure(db, specs)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email, password, or recovery code",
        )

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
    session = db.query(UserSession).filter(
        UserSession.refresh_token_hash == hash_refresh_token(body.refresh_token)
    ).first()
    if not session or not session_is_active(session):
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
    db.commit()

    revoke_all_user_sessions(db, context.user.id, except_session_id=context.session.id)
    recovery_codes = replace_recovery_codes(db, context.user.id)
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
        existing.deleted = False
        existing.deleted_at = None
        existing.updated_at = sync_now()
        if shift.uuid and not existing.uuid:
            existing.uuid = shift.uuid
        db.commit()
        db.refresh(existing)
        return existing

    db_shift = Shift(
        user_id=user_id,
        uuid=shift.uuid or new_uuid(),
        start_time=shift.start_time,
        end_time=shift.end_time,
        project_uuid=shift.project_uuid,
        updated_at=sync_now(),
        deleted=False,
    )
    db.add(db_shift)
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
    db.commit()
    return None


@app.put("/shifts/{shift_id}", response_model=ShiftResponse)
def update_shift(
    shift_id: int,
    shift_update: ShiftCreate,
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    db_shift = db.query(Shift).filter(
        Shift.id == shift_id, Shift.user_id == user_id
    ).first()
    if not db_shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    db_shift.start_time = shift_update.start_time
    db_shift.end_time = shift_update.end_time
    if "project_uuid" in shift_update.model_fields_set:
        db_shift.project_uuid = shift_update.project_uuid
    db_shift.updated_at = sync_now()
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
    return SyncShift(
        uuid=shift.uuid,
        start_time=shift.start_time,
        end_time=shift.end_time,
        project_uuid=shift.project_uuid,
        updated_at=shift.updated_at or "",
        deleted=bool(shift.deleted),
        deleted_at=shift.deleted_at,
    )


def _serialize_sync_off_day(off_day: OffDay) -> SyncOffDay:
    return SyncOffDay(
        uuid=off_day.uuid,
        date=off_day.date,
        updated_at=off_day.updated_at or "",
        deleted=bool(off_day.deleted),
        deleted_at=off_day.deleted_at,
    )


def _serialize_sync_project(project: Project) -> SyncProject:
    return SyncProject(
        uuid=project.uuid,
        name=project.name,
        color=project.color,
        archived=bool(project.archived),
        updated_at=project.updated_at or "",
        deleted=bool(project.deleted),
        deleted_at=project.deleted_at,
    )


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
    user_id: int = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Merge the client's full local state (last-write-wins) and return the
    server's authoritative merged state, including tombstones."""
    for incoming in body.shifts:
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
            db.add(Shift(
                user_id=user_id,
                uuid=incoming.uuid,
                start_time=incoming.start_time,
                end_time=incoming.end_time,
                project_uuid=incoming.project_uuid,
                updated_at=incoming.updated_at,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
            ))
        elif sync_ts_greater(incoming.updated_at, row.updated_at):
            row.start_time = incoming.start_time
            row.end_time = incoming.end_time
            row.project_uuid = incoming.project_uuid
            row.updated_at = incoming.updated_at
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at

    for incoming in body.projects:
        row = db.query(Project).filter(
            Project.user_id == user_id, Project.uuid == incoming.uuid
        ).first()
        if row is None:
            db.add(Project(
                user_id=user_id,
                uuid=incoming.uuid,
                name=incoming.name,
                color=incoming.color,
                archived=incoming.archived,
                updated_at=incoming.updated_at,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
            ))
        elif sync_ts_greater(incoming.updated_at, row.updated_at):
            row.name = incoming.name
            row.color = incoming.color
            row.archived = incoming.archived
            row.updated_at = incoming.updated_at
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at

    for incoming in body.off_days:
        # Off-days merge on (user_id, date), resurrecting tombstones.
        row = db.query(OffDay).filter(
            OffDay.user_id == user_id, OffDay.date == incoming.date
        ).first()
        if row is None:
            db.add(OffDay(
                user_id=user_id,
                uuid=incoming.uuid,
                date=incoming.date,
                updated_at=incoming.updated_at,
                deleted=incoming.deleted,
                deleted_at=incoming.deleted_at,
            ))
        elif sync_ts_greater(incoming.updated_at, row.updated_at):
            row.updated_at = incoming.updated_at
            row.deleted = incoming.deleted
            row.deleted_at = incoming.deleted_at

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
    daily_totals: Dict[str, float] = {}
    for shift in shifts:
        if not shift.end_time:
            continue
        start = datetime.fromisoformat(shift.start_time)
        end = datetime.fromisoformat(shift.end_time)
        duration_hours = (end - start).total_seconds() / 3600
        date_str = start.strftime("%Y-%m-%d")
        daily_totals[date_str] = daily_totals.get(date_str, 0) + duration_hours
    return {key: round(value, 2) for key, value in daily_totals.items()}