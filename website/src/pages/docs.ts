export function renderDocs(app: HTMLElement): void {
    app.innerHTML = `
        <div class="docs-content">
            <h1>Self-Hosting TrackSuite.work</h1>
            <p>TrackSuite.work is uniquely designed to support full self-hosting. You retain 100% control of your telemetry and desktop analytics. The backend is a standard FastAPI service, backed by SQLite, and managed through systemd on Linux.</p>

            <h2>Prerequisites</h2>
            <p>To deploy your own instance, you will need:</p>
            <ul>
                <li>A Linux server (Ubuntu/Debian recommended)</li>
                <li>Python 3.10+ and <code>venv</code></li>
                <li>Node.js 20.19+ or 22.12+ (to build the web dashboard)</li>
                <li>Git</li>
            </ul>

            <h2>1. Automated Deployment</h2>
            <p>We provide a deploy script that pulls the required directories, creates a Python virtual environment, installs dependencies, and builds the frontend dashboard.</p>
            <pre><code>sudo mkdir -p /opt/work-time-app
sudo chown "$USER":"$USER" /opt/work-time-app
git clone --filter=blob:none --sparse git@github.com:YOUR_USERNAME/work-time-app.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website
sudo ./backend/deploy.sh main</code></pre>
            
            <p>This provisions everything in <code>/opt/work-time-app</code>. Use it when you want the full TrackSuite.work website plus API on its own site root or subdomain. If you only want the backend behind your existing Apache site, run <code>sudo SKIP_WEBSITE_BUILD=1 ./backend/deploy.sh main</code> for the last step and proxy only one path to the backend.</p>

            <p>To remove the backend later without touching Apache, run <code>cd /opt/work-time-app &amp;&amp; sudo ./backend/uninstall.sh</code>.</p>

            <h2>2. Generate a JWT Secret</h2>
            <p>Your backend needs a secure secret to sign and verify access tokens. You can generate a 32-byte hex string using Python:</p>
            <pre><code>python3 -c "import secrets; print(secrets.token_hex(32))"</code></pre>

            <h2>3. Configure Systemd Service</h2>
            <p>Create or edit the service file to keep the backend running persistently. Be sure to replace the <code>WORK_TIME_JWT_SECRET</code> value with the token generated in the previous step, and leave <code>User=www-data</code> / <code>Group=www-data</code> unless you intentionally need something different.</p>
            <pre><code>sudo nano /etc/systemd/system/work-time-backend.service</code></pre>
            
            <pre><code>[Unit]
Description=TrackSuite.work Backend (FastAPI)
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/work-time-app
Environment="PATH=/opt/work-time-app/venv_server/bin"
Environment="WORK_TIME_JWT_SECRET=YOUR_GENERATED_SECRET_HERE"
Environment="WORK_TIME_DB_FILE=/opt/work-time-app/data/work_time_server.db"

ExecStart=/opt/work-time-app/venv_server/bin/uvicorn backend.app_server.main:app --host 127.0.0.1 --port 8007 --workers 1

Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target</code></pre>

            <h2>4. Start the Service</h2>
            <p>Enable the service to start automatically on system boot and launch it immediately.</p>
            <pre><code>sudo systemctl daemon-reload
sudo systemctl enable --now work-time-backend</code></pre>

            <h2>Connecting the Desktop Client</h2>
            <p>Once your backend is running behind a reverse proxy (like Nginx/Caddy) with SSL, create a sync API key in the web dashboard, then open your TrackSuite.work desktop client and enter the API base URL plus that key.</p>
        </div>
    `;
}
