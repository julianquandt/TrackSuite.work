"""Tests for the Terms re-acceptance loop.

§ 9 of the Terms promises registered users notice before a material change takes
effect. The backend records which version each account accepted; these tests
cover the endpoints the web app uses to notice a change and record consent.
"""

import pyotp
import pytest

import backend.app_server.main as _m
from app_server import limiter
from app_server.auth import decrypt_secret, hash_email
from app_server.models import Base, User

from backend.app_server import cli

from .test_api import (
    TEST_PASSWORD,
    TestingSessionLocal,
    client,
    engine,
)

EMAIL = "solo@example.com"
NEXT_VERSION = "2099-01-01"


@pytest.fixture(autouse=True)
def _setup_db(monkeypatch):
    limiter.enabled = False
    _m._rate_buckets.clear()
    monkeypatch.delenv("WORK_TIME_SIGNUP_MODE", raising=False)
    monkeypatch.setattr(cli.server, "SessionLocal", TestingSessionLocal)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def token(capsys):
    """An active account and a bearer token for it.

    Created through the CLI because that account is enrolled and verified from
    the start — no mailer, no round-trip, which keeps these tests about the
    Terms rather than about onboarding.
    """
    assert cli.main(["create-user", "--email", EMAIL, "--password", TEST_PASSWORD]) == 0
    capsys.readouterr()  # swallow the QR / recovery codes

    with TestingSessionLocal() as db:
        user = db.query(User).filter(User.email_hash == hash_email(EMAIL)).one()
        secret = decrypt_secret(user.totp_secret)

    res = client.post("/auth/login", json={"email": EMAIL, "password": TEST_PASSWORD,
                                           "otp": pyotp.TOTP(secret).now()})
    assert res.status_code == 200
    return res.json()["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _stored_version():
    with TestingSessionLocal() as db:
        user = db.query(User).filter(User.email_hash == hash_email(EMAIL)).one()
        return user.tos_version, user.tos_accepted_at


# ── Status ───────────────────────────────────────────────────────────

def test_a_current_account_is_not_prompted(token):
    res = client.get("/auth/tos", headers=_auth(token))
    assert res.status_code == 200
    body = res.json()
    assert body["acceptance_required"] is False
    assert body["accepted_version"] == body["current_version"] == _m.CURRENT_TOS_VERSION
    assert body["accepted_at"]


def test_publishing_new_terms_prompts_existing_accounts(token, monkeypatch):
    accepted_before, _ = _stored_version()
    monkeypatch.setattr(_m, "CURRENT_TOS_VERSION", NEXT_VERSION)

    body = client.get("/auth/tos", headers=_auth(token)).json()
    assert body["acceptance_required"] is True
    assert body["current_version"] == NEXT_VERSION
    assert body["accepted_version"] == accepted_before


def test_status_requires_a_session():
    assert client.get("/auth/tos").status_code == 401


# ── Acceptance ───────────────────────────────────────────────────────

def test_accepting_records_the_new_version(token, monkeypatch):
    _, accepted_at_before = _stored_version()
    monkeypatch.setattr(_m, "CURRENT_TOS_VERSION", NEXT_VERSION)

    res = client.post("/auth/tos/accept", json={"version": NEXT_VERSION}, headers=_auth(token))
    assert res.status_code == 200
    assert res.json()["acceptance_required"] is False

    version, accepted_at = _stored_version()
    assert version == NEXT_VERSION
    assert accepted_at != accepted_at_before

    assert client.get("/auth/tos", headers=_auth(token)).json()["acceptance_required"] is False


def test_a_stale_tab_cannot_blind_accept(token, monkeypatch):
    """A client open since before an update holds the *old* version string. It
    must be told to reload rather than silently recording consent to terms it
    never displayed."""
    stale, _ = _stored_version()
    monkeypatch.setattr(_m, "CURRENT_TOS_VERSION", NEXT_VERSION)

    res = client.post("/auth/tos/accept", json={"version": stale}, headers=_auth(token))
    assert res.status_code == 409
    assert "out of date" in res.json()["detail"]
    assert _stored_version()[0] == stale


def test_acceptance_requires_a_session():
    res = client.post("/auth/tos/accept", json={"version": _m.CURRENT_TOS_VERSION})
    assert res.status_code == 401


def test_instance_metadata_reports_the_current_version(monkeypatch):
    monkeypatch.setattr(_m, "CURRENT_TOS_VERSION", NEXT_VERSION)
    assert client.get("/meta/instance").json()["tos_version"] == NEXT_VERSION
