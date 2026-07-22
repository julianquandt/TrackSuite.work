import { invoke } from "@tauri-apps/api/core";
import {
    DEFAULT_AUTO_RESUME_CONFIG,
    type AutoResumeConfig,
    type OffDayRecord,
    type ProjectRecord,
    type ShiftRecord,
    type StaleClose,
    type SyncConfig,
    type AppearanceConfig,
    type WorkScheduleConfig,
} from "./domain";
import { DEFAULT_WORK_SCHEDULE, normalizeWorkSchedule } from "./workSchedule";

export interface ShiftRepository {
    getActiveShift(): Promise<ShiftRecord | null>;
    getAllShifts(): Promise<ShiftRecord[]>;
    startShift(): Promise<void>;
    endShift(): Promise<void>;
    heartbeat(): Promise<void>;
    reconcileStaleShift(staleMinutes: number): Promise<StaleClose | null>;
    addManualShift(startTime: string, endTime: string, note?: string | null): Promise<void>;
    setShiftNote(shiftId: number, note: string | null): Promise<void>;
    deleteShift(shiftId: number): Promise<void>;
}

export interface OffDayRepository {
    getOffDays(): Promise<OffDayRecord[]>;
    addOffDay(date: string): Promise<void>;
    removeOffDay(date: string): Promise<void>;
}

export interface ProjectRepository {
    getProjects(): Promise<ProjectRecord[]>;
    createProject(name: string, color: string | null): Promise<ProjectRecord>;
    updateProject(
        uuid: string,
        name: string,
        color: string | null,
        archived: boolean,
        billing?: { rate?: string | null; currency?: string | null },
    ): Promise<void>;
    deleteProject(uuid: string): Promise<void>;
    getCurrentProject(): Promise<string | null>;
    /** Returns true if switching split an active shift. */
    setCurrentProject(projectUuid: string | null): Promise<boolean>;
    setShiftProject(shiftId: number, projectUuid: string | null): Promise<void>;
    /** Returns the number of shifts touched by the range assignment. */
    assignProjectToRange(rangeStart: string, rangeEnd: string, projectUuid: string | null): Promise<number>;
}

export interface SettingsRepository {
    getServerUrl(): Promise<string>;
    saveServerUrl(url: string): Promise<void>;
    getSyncConfig(): Promise<SyncConfig | null>;
    saveSyncConfig(config: SyncConfig): Promise<void>;
    getAppearance(): Promise<AppearanceConfig>;
    saveAppearance(config: AppearanceConfig): Promise<void>;
    getAutoResumeConfig(): Promise<AutoResumeConfig>;
    saveAutoResumeConfig(config: AutoResumeConfig): Promise<void>;
    getWorkSchedule(): Promise<WorkScheduleConfig>;
    saveWorkSchedule(config: WorkScheduleConfig): Promise<void>;
    // Work-schedule sync bookkeeping (last-write-wins vs the server).
    hasExplicitWorkSchedule(): Promise<boolean>;
    getWorkScheduleUpdatedAt(): Promise<string | null>;
    setWorkScheduleUpdatedAt(ts: string): Promise<void>;
}

// ── Tauri-backed implementations ────────────────────────────────────

type RustShift = { id: number; start_time: string; end_time: string | null; project_uuid: string | null; note?: string | null };
type RustProject = { uuid: string; name: string; color: string | null; archived: boolean; rate?: string | null; currency?: string | null };

async function getConfigValue(key: string) {
    return await invoke<string | null>("get_config", { key });
}

async function setConfigValue(key: string, value: string) {
    await invoke("set_config", { key, value });
}

function toShiftRecord(r: RustShift): ShiftRecord {
    return { id: r.id, startTime: r.start_time, endTime: r.end_time, projectUuid: r.project_uuid, note: r.note ?? null };
}

