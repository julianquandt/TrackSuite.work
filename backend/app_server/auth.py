"""Authentication utilities: validated secrets, encrypted MFA state, JWT access tokens, refresh tokens, and recovery codes."""

import hashlib
import hmac
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional
from uuid import uuid4

import jwt
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken, MultiFernet

ph = PasswordHasher()

DEFAULT_JWT_SECRET = "change-me-in-production"
JWT_SECRET = os.environ.get("WORK_TIME_JWT_SECRET", DEFAULT_JWT_SECRET)
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 30
MIN_JWT_SECRET_LENGTH = 32
TOTP_ISSUER = os.environ.get("WORK_TIME_TOTP_ISSUER", "TrackSuite.work")
WORK_TIME_ENCRYPTION_KEY = os.environ.get("WORK_TIME_ENCRYPTION_KEY", "")
# Optional comma-separated list of *previous* Fernet keys, kept only so data
# encrypted before a key rotation can still be decrypted. New writes always use
# WORK_TIME_ENCRYPTION_KEY (the MultiFernet primary); run a re-encrypt pass and
# then drop the old keys from this variable. See DEPLOYMENT.md §8.
WORK_TIME_OLD_ENCRYPTION_KEYS = os.environ.get("WORK_TIME_OLD_ENCRYPTION_KEYS", "")
ENCRYPTION_PREFIX = "fernet$"
RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# Reject the documented placeholders ("CHANGE-ME-use-python3-...") which are
# long enough to pass the length check but are publicly known values.
_PLACEHOLDER_SECRET_RE = re.compile(r"change[-_ ]?me", re.IGNORECASE)


def validate_auth_configuration() -> None:
    if (
        JWT_SECRET == DEFAULT_JWT_SECRET
        or len(JWT_SECRET) < MIN_JWT_SECRET_LENGTH
        or _PLACEHOLDER_SECRET_RE.search(JWT_SECRET)
    ):
        raise RuntimeError(
            "WORK_TIME_JWT_SECRET must be set to a unique, high-entropy value of at "
            "least 32 characters (the shipped 'CHANGE-ME-...' placeholder is rejected). "
            'Generate one with: python3 -c "import secrets; print(secrets.token_hex(32))"'
        )

    if not WORK_TIME_ENCRYPTION_KEY or _PLACEHOLDER_SECRET_RE.search(WORK_TIME_ENCRYPTION_KEY):
        raise RuntimeError(
            "WORK_TIME_ENCRYPTION_KEY must be set to a valid Fernet key for data-at-rest "
            'encryption. Generate one with: python3 -c "from cryptography.fernet import '
            'Fernet; print(Fernet.generate_key().decode())"'
        )

    get_fernet()


def _encryption_keys() -> list[str]:
    keys = [WORK_TIME_ENCRYPTION_KEY]
    keys += [k.strip() for k in WORK_TIME_OLD_ENCRYPTION_KEYS.split(",") if k.strip()]
    return keys


@lru_cache(maxsize=1)
def get_fernet() -> MultiFernet:
    """A MultiFernet: new writes use the primary key, reads try every key in
    order so data survives a key rotation until it is re-encrypted."""
    try:
        return MultiFernet([Fernet(k.encode("utf-8")) for k in _encryption_keys()])
    except Exception as exc:  # pragma: no cover - configuration failure
        raise RuntimeError(
            "WORK_TIME_ENCRYPTION_KEY (and any WORK_TIME_OLD_ENCRYPTION_KEYS) must be "
            "valid Fernet keys."
        ) from exc


