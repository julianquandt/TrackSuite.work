import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app_server.models import ApiKey, Base, OffDay, RecoveryCode, Shift, User, UserSession


def test_create_user():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    user = User(
        email="test@example.com",
        password_hash="fakehash",
        totp_secret="fernet$encrypted",
        pending_totp_secret="fernet$pending",
        mfa_enrolled_at="2026-03-30T12:05:00",
        created_at="2026-03-30T12:00:00",
    )
    session.add(user)
    session.commit()

    fetched = session.query(User).first()
    assert fetched.email == "test@example.com"
    assert fetched.password_hash == "fakehash"
    assert fetched.totp_secret == "fernet$encrypted"
    assert fetched.pending_totp_secret == "fernet$pending"
    assert fetched.mfa_enrolled_at == "2026-03-30T12:05:00"


def test_user_email_uniqueness():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    session.add(User(email="a@b.com", password_hash="h", totp_secret="AAAA", created_at="t"))
    session.commit()
    session.add(User(email="a@b.com", password_hash="h2", totp_secret="BBBB", created_at="t"))
    with pytest.raises(Exception):
        session.commit()


def test_create_api_key():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    key = ApiKey(
        user_id=1,
        key_hash="abc123",
        name="desktop",
        created_at="2026-03-30T12:00:00",
    )
    session.add(key)
    session.commit()

    fetched = session.query(ApiKey).first()
    assert fetched.name == "desktop"
    assert fetched.user_id == 1


def test_create_recovery_code():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    code = RecoveryCode(
        user_id=1,
        code_hash="argon-hash",
        created_at="2026-03-30T12:00:00",
        used_at=None,
    )
    session.add(code)
    session.commit()

    fetched = session.query(RecoveryCode).first()
    assert fetched.user_id == 1
    assert fetched.used_at is None


def test_create_user_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    user_session = UserSession(
        id="session-1",
        user_id=1,
        refresh_token_hash="refresh-hash",
        created_at="2026-03-30T12:00:00",
        last_used_at="2026-03-30T12:00:00",
        expires_at="2026-04-29T12:00:00",
        revoked_at=None,
        ip_address="127.0.0.1",
        user_agent="pytest",
        label="Pytest Browser",
    )
    session.add(user_session)
    session.commit()

    fetched = session.query(UserSession).first()
    assert fetched.id == "session-1"
    assert fetched.label == "Pytest Browser"


def test_create_shift():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    new_shift = Shift(user_id=1, start_time="2026-03-19T08:00:00")
    session.add(new_shift)
    session.commit()

    shift = session.query(Shift).first()
    assert shift.user_id == 1
    assert shift.start_time == "2026-03-19T08:00:00"
    assert shift.end_time is None


def test_create_off_day():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    new_off_day = OffDay(user_id=1, date="2026-03-19")
    session.add(new_off_day)
    session.commit()

    off_day = session.query(OffDay).first()
    assert off_day.user_id == 1
    assert off_day.date == "2026-03-19"
