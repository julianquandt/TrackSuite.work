"""Tests for the TrackSuite.work API with MFA enrollment, refresh sessions, and recovery flows."""

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app_server import limiter
from app_server.main import app, get_db, report_timezone
from app_server.models import Base, RecoveryCode, Shift, User, UserSession


SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


def override_get_db():
    try:
        db = TestingSessionLocal()
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db

client = TestClient(app)

TEST_EMAIL = "test@example.com"
TEST_PASSWORD = "securepassword123"


@pytest.fixture(autouse=True)
def setup_db():
    limiter.enabled = False
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


def _register(email: str = TEST_EMAIL, password: str = TEST_PASSWORD):
    return client.post(
        "/auth/register",
        json={"email": email, "password": password},
    )


def _confirm_enrollment(
    email: str,
    password: str,
    otp: str,
    device_name: str = "Pytest Browser",
):
    return client.post(
        "/auth/mfa/confirm-enrollment",
        json={
            "email": email,
            "password": password,
            "otp": otp,
            "device_name": device_name,
        },
    )


def _login(
    email: str = TEST_EMAIL,
    password: str = TEST_PASSWORD,
    otp: str = "000000",
    device_name: str = "Pytest Browser",
):
    return client.post(
        "/auth/login",
        json={
            "email": email,
            "password": password,
            "otp": otp,
            "device_name": device_name,
        },
    )


def _login_with_recovery_code(
    email: str,
    password: str,
    recovery_code: str,
    device_name: str = "Recovery Browser",
):
    return client.post(
        "/auth/login/recovery",
        json={
            "email": email,
            "password": password,
            "recovery_code": recovery_code,
            "device_name": device_name,
        },
    )


def _register_and_enroll(
    email: str = TEST_EMAIL,
    password: str = TEST_PASSWORD,
    device_name: str = "Pytest Browser",
):
    register_response = _register(email, password)
    secret = register_response.json()["totp_secret"]
    enroll_response = _confirm_enrollment(
        email,
        password,
        pyotp.TOTP(secret).now(),
        device_name=device_name,
    )
    return register_response, enroll_response, secret


def _auth_headers(access_token: str):
    return {"Authorization": f"Bearer {access_token}"}


def test_read_root_no_auth():
    response = client.get("/")
    assert response.status_code == 200


def test_register_success_creates_pending_enrollment():
    response = _register()
    assert response.status_code == 201
    data = response.json()
    assert data["email"] == TEST_EMAIL
    assert data["totp_secret"]
    assert data["totp_uri"].startswith("otpauth://totp/")

    with TestingSessionLocal() as db:
        user = db.query(User).filter(User.email == TEST_EMAIL).one()
        assert user.totp_secret == ""
        assert user.pending_totp_secret is not None
        assert user.pending_totp_secret.startswith("fernet$")
        assert user.pending_totp_secret != data["totp_secret"]
        assert user.mfa_enrolled_at is None


def test_register_duplicate_email():
    _register()
    response = _register()
    assert response.status_code == 409


def test_register_weak_password():
    response = _register(password="short")
    assert response.status_code == 422


def test_register_invalid_email():
    response = client.post(
        "/auth/register",
        json={"email": "not-an-email", "password": TEST_PASSWORD},
    )
    assert response.status_code == 422


def test_confirm_enrollment_activates_account_and_returns_recovery_codes():
    register_response, enroll_response, raw_secret = _register_and_enroll()
    assert register_response.status_code == 201
    assert enroll_response.status_code == 200

    data = enroll_response.json()
    assert data["access_token"]
    assert data["refresh_token"]
    assert data["token_type"] == "bearer"
    assert data["expires_in"] == 900
    assert len(data["recovery_codes"]) == 10
    assert data["session"]["current"] is True

    with TestingSessionLocal() as db:
        user = db.query(User).filter(User.email == TEST_EMAIL).one()
        assert user.totp_secret.startswith("fernet$")
        assert user.totp_secret != raw_secret
        assert user.pending_totp_secret is None
        assert user.mfa_enrolled_at is not None
        assert db.query(RecoveryCode).filter(RecoveryCode.user_id == user.id).count() == 10
        assert db.query(UserSession).filter(UserSession.user_id == user.id).count() == 1


