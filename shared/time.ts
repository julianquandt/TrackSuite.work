// Date and duration helpers shared by the desktop and web apps.
//
// Shift timestamps are strings in one of two frames: naive local wall clock
// ("2026-07-15T09:00:00", what both apps write today) or UTC ("...Z", legacy
// web rows). `new Date(iso)` reads both correctly, so every day/week bucket goes
// through a Date — never through slicing the string, which yields the UTC day
// for "Z" rows.

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" of a Date in local time. */
export function localDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** Local day key of a shift timestamp, in either frame. */
export function dayKeyOf(iso: string): string {
    return localDateKey(new Date(iso));
}

/** Naive local "YYYY-MM-DDTHH:MM:SS" — the frame every shift write must use. */
export function localIso(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${localDateKey(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Local midnight of a "YYYY-MM-DD" key. */
export function dayStart(dateKey: string): Date {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

/** Key of the day `n` days after `dateKey` (DST-safe: steps in calendar days). */
export function shiftDayKey(dateKey: string, n: number): string {
    return localDateKey(addDays(dayStart(dateKey), n));
}

/** Monday 00:00 (local) of the week containing `d`. Weeks start on Monday. */
export function startOfWeek(d: Date): Date {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    const day = r.getDay(); // 0 = Sunday
    r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
    return r;
}

/**
 * Week bucket key: the Monday's "YYYY-MM-DD". Sorts chronologically and never
 * splits a week at New Year (the old "YYYY-Www" key started weeks on Sunday and
 * cut the last days of December into their own week).
 */
export function weekKey(d: Date): string {
    return localDateKey(startOfWeek(d));
}

export function monthKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export type Granularity = "day" | "week" | "month";

export function bucketKey(d: Date, granularity: string): string {
    if (granularity === "week") return weekKey(d);
    if (granularity === "month") return monthKey(d);
    return localDateKey(d);
}

/** Human label for a bucket key (chart axis): "Mon 6", "Wk 6 Apr", "Apr 2026". */
export function bucketLabel(key: string, granularity: string): string {
    if (granularity === "month") {
        const [y, m] = key.split("-").map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    }
    const d = dayStart(key);
    if (granularity === "week") {
        return "Wk " + d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

/** "7h 14m" / "7h" / "-0h 30m". Rounds to whole minutes first, so never "60m". */
export function formatDuration(hours: number): string {
    const totalMin = Math.round(Math.abs(hours) * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const sign = hours < 0 && totalMin > 0 ? "-" : "";
    return m > 0 ? `${sign}${h}h ${m}m` : `${sign}${h}h`;
}

export function formatSigned(hours: number): string {
    return (hours >= 0 ? "+" : "") + formatDuration(hours);
}

/** "HH:MM" from minutes since midnight (1440 renders as "24:00"). */
export function formatClock(minutes: number): string {
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Hours of [startMs, endMs) that fall on each local day, keyed by day. */
export function splitAcrossDays(startMs: number, endMs: number): Map<string, number> {
    const out = new Map<string, number>();
    if (!(endMs > startMs)) return out;
    let cursor = startMs;
    while (cursor < endMs) {
        const d = new Date(cursor);
        const next = addDays(dayStart(localDateKey(d)), 1).getTime();
        const segEnd = Math.min(next, endMs);
        const key = localDateKey(d);
        out.set(key, (out.get(key) ?? 0) + (segEnd - cursor) / MS_PER_HOUR);
        cursor = segEnd;
    }
    return out;
}

/** Timestamps of a shift as epoch ms; an open shift runs to `nowMs`. */
export function shiftSpanMs(start: string, end: string | null, nowMs: number = Date.now()): [number, number] {
    return [new Date(start).getTime(), end ? new Date(end).getTime() : nowMs];
}

/** Hours a shift contributes to each local day (open shifts count up to now). */
export function shiftHoursByDay(start: string, end: string | null, nowMs: number = Date.now()): Map<string, number> {
    const [s, e] = shiftSpanMs(start, end, nowMs);
    return splitAcrossDays(s, e);
}

export type RangePreset = "this-week" | "last-week" | "this-month" | "last-month" | "this-year";

/**
 * [from, to] day keys (inclusive) of a named range around `now`. The current
 * week/month/year end today ("so far"), so a timesheet never lists future days
 * as missing hours.
 */
export function presetRange(name: RangePreset, now: Date = new Date()): [string, string] {
    const y = now.getFullYear(), m = now.getMonth();
    const today = localDateKey(now);
    switch (name) {
        case "this-week": return [localDateKey(startOfWeek(now)), today];
        case "last-week": { const s = addDays(startOfWeek(now), -7); return [localDateKey(s), localDateKey(addDays(s, 6))]; }
        case "this-month": return [localDateKey(new Date(y, m, 1)), today];
        case "last-month": return [localDateKey(new Date(y, m - 1, 1)), localDateKey(new Date(y, m, 0))];
        case "this-year": return [localDateKey(new Date(y, 0, 1)), today];
    }
}

/** Sunday 23:59:59.999 of the last complete Monday–Sunday week before `now`. */
export function endOfLastCompleteWeek(now: Date = new Date()): Date {
    const d = addDays(startOfWeek(now), -1);
    d.setHours(23, 59, 59, 999);
    return d;
}
