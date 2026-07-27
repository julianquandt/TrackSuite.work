"""Tests for self-hosted deployment modes: the signup policy that gates
/auth/register (single-user, company-domain, invite-code) and the admin CLI that
creates accounts when web signup is switched off entirely."""

import time

import pyotp
import pytest

from app_server import limiter
from app_server.auth import decrypt_secret, hash_email
from app_server.models import Base, User

from backend.app_server import instance
from backend.app_server import cli

from .test_api import (
    TEST_EMAIL,
    TEST_PASSWORD,
    TestingSessionLocal,
    client,
    engine,
)


@pytest.fixture(autouse=True)
def _setup_db(monkeypatch):
    limiter.enabled = False
    import backend.app_server.main as _m
    _m._rate_buckets.clear()
    # Every signup-policy variable must start unset, or a stray value from the
    # developer's shell would silently change what these tests assert.
    for name in ("WORK_TIME_SIGNUP_MODE", "WORK_TIME_SIGNUP_ALLOWED_DOMAINS",
                 "WORK_TIME_SIGNUP_INVITE_CODES", "WORK_TIME_MAX_USERS",
                 "WORK_TIME_INSTANCE_NAME"):
        monkeypatch.delenv(name, raising=False)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def _next_otp(secret):
    """A code for the *next* time step.

    Two logins seconds apart would otherwise present the same code, and the
    server's TOTP replay protection rightly rejects the second. The next step is
    still inside the server's ±1 acceptance window.
    """
    return pyotp.TOTP(secret).at(time.time() + 30)


def _register(email=TEST_EMAIL, password=TEST_PASSWORD, invite_code=None):
    body = {"email": email, "password": password}
    if invite_code is not None:
        body["invite_code"] = invite_code
    return client.post("/auth/register", json=body)


# ── Default (public) instance ────────────────────────────────────────

def test_default_instance_is_open():
    assert _register().status_code == 201
    meta = client.get("/meta/instance").json()
    assert meta["signup_mode"] == "open"
    assert meta["signup_open"] is True
    assert meta["invite_required"] is False


# ── Closed: single-user self-host ────────────────────────────────────

def test_closed_instance_refuses_registration(monkeypatch):
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "closed")
    res = _register()
    assert res.status_code == 403
    assert "disabled" in res.json()["detail"]
    with TestingSessionLocal() as db:
        assert db.query(User).count() == 0
    assert client.get("/meta/instance").json()["signup_open"] is False


def test_closed_instance_does_not_leak_existing_accounts(monkeypatch):
    """The policy check must run before the duplicate-email 409, otherwise the
    status code tells an attacker which addresses already have accounts."""
    assert _register().status_code == 201
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "closed")
    taken = _register(email=TEST_EMAIL)
    fresh = _register(email="nobody@example.com")
    assert taken.status_code == fresh.status_code == 403
    assert taken.json() == fresh.json()


# ── Restricted: company deployment ───────────────────────────────────

def test_restricted_allows_only_configured_domains(monkeypatch):
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "restricted")
    monkeypatch.setenv("WORK_TIME_SIGNUP_ALLOWED_DOMAINS", "acme.com, acme.de")

    assert _register(email="hr@gmail.com").status_code == 403
    assert _register(email="hr@acme.com").status_code == 201
    assert _register(email="payroll@ACME.DE").status_code == 201

    meta = client.get("/meta/instance").json()
    assert meta["allowed_email_domains"] == ["acme.com", "acme.de"]


def test_restricted_requires_a_valid_invite_code(monkeypatch):
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "restricted")
    monkeypatch.setenv("WORK_TIME_SIGNUP_INVITE_CODES", "code-one code-two")

    assert _register().status_code == 403
    assert _register(invite_code="wrong").status_code == 403
    assert _register(invite_code="code-two").status_code == 201
    assert client.get("/meta/instance").json()["invite_required"] is True


def test_restricted_enforces_domain_and_invite_together(monkeypatch):
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "restricted")
    monkeypatch.setenv("WORK_TIME_SIGNUP_ALLOWED_DOMAINS", "acme.com")
    monkeypatch.setenv("WORK_TIME_SIGNUP_INVITE_CODES", "shared-secret")

    assert _register(email="x@gmail.com", invite_code="shared-secret").status_code == 403
    assert _register(email="x@acme.com", invite_code="nope").status_code == 403
    assert _register(email="x@acme.com", invite_code="shared-secret").status_code == 201


def test_restricted_without_any_restriction_fails_closed(monkeypatch):
    """'restricted' with nothing configured must not silently behave as 'open'."""
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "restricted")
    assert _register().status_code == 403


def test_unknown_mode_fails_closed(monkeypatch):
    """A typo in the unit file must never open registration to the internet."""
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "opne")
    assert _register().status_code == 403
    assert instance.signup_mode() == instance.SIGNUP_CLOSED


# ── Account cap ──────────────────────────────────────────────────────

def test_max_users_caps_new_accounts(monkeypatch):
    monkeypatch.setenv("WORK_TIME_MAX_USERS", "1")
    assert _register(email="first@example.com").status_code == 201
    res = _register(email="second@example.com")
    assert res.status_code == 403
    assert "account limit" in res.json()["detail"]
    assert client.get("/meta/instance").json()["signup_open"] is False


def test_max_users_still_allows_resetting_an_incomplete_account(monkeypatch):
    """Re-registering an unfinished (data-less) account reuses its row, so it
    consumes no new seat and must not be blocked by a full instance."""
    assert _register(email="first@example.com").status_code == 201
    monkeypatch.setenv("WORK_TIME_MAX_USERS", "1")
    assert _register(email="first@example.com").status_code == 201