def test_login_requires_completed_enrollment():
    register_response = _register()
    secret = register_response.json()["totp_secret"]
    response = _login(otp=pyotp.TOTP(secret).now())
    assert response.status_code == 403


def test_login_success_after_enrollment():
    _, _, secret = _register_and_enroll()
    response = _login(otp=pyotp.TOTP(secret).now(), device_name="Laptop Browser")
    assert response.status_code == 200
    data = response.json()
    assert data["session"]["label"] == "Laptop Browser"
    assert data["refresh_token"]


def test_login_wrong_password():
    _, _, secret = _register_and_enroll()
    response = _login(password="wrongpassword123", otp=pyotp.TOTP(secret).now())
    assert response.status_code == 401


def test_login_unknown_email():
    response = _login(email="nobody@example.com")
    assert response.status_code == 401


def test_login_invalid_otp():
    _register_and_enroll()
    response = _login(otp="123456")
    assert response.status_code == 401


def test_refresh_rotates_tokens_for_current_session():
    _, enroll_response, _ = _register_and_enroll()
    initial = enroll_response.json()

    response = client.post(
        "/auth/refresh",
        json={"refresh_token": initial["refresh_token"]},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["session"]["id"] == initial["session"]["id"]
    assert data["refresh_token"] != initial["refresh_token"]
    assert data["access_token"]


def test_list_sessions_and_revoke_other_session():
    _, enroll_response, secret = _register_and_enroll(device_name="Primary Browser")
    primary = enroll_response.json()
    second_login = _login(otp=pyotp.TOTP(secret).now(), device_name="Second Browser")
    second = second_login.json()

    headers = _auth_headers(primary["access_token"])
    sessions_response = client.get("/auth/sessions", headers=headers)
    assert sessions_response.status_code == 200
    sessions = sessions_response.json()
    assert len(sessions) == 2
    assert any(session["current"] for session in sessions)

    revoke_response = client.delete(
        f"/auth/sessions/{second['session']['id']}",
        headers=headers,
    )
    assert revoke_response.status_code == 204

    refresh_response = client.post(
        "/auth/refresh",
        json={"refresh_token": second["refresh_token"]},
    )
    assert refresh_response.status_code == 401


def test_logout_revokes_current_session():
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    response = client.post("/auth/logout", headers=headers)
    assert response.status_code == 204
    assert client.get("/auth/api-keys", headers=headers).status_code == 401


def test_logout_all_revokes_every_session():
    _, enroll_response, secret = _register_and_enroll(device_name="Primary Browser")
    primary = enroll_response.json()
    second_login = _login(otp=pyotp.TOTP(secret).now(), device_name="Second Browser")
    second = second_login.json()

    headers = _auth_headers(primary["access_token"])
    response = client.post("/auth/logout-all", headers=headers)
    assert response.status_code == 200
    assert response.json()["revoked_sessions"] == 2
    assert client.get("/auth/api-keys", headers=headers).status_code == 401

    refresh_response = client.post(
        "/auth/refresh",
        json={"refresh_token": second["refresh_token"]},
    )
    assert refresh_response.status_code == 401


def test_login_with_recovery_code_consumes_single_code():
    _, enroll_response, _ = _register_and_enroll()
    initial = enroll_response.json()
    recovery_code = initial["recovery_codes"][0]

    login_response = _login_with_recovery_code(TEST_EMAIL, TEST_PASSWORD, recovery_code)
    assert login_response.status_code == 200

    headers = _auth_headers(login_response.json()["access_token"])
    status_response = client.get("/auth/recovery-codes/status", headers=headers)
    assert status_response.status_code == 200
    assert status_response.json()["remaining_count"] == 9

    reused_response = _login_with_recovery_code(TEST_EMAIL, TEST_PASSWORD, recovery_code)
    assert reused_response.status_code == 401


def test_regenerate_recovery_codes_invalidates_previous_set():
    _, enroll_response, secret = _register_and_enroll()
    initial = enroll_response.json()
    stale_code = initial["recovery_codes"][0]
    headers = _auth_headers(initial["access_token"])

    response = client.post(
        "/auth/recovery-codes/regenerate",
        json={"password": TEST_PASSWORD, "otp": pyotp.TOTP(secret).now()},
        headers=headers,
    )

    assert response.status_code == 200
    data = response.json()
    assert data["remaining_count"] == 10
    assert len(data["recovery_codes"]) == 10

    stale_login = _login_with_recovery_code(TEST_EMAIL, TEST_PASSWORD, stale_code)
    assert stale_login.status_code == 401


def test_mfa_reset_rotates_secret_and_revokes_other_sessions():
    _, enroll_response, original_secret = _register_and_enroll(device_name="Primary Browser")
    current = enroll_response.json()
    second_login = _login(otp=pyotp.TOTP(original_secret).now(), device_name="Second Browser")
    second = second_login.json()
    headers = _auth_headers(current["access_token"])

    start_response = client.post(
        "/auth/mfa/reset/start",
        json={"password": TEST_PASSWORD, "otp": pyotp.TOTP(original_secret).now()},
        headers=headers,
    )
    assert start_response.status_code == 200
    reset_secret = start_response.json()["totp_secret"]

    confirm_response = client.post(
        "/auth/mfa/reset/confirm",
        json={"otp": pyotp.TOTP(reset_secret).now()},
        headers=headers,
    )
    assert confirm_response.status_code == 200
    assert len(confirm_response.json()["recovery_codes"]) == 10

    old_login = _login(otp=pyotp.TOTP(original_secret).now())
    assert old_login.status_code == 401

    new_login = _login(otp=pyotp.TOTP(reset_secret).now())
    assert new_login.status_code == 200

    refresh_response = client.post(
        "/auth/refresh",
        json={"refresh_token": second["refresh_token"]},
    )
    assert refresh_response.status_code == 401


def test_create_list_and_delete_api_key():
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    create_response = client.post(
        "/auth/api-keys",
        json={"name": "desktop"},
        headers=headers,
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["name"] == "desktop"
    assert len(created["key"]) == 64

    list_response = client.get("/auth/api-keys", headers=headers)
    assert list_response.status_code == 200
    assert len(list_response.json()) == 1
    assert "key" not in list_response.json()[0]

    delete_response = client.delete(
        f"/auth/api-keys/{created['id']}",
        headers=headers,
    )
    assert delete_response.status_code == 204


def test_delete_other_users_api_key():
    _, first_response, _ = _register_and_enroll("user1@example.com")
    _, second_response, _ = _register_and_enroll("user2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])

    create_response = client.post(
        "/auth/api-keys",
        json={"name": "desktop"},
        headers=first_headers,
    )
    key_id = create_response.json()["id"]

    delete_response = client.delete(
        f"/auth/api-keys/{key_id}",
        headers=second_headers,
    )
    assert delete_response.status_code == 404


def test_auth_with_api_key_accesses_scoped_data_endpoints():
    _, enroll_response, _ = _register_and_enroll()
    bearer_headers = _auth_headers(enroll_response.json()["access_token"])
    create_key_response = client.post(
        "/auth/api-keys",
        json={"name": "sync"},
        headers=bearer_headers,
    )
    raw_key = create_key_response.json()["key"]
    api_headers = {"X-API-KEY": raw_key, "X-App-Version": "0.8.1"}

    shift_response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=api_headers,
    )
    assert shift_response.status_code == 201
    assert client.get("/shifts/", headers=api_headers).status_code == 200


def test_auth_with_api_key_version_guard():
    _, enroll_response, _ = _register_and_enroll()
    bearer_headers = _auth_headers(enroll_response.json()["access_token"])
    create_key_response = client.post(
        "/auth/api-keys",
        json={"name": "sync"},
        headers=bearer_headers,
    )
    raw_key = create_key_response.json()["key"]
    
    # 1. API key mutating request without version header -> Rejected (400)
    api_headers_no_ver = {"X-API-KEY": raw_key}
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=api_headers_no_ver,
    )
    assert response.status_code == 400
    assert "upgrade required" in response.json()["detail"].lower()

    # 2. API key mutating request with older version -> Rejected (400)
    api_headers_old_ver = {"X-API-KEY": raw_key, "X-App-Version": "0.8.0"}
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=api_headers_old_ver,
    )
    assert response.status_code == 400

    # 3. API key mutating request with valid version >= 0.8.1 -> Success (201)
    api_headers_valid_ver = {"X-API-KEY": raw_key, "X-App-Version": "0.8.1"}
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=api_headers_valid_ver,
    )
    assert response.status_code == 201

    # 4. API key mutating request with future version -> Success (201)
    api_headers_future_ver = {"X-API-KEY": raw_key, "X-App-Version": "0.9.0"}
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:30:00"},
        headers=api_headers_future_ver,
    )
    assert response.status_code == 201

    # 5. API key non-mutating (GET) request without version header -> Success (200)
    response = client.get("/shifts/", headers=api_headers_no_ver)
    assert response.status_code == 200

    # 6. Bearer token mutating request (web app) without version header -> Success (201)
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T09:00:00"},
        headers=bearer_headers,
    )
    assert response.status_code == 201


