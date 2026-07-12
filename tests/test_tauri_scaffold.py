import json
import os


def test_desktop_scaffold_exists():
    assert os.path.exists("desktop/package.json")
    assert os.path.exists("desktop/src-tauri/tauri.conf.json")
    assert os.path.exists("desktop/src-tauri/src/main.rs")
    assert os.path.exists("desktop/src-tauri/src/db.rs")
    assert os.path.exists("desktop/src-tauri/icons/icon.png")


def test_desktop_package_json_content():
    with open("desktop/package.json", "r") as f:
        data = json.load(f)

    assert data["name"] == "tracksuite-work-desktop"
    assert "tauri" in data["scripts"]
    assert "chart.js" in data["dependencies"]


def test_backend_canonical_structure_exists():
    assert os.path.exists("backend/app_server/main.py")
    assert os.path.exists("backend/deploy.sh")
    assert os.path.exists("backend/work-time-backend.service")