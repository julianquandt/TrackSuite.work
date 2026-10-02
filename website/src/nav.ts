import { getToken, logout } from "./api";
import { APP_ONLY, instanceConfig } from "./config";

/** "TrackSuite.work" keeps its two-tone logo; a custom instance name renders plainly. */
function logoMarkup(name: string): string {
    if (name === "TrackSuite.work") return `TrackSuite<span>.work</span>`;
    const el = document.createElement("span");
    el.textContent = name;
    return el.innerHTML;
}

// The nav is re-rendered on every route; document-level listeners are installed
// once and act on whichever nav is current (they used to pile up per render).
let currentNav: HTMLElement | null = null;
let closeCurrentMobileMenu: (() => void) | null = null;
let applyCurrentTheme: ((theme: string) => void) | null = null;
let globalNavListenersInstalled = false;

function installGlobalNavListeners() {
    if (globalNavListenersInstalled) return;
    globalNavListenersInstalled = true;
    document.addEventListener("click", (e) => {
        if (currentNav && !currentNav.contains(e.target as Node)) closeCurrentMobileMenu?.();
    });
    // Follow the system theme while the user hasn't picked one.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        if (!localStorage.getItem("theme")) applyCurrentTheme?.(e.matches ? "dark" : "light");
    });
}

/** "system" follows the OS setting; "light"/"dark" are stored overrides. */
export function setThemePreference(pref: "system" | "light" | "dark"): void {
    if (pref === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", pref);
    const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    applyCurrentTheme?.(dark ? "dark" : "light");
}

export function getThemePreference(): "system" | "light" | "dark" {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
}

export function renderNav(app: HTMLElement): void {
    const token = getToken();
    const config = instanceConfig();
    const isPublic = !APP_ONLY;

    const links: string[] = [];
    const actions: string[] = [];

    if (token) {
        links.push(`<a href="#/tracker" class="nav-link">Tracker</a>`);
        if (isPublic) links.push(`<a href="#/docs" class="nav-link">Docs</a>`);
        links.push(`<a href="#/dashboard" class="nav-link">Account</a>`);
        if (isPublic) {
            links.push(`<a href="#/" id="nav-download" class="nav-link scroll-downloads">Download</a>`);
        }
        actions.push(`<a href="#/" id="nav-logout" class="btn btn-outline btn-small">Logout</a>`);
    } else {
        if (isPublic) {
            links.push(`<a href="#/docs" class="nav-link">Docs</a>`);
            links.push(`<a href="#/" id="nav-download" class="nav-link scroll-downloads">Download</a>`);
        }
        links.push(`<a href="#/login" class="nav-link">Login</a>`);
        if (config.signup_open) {
            actions.push(`<a href="#/register" class="btn btn-primary btn-small">Sign Up</a>`);
        }
    }

    const nav = document.createElement("nav");
    nav.className = "site-nav";
    nav.innerHTML = `
        <div class="nav-container">
            <a href="${APP_ONLY ? (token ? "#/tracker" : "#/login") : "#/"}" class="logo">${logoMarkup(config.instance_name)}</a>
            <div class="nav-right">
                <div id="site-nav-links" class="nav-links">
                    <div class="nav-group-links">
                        ${links.join("")}
                    </div>
                    ${actions.length ? `<div class="nav-group-actions">${actions.join("")}</div>` : ""}
                </div>
                <button id="theme-toggle" class="theme-toggle-btn" aria-label="Toggle theme" title="Toggle theme">
                    <svg id="theme-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
                </button>
                <button id="mobile-menu-toggle" class="mobile-menu-btn" aria-label="Toggle navigation menu" aria-expanded="false">
                    <svg class="icon-menu" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    <svg class="icon-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
    `;
    app.prepend(nav);

    const themeToggle = nav.querySelector("#theme-toggle");
    const themeIcon = nav.querySelector("#theme-icon");
    const mobileMenuToggle = nav.querySelector<HTMLButtonElement>("#mobile-menu-toggle");
    const navLinks = nav.querySelector<HTMLElement>("#site-nav-links");

    function toggleMobileMenu(force?: boolean) {
        const isOpen = force !== undefined ? force : !nav.classList.contains("nav-open");
        nav.classList.toggle("nav-open", isOpen);
        if (mobileMenuToggle) {
            mobileMenuToggle.setAttribute("aria-expanded", String(isOpen));
        }
    }

    mobileMenuToggle?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMobileMenu();
    });

    // Close mobile menu on clicking any navigation link or clicking outside
    navLinks?.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", () => toggleMobileMenu(false));
    });

    currentNav = nav;
    closeCurrentMobileMenu = () => toggleMobileMenu(false);
    installGlobalNavListeners();

    const sunIcon = `<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;
    const moonIcon = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;

    // Apply a theme without storing it (system-following stays system-following).
    function applyTheme(theme: string) {
        const dark = theme === "dark";
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.classList.toggle("light", !dark);
        if (themeIcon) themeIcon.innerHTML = dark ? sunIcon : moonIcon;
        // Charts read theme colours when drawn; let open pages redraw them.
        window.dispatchEvent(new CustomEvent("tracksuite:themechange"));
    }
    applyCurrentTheme = applyTheme;

    const savedTheme = localStorage.getItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(savedTheme ?? (systemDark ? "dark" : "light"));

    themeToggle?.addEventListener("click", () => {
        const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
        localStorage.setItem("theme", next);
        applyTheme(next);
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
