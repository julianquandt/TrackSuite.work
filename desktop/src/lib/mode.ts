import { invoke } from "@tauri-apps/api/core";

/**
 * App mode: "simple" (default — the clean tracker) vs "full" (reveals billing
 * rates, the report letterhead profile, and the Reports tab). Persisted in the
 * local config table. Loaded once at startup so callers can read it
 * synchronously during render. Shift notes are in BOTH modes and never gated.
 */

export type AppMode = "simple" | "full";

let currentMode: AppMode = "simple";

export async function loadMode(): Promise<AppMode> {
    const raw = await invoke<string | null>("get_config", { key: "app_mode" });
    currentMode = raw === "full" ? "full" : "simple";
    return currentMode;
}

export function getMode(): AppMode {
    return currentMode;
}

export function isFullMode(): boolean {
    return currentMode === "full";
}

export async function setModePersisted(mode: AppMode): Promise<void> {
    currentMode = mode;
    await invoke("set_config", { key: "app_mode", value: mode });
}
