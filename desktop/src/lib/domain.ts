export type ShiftRecord = {
    id: number;
    startTime: string;
    endTime: string | null;
    projectUuid?: string | null;
    note?: string | null;
};

/** A shift the app retro-closed to its last active time after a missed clock-out. */
export type StaleClose = {
    startTime: string;
    endTime: string;
};

export type ProjectRecord = {
    uuid: string;
    name: string;
    color: string | null;
    archived: boolean;
    rate?: string | null;
    currency?: string | null;
};

export type OffDayRecord = {
    id?: number;
    date: string;
};

export type SyncConfig = {
    serverUrl: string;
    apiKey: string;
};

export type AppearanceConfig = {
    theme: "light" | "dark" | "system";
    palette: string;
};

export type AutoResumeConfig = {
    enabled: boolean;
    startTime: string;
    endTime: string;
};

export const DEFAULT_AUTO_RESUME_CONFIG: AutoResumeConfig = {
    enabled: false,
    startTime: "08:00",
    endTime: "18:00",
};

export const WORKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type WorkdayKey = (typeof WORKDAY_KEYS)[number];

export type WorkdayHours = Record<WorkdayKey, number>;

export type WorkScheduleConfig = {
    dailyHours: WorkdayHours;
};

export type DailyHours = Record<string, number>;

export type DashboardSnapshot = {
    shifts: ShiftRecord[];
    offDays: OffDayRecord[];
    dailyHours: DailyHours;
    activeShiftId: number | null;
};