def test_auth_with_invalid_api_key():
    response = client.get("/shifts/", headers={"X-API-KEY": "invalid"})
    assert response.status_code == 403


def test_shifts_no_auth():
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
    )
    assert response.status_code == 401


def test_create_shift_with_auth():
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])
    response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=headers,
    )
    assert response.status_code == 201
    data = response.json()
    assert data["start_time"] == "2026-03-19T08:00:00"
    assert data["user_id"] == 1


def test_get_shifts_scoped():
    _, first_response, _ = _register_and_enroll("u1@example.com")
    _, second_response, _ = _register_and_enroll("u2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])
    client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=first_headers,
    )
    client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T09:00:00"},
        headers=second_headers,
    )
    assert len(client.get("/shifts/", headers=first_headers).json()) == 1
    assert len(client.get("/shifts/", headers=second_headers).json()) == 1


def test_delete_shift_scoped():
    _, first_response, _ = _register_and_enroll("u1@example.com")
    _, second_response, _ = _register_and_enroll("u2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])
    create_response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=first_headers,
    )
    shift_id = create_response.json()["id"]
    assert client.delete(f"/shifts/{shift_id}", headers=second_headers).status_code == 404
    assert client.delete(f"/shifts/{shift_id}", headers=first_headers).status_code == 204


