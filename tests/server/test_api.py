"""Tests for the TrackSuite.work API with MFA enrollment, refresh sessions, and recovery flows."""

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app_server import limiter
from app_server.main import app, get_db
from app_server.models import Base, RecoveryCode, User, UserSession


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
