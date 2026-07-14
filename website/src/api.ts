/** Browser API client — all calls go through /api/ which Apache proxies to FastAPI. */

const BASE = "/api";
const ACCESS_TOKEN_KEY = "tracksuite.auth.access";
const REFRESH_TOKEN_KEY = "tracksuite.auth.refresh";

export type ApiResponse<T> = {
    ok: boolean;
    status: number;
    data: T;
};

export type StoredSession = {
    accessToken: string;
    refreshToken: string;
};

export interface RegisterResponse {
    id: number;
    email: string;
    created_at: string;
    totp_secret: string;
    totp_uri: string;
}

export interface SessionInfo {
    id: string;
    label: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: string;
    last_used_at: string;
    expires_at: string;
    revoked_at: string | null;
    current: boolean;
}

export interface AuthTokensResponse {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    session: SessionInfo;
}

export interface EnrollmentCompleteResponse extends AuthTokensResponse {
    recovery_codes: string[];
}

export interface RecoveryCodesResponse {
    recovery_codes: string[];
    remaining_count: number;
}

export interface RecoveryCodesStatusResponse {
    remaining_count: number;
}

export interface MfaResetStartResponse {
    totp_secret: string;
    totp_uri: string;
}

export interface LogoutAllResponse {
    revoked_sessions: number;
}

export interface ApiKeyItem {
    id: number;
    name: string;
    created_at: string;
}

export interface ApiKeyCreated extends ApiKeyItem {
    key: string;
}

let _session: StoredSession | null = loadStoredSession();
let _refreshInFlight: Promise<boolean> | null = null;


function loadStoredSession(): StoredSession | null {
    if (typeof window === "undefined") return null;
    const accessToken = window.localStorage.getItem(ACCESS_TOKEN_KEY);
    const refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
}


function persistSession(session: StoredSession | null): void {
    if (typeof window === "undefined") return;
    if (!session) {
        window.localStorage.removeItem(ACCESS_TOKEN_KEY);
        window.localStorage.removeItem(REFRESH_TOKEN_KEY);
        return;
    }
    window.localStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
}


export function setSession(session: StoredSession | null): void {
    _session = session;
    persistSession(session);
}


export function setSessionFromAuthResponse(response: AuthTokensResponse): void {
    setSession({
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
    });
}


export function clearSession(): void {
    setSession(null);
}


export function getToken(): string | null {
    return _session?.accessToken ?? null;
}


export function getRefreshToken(): string | null {
    return _session?.refreshToken ?? null;
}


function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split(".")[1];
        const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
        return JSON.parse(atob(padded)) as Record<string, unknown>;
    } catch {
        return null;
    }
}


export function getEmailFromToken(): string | null {
    const token = getToken();
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    return typeof payload?.email === "string" ? payload.email : null;
}


