import pytest
from unittest.mock import MagicMock, patch
from work_time_app.database import init_db, set_config, add_shift_manual, add_off_day
from work_time_app.sync import SyncManager
import work_time_app.database
import requests
import time

@pytest.fixture
def test_db(tmp_path):
    db_file = tmp_path / "test_sync.db"
    import work_time_app.database
    original_path = work_time_app.database.DB_PATH
    work_time_app.database.DB_PATH = str(db_file)
    init_db()
    yield str(db_file)
    work_time_app.database.DB_PATH = original_path

@patch("requests.post")
@patch("requests.get")
def test_sync_push(mock_get, mock_post, test_db):
    # Setup config
    set_config("server_url", "http://localhost:8007")
    set_config("api_key", "test_key")
    set_config("user_id", "1")
    
    # Add local data
    add_shift_manual("2026-03-19T08:00:00", "2026-03-19T10:00:00")
    add_off_day("2026-03-20")
    
    # Mock responses
    mock_post.return_value.status_code = 201
    mock_get.return_value.status_code = 200
    mock_get.return_value.json.return_value = [] # Server has no data
    
    manager = SyncManager()
    success = manager.sync()
    
    assert success is True
    assert mock_post.call_count == 2
    
    found_shift_call = False
    found_off_day_call = False
    for call in mock_post.call_args_list:
        args, kwargs = call
        if "shifts" in args[0]:
            found_shift_call = True
        if "off-days" in args[0]:
            found_off_day_call = True
            
    assert found_shift_call is True
    assert found_off_day_call is True

@patch("requests.get")
def test_sync_unauthorized(mock_get, test_db):
    set_config("server_url", "http://localhost:8007")
    set_config("api_key", "wrong_key")
    set_config("user_id", "1")
    
    # Mock a 403 error
    mock_response = MagicMock()
    mock_response.status_code = 403
    mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("403 Forbidden")
    mock_get.return_value = mock_response
    
    manager = SyncManager()
    success = manager.sync()
    
    assert success is False

@patch("requests.post")
@patch("requests.get")
def test_sync_background(mock_get, mock_post, test_db):
    set_config("server_url", "http://localhost:8007")
    set_config("api_key", "test_key")
    set_config("user_id", "1")
    
    mock_post.return_value.status_code = 201
    mock_get.return_value.status_code = 200
    mock_get.return_value.json.return_value = []
    
    callback_called = False
    def callback(success):
        nonlocal callback_called
        callback_called = True
    
    manager = SyncManager()
    thread = manager.sync_background(callback=callback)
    thread.join() # Wait for background task
    
    assert callback_called is True
