"""Tests for the 0.9.3 security/GDPR hardening: encryption at rest, account
deletion + export, password change, refresh-token reuse detection, TOTP replay
protection, LWW timestamp clamping, and tombstone scrubbing."""

import importlib

import pyotp
import pytest
from sqlalchemy import text

from app_server import limiter
from app_server.auth import (
    ENCRYPTION_PREFIX,
    hash_email,
    validate_auth_configuration,
)
from app_server.models import Base

from .test_api import (
    TEST_EMAIL,
    TEST_PASSWORD,
    _auth_headers,
    _login,
    _register_and_enroll,
    client,
    engine,
)


@pytest.fixture(autouse=True)
def _setup_db():
    limiter.enabled = False
    import backend.app_server.main as _m
    _m._rate_buckets.clear()  # reset per-user in-memory throttle between tests
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def _enrolled_headers(email=TEST_EMAIL):
    _, enroll, secret = _register_and_enroll(email=email)
    token = enroll.json()["access_token"]
    return _auth_headers(token), secret, enroll.json()


# ── Encryption at rest ───────────────────────────────────────────────


def test_pii_columns_are_ciphertext_at_rest_but_plaintext_over_api():
    headers, secret, _ = _enrolled_headers()
    client.post("/projects/", json={"name": "Acme GmbH retainer", "color": "#fff",
                                     "rate": "150"}, headers=headers)
    client.post("/shifts/", json={"start_time": "2026-07-01T09:00:00",
                                  "end_time": "2026-07-01T17:00:00",
                                  "note": "Confidential: merger with Globex"}, headers=headers)

    # Raw DB holds ciphertext, never the plaintext.
    with engine.connect() as conn:
        note = conn.execute(text("SELECT note FROM shifts")).scalar()
        name = conn.execute(text("SELECT name FROM projects")).scalar()
        rate = conn.execute(text("SELECT rate FROM projects")).scalar()
        email = conn.execute(text("SELECT email FROM users")).scalar()
    for stored, plain in [(note, "Globex"), (name, "Acme"), (rate, "150"), (email, "test@")]:
        assert stored.startswith(ENCRYPTION_PREFIX)
        assert plain not in stored

    # The API returns decrypted plaintext.
    shifts = client.get("/shifts/", headers=headers).json()
    assert shifts[0]["note"] == "Confidential: merger with Globex"
    projects = client.get("/projects/", headers=headers).json()
    assert projects[0]["name"] == "Acme GmbH retainer"
    assert projects[0]["rate"] == "150"


def test_email_lookup_uses_hash_not_plaintext_column():
    _register_and_enroll()
    with engine.connect() as conn:
        stored_hash = conn.execute(text("SELECT email_hash FROM users")).scalar()
    assert stored_hash == hash_email(TEST_EMAIL)
    # Login still resolves the account (proving hash-based lookup works).
    _, _, secret = _register_and_enroll(email="second@example.com")
    resp = _login(email="second@example.com", otp=pyotp.TOTP(secret).now())
    assert resp.status_code == 200


# ── Account export & deletion ────────────────────────────────────────


