const PUBLIC_REPO = "julianquandt/TrackSuite.work";

type GhAsset = { name: string; browser_download_url: string };
type OS = "windows" | "macos" | "linux";

// Platform groups, in the order their files should appear (primary first).
const PLATFORMS: { key: OS; title: string; exts: string[]; icon: string }[] = [
    {
        key: "windows", title: "Windows", exts: [".exe", ".msi"],
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
    },
    {
        key: "macos", title: "macOS", exts: [".dmg"],
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`,
    },
    {
        key: "linux", title: "Linux", exts: [".appimage", ".deb", ".rpm", ".flatpak"],
        icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 9 12 6 15"/><line x1="12" y1="15" x2="16" y2="15"/></svg>`,
    },
];

function detectOS(): OS | "other" {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("windows")) return "windows";
    if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
    if (ua.includes("linux") || ua.includes("x11")) return "linux";
    return "other";
}

function extOf(name: string): string {
    const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
    return m ? m[0] : "";
}

function assetLabel(name: string): string {
    const n = name.toLowerCase();
    if (n.endsWith(".exe")) return "Windows installer (.exe)";
    if (n.endsWith(".msi")) return "Windows (.msi)";
    if (n.endsWith(".dmg")) {
        if (n.includes("aarch64") || n.includes("arm64")) return "Apple Silicon (.dmg)";
        if (n.includes("x64") || n.includes("x86_64") || n.includes("intel")) return "Intel (.dmg)";
        return "macOS (.dmg)";
    }
    if (n.endsWith(".appimage")) return "AppImage (portable)";
    if (n.endsWith(".deb")) return "Debian / Ubuntu (.deb)";
    if (n.endsWith(".rpm")) return "Fedora / RHEL (.rpm)";
    if (n.endsWith(".flatpak")) return "Flatpak";
    return name;
}

// Populate the download grid from the latest GitHub release. Assets are versioned
// (names change each release), so we resolve real download URLs at runtime rather
// than hardcode them. Falls back to a single "latest release" button on any error
// (rate limit, offline, or no published release yet).
async function populateDownloads(): Promise<void> {
    const grid = document.getElementById("download-grid");
    const versionEl = document.getElementById("download-version");
    if (!grid) return;
    try {
        const res = await fetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const assets: GhAsset[] = Array.isArray(data.assets) ? data.assets : [];
        const userOS = detectOS();
        const ordered = [...PLATFORMS].sort((a, b) =>
            (a.key === userOS ? -1 : 0) - (b.key === userOS ? -1 : 0));

        grid.innerHTML = ordered.map((p) => {
            const items = assets
                .filter((a) => p.exts.includes(extOf(a.name)))
                .sort((a, b) => p.exts.indexOf(extOf(a.name)) - p.exts.indexOf(extOf(b.name)));
            const mine = p.key === userOS;
            const btns = items.length
                ? items.map((a, i) => {
                    // Route .deb clicks through the apt-nudge dialog first.
                    const isDeb = a.name.toLowerCase().endsWith(".deb");
                    const cls = `btn ${i === 0 ? "btn-primary" : "btn-outline"} download-btn${isDeb ? " deb-download" : ""}`;
                    return `<a class="${cls}" href="${a.browser_download_url}" target="_blank" rel="noopener">${assetLabel(a.name)}</a>`;
                  }).join("")
                : `<span class="download-empty">Not in this release</span>`;
            return `<div class="download-card${mine ? " download-card-mine" : ""}">
                <div class="download-card-head">${p.icon}<h3>${p.title}${mine ? `<span class="download-badge">Your system</span>` : ""}</h3></div>
                <div class="download-card-btns">${btns}</div>
            </div>`;
        }).join("");

        if (versionEl && data.tag_name) versionEl.textContent = `Latest release: ${data.tag_name}`;
    } catch {
        grid.innerHTML = `<a class="btn btn-primary" href="https://github.com/${PUBLIC_REPO}/releases/latest" target="_blank" rel="noopener">Download latest release</a>
            <p class="download-empty">Couldn't load individual files just now — the latest release has installers for every platform.</p>`;
    }
}