def test_update_shift_scoped():
    _, first_response, _ = _register_and_enroll("u1@example.com")
    _, second_response, _ = _register_and_enroll("u2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])
    create_response = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=first_headers,
    )
    shift_id = create_response.json()["id"]
    update_data = {"start_time": "2026-03-19T08:00:00", "end_time": "2026-03-19T17:00:00"}
    assert client.put(f"/shifts/{shift_id}", json=update_data, headers=second_headers).status_code == 404
    res = client.put(f"/shifts/{shift_id}", json=update_data, headers=first_headers)
    assert res.status_code == 200
    assert res.json()["end_time"] == "2026-03-19T17:00:00"


def test_create_shift_idempotent():
    _, enroll_response, _ = _register_and_enroll("idemp@example.com")
    headers = _auth_headers(enroll_response.json()["access_token"])
    
    # 1. Create open shift
    res1 = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00"},
        headers=headers,
    )
    assert res1.status_code == 201
    assert res1.json()["end_time"] is None
    first_id = res1.json()["id"]

    # 2. Sync again with same start_time but completed end_time
    res2 = client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00", "end_time": "2026-03-19T17:00:00"},
        headers=headers,
    )
    assert res2.status_code == 201
    assert res2.json()["id"] == first_id
    assert res2.json()["end_time"] == "2026-03-19T17:00:00"

    # 3. Verify no duplicate shifts exist in DB
    list_res = client.get("/shifts/", headers=headers)
    assert len(list_res.json()) == 1