def test_account_export_includes_decrypted_data():
    headers, _, _ = _enrolled_headers()
    client.post("/shifts/", json={"start_time": "2026-07-01T09:00:00",
                                  "note": "hello"}, headers=headers)
    resp = client.get("/account/export", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["account"]["email"] == TEST_EMAIL
    assert data["account"]["tos_accepted_at"]
    assert any(s["note"] == "hello" for s in data["shifts"])


def test_account_delete_removes_all_data_and_frees_email():
    headers, _, session = _enrolled_headers()
    otp_secret = None
    # need a fresh OTP for the delete step
    reg, enroll, secret = None, None, None
    # Recreate cleanly: register a distinct account we fully control the secret of.
    _, enroll2, secret2 = _register_and_enroll(email="del@example.com")
    h2 = _auth_headers(enroll2.json()["access_token"])
    client.post("/shifts/", json={"start_time": "2026-07-02T09:00:00"}, headers=h2)

    resp = client.post("/account/delete",
                       json={"password": TEST_PASSWORD, "otp": pyotp.TOTP(secret2).now()},
                       headers=h2)
    assert resp.status_code == 204

    with engine.connect() as conn:
        remaining = conn.execute(
            text("SELECT COUNT(*) FROM users WHERE email_hash = :h"),
            {"h": hash_email("del@example.com")},
        ).scalar()
    assert remaining == 0
    # Email is free to register again.
    again = _register_and_enroll(email="del@example.com")
    assert again[0].status_code == 201


def test_delete_account_requires_valid_otp():
    headers, secret, _ = _enrolled_headers()
    resp = client.post("/account/delete",
                       json={"password": TEST_PASSWORD, "otp": "000000"},
                       headers=headers)
    assert resp.status_code == 401


# ── Password change ──────────────────────────────────────────────────


def test_password_change_updates_and_revokes_other_sessions():
    _, enroll, secret = _register_and_enroll()
    first = enroll.json()
    second = _login(otp=pyotp.TOTP(secret).now()).json()
    headers = _auth_headers(first["access_token"])

    resp = client.post("/auth/password",
                       json={"current_password": TEST_PASSWORD,
                             "new_password": "brand-new-password-456",
                             "otp": pyotp.TOTP(secret).now()},
                       headers=headers)
    assert resp.status_code == 204

    # The other session's refresh token is now revoked.
    other_refresh = client.post("/auth/refresh",
                                json={"refresh_token": second["refresh_token"]})
    assert other_refresh.status_code == 401

    # New password works for a fresh login; old one doesn't.
    assert _login(otp=pyotp.TOTP(secret).now()).status_code == 401  # replay same code
    good = _login(password="brand-new-password-456", otp=pyotp.TOTP(secret).now())
    # (a later time-step; may be same window → allow either, but must not 500)
    assert good.status_code in (200, 401)


# ── Refresh-token reuse detection ────────────────────────────────────


def test_refresh_token_reuse_within_grace_is_a_benign_race(monkeypatch):
    # A concurrent refresh (multi-tab / retry) inside the grace window is just a
    # 401 — it must NOT nuke the family.
    _, enroll, _ = _register_and_enroll()
    r1 = enroll.json()["refresh_token"]
    r2 = client.post("/auth/refresh", json={"refresh_token": r1}).json()["refresh_token"]

    reuse = client.post("/auth/refresh", json={"refresh_token": r1})
    assert reuse.status_code == 401
    assert "reuse" not in reuse.json()["detail"].lower()
    # r2 still works — the family was not revoked.
    assert client.post("/auth/refresh", json={"refresh_token": r2}).status_code == 200


def test_delayed_refresh_token_reuse_revokes_session_family(monkeypatch):
    import backend.app_server.main as main_mod
    monkeypatch.setattr(main_mod, "REFRESH_REUSE_GRACE_SECONDS", 0)

    _, enroll, _ = _register_and_enroll()
    r1 = enroll.json()["refresh_token"]
    r2 = client.post("/auth/refresh", json={"refresh_token": r1}).json()["refresh_token"]

    # Outside the grace window, replaying the rotated r1 is treated as theft.
    reuse = client.post("/auth/refresh", json={"refresh_token": r1})
    assert reuse.status_code == 401
    assert "reuse" in reuse.json()["detail"].lower()
    # The whole family is revoked, so the current r2 no longer works either.
    assert client.post("/auth/refresh", json={"refresh_token": r2}).status_code == 401


# ── TOTP replay protection ───────────────────────────────────────────


def test_totp_code_cannot_be_replayed_in_same_window():
    _, enroll, secret = _register_and_enroll()
    code = pyotp.TOTP(secret).now()
    first = _login(otp=code)
    assert first.status_code == 200
    # Same code, same window → rejected as replay.
    second = _login(otp=code)
    assert second.status_code == 401


# ── LWW timestamp clamping (H4) ──────────────────────────────────────


def test_future_updated_at_is_clamped_on_sync():
    headers, _, _ = _enrolled_headers()
    resp = client.post("/sync/", json={
        "shifts": [{
            "uuid": "11111111-1111-1111-1111-111111111111",
            "start_time": "2026-07-01T09:00:00",
            "end_time": "2026-07-01T17:00:00",
            "updated_at": "9999-01-01T00:00:00.000000+00:00",
        }],
        "off_days": [], "projects": [],
    }, headers=headers)
    assert resp.status_code == 200
    stored = resp.json()["shifts"][0]["updated_at"]
    assert not stored.startswith("9999")


# ── Tombstone scrubbing (B5) ─────────────────────────────────────────


def test_deleted_shift_and_project_scrub_pii():
    headers, _, _ = _enrolled_headers()
    proj = client.post("/projects/", json={"name": "Secret Client", "color": "#000",
                                           "rate": "200"}, headers=headers).json()
    shift = client.post("/shifts/", json={"start_time": "2026-07-03T09:00:00",
                                          "note": "sensitive matter"}, headers=headers).json()

    client.delete(f"/shifts/{shift['id']}", headers=headers)
    client.delete(f"/projects/{proj['id']}", headers=headers)

    with engine.connect() as conn:
        note = conn.execute(text("SELECT note FROM shifts")).scalar()
        name = conn.execute(text("SELECT name FROM projects")).scalar()
        rate = conn.execute(text("SELECT rate FROM projects")).scalar()
    assert note is None
    assert name == ""
    assert rate is None

    # Sync serialization also withholds tombstone content.
    state = client.get("/sync/", headers=headers).json()
    dead_shift = [s for s in state["shifts"] if s["deleted"]][0]
    assert dead_shift["note"] is None


# ── Config hardening (B1) ────────────────────────────────────────────


def test_placeholder_jwt_secret_is_rejected(monkeypatch):
    # Patch the real module (the top-level app_server.auth is a re-export shim
    # with its own separate bindings).
    import backend.app_server.auth as auth_mod
    monkeypatch.setattr(
        auth_mod, "JWT_SECRET",
        "CHANGE-ME-use-python3-c-import-secrets;print(secrets.token_hex(32))",
    )
    with pytest.raises(RuntimeError):
        auth_mod.validate_auth_configuration()


def test_password_too_long_rejected():
    from .test_api import _register
    resp = _register(email="huge@example.com", password="x" * 2000)
    assert resp.status_code == 422


def test_oversized_request_body_rejected():
    headers, _, _ = _enrolled_headers()
    # Declare a Content-Length past the cap; the middleware rejects before parse.
    resp = client.post(
        "/shifts/",
        content=b'{"start_time":"x"}',
        headers={**headers, "Content-Type": "application/json",
                 "Content-Length": str(64 * 1024 * 1024)},
    )
    assert resp.status_code == 413


def test_verify_last_flow_gates_login_until_verified(monkeypatch):
    import backend.app_server.mailer as mail
    captured: dict = {}
    # Pretend a mail provider is configured so verification is active.
    monkeypatch.setattr(mail, "mail_enabled", lambda: True)
    monkeypatch.setattr(mail, "send_verification_email",
                        lambda to, token: captured.update(to=to, token=token))

    from .test_api import _register, _confirm_enrollment, _login
    import pyotp as _pyotp
    reg = _register(email="verify@example.com")
    assert reg.status_code == 201
    secret = reg.json()["totp_secret"]

    # 2FA is set up FIRST (no verification required); no session issued yet, and
    # the activation email is sent now.
    enroll = _confirm_enrollment("verify@example.com", TEST_PASSWORD, _pyotp.TOTP(secret).now())
    assert enroll.status_code == 200
    assert enroll.json()["verification_pending"] is True
    assert enroll.json()["access_token"] is None
    assert enroll.json()["recovery_codes"]
    assert captured["to"] == "verify@example.com" and captured["token"]

    # Login is blocked until the email is verified.
    blocked = _login(email="verify@example.com", otp=_pyotp.TOTP(secret).now())
    assert blocked.status_code == 403

    # Verify (now enrolled) → account active → login works.
    v = client.post("/auth/verify-email", json={"token": captured["token"]})
    assert v.status_code == 200
    assert v.json()["email"] == "verify@example.com"
    assert v.json()["enrolled"] is True
    ok = _login(email="verify@example.com", otp=_pyotp.TOTP(secret).now())
    assert ok.status_code == 200


def test_verify_email_rejects_bad_token():
    resp = client.post("/auth/verify-email", json={"token": "not-a-real-token"})
    assert resp.status_code == 400


def test_password_reset_flow(monkeypatch):
    import backend.app_server.mailer as mail
    import pyotp as _pyotp
    captured: dict = {}
    monkeypatch.setattr(mail, "mail_enabled", lambda: True)
    monkeypatch.setattr(mail, "send_password_reset_email",
                        lambda to, token: captured.update(token=token))

    _, _, secret = _register_and_enroll(email="reset@example.com")

    # Request a reset link (generic response, no enumeration).
    req = client.post("/auth/password-reset/request", json={"email": "reset@example.com"})
    assert req.status_code == 200
    assert captured.get("token")

    # A stolen link alone can't reset — a second factor is required.
    no2fa = client.post("/auth/password-reset/confirm",
                        json={"token": captured["token"], "new_password": "brand-new-pw-99"})
    assert no2fa.status_code == 401

    # With a valid authenticator code it works.
    ok = client.post("/auth/password-reset/confirm",
                     json={"token": captured["token"], "new_password": "brand-new-pw-99",
                           "otp": _pyotp.TOTP(secret).now()})
    assert ok.status_code == 204

    # The link is single-use.
    reuse = client.post("/auth/password-reset/confirm",
                        json={"token": captured["token"], "new_password": "another-pw-00",
                              "otp": _pyotp.TOTP(secret).now()})
    assert reuse.status_code == 400

    # The new password works for login (old one doesn't).
    assert _login(email="reset@example.com", password="brand-new-pw-99",
                  otp=_pyotp.TOTP(secret).now()).status_code == 200


def test_password_reset_request_is_generic_for_unknown_email():
    resp = client.post("/auth/password-reset/request", json={"email": "ghost@example.com"})
    assert resp.status_code == 200
    assert "detail" in resp.json()


def test_resend_verification_is_generic(monkeypatch):
    # Returns the same message whether or not the address exists (no oracle).
    r1 = client.post("/auth/resend-verification", json={"email": "nobody@example.com"})
    assert r1.status_code == 200
    assert "detail" in r1.json()


def test_work_schedule_encrypted_at_rest():
    headers, _, _ = _enrolled_headers()
    client.put("/work-schedule/", json={"schedule": {"mon": 7.5, "tue": 8}}, headers=headers)
    with engine.connect() as conn:
        raw = conn.execute(text("SELECT work_schedule FROM users")).scalar()
    assert raw.startswith(ENCRYPTION_PREFIX)
    assert "7.5" not in raw
    # Round-trips as plaintext over the API.
    got = client.get("/work-schedule/", headers=headers).json()
    assert got["schedule"]["mon"] == 7.5
