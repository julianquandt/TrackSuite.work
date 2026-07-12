import pytest
import os
import sqlite3
from work_time_app.database import init_db, get_config, set_config

@pytest.fixture
def test_db(tmp_path):
    db_file = tmp_path / "test.db"
    # We need a way to tell database.py to use this path
    import work_time_app.database
    original_path = work_time_app.database.DB_PATH
    work_time_app.database.DB_PATH = str(db_file)
    
    init_db()
    yield str(db_file)
    
    work_time_app.database.DB_PATH = original_path

def test_set_get_config(test_db):
    set_config("server_url", "http://localhost:8007")
    set_config("api_key", "secret_key")
    set_config("user_id", "1")
    
    assert get_config("server_url") == "http://localhost:8007"
    assert get_config("api_key") == "secret_key"
    assert get_config("user_id") == "1"

def test_get_config_not_found(test_db):
    assert get_config("non_existent") is None