def test_create_off_day_with_auth():
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])
    response = client.post(
        "/off-days/",
        json={"date": "2026-03-19"},
        headers=headers,
    )
    assert response.status_code == 201
    assert response.json()["date"] == "2026-03-19"


def test_get_off_days_scoped():
    _, first_response, _ = _register_and_enroll("u1@example.com")
    _, second_response, _ = _register_and_enroll("u2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])
    client.post(
        "/off-days/",
        json={"date": "2026-03-19"},
        headers=first_headers,
    )
    assert len(client.get("/off-days/", headers=first_headers).json()) == 1
    assert len(client.get("/off-days/", headers=second_headers).json()) == 0


def test_delete_off_day_scoped():
    _, first_response, _ = _register_and_enroll("u1@example.com")
    _, second_response, _ = _register_and_enroll("u2@example.com")
    first_headers = _auth_headers(first_response.json()["access_token"])
    second_headers = _auth_headers(second_response.json()["access_token"])
    create_response = client.post(
        "/off-days/",
        json={"date": "2026-03-19"},
        headers=first_headers,
    )
    off_day_id = create_response.json()["id"]
    assert client.delete(f"/off-days/{off_day_id}", headers=second_headers).status_code == 404
    assert client.delete(f"/off-days/{off_day_id}", headers=first_headers).status_code == 204


def test_daily_hours_aggregation():
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T08:00:00", "end_time": "2026-03-19T10:00:00"},
        headers=headers,
    )
    client.post(
        "/shifts/",
        json={"start_time": "2026-03-19T13:00:00", "end_time": "2026-03-19T16:00:00"},
        headers=headers,
    )
    client.post(
        "/shifts/",
        json={"start_time": "2026-03-20T09:00:00", "end_time": "2026-03-20T13:30:00"},
        headers=headers,
    )

    response = client.get("/stats/daily-hours/", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert data["2026-03-19"] == 5.0
    assert data["2026-03-20"] == 4.5


def test_daily_hours_tolerates_mixed_timezone_frames(monkeypatch):
    """Desktop writes naive local timestamps, the web app writes UTC ("Z").
    A shift started on one and closed on the other has mixed frames; the
    aggregation must still answer instead of raising (500), reading the naive
    half as local time the way the clients' ``new Date(...)`` does."""
    monkeypatch.setenv("WORK_TIME_REPORT_TIMEZONE", "Europe/Berlin")
    report_timezone.cache_clear()

    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    created = client.post(
        "/shifts/", json={"start_time": "2026-07-15T09:00:00"}, headers=headers
    )
    shift_id = created.json()["id"]
    client.put(
        f"/shifts/{shift_id}",
        json={"start_time": "2026-07-15T09:00:00", "end_time": "2026-07-15T17:00:00Z"},
        headers=headers,
    )

    response = client.get("/stats/daily-hours/", headers=headers)
    assert response.status_code == 200
    # 09:00 local → 17:00Z (19:00 local in July) = 10h, not 8h.
    assert response.json()["2026-07-15"] == 10.0
    report_timezone.cache_clear()


def test_daily_hours_skips_unparseable_timestamps(monkeypatch):
    """One corrupt row must not take the whole aggregation down."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    client.post(
        "/shifts/",
        json={"start_time": "2026-07-16T08:00:00", "end_time": "2026-07-16T12:00:00"},
        headers=headers,
    )
    db = TestingSessionLocal()
    db.add(
        Shift(user_id=1, uuid="corrupt", start_time="not-a-timestamp", end_time="also-not")
    )
    db.commit()
    db.close()

    response = client.get("/stats/daily-hours/", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"2026-07-16": 4.0}


def test_sync_reconciles_multiple_open_shifts():
    """A cross-device race / old client can leave several shifts open at once.
    The server must keep only the most recently started one open and auto-close
    the rest to the end of their start day, flagged for the user."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    payload = {
        "shifts": [
            {
                "uuid": "open-old",
                "start_time": "2026-04-07T08:00:00",
                "end_time": None,
                "updated_at": "2026-04-07T08:00:00.000000+00:00",
            },
            {
                "uuid": "open-mid",
                "start_time": "2026-05-01T09:00:00",
                "end_time": None,
                "updated_at": "2026-05-01T09:00:00.000000+00:00",
            },
            {
                "uuid": "open-new",
                "start_time": "2026-07-10T10:00:00",
                "end_time": None,
                "updated_at": "2026-07-10T10:00:00.000000+00:00",
            },
        ],
        "off_days": [],
        "projects": [],
    }
    response = client.post("/sync/", json=payload, headers=headers)
    assert response.status_code == 200
    shifts = {s["uuid"]: s for s in response.json()["shifts"]}

    # Most recently started stays open and unflagged.
    assert shifts["open-new"]["end_time"] is None
    assert shifts["open-new"]["auto_closed_at"] is None

    # The earlier ones are auto-closed to 23:59:59 of their own start day.
    assert shifts["open-old"]["end_time"] == "2026-04-07T23:59:59"
    assert shifts["open-old"]["auto_closed_at"]
    assert shifts["open-mid"]["end_time"] == "2026-05-01T23:59:59"
    assert shifts["open-mid"]["auto_closed_at"]

    # Exactly one open shift remains.
    open_count = sum(1 for s in shifts.values() if s["end_time"] is None and not s["deleted"])
    assert open_count == 1


