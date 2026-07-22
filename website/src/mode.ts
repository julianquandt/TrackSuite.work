/**
 * App mode: "simple" (default — clean tracker, as it always was) vs "full"
 * (reveals reports/billing surfaces: project rates, letterhead profile, and the
 * Reports page). A per-device UI preference stored in localStorage; shift notes
 * are available in BOTH modes and are never gated by this.
 */

export type AppMode = "simple" | "full";

const MODE_KEY = "app_mode";

export function getMode(): AppMode {
    return localStorage.getItem(MODE_KEY) === "full" ? "full" : "simple";
}

export function setMode(mode: AppMode): void {
    localStorage.setItem(MODE_KEY, mode);
}

export function isFullMode(): boolean {
    return getMode() === "full";
}
