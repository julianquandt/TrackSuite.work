import { invoke } from "@tauri-apps/api/core";
import type { ShiftRecord } from "./domain";

export type ApiResult<T> = {
    ok: boolean;
    status: number;
    data: T | null;
    message: string | null;
};

type RemoteShift = {
    id: number;
    start_time: string;
    end_time: string | null;
};

type RemoteOffDay = {
    id: number;
    date: string;
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

export function listRemoteShifts(serverUrl: string, apiKey: string) {
    return request<RemoteShift[]>("GET", serverUrl, "/shifts/", { apiKey });
}

export function createRemoteShift(
    serverUrl: string,
    apiKey: string,
    shift: Pick<ShiftRecord, "startTime" | "endTime">,
) {
    return request<RemoteShift>("POST", serverUrl, "/shifts/", {
        apiKey,
        body: { start_time: shift.startTime, end_time: shift.endTime },
    });
}

export function updateRemoteShift(
    serverUrl: string,
    apiKey: string,
    id: number,
    shift: Pick<ShiftRecord, "startTime" | "endTime">,
) {
    return request<RemoteShift>("PUT", serverUrl, `/shifts/${id}`, {
        apiKey,
        body: { start_time: shift.startTime, end_time: shift.endTime },
    });
}

export function listRemoteOffDays(serverUrl: string, apiKey: string) {
    return request<RemoteOffDay[]>("GET", serverUrl, "/off-days/", { apiKey });
}

export function createRemoteOffDay(serverUrl: string, apiKey: string, date: string) {
    return request<RemoteOffDay>("POST", serverUrl, "/off-days/", {
        apiKey,
        body: { date },
    });
}