def test_sync_preserves_timezone_frame_when_auto_closing():
    """Auto-close must keep the original tz frame so the bounded shift never
    goes negative or spans days (web stores UTC ISO, desktop stores naive)."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    payload = {
        "shifts": [
            {
                "uuid": "utc-open",
                "start_time": "2026-04-07T08:00:00.000Z",
                "end_time": None,
                "updated_at": "2026-04-07T08:00:00.000000+00:00",
            },
            {
                "uuid": "newer-open",
                "start_time": "2026-07-10T10:00:00.000Z",
                "end_time": None,
                "updated_at": "2026-07-10T10:00:00.000000+00:00",
            },
        ],
        "off_days": [],
        "projects": [],
    }
    response = client.post("/sync/", json=payload, headers=headers)
    assert response.status_code == 200
    shifts = {s["uuid"]: s for s in response.json()["shifts"]}
    assert shifts["utc-open"]["end_time"] == "2026-04-07T23:59:59Z"
    assert shifts["newer-open"]["end_time"] is None


def test_create_shift_auto_closes_prior_open_shift():
    """Creating a new open shift while one is already open (cross-device) must
    auto-close the older one rather than leave two open."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    first = client.post(
        "/shifts/", json={"uuid": "s1", "start_time": "2026-04-07T08:00:00"}, headers=headers
    )
    assert first.status_code == 201
    assert first.json()["end_time"] is None

    second = client.post(
        "/shifts/", json={"uuid": "s2", "start_time": "2026-07-10T09:00:00"}, headers=headers
    )
    assert second.status_code == 201
    assert second.json()["end_time"] is None  # newest stays open

    all_shifts = {s["uuid"]: s for s in client.get("/shifts/", headers=headers).json()}
    assert all_shifts["s1"]["end_time"] == "2026-04-07T23:59:59"
    assert all_shifts["s1"]["auto_closed_at"]


