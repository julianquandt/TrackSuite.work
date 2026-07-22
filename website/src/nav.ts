import { getToken, logout } from "./api";
import { isFullMode } from "./mode";

export function renderNav(app: HTMLElement): void {
    const token = getToken();
    const reportsLink = isFullMode() ? `<a href="#/reports">Reports</a>` : "";
    const downloadBtn = `<a href="#/" id="nav-download" class="btn btn-outline btn-small">Download</a>`;
    const navRight = token
        ? `<a href="#/tracker">Tracker</a>${reportsLink}<a href="#/docs">Docs</a><a href="#/dashboard">Dashboard</a>${downloadBtn}<a href="#/" id="nav-logout">Logout</a>`
        : `<a href="#/docs">Docs</a>${downloadBtn}<a href="#/login">Login</a><a href="#/register" class="btn btn-primary btn-small">Sign Up</a>`;

    const nav = document.createElement("nav");
    nav.className = "site-nav";
    nav.innerHTML = `
        <a href="#/" class="logo">TrackSuite<span>.work</span></a>
        <div class="nav-links">
            ${navRight}
            <button id="theme-toggle" class="btn btn-outline btn-small" style="padding: 0.4rem; border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-subtle);">
                <svg id="theme-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
            </button>
        </div>
    `;
    app.prepend(nav);

    const themeToggle = nav.querySelector("#theme-toggle");
    const themeIcon = nav.querySelector("#theme-icon");

    const sunIcon = `<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;
    const moonIcon = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;

    function updateTheme(theme: string) {
        if (theme === "dark") {
            document.documentElement.classList.add("dark");
            document.documentElement.classList.remove("light");
            if (themeIcon) themeIcon.innerHTML = sunIcon;
        } else {
            document.documentElement.classList.add("light");
            document.documentElement.classList.remove("dark");
            if (themeIcon) themeIcon.innerHTML = moonIcon;
        }
        localStorage.setItem("theme", theme);
    }

    // Initialize
    const savedTheme = localStorage.getItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    if (savedTheme) {
        updateTheme(savedTheme);
    } else {
        updateTheme(systemDark ? "dark" : "light");
    }

    themeToggle?.addEventListener("click", () => {
        const isDark = document.documentElement.classList.contains("dark");
        updateTheme(isDark ? "light" : "dark");
    });

    // Sync with system changes if no manual override
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e => {
        if (!localStorage.getItem("theme")) {
            updateTheme(e.matches ? "dark" : "light");
        }
    });

    // "Download for Desktop" scrolls to the downloads section on the landing page
    // (routing to #/ first if we're elsewhere, since the section only exists there).
    const downloadLink = nav.querySelector("#nav-download");
    downloadLink?.addEventListener("click", (e) => {
        e.preventDefault();
        const scrollToDownloads = () =>
            document.getElementById("downloads")?.scrollIntoView({ behavior: "smooth", block: "start" });
        const h = window.location.hash;
        if ((h === "" || h === "#/" || h === "#") && document.getElementById("downloads")) {
            scrollToDownloads();
        } else {
            window.location.hash = "#/";
            setTimeout(scrollToDownloads, 80); // wait for the landing route to render
        }
    });

    const logoutBtn = nav.querySelector("#nav-logout");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            await logout();
            window.location.hash = "#/";
        });
    }
}