def hash_password(password: str) -> str:
    return ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return ph.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(user_id: int, email: str, session_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "email": email,
        "sid": session_id,
        "type": "access",
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": now,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and validate an access JWT. Raises jwt.PyJWTError on failure.

    Required claims are pinned so a token missing ``exp`` can't validate as
    non-expiring, and ``sub``/``sid`` are always present for the session check."""
    return jwt.decode(
        token,
        JWT_SECRET,
        algorithms=[JWT_ALGORITHM],
        options={"require": ["exp", "iat", "sub", "sid"]},
    )


def hash_email(email: str) -> str:
    """Deterministic keyed lookup hash for an email address.

    Peppered with the encryption key so an attacker who steals only the SQLite
    file (no app secrets) cannot test candidate addresses against it. Used as
    the unique key and login lookup now that the email column is encrypted."""
    normalized = email.strip().lower().encode("utf-8")
    return hmac.new(
        WORK_TIME_ENCRYPTION_KEY.encode("utf-8"), normalized, hashlib.sha256
    ).hexdigest()


def access_token_expires_in_seconds() -> int:
    return ACCESS_TOKEN_EXPIRE_MINUTES * 60


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def build_totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=TOTP_ISSUER)


def encrypt_secret(secret: str) -> str:
    if not secret:
        return ""
    encrypted = get_fernet().encrypt(secret.encode("utf-8")).decode("utf-8")
    return f"{ENCRYPTION_PREFIX}{encrypted}"


def is_encrypted_secret(secret: str) -> bool:
    return bool(secret) and secret.startswith(ENCRYPTION_PREFIX)


def decrypt_secret(secret: str) -> str:
    if not secret:
        return ""
    if not is_encrypted_secret(secret):
        raise InvalidToken("Secret is not encrypted")
    token = secret[len(ENCRYPTION_PREFIX):]
    return get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")


def verify_totp(code: str, encrypted_secret: str) -> bool:
    return verify_totp_step(code, encrypted_secret) is not None


def verify_totp_step(code: str, encrypted_secret: str) -> Optional[int]:
    """Verify a TOTP code and return the matched time-step counter, or None.

    The counter lets callers reject replay of an already-used code within the
    acceptance window (persist the last accepted step per user)."""
    if not encrypted_secret:
        return None
    normalized = code.replace(" ", "")
    if not normalized.isdigit():
        return None
    try:
        secret = decrypt_secret(encrypted_secret)
    except InvalidToken:
        return None
    totp = pyotp.TOTP(secret)
    now = int(time.time())
    for offset in (0, -1, 1):  # valid_window=1: current step ± one
        for_time = now + offset * totp.interval
        if totp.verify(normalized, for_time=for_time, valid_window=0):
            return for_time // totp.interval
    return None


# ── Transparent data-at-rest encryption (used by the ORM TypeDecorator) ──


def encrypt_at_rest(value: Optional[str]) -> Optional[str]:
    """Encrypt a value for storage. None and "" pass through unchanged."""
    if value is None or value == "":
        return value
    if is_encrypted_secret(value):
        return value
    return encrypt_secret(value)


def decrypt_at_rest(value: Optional[str]) -> Optional[str]:
    """Decrypt a stored value. Legacy plaintext (no prefix) passes through so
    reads keep working during the lazy at-rest migration window."""
    if value is None or value == "":
        return value
    if not is_encrypted_secret(value):
        return value
    try:
        return decrypt_secret(value)
    except InvalidToken:
        # Undecryptable (e.g. key fully rotated out) — surface empty rather than
        # crash a read path; the field can be re-saved by the user.
        return ""


def needs_reencryption(value: Optional[str]) -> bool:
    """True if ``value`` is ciphertext that the *primary* key alone cannot read
    (i.e. it was encrypted under an old key and should be rewritten)."""
    if not is_encrypted_secret(value):
        return False
    token = value[len(ENCRYPTION_PREFIX):].encode("utf-8")
    try:
        Fernet(WORK_TIME_ENCRYPTION_KEY.encode("utf-8")).decrypt(token)
        return False
    except InvalidToken:
        return True


def generate_session_id() -> str:
    return str(uuid4())


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_token() -> str:
    """Random URL-safe token for email verification / one-shot links."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """SHA-256 hash for storing a high-entropy one-shot token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    """Generate a random API key (plaintext). 32-byte hex string."""
    return secrets.token_hex(32)


def hash_api_key(key: str) -> str:
    """SHA-256 hash of an API key for storage."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def normalize_recovery_code(code: str) -> str:
    return code.replace("-", "").replace(" ", "").upper()


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    codes: list[str] = []
    for _ in range(count):
        raw = "".join(secrets.choice(RECOVERY_CODE_ALPHABET) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes


def hash_recovery_code(code: str) -> str:
    return hash_password(normalize_recovery_code(code))


def verify_recovery_code(code: str, code_hash: str) -> bool:
    return verify_password(normalize_recovery_code(code), code_hash)
