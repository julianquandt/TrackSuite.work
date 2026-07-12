"""Authentication utilities: validated secrets, encrypted MFA state, JWT access tokens, refresh tokens, and recovery codes."""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from uuid import uuid4

import jwt
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken

ph = PasswordHasher()

DEFAULT_JWT_SECRET = "change-me-in-production"
JWT_SECRET = os.environ.get("WORK_TIME_JWT_SECRET", DEFAULT_JWT_SECRET)
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 30
MIN_JWT_SECRET_LENGTH = 32
TOTP_ISSUER = os.environ.get("WORK_TIME_TOTP_ISSUER", "TrackSuite.work")
WORK_TIME_ENCRYPTION_KEY = os.environ.get("WORK_TIME_ENCRYPTION_KEY", "")
ENCRYPTION_PREFIX = "fernet$"
RECOVERY_CODE_COUNT = 10
RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def validate_auth_configuration() -> None:
    if JWT_SECRET == DEFAULT_JWT_SECRET or len(JWT_SECRET) < MIN_JWT_SECRET_LENGTH:
        raise RuntimeError(
            "WORK_TIME_JWT_SECRET must be set to a non-default value with at least 32 characters."
        )

    if not WORK_TIME_ENCRYPTION_KEY:
        raise RuntimeError(
            "WORK_TIME_ENCRYPTION_KEY must be set to a valid Fernet key for MFA secret encryption."
        )

    get_fernet()


@lru_cache(maxsize=1)
def get_fernet() -> Fernet:
    try:
        return Fernet(WORK_TIME_ENCRYPTION_KEY.encode("utf-8"))
    except Exception as exc:  # pragma: no cover - configuration failure
        raise RuntimeError(
            "WORK_TIME_ENCRYPTION_KEY must be a valid Fernet key."
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
    """Decode and validate an access JWT. Raises jwt.PyJWTError on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


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
    if not encrypted_secret:
        return False
    normalized = code.replace(" ", "")
    if not normalized.isdigit():
        return False
    try:
        secret = decrypt_secret(encrypted_secret)
    except InvalidToken:
        return False
    return pyotp.TOTP(secret).verify(normalized, valid_window=1)


def generate_session_id() -> str:
    return str(uuid4())


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
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
