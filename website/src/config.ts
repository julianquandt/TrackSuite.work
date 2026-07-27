/**
 * Deployment configuration for the web app.
 *
 * Two layers:
 *  - **Build-time** (`VITE_*`, baked in by `npm run build`): which *surfaces*
 *    exist. The default is the tracker and nothing else, because almost every
 *    build of this repo is someone self-hosting, and the marketing site for
 *    tracksuite.work has no place on their server. Building the public site —
 *    landing page, downloads, self-hosting guide — is the opt-in.
 *  - **Runtime** (`GET /api/meta/instance`, fetched once at startup): what the
 *    *backend* permits — whether signup is open, whether an invite code is
 *    required, which email domains are accepted. The server enforces all of it
 *    regardless; this only decides what the UI bothers to render.
 */

/**
 * Substituted with a literal `true`/`false` by Vite's `define` (see
 * `vite.config.ts`). Being a literal is the point: `if (APP_ONLY)` folds at
 * build time, so an ordinary build doesn't merely hide the landing page — it
 * doesn't contain it.
 */
declare const __APP_ONLY__: boolean;

export const APP_ONLY = __APP_ONLY__;

/**
 * Where the source lives, from `VITE_REPO_SLUG` (see `vite.config.ts`). A fork
 * should point that at its own repository — otherwise its users file bugs about
 * code it no longer runs.
 */
declare const __REPO_SLUG__: string;

export const REPO_URL = `https://github.com/${__REPO_SLUG__}`;
export const REPO_ISSUES_URL = `${REPO_URL}/issues`;
export const REPO_NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
export const REPO_LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const REPO_RELEASES_URL = `${REPO_URL}/releases`;

export interface InstanceConfig {
    instance_name: string;
    signup_mode: "open" | "restricted" | "closed";
    signup_open: boolean;
    invite_required: boolean;
    allowed_email_domains: string[];
    email_enabled: boolean;
    tos_version: string;
}

/**
 * Assume an open, public instance until told otherwise. The fallback matters
 * when the endpoint is missing (a backend that hasn't been restarted yet) — the
 * public site must not hide its own signup link over a failed metadata fetch,
 * and hiding nothing is safe because /auth/register enforces the real policy.
 */
const DEFAULT_CONFIG: InstanceConfig = {
    instance_name: "TrackSuite.work",
    signup_mode: "open",
    signup_open: true,
    invite_required: false,
    allowed_email_domains: [],
    email_enabled: true,
    tos_version: "",
};

let current: InstanceConfig = DEFAULT_CONFIG;

export function instanceConfig(): InstanceConfig {
    return current;
}

export async function loadInstanceConfig(): Promise<InstanceConfig> {
    try {
        const res = await fetch("/api/meta/instance", { headers: { Accept: "application/json" } });
        if (res.ok) {
            current = { ...DEFAULT_CONFIG, ...(await res.json()) };
        }
    } catch {
        // Offline or unreachable backend — keep the defaults and let the app load.
    }
    return current;
}
