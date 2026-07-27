import { REPO_URL } from "../config";

const DEPLOYMENT_GUIDE = `${REPO_URL}/blob/main/backend/DEPLOYMENT.md`;

/**
 * Self-hosting quickstart.
 *
 * Deliberately a summary, not a second copy of the deployment guide: this page
 * and `backend/DEPLOYMENT.md` drifted apart once already, and the version that
 * lost was this one — it omitted WORK_TIME_ENCRYPTION_KEY entirely, so anyone
 * following it built a backend that refused to start. The repository file is
 * the single source of truth; everything here links to it.
 */
export function renderDocs(app: HTMLElement): void {
    app.innerHTML = `
        <div class="docs-content">
            <h1>Self-Hosting TrackSuite.work</h1>
            <p>The backend is a standard FastAPI service backed by SQLite, managed through systemd. Self-hosting it gives you multi-device sync and the web app on your own infrastructure, with none of your data on ours.</p>

            <p class="docs-callout">This page is the short version. The complete guide — Apache reverse proxy with TLS and security headers, backups, data-at-rest encryption and key rotation, GDPR tooling — lives in the repository and is kept current there: <a href="${DEPLOYMENT_GUIDE}" target="_blank" rel="noopener">backend/DEPLOYMENT.md</a>. Where the two disagree, that file wins.</p>

            <h2>Prerequisites</h2>
            <ul>
                <li>A Linux server (Ubuntu/Debian recommended)</li>
                <li>Python 3.12+ and <code>venv</code> (3.12 is what CI tests)</li>
                <li>Node.js 20.19+ or 22.12+ (to build the web app)</li>
                <li>Git, and a reverse proxy with TLS (Apache config is in the full guide)</li>
            </ul>

            <h2>1. Deploy</h2>
            <p>The deploy script checks out the server-side directories, creates a virtualenv, installs dependencies and builds the web app.</p>
            <pre><code>sudo mkdir -p /opt/work-time-app
sudo chown "$USER":"$USER" /opt/work-time-app
git clone --filter=blob:none --sparse ${REPO_URL}.git /opt/work-time-app
cd /opt/work-time-app
git sparse-checkout set backend app_server website
sudo ./backend/deploy.sh main</code></pre>
            <p>Running the backend behind an existing website instead, with no web app? Use <code>sudo SKIP_WEBSITE_BUILD=1 ./backend/deploy.sh main</code> and proxy a single path to the backend.</p>
            <p>To remove it later without touching your web server: <code>cd /opt/work-time-app &amp;&amp; sudo ./backend/uninstall.sh</code></p>

            <h2>2. Generate Two Secrets</h2>
            <p>A JWT signing secret and a Fernet key for data-at-rest encryption. <strong>Both are required</strong> — the backend refuses to start without them, or with the shipped placeholders, so a misconfigured deploy fails loudly instead of running on a known key.</p>
            <pre><code>python3 -c "import secrets; print(secrets.token_hex(32))"
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"</code></pre>

            <h2>3. Configure the Service</h2>
            <p>Install the unit file that ships with the repo rather than writing one by hand — it carries the hardening settings and the correct paths.</p>
            <pre><code>sudo cp /opt/work-time-app/backend/work-time-backend.service /etc/systemd/system/</code></pre>
            <p>Keep the secrets out of the unit file: anything set with <code>Environment=</code> is readable by any local user through <code>systemctl show</code>. Put them in a root-only file instead.</p>
            <pre><code>sudo tee /etc/work-time-backend.env >/dev/null &lt;&lt;'EOF'
WORK_TIME_JWT_SECRET=&lt;your-hex-secret&gt;
WORK_TIME_ENCRYPTION_KEY=&lt;your-fernet-key&gt;
EOF
sudo chmod 600 /etc/work-time-backend.env
sudo chown root:root /etc/work-time-backend.env</code></pre>
            <p>Then reference it from the unit, replacing the placeholder <code>Environment=</code> secret lines:</p>
            <pre><code>EnvironmentFile=/etc/work-time-backend.env</code></pre>
            <p>systemd reads the file as root before dropping to <code>www-data</code>, so the service still gets the values while other local users can't.</p>

            <h2>4. Start It</h2>
            <pre><code>sudo systemctl daemon-reload
sudo systemctl enable --now work-time-backend</code></pre>

            <h2>5. Choose Who May Register</h2>
            <p>A fresh instance accepts sign-ups from anyone who can reach it. That is right for a public service and wrong for almost every self-hosted one, so registration is gated by environment variables in the same file as your secrets.</p>

            <h3>Just me</h3>
            <p>No sign-up form at all — you create your one account over SSH.</p>
            <pre><code>WORK_TIME_SIGNUP_MODE=closed
WORK_TIME_MAX_USERS=1</code></pre>
            <p>Then create the account. It prints a QR code, a manual setup key and ten recovery codes, and the account is active immediately — no email round-trip, so this works on a server with no mail provider.</p>
            <pre><code>cd /opt/work-time-app
sudo -u www-data env $(grep -v '^#' /etc/work-time-backend.env | xargs) \\
  ./venv_server/bin/python -m app_server.cli create-user --email me@example.com</code></pre>
            <p>Pass the service's environment as above — <code>WORK_TIME_ENCRYPTION_KEY</code> above all, since the address and authenticator secret are encrypted at rest. The CLI also offers <code>list-users</code>, <code>reset-password</code>, <code>reset-2fa</code>, <code>recovery-codes</code> and <code>delete-user</code>.</p>

            <h3>My team or company</h3>
            <p>Colleagues enrol themselves; nobody else can. Set either restriction or both — with both, an address must match a permitted domain <em>and</em> present a valid invite code.</p>
            <pre><code>WORK_TIME_SIGNUP_MODE=restricted
WORK_TIME_SIGNUP_ALLOWED_DOMAINS=acme.com,acme.de
WORK_TIME_SIGNUP_INVITE_CODES=a-long-random-string
WORK_TIME_INSTANCE_NAME=Acme Time</code></pre>
            <p>A typo in <code>WORK_TIME_SIGNUP_MODE</code>, or <code>restricted</code> with nothing configured to restrict by, closes registration rather than opening it — a mistake in this file must never expose sign-up to the internet.</p>

            <h2>6. What Gets Built</h2>
            <p>The deploy builds the app: tracker, dashboard and reports. This website you are reading — landing page, download section, these docs — is marketing for our hosted service and is never part of your build. Nothing to do and nothing to switch off: <code>/</code> simply goes straight to the tracker, or to the sign-in page.</p>
            <p>Copy <code>website/.env.example</code> to <code>website/.env.local</code> to publish your own imprint and privacy policy — required if you put an instance on the open internet from the EU. Set <code>VITE_LEGAL_JURISDICTION</code> to <code>at</code> or <code>de</code> and the pages cite that country's statutes, liability rules and data-protection authority. Leave <code>VITE_LEGAL_NAME</code> empty and no legal pages are published at all, which is what you want for an internal instance already covered by your organisation's own notices. That file is untracked, so it survives every deploy.</p>

            <h2>Optional: Email</h2>
            <p>Without a mail provider the server works fully — registrations simply auto-verify. Configure <a href="https://resend.com" target="_blank" rel="noopener">Resend</a> and you additionally get email verification, password reset, and security notices for password changes and account deletion. See the full guide for the three variables involved.</p>

            <h2>Connecting the Desktop Client</h2>
            <p>Once the backend is running behind TLS, create a sync API key in the web dashboard, then open the desktop client and enter your API base URL plus that key.</p>

            <p class="docs-callout">Something unclear or out of date here? <a href="${REPO_URL}/issues" target="_blank" rel="noopener">Open an issue</a> — documentation bugs are bugs.</p>
        </div>
    `;
}
