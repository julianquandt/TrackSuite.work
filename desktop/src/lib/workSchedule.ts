import { WORKDAY_KEYS, type WorkScheduleConfig, type WorkdayHours, type WorkdayKey } from "./domain";

const DAY_INDEX_TO_KEY: WorkdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type LegacyWorkScheduleConfig = {
    weeklyTargetHours?: unknown;
    workingDays?: unknown;
    dailyHours?: unknown;
};

function createWorkdayHours(values: Partial<WorkdayHours>): WorkdayHours {
    return {
        mon: values.mon ?? 0,
        tue: values.tue ?? 0,
        wed: values.wed ?? 0,
        thu: values.thu ?? 0,
        fri: values.fri ?? 0,
        sat: values.sat ?? 0,
        sun: values.sun ?? 0,
    };
}

export const DEFAULT_WORK_SCHEDULE: WorkScheduleConfig = {
    dailyHours: createWorkdayHours({
        mon: 7.2,
        tue: 7.2,
        wed: 7.2,
        thu: 7.2,
        fri: 7.2,
    }),
};

function roundHours(value: number): number {
    return Math.round(value * 100) / 100;
}

function localDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function isWorkdayKey(value: unknown): value is WorkdayKey {
    return typeof value === "string" && WORKDAY_KEYS.includes(value as WorkdayKey);
}

export function normalizeWorkSchedule(
    value?: Partial<WorkScheduleConfig> | LegacyWorkScheduleConfig | null,
): WorkScheduleConfig {
    const legacyValue = (value ?? null) as LegacyWorkScheduleConfig | null;

    if (legacyValue && typeof legacyValue === "object" && legacyValue.dailyHours && typeof legacyValue.dailyHours === "object") {
        const rawDailyHours = legacyValue.dailyHours as Record<string, unknown>;
        return {
            dailyHours: createWorkdayHours(
                Object.fromEntries(
                    WORKDAY_KEYS.map((day) => {
                        const candidate = rawDailyHours[day];
                        const parsed = typeof candidate === "number" ? candidate : Number(candidate);
                        const normalized = Number.isFinite(parsed) && parsed >= 0 ? roundHours(parsed) : 0;
                        return [day, normalized];
                    }),
                ) as WorkdayHours,
            ),
        };
    }

    const targetCandidate =
        typeof legacyValue?.weeklyTargetHours === "number"
            ? legacyValue.weeklyTargetHours
            : Number(legacyValue?.weeklyTargetHours);
    const weeklyTargetHours =
        Number.isFinite(targetCandidate) && targetCandidate >= 0
            ? roundHours(targetCandidate)
            : getWeeklyTargetHours(DEFAULT_WORK_SCHEDULE);

    const candidateDays = Array.isArray(legacyValue?.workingDays)
        ? legacyValue.workingDays.filter(isWorkdayKey)
        : WORKDAY_KEYS.filter((day) => DEFAULT_WORK_SCHEDULE.dailyHours[day] > 0);

    if (candidateDays.length === 0) {
        return {
            dailyHours: { ...DEFAULT_WORK_SCHEDULE.dailyHours },
        };
    }

    const distributedDailyHours = roundHours(weeklyTargetHours / candidateDays.length);
    return {
        dailyHours: createWorkdayHours(
            Object.fromEntries(
                WORKDAY_KEYS.map((day) => [day, candidateDays.includes(day) ? distributedDailyHours : 0]),
            ) as WorkdayHours,
        ),
    };
}

export function workdayKeyFromDate(date: Date): WorkdayKey {
    return DAY_INDEX_TO_KEY[date.getDay()] ?? "mon";
}

export function isScheduledWorkday(date: Date, schedule: WorkScheduleConfig): boolean {
    return getTargetHoursForDate(date, schedule) > 0;
}

export function getTargetHoursForWorkday(day: WorkdayKey, schedule: WorkScheduleConfig): number {
    return roundHours(schedule.dailyHours[day] ?? 0);
}

export function getTargetHoursForDate(date: Date, schedule: WorkScheduleConfig): number {
    return getTargetHoursForWorkday(workdayKeyFromDate(date), schedule);
}

export function getWeeklyTargetHours(schedule: WorkScheduleConfig): number {
    return roundHours(WORKDAY_KEYS.reduce((total, day) => total + getTargetHoursForWorkday(day, schedule), 0));
}

export function getAdjustedWeeklyTargetHours(
    schedule: WorkScheduleConfig,
    offDayDates: Set<string>,
    weekStart: Date,
): number {
    let total = 0;
    for (let i = 0; i < 7; i++) {
        const day = new Date(weekStart);
        day.setDate(weekStart.getDate() + i);
        if (offDayDates.has(localDateKey(day))) continue;
        total += getTargetHoursForDate(day, schedule);
    }
    return roundHours(total);
}