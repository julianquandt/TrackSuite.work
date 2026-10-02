import { defineConfig, loadEnv } from "vite";

/**
 * Which surfaces this build contains.
 *
 * Every build is the app — tracker, dashboard, reports — and that is all you
 * want unless you are the operator of tracksuite.work itself.
 *
 * The one other value builds tracksuite.work's own public site: its landing
 * page, its download section, its self-hosting guide. Those pages advertise one
 * specific hosted instance — its uptime, its signup, its downloads — so a copy
 * running anywhere else is just wrong rather than useful. That's why it isn't
 * mentioned in the guides: not to protect anything, but because nobody
 * following them wants it. The code is MIT like the rest; fork it, rename it,
 * do as you like.
 *
 * Resolved here, in Node, rather than in the app: `define` substitutes a real
 * boolean literal, so `if (APP_ONLY)` folds at build time and the landing page
 * is dropped from the bundle entirely instead of merely never being routed to.
 * Doing the same normalisation inside config.ts would leave it in the output.
 */
const OPERATOR_PROFILE = "tracksuite-public";
const DEFAULT_REPO_SLUG = "julianquandt/TrackSuite.work";

function isAppOnly(env: Record<string, string>): boolean {
    return (env.VITE_SITE_PROFILE ?? "").trim().toLowerCase() !== OPERATOR_PROFILE;
}

/**
 * Which repository the footer's source/licence/issues links point at. Resolved
 * here for the same reason as the profile: substituted as a literal, so a
 * fork's bundle carries its own URL and not this one's as a dead fallback.
 */
function repoSlug(env: Record<string, string>): string {
    return (env.VITE_REPO_SLUG ?? "").trim() || DEFAULT_REPO_SLUG;
}

export default defineConfig(({ mode }) => {
    // "" loads every variable, not just the VITE_-prefixed ones, and reads
    // .env.local — the untracked per-deployment config.
    const env = loadEnv(mode, process.cwd(), "");
    const appOnly = isAppOnly(env);

    console.log(`  Profile: ${appOnly ? "app (tracker, dashboard, reports)"
        : `${OPERATOR_PROFILE} — tracksuite.work's own marketing site`}`);

    return {
        root: ".",
        define: {
            __APP_ONLY__: JSON.stringify(appOnly),
            __REPO_SLUG__: JSON.stringify(repoSlug(env)),
        },
        build: {
            outDir: "dist",
            emptyOutDir: true,
        },
        server: {
            port: 3000,
            // Allow importing ../shared (code shared with the desktop app).
            fs: { allow: [".."] },
            proxy: {
                "/api": {
                    target: "http://127.0.0.1:8007",
                    rewrite: (path) => path.replace(/^\/api/, ""),
                },
            },
        },
    };
});
