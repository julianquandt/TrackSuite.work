import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

def test_requirements_server_exists():
    assert os.path.exists("requirements_server.txt")
    assert os.path.exists("backend/requirements.txt")

def test_requirements_server_content():
    with open("requirements_server.txt", "r") as f:
        content = f.read()
        assert "backend/requirements.txt" in content

    with open("backend/requirements.txt", "r") as f:
        content = f.read()
        assert "fastapi" in content
        assert "uvicorn" in content
        assert "sqlalchemy" in content
        assert "pydantic" in content
        assert "cryptography" in content

def test_deploy_script_exists():
    assert os.path.exists("deploy_backend.sh")
    assert os.path.exists("backend/deploy.sh")
    assert os.path.exists("uninstall_backend.sh")
    assert os.path.exists("backend/uninstall.sh")
    assert os.path.exists("backend/DEPLOYMENT.md")


def test_backend_deploy_script_is_executable():
    mode = os.stat("backend/deploy.sh").st_mode
    assert mode & 0o111


def test_backend_uninstall_script_is_executable():
    mode = os.stat("backend/uninstall.sh").st_mode
    assert mode & 0o111

def test_deploy_script_content():
    with open("deploy_backend.sh", "r") as f:
        content = f.read()
        assert "backend/deploy.sh" in content

    with open("backend/deploy.sh", "r") as f:
        content = f.read()
        assert "sparse-checkout" in content
        assert "fetch --depth=1 origin" in content
        assert "checkout -B" in content
        assert "WORK_TIME_REPO_URL" in content
        assert "APP_USER" in content
        assert 'chown -R "$APP_USER:$APP_GROUP" "$DEPLOY_DIR/data"' in content
        assert "venv" in content
        assert "backend/requirements.txt" in content
        assert "npm ci 2>/dev/null || npm install" in content
        assert "npm ci --omit=dev" not in content
        assert "WORK_TIME_ENCRYPTION_KEY" in content


def test_uninstall_script_content():
    with open("uninstall_backend.sh", "r") as f:
        content = f.read()
        assert "backend/uninstall.sh" in content

    with open("backend/uninstall.sh", "r") as f:
        content = f.read()
        assert 'systemctl disable --now "$SERVICE_NAME"' in content
        assert 'rm -f "$SYSTEMD_UNIT_PATH"' in content
        assert 'rm -rf "$DEPLOY_DIR"' in content
        assert "Apache configuration will not be changed" in content


def test_root_deployment_doc_points_to_backend_copy():
    with open("DEPLOYMENT.md", "r") as f:
        content = f.read()
        assert "backend/DEPLOYMENT.md" in content


def test_backend_deployment_doc_mentions_private_repo_bootstrap():
    with open("backend/DEPLOYMENT.md", "r") as f:
        content = f.read()
        assert "Start Over From Scratch" in content
        assert "sudo ./backend/uninstall.sh" in content
        assert "Choose a deployment mode" in content
        assert "Full TrackSuite.work site" in content
        assert "Backend API only" in content
        assert "should live on its own site root or subdomain" in content
        assert "For a private repository, run these commands on the server" in content
        assert "git clone --filter=blob:none --sparse" in content
        assert "git sparse-checkout set backend app_server website" in content
        assert "sudo SKIP_WEBSITE_BUILD=1 ./backend/deploy.sh main" in content
        assert "runs the backend as `www-data`" in content
        assert "APP_USER=tracksuite-work APP_GROUP=tracksuite-work" not in content
        assert "git clone --no-checkout" not in content


def test_backend_deployment_doc_covers_existing_apache_site_path_prefix():
    with open("backend/DEPLOYMENT.md", "r") as f:
        content = f.read()
        assert "Option B: Backend API only on an existing Apache site" in content
        assert "ProxyPass /tracksuite-work-api/ http://127.0.0.1:8007/" in content
        assert "ProxyPassReverse /tracksuite-work-api/ http://127.0.0.1:8007/" in content
        assert "https://yourdomain.com/tracksuite-work-api" in content


def test_apache_examples_do_not_fallback_unknown_paths_to_index():
    with open("backend/DEPLOYMENT.md", "r") as f:
        deployment_doc = f.read()

    assert "FallbackResource /index.html" not in deployment_doc
    assert "hash-based routes" in deployment_doc

    # This is a machine-local Apache vhost example and is intentionally gitignored.
    apache_template_path = ROOT / "packaging/linux/tracksuite-work.julianquandt.com.conf"
    if apache_template_path.exists():
        apache_template = apache_template_path.read_text()
        assert "FallbackResource /index.html" not in apache_template


def test_backend_deployment_doc_covers_first_user_registration():
    with open("backend/DEPLOYMENT.md", "r") as f:
        content = f.read()
        assert "Register the first user" in content
        assert "https://yourdomain.com/tracksuite-work-api/auth/register" in content
        assert "https://tracksuite-work.example.com/api/auth/register" in content
        assert "totp_secret" in content
        assert "/auth/mfa/confirm-enrollment" in content
        assert '"device_name":"Initial browser"' in content
        assert "recovery codes" in content
        assert "https://yourdomain.com/tracksuite-work-api/auth/login" in content
        assert '"otp":"123456"' in content
        assert "https://yourdomain.com/tracksuite-work-api/auth/api-keys" in content
        assert "/auth/login/recovery" in content
        assert "If `/auth/register` returns `404`" in content


def test_deploy_script_populates_sparse_checkout_after_no_checkout_clone(tmp_path):
    source_repo = tmp_path / "source"
    source_repo.mkdir()
    (source_repo / "backend").mkdir()
    (source_repo / "app_server").mkdir()
    (source_repo / "website").mkdir()
    (source_repo / "backend" / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
    (source_repo / "app_server" / "__init__.py").write_text("", encoding="utf-8")
    (source_repo / "website" / "index.html").write_text("<html></html>\n", encoding="utf-8")

    subprocess.run(["git", "init", "-b", "main"], cwd=source_repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=source_repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source_repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "add", "."], cwd=source_repo, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=source_repo, check=True, capture_output=True, text=True)

    deploy_dir = tmp_path / "deploy"
    subprocess.run(["git", "clone", "--no-checkout", str(source_repo), str(deploy_dir)], check=True, capture_output=True, text=True)

    env = os.environ.copy()
    env["DEPLOY_DIR"] = str(deploy_dir)
    env["WORK_TIME_REPO_URL"] = str(source_repo)
    env["SKIP_PYTHON_SETUP"] = "1"
    env["SKIP_WEBSITE_BUILD"] = "1"

    subprocess.run(
        ["bash", str(ROOT / "backend" / "deploy.sh"), "main"],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert (deploy_dir / "backend" / "requirements.txt").exists()
    assert (deploy_dir / "app_server" / "__init__.py").exists()
    assert (deploy_dir / "website" / "index.html").exists()

def test_systemd_template_exists():
    assert os.path.exists("app_server/work-time-backend.service")
    assert os.path.exists("backend/work-time-backend.service")

def test_systemd_template_content():
    with open("backend/work-time-backend.service", "r") as f:
        content = f.read()
        assert "[Unit]" in content
        assert "APP_USER/APP_GROUP" in content
        assert "uvicorn" in content
        assert "backend.app_server.main:app" in content
        assert "WORK_TIME_JWT_SECRET" in content
        assert "WORK_TIME_ENCRYPTION_KEY" in content
