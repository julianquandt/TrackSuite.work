// Pure shift-editing rules. The desktop app runs the same rules in Rust
// (desktop/src-tauri/src/db.rs); the web app plans its server calls with these.
// All times are epoch milliseconds; an open (running) shift has endMs = null.

export type Span = { startMs: number; endMs: number };

export type PlanShift = {
    key: number; // the caller's id for the row
    startMs: number;
    endMs: number | null;
    project: string | null;
    note: string | null;
};

/** The parts of [rangeStart, rangeEnd) not covered by any `occupied` span. */
export function findGaps(occupied: Span[], rangeStart: number, rangeEnd: number): Span[] {
    const sorted = occupied
        .filter((o) => o.endMs > rangeStart && o.startMs < rangeEnd)
        .sort((a, b) => a.startMs - b.startMs);
    const gaps: Span[] = [];
    let cursor = rangeStart;
    for (const o of sorted) {
        if (o.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(o.startMs, rangeEnd) });
        cursor = Math.max(cursor, o.endMs);
        if (cursor >= rangeEnd) break;
    }
    if (cursor < rangeEnd) gaps.push({ startMs: cursor, endMs: rangeEnd });
    return gaps.filter((g) => g.endMs > g.startMs);
}

/** Occupied spans of a shift list (open shifts run to `nowMs`). */
export function occupiedSpans(shifts: PlanShift[], nowMs: number): Span[] {
    return shifts.map((s) => ({ startMs: s.startMs, endMs: s.endMs ?? nowMs }));
}

export type AssignPlan = {
    updates: { key: number; startMs: number; endMs: number; project: string | null }[];
    creates: { startMs: number; endMs: number; project: string | null; note: string | null }[];
};

/**
 * Re-tag the closed time inside [rangeStart, rangeEnd) with `project`. A shift
 * cut by the range splits into up to three pieces; every piece keeps the note.
 * The running shift is never split.
 */
export function planAssignRange(shifts: PlanShift[], rangeStart: number, rangeEnd: number, project: string | null): AssignPlan {
    const plan: AssignPlan = { updates: [], creates: [] };
    if (!(rangeEnd > rangeStart)) return plan;
    for (const s of shifts) {
        if (s.endMs === null) continue;
        const oStart = Math.max(s.startMs, rangeStart);
        const oEnd = Math.min(s.endMs, rangeEnd);
        if (oStart >= oEnd) continue;
        if ((s.project ?? null) === (project ?? null)) continue; // already that project
        const segs: { startMs: number; endMs: number; project: string | null }[] = [];
        if (s.startMs < oStart) segs.push({ startMs: s.startMs, endMs: oStart, project: s.project });
        segs.push({ startMs: oStart, endMs: oEnd, project });
        if (oEnd < s.endMs) segs.push({ startMs: oEnd, endMs: s.endMs, project: s.project });
        plan.updates.push({ key: s.key, ...segs[0] });
        for (const seg of segs.slice(1)) plan.creates.push({ ...seg, note: s.note });
    }
    return plan;
}

/** Touching shifts merge only when project AND note match, so no note is ever lost. */
export function canMerge(a: PlanShift, b: PlanShift): boolean {
    return a.endMs !== null && b.endMs !== null
        && a.endMs === b.startMs
        && (a.project ?? null) === (b.project ?? null)
        && (a.note ?? null) === (b.note ?? null);
}

export type CoalescePlan = { updates: { key: number; endMs: number }[]; deletes: number[] };

/** Merge runs of touching, identical shifts. Pass only the shifts of the edited day(s). */
export function planCoalesce(shifts: PlanShift[]): CoalescePlan {
    const closed = shifts.filter((s) => s.endMs !== null).sort((a, b) => a.startMs - b.startMs);
    const plan: CoalescePlan = { updates: [], deletes: [] };
    let i = 0;
    while (i < closed.length) {
        const keep = closed[i];
        let last = keep;
        let j = i + 1;
        while (j < closed.length && canMerge(last, closed[j])) {
            plan.deletes.push(closed[j].key);
            last = closed[j];
            j++;
        }
        if (last !== keep) plan.updates.push({ key: keep.key, endMs: last.endMs! });
        i = j;
    }
    return plan;
}

/** Shifts overlapping [fromMs, toMs) — e.g. the day an edit touched. */
export function overlapping<T extends { startMs: number; endMs: number | null }>(shifts: T[], fromMs: number, toMs: number, nowMs: number): T[] {
    return shifts.filter((s) => s.startMs < toMs && (s.endMs ?? nowMs) > fromMs);
}

export type TimeEdit = { key: number; startMs: number; endMs: number | null };

/**
 * Check new start/end times against the final state of all shifts (the same
 * rules as the desktop's update_shift_times): start before end, only the
 * running shift may stay open, nothing in the future, no overlaps. Returns a
 * short sentence for the user, or null when the edit is fine.
 */
export function validateTimeEdits(shifts: PlanShift[], edits: TimeEdit[], nowMs: number): string | null {
    const byKey = new Map(shifts.map((s) => [s.key, s]));
    const final = new Map(shifts.map((s) => [s.key, { startMs: s.startMs, endMs: s.endMs }]));
    for (const e of edits) {
        const orig = byKey.get(e.key);
        if (!orig) return "That shift no longer exists.";
        if (e.endMs === null && orig.endMs !== null) return "Only the running shift can stay open.";
        if (e.endMs !== null && e.endMs <= e.startMs) return "The end must be after the start.";
        if (e.startMs > nowMs || (e.endMs !== null && e.endMs > nowMs + 60_000)) return "Shifts can't reach into the future.";
        final.set(e.key, { startMs: e.startMs, endMs: e.endMs });
    }
    const spans = [...final.entries()]
        .map(([key, v]) => ({ key, startMs: v.startMs, endMs: v.endMs ?? nowMs }))
        .sort((a, b) => a.startMs - b.startMs);
    const edited = new Set(edits.map((e) => e.key));
    for (let i = 1; i < spans.length; i++) {
        const a = spans[i - 1], b = spans[i];
        if (b.startMs < a.endMs && (edited.has(a.key) || edited.has(b.key))) {
            return "That would overlap another shift.";
        }
    }
    return null;
}

/**
 * A sensible default for "Add shift" on `dayStartMs`'s day: right after the
 * day's last shift (1 hour, never past now), or 09:00 for the scheduled hours
 * on an empty day. Returns [startMs, endMs].
 */
export function suggestManualShift(spans: Span[], dayStartMs: number, nowMs: number, targetHours: number): [number, number] {
    const H = 3_600_000;
    const dayEnd = dayStartMs + 24 * H;
    const onDay = spans.filter((s) => s.startMs < dayEnd && s.endMs > dayStartMs);
    let start: number, end: number;
    if (onDay.length) {
        start = Math.min(Math.max(...onDay.map((s) => s.endMs)), dayEnd - H);
        end = start + H;
    } else {
        start = dayStartMs + 9 * H;
        end = start + (targetHours > 0 ? targetHours : 8) * H;
    }
    // Never suggest future time on today.
    if (end > nowMs && nowMs > dayStartMs) {
        end = Math.max(nowMs - (nowMs % (5 * 60_000)), dayStartMs);
        if (start >= end) start = Math.max(dayStartMs, end - H);
    }
    return [start, end];
}
