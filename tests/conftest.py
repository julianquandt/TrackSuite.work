import os

import pytest
from cryptography.fernet import Fernet


os.environ.setdefault("WORK_TIME_API_KEY", "test_key")
os.environ.setdefault("WORK_TIME_JWT_SECRET", "test-jwt-secret-for-suite-0123456789abcdef")
os.environ.setdefault("WORK_TIME_ENCRYPTION_KEY", Fernet.generate_key().decode("utf-8"))


@pytest.fixture(autouse=True)
def set_env_vars():
    yield
