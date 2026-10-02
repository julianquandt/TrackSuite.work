import { invoke } from "@tauri-apps/api/core";

export type ApiResult<T> = {
    ok: boolean;
    status: number;
    data: T | null;
    message: string | null;
};

type NativeApiResult = {
    ok: boolean;
    status: number;
    data: unknown | null;
    message: string | null;
};

function normalizeServerUrl(serverUrl: string): string {
    return serverUrl.trim().replace(/\/+$/, "");
}

async function request<T>(
    method: string,
    serverUrl: string,
    path: string,
    opts: { body?: unknown; apiKey?: string } = {},
): Promise<ApiResult<T>> {
    const res = await invoke<NativeApiResult>("sync_api_request", {
        method,
        serverUrl: normalizeServerUrl(serverUrl),
        path,
        apiKey: opts.apiKey ?? null,
        body: opts.body ?? null,
    });

    return {
        ok: res.ok,
        status: res.status,
        data: (res.data as T | null) ?? null,
        message: res.message,
    };
}

// ── Report profile (Full mode) ──────────────────────────────────────
// The letterhead/report profile lives server-side (Fernet-encrypted, one per
// account) so it's shared across devices. The desktop reads/writes it over the
// same authenticated channel as sync; it requires sync to be configured.

export type ReportProfile = {
    name?: string;
    company?: string;
    address?: string;
    email?: string;
    letter_header?: string;
    footer?: string;
    default_currency?: string;
    custom_fields?: { label: string; value: string }[];
};

type RemoteProfile = { profile: ReportProfile | null; profile_updated_at: string | null };

export function getRemoteProfile(serverUrl: string, apiKey: string) {
    return request<RemoteProfile>("GET", serverUrl, "/profile/", { apiKey });
}

export function saveRemoteProfile(serverUrl: string, apiKey: string, profile: ReportProfile) {
    return request<RemoteProfile>("PUT", serverUrl, "/profile/", { apiKey, body: { profile } });
}

export type RemoteSchedule = {
    schedule: Record<string, number> | null;
    schedule_updated_at: string | null;
};

export function getRemoteSchedule(serverUrl: string, apiKey: string) {
    return request<RemoteSchedule>("GET", serverUrl, "/work-schedule/", { apiKey });
}

export function saveRemoteSchedule(serverUrl: string, apiKey: string, schedule: Record<string, number>) {
    return request<RemoteSchedule>("PUT", serverUrl, "/work-schedule/", { apiKey, body: { schedule } });
}