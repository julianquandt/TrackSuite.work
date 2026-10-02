// Focus timer (Pomodoro): pure state machine, no DOM.
//
// focus → short break → focus → … and after every `longEvery` focus rounds a
// long break. With `autoContinue` it keeps cycling until stopped; without, it
// stops after each break. It can be paused. If the app was closed or asleep
// past the end of a period, the timer waits in the next period, paused (it
// never silently runs through rounds while nobody was there).

import { CHIME_SOUNDS, type ChimeSound } from "./sound.ts";

export type FocusSettings = {
    enabled: boolean;
    focusMin: number;
    shortBreakMin: number;
    longBreakMin: number;
    /** A long break after this many focus rounds. */
    longEvery: number;
    /** Start the next period by itself (classic Pomodoro). */
    autoContinue: boolean;
    /** End the running shift during breaks, start a new one after. */
    pauseTracking: boolean;
    /** Sound when a focus or break period ends. */
    sound: "off" | ChimeSound;
    /** A system notification when a period ends. */
    notify: boolean;
};

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
    enabled: false, focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4,
    autoContinue: true, pauseTracking: false, sound: "marimba", notify: true,
};

export type Phase = "focus" | "short" | "long";

export type FocusState =
    | { phase: "idle" }
    | {
        phase: Phase;
        /** Which focus round of the current set (1..longEvery). */
        round: number;
        durationMs: number;
        endsAt: number;
        /** Set while paused: the time that was left. */
        pausedLeftMs: number | null;
    };

export type FocusEvent = "focus-done" | "break-done";

const MIN = 60_000;
/** Ending this long ago means nobody was there: wait, paused. */
export const STALE_MS = 2 * MIN;

export const IDLE: FocusState = { phase: "idle" };

function minutesOf(phase: Phase, s: FocusSettings): number {
    return phase === "focus" ? s.focusMin : phase === "short" ? s.shortBreakMin : s.longBreakMin;
}

function period(phase: Phase, round: number, from: number, s: FocusSettings, paused = false): FocusState {
    const durationMs = minutesOf(phase, s) * MIN;
    return { phase, round, durationMs, endsAt: from + durationMs, pausedLeftMs: paused ? durationMs : null };
}

/** What comes after `st` (a running or paused period). */
function next(st: Exclude<FocusState, { phase: "idle" }>, s: FocusSettings): { phase: Phase; round: number } | null {
    if (st.phase === "focus") return { phase: st.round >= s.longEvery ? "long" : "short", round: st.round };
    if (!s.autoContinue) return null;
    return { phase: "focus", round: st.phase === "long" ? 1 : st.round + 1 };
}

export function startFocus(now: number, s: FocusSettings): FocusState {
    return period("focus", 1, now, s);
}

/**
 * Advance to `now`. Returns the periods that ended (in order). A period that
 * ended more than STALE_MS ago is not replayed: the timer moves on to the
 * next period and waits there, paused, with no events.
 */
export function tick(state: FocusState, now: number, s: FocusSettings): { state: FocusState; events: FocusEvent[] } {
    const events: FocusEvent[] = [];
    let st = state;
    for (let guard = 0; guard < 3 && st.phase !== "idle" && st.pausedLeftMs === null && now >= st.endsAt; guard++) {
        const after = next(st, s);
        if (now - st.endsAt > STALE_MS) {
            return { state: after ? period(after.phase, after.round, now, s, true) : IDLE, events: [] };
        }
        events.push(st.phase === "focus" ? "focus-done" : "break-done");
        st = after ? period(after.phase, after.round, st.endsAt, s) : IDLE;
    }
    return { state: st, events };
}

export function pause(st: FocusState, now: number): FocusState {
    if (st.phase === "idle" || st.pausedLeftMs !== null) return st;
    return { ...st, pausedLeftMs: Math.max(0, st.endsAt - now) };
}

export function resume(st: FocusState, now: number): FocusState {
    if (st.phase === "idle" || st.pausedLeftMs === null) return st;
    return { ...st, endsAt: now + st.pausedLeftMs, pausedLeftMs: null };
}

/** Skip the rest of this period (a focus goes to its break, a break to focus). */
export function skip(st: FocusState, now: number, s: FocusSettings): { state: FocusState; events: FocusEvent[] } {
    if (st.phase === "idle") return { state: st, events: [] };
    if (st.phase === "focus") {
        const after = next(st, s)!;
        return { state: period(after.phase, after.round, now, s), events: ["focus-done"] };
    }
    // Skipping a break always starts the next focus (that's what was asked for).
    return { state: period("focus", st.phase === "long" ? 1 : st.round + 1, now, s), events: ["break-done"] };
}

export function isPaused(st: FocusState): boolean {
    return st.phase !== "idle" && st.pausedLeftMs !== null;
}

export function msLeft(st: FocusState, now: number): number {
    if (st.phase === "idle") return 0;
    return Math.max(0, st.pausedLeftMs ?? st.endsAt - now);
}

/** 0 → 1 through the current period. */
export function progress(st: FocusState, now: number): number {
    if (st.phase === "idle" || st.durationMs <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - msLeft(st, now) / st.durationMs));
}

export function minutesLeft(st: FocusState, now: number): number {
    return Math.ceil(msLeft(st, now) / MIN);
}

/** Parse stored settings, falling back to defaults for anything invalid. */
export function normalizeFocusSettings(raw: unknown): FocusSettings {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<FocusSettings> & { chime?: boolean; breakMin?: number };
    const num = (v: unknown, d: number, max = 180) => (typeof v === "number" && v >= 1 && v <= max ? Math.round(v) : d);
    const d = DEFAULT_FOCUS_SETTINGS;
    // Older settings had "breakMin" and "chime: true/false".
    const sound = r.sound === "off" || CHIME_SOUNDS.some((c) => c.key === r.sound)
        ? r.sound!
        : r.chime === false ? "off" : d.sound;
    return {
        enabled: r.enabled === true,
        focusMin: num(r.focusMin, d.focusMin),
        shortBreakMin: num(r.shortBreakMin ?? r.breakMin, d.shortBreakMin),
        longBreakMin: num(r.longBreakMin, d.longBreakMin),
        longEvery: num(r.longEvery, d.longEvery, 12),
        autoContinue: r.autoContinue !== false,
        pauseTracking: r.pauseTracking === true,
        sound,
        notify: r.notify !== false,
    };
}

export function normalizeFocusState(raw: unknown): FocusState {
    const r = raw as Partial<Extract<FocusState, { round: number }>> | null;
    if (r && (r.phase === "focus" || r.phase === "short" || r.phase === "long")
        && typeof r.round === "number" && typeof r.durationMs === "number" && typeof r.endsAt === "number") {
        return { phase: r.phase, round: r.round, durationMs: r.durationMs, endsAt: r.endsAt, pausedLeftMs: typeof r.pausedLeftMs === "number" ? r.pausedLeftMs : null };
    }
    return IDLE;
}
