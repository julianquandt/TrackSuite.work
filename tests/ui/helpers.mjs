// Shared helpers for the browser tests: find Chrome, start the dev servers,
// open a page, and check what is really visible.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TAURI_MOCK = join(REPO, "tests", "ui", "tauri-mock.js");

const CHROME_PATHS = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

/** Path of an installed Chrome/Chromium, or null (tests then skip). */
export function findChrome() {
    return CHROME_PATHS.find((p) => existsSync(p)) ?? null;
}

export async function launchBrowser() {
    return chromium.launch({ executablePath: findChrome(), headless: true });
}

async function waitForHttp(url, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Nothing answered at ${url}. Is the port already in use?`);
}

function start(cmd, args, opts) {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, ...opts });
    // Kill the whole process group: npx starts vite as a child of its own.
    return () => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } };
}

/** Start a Vite dev server for desktop/ or website/. Returns { url, stop }. */
export async function startVite(app, port) {
    const stop = start("npx", ["vite", "--port", String(port), "--strictPort"], { cwd: join(REPO, app) });
    const url = `http://localhost:${port}`;
    try { await waitForHttp(url + "/"); } catch (e) { stop(); throw e; }
    return { url, stop };
}

/**
 * Start the real backend on a throwaway database with a seeded, signed-in
 * test account (the same seeding as scripts/sandbox-web.sh).
 * Returns { loginHash, stop }. The website dev server proxies /api to port 8007.
 */
export async function startBackend() {
    const py = join(REPO, ".venv", "bin", "python");
    if (!existsSync(py)) throw new Error("Missing .venv (see README): the web tests need the Python backend.");
    const dir = mkdtempSync(join(tmpdir(), "tracksuite-ui-"));
    const env = {
        ...process.env,
        WORK_TIME_JWT_SECRET: "ui-tests-only-not-a-real-secret-0123456789abcdef",
        // A fixed, throwaway Fernet key (32 url-safe base64 bytes); protects nothing real.
        WORK_TIME_ENCRYPTION_KEY: "dWktdGVzdHMtb25seS1ub3QtYS1yZWFsLWtleS0wMTI=",
        WORK_TIME_DB_FILE: join(dir, "server.db"),
        WORK_TIME_DISABLE_MAINTENANCE: "1",
    };
    const stop = start(py, ["-m", "uvicorn", "backend.app_server.main:app", "--host", "127.0.0.1", "--port", "8007"], { cwd: REPO, env });
    try {
        await waitForHttp("http://127.0.0.1:8007/meta/instance");
        const seed = spawn(py, [join(REPO, "scripts", "sandbox_web_seed.py"), dir], { cwd: REPO, env });
        let out = "";
        seed.stdout.on("data", (d) => { out += d; });
        const code = await new Promise((r) => seed.on("close", r));
        if (code !== 0 || !out.trim().startsWith("#/dev-login")) throw new Error("Seeding the test account failed.");
        return { loginHash: out.trim(), stop };
    } catch (e) { stop(); throw e; }
}

/** Open the desktop interface with the Rust stand-in. `seed` sets its starting state. */
export async function openDesktop(browser, url, { width = 1280, height = 800, seed = {}, localStorage = {} } = {}) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(([seed, ls]) => {
        window.__TAURI_SEED__ = seed;
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
    }, [seed, localStorage]);
    await page.addInitScript(readFileSync(TAURI_MOCK, "utf8"));
    await page.goto(url + "/");
    await page.waitForSelector("#project-chip");
    await page.waitForSelector(".tl-block");
    return { page, errors };
}

/**
 * True when the element is what the user would actually hit at several points
 * inside it: not clipped by a parent and not covered by something else.
 */
export async function isFullyOnTop(page, selector) {
    return page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const b = el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2) return false;
        const points = [
            [b.left + b.width / 2, b.top + 6], [b.left + b.width / 2, b.bottom - 6],
            [b.left + 6, b.top + b.height / 2], [b.right - 6, b.top + b.height / 2],
        ];
        return points.every(([x, y]) => { const hit = document.elementFromPoint(x, y); return !!hit && el.contains(hit); });
    }, selector);
}

/** A wider font than the app's own, like some system setups: stresses tight layouts. */
export async function useWideFont(page) {
    await page.addStyleTag({ content: `body, button, input, h1 { font-family: "DejaVu Sans", Verdana, sans-serif !important; }` });
}

/** The colour of one screen pixel, as a comparable string. */
export async function pixel(page, x, y) {
    const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
    return png.toString("base64");
}