// Reveal-on-scroll for feature blocks. Honours reduced-motion by showing
// everything immediately.
function observeReveals(): void {
    const reveals = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (!reveals.length) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
        reveals.forEach((el) => el.classList.add("in-view"));
        return;
    }
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) { e.target.classList.add("in-view"); io.unobserve(e.target); }
        }
    }, { threshold: 0.25 });
    reveals.forEach((el) => io.observe(el));
}

// The hero timeline's running block counts up from page load — a live, honest
// timer, the way the app itself shows an open shift.
let heroTimer: number | undefined;
function startHeroTimer(): void {
    const el = document.getElementById("hero-live-time");
    if (!el) return;
    if (heroTimer) window.clearInterval(heroTimer); // don't stack across re-renders
    const start = Date.now() - 2 * 3600_000 - 47 * 60_000; // seed at ~2h47m so it reads full
    const tick = () => {
        const s = Math.floor((Date.now() - start) / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        el.textContent = `${hh}:${mm}:${ss}`;
    };
    tick();
    heroTimer = window.setInterval(tick, 1000);
}

// A mini day-timeline (colored project blocks + a live one). Reused in the hero
// and feature visuals; blocks grow in on load/reveal.
function miniTimeline(opts: { live?: boolean; note?: string } = {}): string {
    const note = opts.note
        ? `<span class="mtl-note" style="left:41%"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>${opts.note}</span>`
        : "";
    const liveBlock = opts.live
        ? `<span class="mtl-block mtl-live" style="left:80%;width:15%"></span>`
        : `<span class="mtl-block mtl-c1" style="left:80%;width:11%"></span>`;
    return `<div class="mtl-track">
        <span class="mtl-block mtl-c1" style="left:0%;width:23%"></span>
        <span class="mtl-block mtl-c2" style="left:25%;width:13%"></span>
        <span class="mtl-block mtl-c3" style="left:40%;width:28%"></span>
        <span class="mtl-block mtl-c2" style="left:70%;width:8%"></span>
        ${liveBlock}
        ${note}
    </div>`;
}

// The apt setup as three separate, copy-paste steps. Reused on the download
// section and in the .deb confirmation dialog.
function aptStepsHtml(): string {
    const key = "https://julianquandt.github.io/TrackSuite.work/apt/tracksuite-work.asc";
    const url = "https://julianquandt.github.io/TrackSuite.work/apt";
    return `<ol class="apt-steps">
        <li><span class="apt-step-label">1 · Add the signing key</span>
            <pre><code>curl -fsSL ${key} | sudo gpg --dearmor -o /usr/share/keyrings/tracksuite-work.gpg</code></pre></li>
        <li><span class="apt-step-label">2 · Add the repository</span>
            <pre><code>echo "deb [signed-by=/usr/share/keyrings/tracksuite-work.gpg] ${url} stable main" | sudo tee /etc/apt/sources.list.d/tracksuite-work.list</code></pre></li>
        <li><span class="apt-step-label">3 · Install</span>
            <pre><code>sudo apt update &amp;&amp; sudo apt install track-suite-work</code></pre></li>
    </ol>`;
}

export function renderLanding(app: HTMLElement): void {
    app.innerHTML = `
        <section class="hero">
            <span class="hero-eyebrow">Time tracking · menu bar &amp; browser</span>
            <h1>Your workday, on <span>one clear timeline.</span></h1>
            <p>
                Clock in from your menu bar or your browser. TrackSuite.work tracks
                your hours offline, lets you assign them to projects on a visual
                timeline, and turns them into reports — with sync only if you want it.
            </p>
            <div class="hero-actions">
                <a href="#/register" class="btn btn-primary">Open the web app</a>
                <a href="#/" class="btn btn-outline scroll-downloads">Download for Desktop</a>
            </div>

            <div class="hero-stage" aria-hidden="true">
                <div class="hero-tl-head">
                    <span class="hero-tl-day">Today</span>
                    <span class="hero-tl-live"><span class="rec-dot"></span>Tracking <b id="hero-live-time">02:47:00</b></span>
                </div>
                <div class="hero-tl-ticks"><span>09:00</span><span>11:00</span><span>13:00</span><span>15:00</span><span>now</span></div>
                ${miniTimeline({ live: true, note: "client call" })}
                <div class="hero-tl-legend">
                    <span><i class="dot dot-c1"></i>Acme</span>
                    <span><i class="dot dot-c2"></i>Internal</span>
                    <span><i class="dot dot-c3"></i>Design</span>
                </div>
            </div>
        </section>

        <!-- Web vs desktop: two ways to run the same tracker -->
        <section class="section ways">
            <div class="section-header">
                <h2>Two ways to use it</h2>
                <p>Same account, same timeline. Pick whichever fits the moment — or use both.</p>
            </div>
            <div class="ways-grid">
                <article class="way-card">
                    <div class="way-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    </div>
                    <h3>Web app</h3>
                    <p>Nothing to install. Open it in any browser, clock in, and your timeline is there — handy for trying it out or working from a machine that isn't yours. Backed by a server you choose: our cloud, or your own.</p>
                    <a href="#/register" class="btn btn-primary btn-small">Open the web app</a>
                </article>
                <article class="way-card">
                    <div class="way-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16"/><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 21h6"/><circle cx="6" cy="4" r="1"/></svg>
                    </div>
                    <h3>Desktop app</h3>
                    <p>A tiny menu-bar / tray companion that starts instantly and keeps running in the background. Tracks 100% offline with a local database; sync is optional. Windows, macOS and Linux.</p>
                    <a href="#/" class="btn btn-outline btn-small scroll-downloads">Download for Desktop</a>
                </article>
            </div>
        </section>

        <!-- Feature showcase -->
        <section class="section feats">
            <div class="section-header">
                <h2>Built around your day</h2>
                <p>Every feature works toward one thing: an accurate, honest record of where your time went.</p>
            </div>
            <div class="feat-list">
                <article class="feat reveal">
                    <div class="feat-visual feat-visual-clock">
                        <div class="fv-clock"><span class="rec-dot"></span><span class="fv-time">01:12:38</span></div>
                        <div class="fv-caption">Menu bar · Tray · Browser</div>
                    </div>
                    <div class="feat-copy">
                        <h3>Clock in from anywhere</h3>
                        <p>Start the timer from the menu bar, the tray, or a browser tab. It keeps counting even offline, and your running session shows live on the timeline.</p>
                    </div>
                </article>

                <article class="feat feat-reverse reveal">
                    <div class="feat-visual feat-visual-tl">
                        <div class="fv-tl-ticks"><span>09</span><span>12</span><span>15</span><span>18</span></div>
                        ${miniTimeline({ note: "kickoff notes" })}
                        <div class="fv-brush">🖌 note brush</div>
                    </div>
                    <div class="feat-copy">
                        <h3>A visual timeline you can edit</h3>
                        <p>Drag across your day to assign work to projects. Switched tasks a lot? Paint one note across several blocks with the note brush instead of typing them one at a time.</p>
                    </div>
                </article>

                <article class="feat reveal">
                    <div class="feat-visual feat-visual-bars">
                        <div class="fv-bars">
                            <span class="fv-bar" style="--h:42%"><i class="fv-seg fv-c3" style="height:60%"></i><i class="fv-seg fv-c1" style="height:40%"></i></span>
                            <span class="fv-bar" style="--h:70%"><i class="fv-seg fv-c1" style="height:55%"></i><i class="fv-seg fv-c2" style="height:45%"></i></span>
                            <span class="fv-bar" style="--h:55%"><i class="fv-seg fv-c1" style="height:100%"></i></span>
                            <span class="fv-bar" style="--h:88%"><i class="fv-seg fv-c1" style="height:70%"></i><i class="fv-seg fv-c3" style="height:30%"></i></span>
                            <span class="fv-bar" style="--h:64%"><i class="fv-seg fv-c2" style="height:100%"></i></span>
                        </div>
                        <div class="fv-balance">Balance <b>+2h 40m</b></div>
                    </div>
                    <div class="feat-copy">
                        <h3>Trends &amp; overtime at a glance</h3>
                        <p>See worked-versus-target and your running balance. Click any bar — even weeks back — to open that day and backfill or fix it, right there.</p>
                    </div>
                </article>

                <article class="feat feat-reverse reveal">
                    <div class="feat-visual feat-visual-doc">
                        <div class="fv-doc">
                            <div class="fv-doc-head"><span class="fv-doc-brand"></span><span class="fv-doc-meta"></span></div>
                            <div class="fv-doc-row"><span></span><b></b></div>
                            <div class="fv-doc-row"><span></span><b></b></div>
                            <div class="fv-doc-row"><span></span><b></b></div>
                            <div class="fv-doc-total"><span>Total</span><b>€ 3,240</b></div>
                        </div>
                    </div>
                    <div class="feat-copy">
                        <h3>Client-ready reports</h3>
                        <p>Turn tracked hours into a client report (hours × rate) or a timesheet. Add a letterhead and per-project rates, then print to PDF or export CSV.</p>
                    </div>
                </article>

                <article class="feat reveal">
                    <div class="feat-visual feat-visual-sync">
                        <div class="fv-dev fv-dev-a"><span class="fv-dev-scr"></span></div>
                        <div class="fv-sync-line"><span class="fv-sync-pulse"></span></div>
                        <div class="fv-dev fv-dev-b"><span class="fv-dev-scr"></span></div>
                    </div>
                    <div class="feat-copy">
                        <h3>Sync only if you want</h3>
                        <p>Everything works 100% offline. Turn on encrypted sync and one timeline follows you across every device — last write wins, no conflicts to babysit.</p>
                    </div>
                </article>

                <article class="feat feat-reverse reveal">
                    <div class="feat-visual feat-visual-own">
                        <svg class="fv-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.3"/></svg>
                    </div>
                    <div class="feat-copy">
                        <h3>Your data stays yours</h3>
                        <p>Local-first by default — your database lives on your machine. Use our cloud, or self-host the open-source FastAPI backend on your own box and hold the keys.</p>
                    </div>
                </article>
            </div>
        </section>

        <!-- Infrastructure choice -->
        <section class="section pathway-section">
            <div class="section-header" style="text-align:left; margin-left:0; max-width:800px;">
                <h2 style="font-size:2.5rem; margin-bottom:0;">Choose your infrastructure.</h2>
                <p style="margin-top:1rem;">The app is the same everywhere. What changes is where your data lives.</p>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 01</span>
                    <h3 class="pathway-title">Local solo</h3>
                </div>
                <div class="pathway-content">
                    <p>The purest way to use TrackSuite.work. Run the desktop app entirely on your machine — its database lives on your disk and never touches a network cable. No account, no server, nothing to trust. Prefer the browser? The web app needs a backend, so pick a cloud below.</p>
                    <div class="pathway-actions">
                        <a href="#/" class="btn btn-outline scroll-downloads">Download for Desktop</a>
                    </div>
                </div>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 02</span>
                    <h3 class="pathway-title">TrackSuite.work cloud</h3>
                </div>
                <div class="pathway-content">
                    <p>Instant sync across macOS, Windows, Linux and the web app. Create an account and we run the encrypted bridge between your devices, so your balance is always right no matter where you clock in. Nothing to deploy.</p>
                    <div class="pathway-actions">
                        <a href="#/register" class="btn btn-primary">Start syncing</a>
                    </div>
                </div>
            </div>

            <div class="pathway-row">
                <div class="pathway-meta">
                    <span class="pathway-number">LEVEL 03</span>
                    <h3 class="pathway-title">Self-hosted</h3>
                </div>
                <div class="pathway-content">
                    <p>For teams and power users. Deploy the lightweight FastAPI backend to your own VPS or homelab — it serves the web app and syncs every desktop client. You own the hardware, the backups and the encryption keys.</p>
                    <div class="pathway-actions">
                        <a href="#/docs" class="btn btn-outline">Read the deployment guide</a>
                    </div>
                </div>
            </div>
        </section>

        <section class="downloads" id="downloads">
            <h2>Download for Desktop</h2>
            <p>Native apps for Windows, macOS, and Linux. Start tracking locally today — no backend setup required.</p>
            <div class="download-grid" id="download-grid">
                <p class="download-loading" id="download-loading">Fetching the latest release…</p>
            </div>
            <div class="download-links">
                <a href="https://github.com/${PUBLIC_REPO}/releases" class="btn btn-outline" target="_blank" rel="noopener">See all versions</a>
            </div>
            <p class="download-note" id="download-version"></p>

            <div class="update-info">
                <h3>Staying up to date</h3>
                <ul class="update-list">
                    <li class="update-auto"><span class="update-tag">Automatic</span> Windows, macOS and the Linux <strong>AppImage</strong> update themselves in the background.</li>
                    <li class="update-apt"><span class="update-tag">apt</span> On <strong>Debian / Ubuntu</strong>, add our repository once and update with a normal <code>apt upgrade</code>.</li>
                    <li class="update-assisted"><span class="update-tag">Manual</span> The direct <strong>.deb</strong> / <strong>.rpm</strong> downloads open your system installer (no self-update) — handy if you'd rather not add a repo.</li>
                    <li class="update-soon"><span class="update-tag">Coming soon</span> The <strong>Flatpak</strong> on Flathub.</li>
                </ul>
                <div class="apt-setup">
                    <p class="apt-setup-title">Debian / Ubuntu — set up apt</p>
                    ${aptStepsHtml()}
                </div>
            </div>
        </section>

        <section class="section" style="background: var(--bg-surface);">
            <div class="section-header">
                <h2 style="font-size: 1.5rem; margin-bottom: 0.5rem;">Under the hood</h2>
                <p>Technical details for the engineering-minded.</p>
            </div>
            <div class="split-grid">
                <div class="info-block" style="background: transparent; border: none; padding: 0;">
                    <ul>
                        <li><strong>Tauri client:</strong> the desktop app runs natively via Tauri (Rust), for a fraction of the memory of a Chromium wrapper.</li>
                        <li><strong>Offline-first:</strong> all logging and calculations happen locally. Every feature works without a network connection.</li>
                    </ul>
                </div>
                <div class="info-block" style="background: transparent; border: none; padding: 0;">
                    <ul>
                        <li><strong>Optional FastAPI backend:</strong> a small async Python service that acts purely as a sync bridge between local databases.</li>
                        <li><strong>Zero-overhead sync:</strong> compact JSON over HTTPS, secured with JWT — last-write-wins, no merge conflicts.</li>
                    </ul>
                </div>
            </div>
        </section>

        <dialog id="deb-apt-dialog" class="deb-dialog">
            <h3>Get automatic updates with apt</h3>
            <p>The <code>.deb</code> installs fine, but it won't update itself — you'd download a fresh one each release. On Debian/Ubuntu we recommend adding our apt repository instead, so updates arrive with a normal <code>apt upgrade</code>.</p>
            ${aptStepsHtml()}
            <div class="deb-dialog-actions">
                <a id="deb-proceed" class="btn btn-outline" href="" target="_blank" rel="noopener">Just download the .deb</a>
                <button id="deb-done" class="btn btn-primary" type="button">I'll use apt</button>
            </div>
        </dialog>

        <footer class="site-footer">
            <p>&copy; ${new Date().getFullYear()} TrackSuite.work OSS. Under MIT License.</p>
        </footer>
    `;

    // Smooth-scroll any in-page "Download for Desktop" links to the section.
    app.querySelectorAll<HTMLAnchorElement>(".scroll-downloads").forEach((a) => {
        a.addEventListener("click", (e) => {
            e.preventDefault();
            document.getElementById("downloads")?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });

    // Nudge .deb downloaders toward apt (which auto-updates) before the direct
    // download. Delegated on the grid, which populateDownloads refills.
    const debDialog = document.getElementById("deb-apt-dialog") as HTMLDialogElement | null;
    document.getElementById("download-grid")?.addEventListener("click", (e) => {
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(".deb-download");
        if (!link || !debDialog) return;
        e.preventDefault();
        const proceed = document.getElementById("deb-proceed") as HTMLAnchorElement | null;
        if (proceed) proceed.href = link.href;
        debDialog.showModal();
    });
    document.getElementById("deb-done")?.addEventListener("click", () => debDialog?.close());
    document.getElementById("deb-proceed")?.addEventListener("click", () => debDialog?.close());

    void populateDownloads();
    observeReveals();
    startHeroTimer();
}
