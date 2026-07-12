export function renderLanding(app: HTMLElement): void {
    app.innerHTML = `
        <section class="hero">
            <h1>Track your work time,<br><span>effortlessly.</span></h1>
            <p>
                TrackSuite.work lives in your system menu. Clock in seamlessly,
                visualize your balance, and keep your data exactly where you want it.
            </p>
            <div class="hero-actions">
                <a href="#/register" class="btn btn-primary">Use Hosted Version</a>
                <a href="#/docs" class="btn btn-outline">Self-Host Docs</a>
            </div>
        </section>

        <section class="features-container" id="features">
            <div class="features-grid">
                <div class="feature-cell">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <h3>Native Integration</h3>
                    <p>Starts instantly from your macOS menu bar or Windows tray. No heavy Electron wrappers or browser tabs.</p>
                </div>
                <div class="feature-cell">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                    <h3>Backend Optional</h3>
                    <p>TrackSuite.work works 100% offline. A backend is only needed if you want to sync between multiple machines.</p>
                </div>
                <div class="feature-cell">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                    <h3>Privacy First</h3>
                    <p>By default, your data never leaves your computer. You choose if and where to sync your work history.</p>
                </div>
                <div class="feature-cell">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                    <h3>True Ownership</h3>
                    <p>Whether you use our cloud or your own VPS, your database belongs to you. No vendor lock-in.</p>
                </div>
            </div>
        </section>

        <style>
            .pathway-section {
                padding: 8rem 2rem;
                border-top: 1px solid var(--border-subtle);
                max-width: 1100px;
                margin: 0 auto;
            }
            .pathway-row {
                display: flex;
                gap: 4rem;
                margin-bottom: 6rem;
                align-items: flex-start;
            }
            .pathway-row:last-child { margin-bottom: 0; }
            .pathway-meta {
                flex: 0 0 240px;
                padding-top: 0.5rem;
            }
            .pathway-number {
                display: block;
                font-family: var(--font-mono);
                font-size: 0.75rem;
                color: var(--text-tertiary);
                margin-bottom: 1rem;
                letter-spacing: 0.1em;
            }
            .pathway-title {
                font-size: 1.5rem;
                font-weight: 600;
                margin-bottom: 1rem;
            }
            .pathway-content {
                flex: 1;
                font-size: 1.125rem;
                line-height: 1.6;
            }
            .pathway-actions {
                margin-top: 2rem;
                display: flex;
                gap: 1rem;
            }
            @media (max-width: 768px) {
                .pathway-row { flex-direction: column; gap: 1rem; margin-bottom: 4rem; }
                .pathway-meta { flex: none; }
            }
        </style>

        <section class="pathway-section">
            <div class="section-header" style="text-align: left; margin-left: 0; max-width: 800px;">
                <h2 style="font-size: 3rem; margin-bottom: 4rem;">Choose your infrastructure.</h2>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 01</span>
                    <h3 class="pathway-title">Local Solo</h3>
                </div>
                <div class="pathway-content">
                    <p>The purest way to use TrackSuite.work. Your database lives on your disk, and your data never touches a network cable. Perfect for single-machine setups where privacy is the only priority.</p>
                    <div class="pathway-actions">
                         <span class="btn btn-outline" style="cursor: default; opacity: 0.7;">No Account Needed</span>
                    </div>
                </div>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 02</span>
                    <h3 class="pathway-title">TrackSuite.work Cloud</h3>
                </div>
                <div class="pathway-content">
                    <p>Instant synchronization across macOS, Windows, and Linux. We provide the encrypted bridge between your devices, so your work balance is always accurate no matter where you clock in.</p>
                    <div class="pathway-actions">
                        <a href="#/register" class="btn btn-primary">Start Syncing</a>
                    </div>
                </div>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 03</span>
                    <h3 class="pathway-title">Self-Hosted</h3>
                </div>
                <div class="pathway-content">
                    <p>For teams and power users. Deploy our lightweight FastAPI backend to your own VPS or homelab. You own the hardware, the database backups, and the encryption keys.</p>
                    <div class="pathway-actions">
                        <a href="#/docs" class="btn btn-outline">Read Deployment Guide</a>
                    </div>
                </div>
            </div>
        </section>

        <section class="section" style="background: var(--bg-surface);">
            <div class="section-header">
                <h2 style="font-size: 1.5rem; margin-bottom: 0.5rem;">Under the Hood</h2>
                <p>Technical details for the engineering-minded.</p>
            </div>
            <div class="split-grid">
                <div class="info-block" style="background: transparent; border: none; padding: 0;">
                    <ul>
                        <li><strong>Tauri Client:</strong> The desktop app runs natively using Tauri (Rust), dramatically lowering memory footprint versus Chromium-based web wrappers.</li>
                        <li><strong>Offline-First:</strong> The app performs all logging and calculations locally. All features work without an active network connection.</li>
                    </ul>
                </div>
                <div class="info-block" style="background: transparent; border: none; padding: 0;">
                    <ul>
                        <li><strong>Optional FastAPI Backend:</strong> An asynchronous Python service that acts purely as a synchronization bridge for the local databases.</li>
                        <li><strong>Zero-Overhead Sync:</strong> Syncing is done via efficient JSON payloads over HTTPS, secured by JWT authentication.</li>
                    </ul>
                </div>
            </div>
        </section>

        <section class="downloads" id="downloads">
            <h2>Download TrackSuite.work</h2>
            <p>Desktop apps for Windows, macOS, and Linux. Start tracking locally today — no backend setup required.</p>
            <div class="download-links">
                <a href="https://github.com/julianquandt/TrackSuite.work/releases/latest" class="btn btn-primary" target="_blank" rel="noopener">Download latest release</a>
                <a href="https://github.com/julianquandt/TrackSuite.work/releases" class="btn btn-outline" target="_blank" rel="noopener">All releases</a>
            </div>
            <p class="download-note">Windows (installer) · macOS (.dmg) · Linux (.deb / AppImage)</p>
        </section>

        <footer class="site-footer">
            <p>&copy; ${new Date().getFullYear()} TrackSuite.work OSS. Under MIT License.</p>
        </footer>
    `;
}