async function rawRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    accessToken?: string | null,
): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let url = `${BASE}${path}`;
    if (method === "GET") {
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}_t=${Date.now()}`;
    }

    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data: T = null as T;
    if (res.status !== 204 && res.status !== 205) {
        if (res.headers.get("content-type")?.includes("application/json")) {
            try {
                data = await res.json();
            } catch (e) {
                console.warn("Failed to parse JSON response body", e);
            }
        }
    }

    return { ok: res.ok, status: res.status, data };
}


async function refreshAuthSessionInternal(): Promise<boolean> {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    const res = await rawRequest<AuthTokensResponse>("POST", "/auth/refresh", {
        refresh_token: refreshToken,
    });
    if (!res.ok) {
        clearSession();
        return false;
    }

    setSessionFromAuthResponse(res.data);
    return true;
}


export async function refreshAuthSession(): Promise<boolean> {
    if (_refreshInFlight) {
        return await _refreshInFlight;
    }

    _refreshInFlight = refreshAuthSessionInternal();
    try {
        return await _refreshInFlight;
    } finally {
        _refreshInFlight = null;
    }
}


async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; allowRefresh?: boolean } = {},
): Promise<ApiResponse<T>> {
    const auth = opts.auth ?? true;
    const allowRefresh = opts.allowRefresh ?? true;
    const accessToken = auth ? getToken() : null;
    let res = await rawRequest<T>(method, path, body, accessToken);

    if (auth && res.status === 401 && allowRefresh && getRefreshToken()) {
        const refreshed = await refreshAuthSession();
        if (refreshed) {
            res = await rawRequest<T>(method, path, body, getToken());
        }
    }

    return res;
}


export function register(email: string, password: string) {
    return request<RegisterResponse>("POST", "/auth/register", { email, password }, { auth: false, allowRefresh: false });
}


export function confirmEnrollment(email: string, password: string, otp: string, deviceName?: string) {
    return request<EnrollmentCompleteResponse>(
        "POST",
        "/auth/mfa/confirm-enrollment",
        { email, password, otp, device_name: deviceName },
        { auth: false, allowRefresh: false },
    );
}


export function login(email: string, password: string, otp: string, deviceName?: string) {
    return request<AuthTokensResponse>(
        "POST",
        "/auth/login",
        { email, password, otp, device_name: deviceName },
        { auth: false, allowRefresh: false },
    );
}


export function loginWithRecoveryCode(email: string, password: string, recoveryCode: string, deviceName?: string) {
    return request<AuthTokensResponse>(
        "POST",
        "/auth/login/recovery",
        { email, password, recovery_code: recoveryCode, device_name: deviceName },
        { auth: false, allowRefresh: false },
    );
}


export async function logout() {
    try {
        return await request<null>("POST", "/auth/logout", undefined, { auth: true, allowRefresh: false });
    } finally {
        clearSession();
    }
}


export function logoutAll() {
    return request<LogoutAllResponse>("POST", "/auth/logout-all");
}


export function listSessions() {
    return request<SessionInfo[]>("GET", "/auth/sessions");
}


export function revokeSession(sessionId: string) {
    return request<null>("DELETE", `/auth/sessions/${sessionId}`);
}


export function getRecoveryCodeStatus() {
    return request<RecoveryCodesStatusResponse>("GET", "/auth/recovery-codes/status");
}


export function regenerateRecoveryCodes(password: string, otp: string) {
    return request<RecoveryCodesResponse>("POST", "/auth/recovery-codes/regenerate", { password, otp });
}


export function startMfaReset(password: string, otp: string) {
    return request<MfaResetStartResponse>("POST", "/auth/mfa/reset/start", { password, otp });
}


export function confirmMfaReset(otp: string) {
    return request<RecoveryCodesResponse>("POST", "/auth/mfa/reset/confirm", { otp });
}


export function listApiKeys() {
    return request<ApiKeyItem[]>("GET", "/auth/api-keys");
}


export function createApiKey(name: string) {
    return request<ApiKeyCreated>("POST", "/auth/api-keys", { name });
}


export function deleteApiKey(id: number) {
    return request<null>("DELETE", `/auth/api-keys/${id}`);
}


export interface ShiftItem {
    id: number;
    user_id: number;
    uuid?: string | null;
    project_uuid?: string | null;
    start_time: string;
    end_time: string | null;
    // Set by the server when it auto-closed a shift left running while a newer
    // one started; the end time is a bounded estimate the user should review.
    auto_closed_at?: string | null;
}

export interface OffDayItem {
    id: number;
    user_id: number;
    uuid?: string | null;
    date: string;
}

export interface ProjectItem {
    id: number;
    user_id: number;
    uuid?: string | null;
    name: string;
    color: string | null;
    archived: boolean;
}

export function listShifts() {
    return request<ShiftItem[]>("GET", "/shifts/");
}

export function createShift(startTime: string, endTime: string | null = null, projectUuid?: string | null) {
    const body: Record<string, unknown> = { start_time: startTime, end_time: endTime, started_from: "web" };
    if (projectUuid !== undefined) body.project_uuid = projectUuid;
    return request<ShiftItem>("POST", "/shifts/", body);
}

export function updateShift(id: number, startTime: string, endTime: string | null, projectUuid?: string | null) {
    const body: Record<string, unknown> = { start_time: startTime, end_time: endTime };
    // Only send project_uuid when explicitly provided, so plain edits preserve it.
    if (projectUuid !== undefined) body.project_uuid = projectUuid;
    return request<ShiftItem>("PUT", `/shifts/${id}`, body);
}

export function listProjects() {
    return request<ProjectItem[]>("GET", "/projects/");
}

export function createProject(name: string, color: string | null) {
    return request<ProjectItem>("POST", "/projects/", { name, color });
}

export function updateProject(id: number, fields: { name?: string; color?: string | null; archived?: boolean }) {
    return request<ProjectItem>("PUT", `/projects/${id}`, fields);
}

export function deleteProject(id: number) {
    return request<null>("DELETE", `/projects/${id}`);
}

export function deleteShift(id: number) {
    return request<null>("DELETE", `/shifts/${id}`);
}

export function listOffDays() {
    return request<OffDayItem[]>("GET", "/off-days/");
}

export function createOffDay(date: string) {
    return request<OffDayItem>("POST", "/off-days/", { date });
}

export function deleteOffDay(id: number) {
    return request<null>("DELETE", `/off-days/${id}`);
}