function timeTextToMinutes(value: string): number {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

function normalizeAutoResumeConfig(config: Partial<AutoResumeConfig> | null | undefined): AutoResumeConfig {
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    const startTime = typeof config?.startTime === "string" && timePattern.test(config.startTime)
        ? config.startTime
        : DEFAULT_AUTO_RESUME_CONFIG.startTime;
    const endTime = typeof config?.endTime === "string" && timePattern.test(config.endTime)
        ? config.endTime
        : DEFAULT_AUTO_RESUME_CONFIG.endTime;

    return {
        enabled: config?.enabled === true,
        startTime,
        endTime: timeTextToMinutes(startTime) < timeTextToMinutes(endTime)
            ? endTime
            : DEFAULT_AUTO_RESUME_CONFIG.endTime,
    };
}

export const shifts: ShiftRepository = {
    async getActiveShift() {
        const row = await invoke<RustShift | null>("get_active_shift");
        return row ? toShiftRecord(row) : null;
    },
    async getAllShifts() {
        const rows = await invoke<RustShift[]>("get_all_shifts");
        return rows.map(toShiftRecord);
    },
    async startShift() {
        await invoke("start_shift");
    },
    async endShift() {
        await invoke("end_shift");
    },
    async heartbeat() {
        await invoke("heartbeat_active_shift");
    },
    async reconcileStaleShift(staleMinutes) {
        const row = await invoke<{ start_time: string; end_time: string } | null>(
            "reconcile_stale_desktop_shift",
            { staleMinutes },
        );
        return row ? { startTime: row.start_time, endTime: row.end_time } : null;
    },
    async addManualShift(startTime, endTime, note) {
        await invoke("add_manual_shift", { startTime, endTime, note: note ?? null });
    },
    async setShiftNote(shiftId, note) {
        await invoke("set_shift_note", { shiftId, note });
    },
    async deleteShift(shiftId) {
        await invoke("delete_shift", { shiftId });
    },
};

export const offDays: OffDayRepository = {
    async getOffDays() {
        const dates = await invoke<string[]>("get_off_days");
        return dates.map((d) => ({ date: d }));
    },
    async addOffDay(date) {
        await invoke("add_off_day", { date });
    },
    async removeOffDay(date) {
        await invoke("remove_off_day", { date });
    },
};

export const projects: ProjectRepository = {
    async getProjects() {
        const rows = await invoke<RustProject[]>("get_projects");
        return rows.map((r) => ({ uuid: r.uuid, name: r.name, color: r.color, archived: r.archived, rate: r.rate ?? null, currency: r.currency ?? null }));
    },
    async createProject(name, color) {
        const r = await invoke<RustProject>("create_project", { name, color });
        return { uuid: r.uuid, name: r.name, color: r.color, archived: r.archived, rate: r.rate ?? null, currency: r.currency ?? null };
    },
    async updateProject(uuid, name, color, archived, billing) {
        await invoke("update_project", {
            uuid, name, color, archived,
            rate: billing?.rate ?? null,
            currency: billing?.currency ?? null,
        });
    },
    async deleteProject(uuid) {
        await invoke("delete_project", { uuid });
    },
    async getCurrentProject() {
        return (await invoke<string | null>("get_current_project")) ?? null;
    },
    async setCurrentProject(projectUuid) {
        return await invoke<boolean>("set_current_project", { projectUuid });
    },
    async setShiftProject(shiftId, projectUuid) {
        await invoke("set_shift_project", { shiftId, projectUuid });
    },
    async assignProjectToRange(rangeStart, rangeEnd, projectUuid) {
        return await invoke<number>("assign_project_to_range", { rangeStart, rangeEnd, projectUuid });
    },
};

export const settings: SettingsRepository = {
    async getServerUrl() {
        return (await getConfigValue("server_url")) || "";
    },
    async saveServerUrl(url) {
        await setConfigValue("server_url", url);
    },
    async getSyncConfig() {
        const serverUrl = await this.getServerUrl();
        const apiKey = await getConfigValue("api_key");
        if (!serverUrl || !apiKey) return null;
        return { serverUrl, apiKey };
    },
    async saveSyncConfig(config) {
        await setConfigValue("server_url", config.serverUrl);
        await setConfigValue("api_key", config.apiKey);
        await setConfigValue("user_id", "");
    },
    async getAppearance() {
        const theme = (await getConfigValue("appearance_theme")) || "system";
        const palette = (await getConfigValue("appearance_palette")) || "default";
        return { theme: theme as AppearanceConfig["theme"], palette };
    },
    async saveAppearance(config) {
        await setConfigValue("appearance_theme", config.theme);
        await setConfigValue("appearance_palette", config.palette);
    },
    async getAutoResumeConfig() {
        const raw = await getConfigValue("auto_resume_config");
        if (!raw) return { ...DEFAULT_AUTO_RESUME_CONFIG };

        try {
            return normalizeAutoResumeConfig(JSON.parse(raw) as Partial<AutoResumeConfig>);
        } catch {
            return { ...DEFAULT_AUTO_RESUME_CONFIG };
        }
    },
    async saveAutoResumeConfig(config) {
        const normalized = normalizeAutoResumeConfig(config);
        await setConfigValue("auto_resume_config", JSON.stringify(normalized));
    },
    async getWorkSchedule() {
        const raw = await getConfigValue("work_schedule");
        if (!raw) {
            return {
                dailyHours: { ...DEFAULT_WORK_SCHEDULE.dailyHours },
            };
        }

        try {
            return normalizeWorkSchedule(JSON.parse(raw) as Partial<WorkScheduleConfig>);
        } catch {
            return {
                dailyHours: { ...DEFAULT_WORK_SCHEDULE.dailyHours },
            };
        }
    },
    async saveWorkSchedule(config) {
        const normalized = normalizeWorkSchedule(config);
        await setConfigValue("work_schedule", JSON.stringify(normalized));
    },
    async hasExplicitWorkSchedule() {
        return (await getConfigValue("work_schedule")) !== null;
    },
    async getWorkScheduleUpdatedAt() {
        return await getConfigValue("work_schedule_updated_at");
    },
    async setWorkScheduleUpdatedAt(ts) {
        await setConfigValue("work_schedule_updated_at", ts);
    },
};