def test_sync_single_open_shift_is_untouched():
    """A single legit open shift (running timer) must not be auto-closed."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    payload = {
        "shifts": [
            {
                "uuid": "only-open",
                "start_time": "2026-07-14T09:00:00",
                "end_time": None,
                "updated_at": "2026-07-14T09:00:00.000000+00:00",
            }
        ],
        "off_days": [],
        "projects": [],
    }
    response = client.post("/sync/", json=payload, headers=headers)
    assert response.status_code == 200
    shifts = response.json()["shifts"]
    assert len(shifts) == 1
    assert shifts[0]["end_time"] is None
    assert shifts[0]["auto_closed_at"] is None


def test_started_from_is_stored_and_round_trips():
    """Origin metadata is persisted on create and carried through sync."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    # REST create (web path) stamps origin.
    created = client.post(
        "/shifts/",
        json={"uuid": "w1", "start_time": "2026-03-01T08:00:00",
              "end_time": "2026-03-01T09:00:00", "started_from": "web"},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["started_from"] == "web"

    # Sync push (desktop path) carries origin and it survives the round-trip.
    payload = {
        "shifts": [{
            "uuid": "d1", "start_time": "2026-03-02T08:00:00",
            "end_time": "2026-03-02T09:00:00",
            "updated_at": "2026-03-02T09:00:00.000000+00:00",
            "started_from": "desktop",
        }],
        "off_days": [], "projects": [],
    }
    resp = client.post("/sync/", json=payload, headers=headers)
    assert resp.status_code == 200
    by_uuid = {s["uuid"]: s for s in resp.json()["shifts"]}
    assert by_uuid["d1"]["started_from"] == "desktop"
    assert by_uuid["w1"]["started_from"] == "web"


def test_shift_note_is_stored_and_round_trips():
    """A shift's free-text note persists on create/update and through sync."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    created = client.post(
        "/shifts/",
        json={"uuid": "n1", "start_time": "2026-04-01T08:00:00",
              "end_time": "2026-04-01T09:00:00", "note": "Fixed the sync bug"},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["note"] == "Fixed the sync bug"
    shift_id = created.json()["id"]

    # Editing the note updates it.
    updated = client.put(
        f"/shifts/{shift_id}",
        json={"start_time": "2026-04-01T08:00:00",
              "end_time": "2026-04-01T09:00:00", "note": "Fixed the sync bug + tests"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["note"] == "Fixed the sync bug + tests"

    # Sync carries the note.
    payload = {
        "shifts": [{
            "uuid": "n2", "start_time": "2026-04-02T08:00:00",
            "end_time": "2026-04-02T09:00:00",
            "updated_at": "2026-04-02T09:00:00.000000+00:00",
            "note": "wrote docs",
        }],
        "off_days": [], "projects": [],
    }
    resp = client.post("/sync/", json=payload, headers=headers)
    assert resp.status_code == 200
    by_uuid = {s["uuid"]: s for s in resp.json()["shifts"]}
    assert by_uuid["n2"]["note"] == "wrote docs"
    assert by_uuid["n1"]["note"] == "Fixed the sync bug + tests"


def test_project_rate_and_currency_round_trip():
    """Per-project billing (rate + currency) persists via REST and sync."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    created = client.post(
        "/projects/",
        json={"uuid": "p1", "name": "Client A", "rate": "80.00", "currency": "EUR"},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["rate"] == "80.00"
    assert created.json()["currency"] == "EUR"
    project_id = created.json()["id"]

    updated = client.put(
        f"/projects/{project_id}",
        json={"rate": "90.00", "currency": "USD"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["rate"] == "90.00"
    assert updated.json()["currency"] == "USD"

    # Sync carries billing info both ways.
    payload = {
        "shifts": [], "off_days": [],
        "projects": [{
            "uuid": "p2", "name": "Client B", "rate": "120", "currency": "GBP",
            "updated_at": "2026-04-02T09:00:00.000000+00:00",
        }],
    }
    resp = client.post("/sync/", json=payload, headers=headers)
    assert resp.status_code == 200
    by_uuid = {p["uuid"]: p for p in resp.json()["projects"]}
    assert by_uuid["p2"]["rate"] == "120"
    assert by_uuid["p2"]["currency"] == "GBP"
    assert by_uuid["p1"]["rate"] == "90.00"


def test_report_profile_round_trips_encrypted():
    """The report profile is stored encrypted and returned decrypted."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    # No profile initially.
    empty = client.get("/profile/", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["profile"] is None

    profile = {
        "name": "Julian Quandt",
        "company": "ACME GmbH",
        "default_currency": "EUR",
        "custom_fields": [{"label": "VAT", "value": "DE123"}],
    }
    saved = client.put("/profile/", json={"profile": profile}, headers=headers)
    assert saved.status_code == 200
    assert saved.json()["profile"] == profile
    assert saved.json()["profile_updated_at"]

    fetched = client.get("/profile/", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["profile"] == profile

    # It is genuinely encrypted at rest (not stored as readable JSON).
    db = TestingSessionLocal()
    try:
        row = db.query(User).first()
        assert row.profile_encrypted
        assert row.profile_encrypted.startswith("fernet$")
        assert "ACME GmbH" not in row.profile_encrypted
    finally:
        db.close()


def test_report_profile_is_per_user():
    """One user cannot read another user's profile."""
    _, first, _ = _register_and_enroll("owner@example.com")
    _, second, _ = _register_and_enroll("other@example.com")
    first_headers = _auth_headers(first.json()["access_token"])
    second_headers = _auth_headers(second.json()["access_token"])

    client.put("/profile/", json={"profile": {"name": "Owner"}}, headers=first_headers)

    assert client.get("/profile/", headers=second_headers).json()["profile"] is None
    assert client.get("/profile/", headers=first_headers).json()["profile"]["name"] == "Owner"


def test_work_schedule_round_trips_and_stamps_updated_at():
    """The work schedule round-trips and gets a server updated_at."""
    _, enroll_response, _ = _register_and_enroll()
    headers = _auth_headers(enroll_response.json()["access_token"])

    empty = client.get("/work-schedule/", headers=headers)
    assert empty.status_code == 200
    assert empty.json()["schedule"] is None
    assert empty.json()["schedule_updated_at"] is None

    schedule = {"mon": 7.2, "tue": 7.2, "wed": 7.2, "thu": 7.2, "fri": 7.2, "sat": 0, "sun": 0}
    saved = client.put("/work-schedule/", json={"schedule": schedule}, headers=headers)
    assert saved.status_code == 200
    assert saved.json()["schedule"] == schedule
    assert saved.json()["schedule_updated_at"]

    fetched = client.get("/work-schedule/", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["schedule"] == schedule
    assert fetched.json()["schedule_updated_at"] == saved.json()["schedule_updated_at"]


def test_work_schedule_is_per_user():
    """One user cannot read another user's work schedule."""
    _, first, _ = _register_and_enroll("owner@example.com")
    _, second, _ = _register_and_enroll("other@example.com")
    first_headers = _auth_headers(first.json()["access_token"])
    second_headers = _auth_headers(second.json()["access_token"])

    client.put("/work-schedule/", json={"schedule": {"mon": 8}}, headers=first_headers)

    assert client.get("/work-schedule/", headers=second_headers).json()["schedule"] is None
    assert client.get("/work-schedule/", headers=first_headers).json()["schedule"]["mon"] == 8
