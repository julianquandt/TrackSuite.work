from sqlalchemy import String, TypeDecorator
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .auth import decrypt_at_rest, encrypt_at_rest


class EncryptedString(TypeDecorator):
    """A text column transparently Fernet-encrypted at rest.

    Values are encrypted on write and decrypted on read, so the Python side
    (ORM attributes, response models, sync serialization) always sees
    plaintext while the SQLite file only ever holds ciphertext. Legacy
    plaintext rows read back unchanged until they're next written, which the
    startup migration forces. NEVER use an EncryptedString column in a SQL
    WHERE/ORDER BY — Fernet is non-deterministic, so equality never matches;
    filter on a separate keyed-hash column instead (see User.email_hash)."""

    impl = String
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return encrypt_at_rest(value)

    def process_result_value(self, value, dialect):
        return decrypt_at_rest(value)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    # Encrypted at rest; look users up by email_hash, never by this column.
    email: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    # Keyed HMAC of the normalized email — the unique key and login lookup.
    email_hash: Mapped[str | None] = mapped_column(unique=True, index=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(nullable=False)
    totp_secret: Mapped[str] = mapped_column(nullable=False, default="")
    pending_totp_secret: Mapped[str | None] = mapped_column(nullable=True)
    mfa_enrolled_at: Mapped[str | None] = mapped_column(nullable=True)
    # Highest TOTP time-step already accepted for a login-class action; blocks
    # replay of the same code within its acceptance window.
    last_totp_step: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[str] = mapped_column(nullable=False)
    # Terms/privacy acceptance captured at registration (GDPR consent record).
    tos_accepted_at: Mapped[str | None] = mapped_column(nullable=True)
    tos_version: Mapped[str | None] = mapped_column(nullable=True)
    # Email ownership verification (anti-squatting; enables breach notices).
    # Existing accounts are grandfathered verified by the migration.
    email_verified_at: Mapped[str | None] = mapped_column(nullable=True)
    email_verification_hash: Mapped[str | None] = mapped_column(nullable=True)
    email_verification_expires_at: Mapped[str | None] = mapped_column(nullable=True)
    # Storage-limitation retention: when an inactivity-warning email was sent, so
    # a stale account is deleted only after a grace period past the warning.
    inactivity_warned_at: Mapped[str | None] = mapped_column(nullable=True)
    # Password-reset link (hashed token + expiry).
    password_reset_hash: Mapped[str | None] = mapped_column(nullable=True)
    password_reset_expires_at: Mapped[str | None] = mapped_column(nullable=True)
    # Report profile (name, company, letterhead, custom fields, default
    # currency) — a JSON blob, Fernet-encrypted at rest. Last-write-wins by
    # profile_updated_at (canonical UTC microsecond timestamp).
    profile_encrypted: Mapped[str | None] = mapped_column(nullable=True)
    profile_updated_at: Mapped[str | None] = mapped_column(nullable=True)
    # Weekly work schedule (target hours per weekday) — a small JSON object,
    # encrypted at rest. Last-write-wins by work_schedule_updated_at.
    work_schedule: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)
    work_schedule_updated_at: Mapped[str | None] = mapped_column(nullable=True)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(index=True, nullable=False)
    key_hash: Mapped[str] = mapped_column(unique=True, nullable=False)
    # User-chosen device label — often identifying ("Julia's ThinkPad").
    name: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    created_at: Mapped[str] = mapped_column(nullable=False)
    # Visibility so a leaked key can be spotted; optional hard expiry.
    last_used_at: Mapped[str | None] = mapped_column(nullable=True)
    expires_at: Mapped[str | None] = mapped_column(nullable=True)


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
    # Previous refresh-token hash, kept for one rotation so replay of an
    # already-rotated token is detected as theft and revokes the session.
    prev_refresh_token_hash: Mapped[str | None] = mapped_column(index=True, nullable=True)
    created_at: Mapped[str] = mapped_column(nullable=False)
    last_used_at: Mapped[str] = mapped_column(nullable=False)
    expires_at: Mapped[str] = mapped_column(nullable=False)
    # Absolute expiry independent of refresh (caps total session lifetime).
    absolute_expires_at: Mapped[str | None] = mapped_column(nullable=True)
    revoked_at: Mapped[str | None] = mapped_column(nullable=True)
    ip_address: Mapped[str | None] = mapped_column(nullable=True)
    user_agent: Mapped[str | None] = mapped_column(nullable=True)
    # User-chosen / user-agent-derived device label — encrypted at rest.
    label: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)


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
    # Optional free-text description of what was worked on (shown in reports).
    # Free text may hold client names / matter details — encrypted at rest.
    note: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)
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
    # Project names often identify clients ("Acme GmbH retainer") — encrypted.
    name: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    color: Mapped[str | None] = mapped_column(nullable=True)
    archived: Mapped[bool] = mapped_column(nullable=False, default=False)
    # Optional billing info for reports: hourly `rate` (stored as a string to
    # avoid float rounding) in `currency`. Commercially sensitive — the rate is
    # encrypted at rest; currency stays clear (not identifying on its own).
    rate: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)
    currency: Mapped[str | None] = mapped_column(nullable=True)
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
    # Why the day is off: NULL for a plain off day, else a short code such as
    # "vacation", "sick", "holiday" or "other". The clients own the labels.
    reason: Mapped[str | None] = mapped_column(nullable=True)
    # Sync metadata (canonical UTC microsecond timestamps).
    updated_at: Mapped[str | None] = mapped_column(nullable=True)
    deleted: Mapped[bool] = mapped_column(nullable=False, default=False)
    deleted_at: Mapped[str | None] = mapped_column(nullable=True)