def test_instance_name_is_configurable(monkeypatch):
    monkeypatch.setenv("WORK_TIME_INSTANCE_NAME", "Acme Time")
    assert client.get("/meta/instance").json()["instance_name"] == "Acme Time"


# ── Invite-code matching ─────────────────────────────────────────────

def test_invite_code_matching_is_exact(monkeypatch):
    monkeypatch.setenv("WORK_TIME_SIGNUP_INVITE_CODES", "SeCrEt-123")
    assert instance._invite_code_matches("SeCrEt-123") is True
    # Case, prefixes and empties must not match.
    assert instance._invite_code_matches("secret-123") is False
    assert instance._invite_code_matches("SeCrEt") is False
    assert instance._invite_code_matches("") is False
    assert instance._invite_code_matches(None) is False


def test_no_invite_codes_configured_matches_nothing():
    assert instance._invite_code_matches("") is False
    assert instance._invite_code_matches("anything") is False


# ── Admin CLI ────────────────────────────────────────────────────────

@pytest.fixture
def cli_db(monkeypatch):
    """Point the CLI at the in-memory test database instead of the real one."""
    monkeypatch.setattr(cli.server, "SessionLocal", TestingSessionLocal)
    return TestingSessionLocal


def test_cli_creates_an_account_that_can_sign_in_immediately(cli_db, capsys, monkeypatch):
    # The whole point of the CLI: usable on an instance with signup switched off
    # and no mailer, so there is no email round-trip to complete.
    monkeypatch.setenv("WORK_TIME_SIGNUP_MODE", "closed")

    assert cli.main(["create-user", "--email", "solo@example.com",
                     "--password", TEST_PASSWORD]) == 0

    with cli_db() as db:
        user = db.query(User).filter(User.email_hash == hash_email("solo@example.com")).one()
        assert user.mfa_enrolled_at and user.email_verified_at
        assert user.tos_accepted_at and user.tos_version
        secret = decrypt_secret(user.totp_secret)

    res = client.post("/auth/login", json={"email": "solo@example.com",
                                           "password": TEST_PASSWORD,
                                           "otp": pyotp.TOTP(secret).now()})
    assert res.status_code == 200
    assert res.json()["access_token"]

    out = capsys.readouterr().out
    assert secret in out                      # printed for manual entry
    assert "otpauth://" in out                # and as a scannable URI
    assert out.count("-") >= 10               # ten recovery codes


def test_cli_refuses_to_clobber_an_existing_account(cli_db):
    assert cli.main(["create-user", "--email", "solo@example.com",
                     "--password", TEST_PASSWORD]) == 0
    assert cli.main(["create-user", "--email", "solo@example.com",
                     "--password", TEST_PASSWORD]) == 1


def test_cli_rejects_a_short_password(cli_db):
    assert cli.main(["create-user", "--email", "solo@example.com", "--password", "short"]) == 1
    with cli_db() as db:
        assert db.query(User).count() == 0


def test_cli_reset_password_signs_the_user_out(cli_db):
    cli.main(["create-user", "--email", "solo@example.com", "--password", TEST_PASSWORD])
    with cli_db() as db:
        secret = decrypt_secret(
            db.query(User).filter(User.email_hash == hash_email("solo@example.com")).one().totp_secret
        )
    old = client.post("/auth/login", json={"email": "solo@example.com",
                                           "password": TEST_PASSWORD,
                                           "otp": pyotp.TOTP(secret).now()}).json()

    assert cli.main(["reset-password", "--email", "solo@example.com",
                     "--password", "brand-new-password"]) == 0

    # Old refresh token is dead, new password works.
    assert client.post("/auth/refresh",
                       json={"refresh_token": old["refresh_token"]}).status_code == 401
    assert client.post("/auth/login", json={"email": "solo@example.com",
                                            "password": "brand-new-password",
                                            "otp": _next_otp(secret)}).status_code == 200


def test_cli_reset_2fa_replaces_the_secret(cli_db, capsys):
    cli.main(["create-user", "--email", "solo@example.com", "--password", TEST_PASSWORD])
    with cli_db() as db:
        old_secret = decrypt_secret(
            db.query(User).filter(User.email_hash == hash_email("solo@example.com")).one().totp_secret
        )
    capsys.readouterr()

    assert cli.main(["reset-2fa", "--email", "solo@example.com"]) == 0

    with cli_db() as db:
        new_secret = decrypt_secret(
            db.query(User).filter(User.email_hash == hash_email("solo@example.com")).one().totp_secret
        )
    assert new_secret != old_secret
    # The old authenticator must stop working.
    assert client.post("/auth/login", json={"email": "solo@example.com",
                                            "password": TEST_PASSWORD,
                                            "otp": pyotp.TOTP(old_secret).now()}).status_code == 401
    assert client.post("/auth/login", json={"email": "solo@example.com",
                                            "password": TEST_PASSWORD,
                                            "otp": pyotp.TOTP(new_secret).now()}).status_code == 200


def test_cli_delete_user_removes_the_account(cli_db):
    cli.main(["create-user", "--email", "solo@example.com", "--password", TEST_PASSWORD])
    assert cli.main(["delete-user", "--email", "solo@example.com", "--yes"]) == 0
    with cli_db() as db:
        assert db.query(User).count() == 0


def test_cli_commands_report_a_missing_account(cli_db):
    for command in ("delete-user", "reset-2fa", "recovery-codes"):
        args = [command, "--email", "ghost@example.com"]
        if command == "delete-user":
            args.append("--yes")
        assert cli.main(args) == 1
