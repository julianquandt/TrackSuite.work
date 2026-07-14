from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(nullable=False)
    totp_secret: Mapped[str] = mapped_column(nullable=False, default="")
    pending_totp_secret: Mapped[str | None] = mapped_column(nullable=True)
    mfa_enrolled_at: Mapped[str | None] = mapped_column(nullable=True)
    created_at: Mapped[str] = mapped_column(nullable=False)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True, nullable=False)
    key_hash: Mapped[str] = mapped_column(unique=True, nullable=False)
    name: Mapped[str] = mapped_column(nullable=False)
    created_at: Mapped[str] = mapped_column(nullable=False)


class RecoveryCode(Base):
    __tablename__ = "recovery_codes"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True, nullable=False)
    code_hash: Mapped[str] = mapped_column(nullable=False)
    created_at: Mapped[str] = mapped_column(nullable=False)
    used_at: Mapped[str | None] = mapped_column(nullable=True)


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(index=True, nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(unique=True, nullable=False)
    created_at: Mapped[str] = mapped_column(nullable=False)
    last_used_at: Mapped[str] = mapped_column(nullable=False)
    expires_at: Mapped[str] = mapped_column(nullable=False)
    revoked_at: Mapped[str | None] = mapped_column(nullable=True)
    ip_address: Mapped[str | None] = mapped_column(nullable=True)
    user_agent: Mapped[str | None] = mapped_column(nullable=True)
    label: Mapped[str | None] = mapped_column(nullable=True)


class AuthRateLimit(Base):
    __tablename__ = "auth_rate_limits"

    key: Mapped[str] = mapped_column(primary_key=True)
    attempts: Mapped[int] = mapped_column(nullable=False, default=0)
    window_started_at: Mapped[str] = mapped_column(nullable=False)
    blocked_until: Mapped[str | None] = mapped_column(nullable=True)


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True)
    # Stable, client-generated identity used for cross-device sync.
    uuid: Mapped[str | None] = mapped_column(index=True, nullable=True)
    start_time: Mapped[str] = mapped_column(nullable=False)
    end_time: Mapped[str | None] = mapped_column(nullable=True)
    # Optional project attribution (uuid of a Project row; NULL = unassigned).
    project_uuid: Mapped[str | None] = mapped_column(index=True, nullable=True)
    # Sync metadata (canonical UTC microsecond timestamps).
    updated_at: Mapped[str | None] = mapped_column(nullable=True)
    deleted: Mapped[bool] = mapped_column(nullable=False, default=False)
    deleted_at: Mapped[str | None] = mapped_column(nullable=True)
    # Set by the server when it auto-closes a shift that was left open while a
    # newer one started (enforces at most one open shift per user). Recoverable:
    # the client surfaces these so the user can fix the end time; cleared on edit.
    auto_closed_at: Mapped[str | None] = mapped_column(nullable=True)
    # Origin of the shift ("desktop" | "web"); immutable metadata used for
    # reports and to scope client-side stale-session cleanup to its own shifts.
    started_from: Mapped[str | None] = mapped_column(nullable=True)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True)
    # Stable, client-generated identity used for cross-device sync.
    uuid: Mapped[str | None] = mapped_column(index=True, nullable=True)
    name: Mapped[str] = mapped_column(nullable=False)
    color: Mapped[str | None] = mapped_column(nullable=True)
    archived: Mapped[bool] = mapped_column(nullable=False, default=False)
    # Sync metadata (canonical UTC microsecond timestamps).
    updated_at: Mapped[str | None] = mapped_column(nullable=True)
    deleted: Mapped[bool] = mapped_column(nullable=False, default=False)
    deleted_at: Mapped[str | None] = mapped_column(nullable=True)


class OffDay(Base):
    __tablename__ = "off_days"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True)
    # An off-day is identified by its date; uuid is carried for parity only.
    uuid: Mapped[str | None] = mapped_column(index=True, nullable=True)
    date: Mapped[str] = mapped_column(nullable=False)
    # Sync metadata (canonical UTC microsecond timestamps).
    updated_at: Mapped[str | None] = mapped_column(nullable=True)
    deleted: Mapped[bool] = mapped_column(nullable=False, default=False)
    deleted_at: Mapped[str | None] = mapped_column(nullable=True)