import { test } from "node:test";
import assert from "node:assert/strict";
import { findGaps, planAssignRange, planCoalesce, suggestManualShift, validateTimeEdits, type PlanShift } from "./shifts.ts";

const H = 3_600_000;
const s = (key: number, start: number, end: number | null, project: string | null = null, note: string | null = null): PlanShift =>
    ({ key, startMs: start * H, endMs: end === null ? null : end * H, project, note });

test("findGaps returns the uncovered parts of a range", () => {
    const gaps = findGaps([{ startMs: 9 * H, endMs: 10 * H }, { startMs: 11 * H, endMs: 12 * H }], 8 * H, 13 * H);
    assert.deepEqual(gaps, [
        { startMs: 8 * H, endMs: 9 * H },
        { startMs: 10 * H, endMs: 11 * H },
        { startMs: 12 * H, endMs: 13 * H },
    ]);
    assert.deepEqual(findGaps([{ startMs: 0, endMs: 24 * H }], 8 * H, 9 * H), []);
});

test("planAssignRange splits and keeps the note on every piece", () => {
    const plan = planAssignRange([s(1, 9, 12, "a", "meeting")], 10 * H, 11 * H, "b");
    assert.deepEqual(plan.updates, [{ key: 1, startMs: 9 * H, endMs: 10 * H, project: "a" }]);
    assert.deepEqual(plan.creates, [
        { startMs: 10 * H, endMs: 11 * H, project: "b", note: "meeting" },
        { startMs: 11 * H, endMs: 12 * H, project: "a", note: "meeting" },
    ]);
});

test("planAssignRange skips the running shift and already-matching time", () => {
    const plan = planAssignRange([s(1, 9, null, "a"), s(2, 7, 8, "b")], 6 * H, 12 * H, "b");
    assert.deepEqual(plan, { updates: [], creates: [] });
});

test("planCoalesce merges only identical project and note", () => {
    const plan = planCoalesce([
        s(1, 9, 10, "a", "x"),
        s(2, 10, 11, "a", "x"),
        s(3, 11, 12, "a", "y"), // different note: must survive
        s(4, 12, 13, "a", "y"),
    ]);
    assert.deepEqual(plan.updates, [{ key: 1, endMs: 11 * H }, { key: 3, endMs: 13 * H }]);
    assert.deepEqual(plan.deletes, [2, 4]);
});

test("planCoalesce leaves gaps and open shifts alone", () => {
    const plan = planCoalesce([s(1, 9, 10, "a"), s(2, 10.5, 11, "a"), s(3, 11, null, "a")]);
    assert.deepEqual(plan, { updates: [], deletes: [] });
});

test("validateTimeEdits accepts a moved shared boundary", () => {
    const shifts = [s(1, 9, 10), s(2, 10, 11)];
    assert.equal(validateTimeEdits(shifts, [{ key: 1, startMs: 9 * H, endMs: 10.5 * H }, { key: 2, startMs: 10.5 * H, endMs: 11 * H }], 20 * H), null);
});

test("validateTimeEdits rejects overlaps, inverted and future times", () => {
    const shifts = [s(1, 9, 10), s(2, 10, 11), s(3, 12, null)];
    assert.match(validateTimeEdits(shifts, [{ key: 1, startMs: 9 * H, endMs: 10.5 * H }], 20 * H)!, /overlap/);
    assert.match(validateTimeEdits(shifts, [{ key: 1, startMs: 10 * H, endMs: 9 * H }], 20 * H)!, /after the start/);
    assert.match(validateTimeEdits(shifts, [{ key: 3, startMs: 21 * H, endMs: null }], 20 * H)!, /future/);
    assert.match(validateTimeEdits(shifts, [{ key: 3, startMs: 10.5 * H, endMs: null }], 20 * H)!, /overlap/);
    assert.equal(validateTimeEdits(shifts, [{ key: 3, startMs: 11.5 * H, endMs: null }], 20 * H), null);
});

test("suggestManualShift continues after the last shift, or uses the schedule", () => {
    const day = 0, now = 100 * H;
    assert.deepEqual(suggestManualShift([{ startMs: 9 * H, endMs: 12 * H }], day, now, 8), [12 * H, 13 * H]);
    assert.deepEqual(suggestManualShift([], day, now, 7.5), [9 * H, 16.5 * H]);
    assert.deepEqual(suggestManualShift([], day, now, 0), [9 * H, 17 * H]);
});

test("suggestManualShift never reaches past now", () => {
    const [a, b] = suggestManualShift([], 0, 10.5 * H, 8);
    assert.equal(b, 10.5 * H);
    assert.equal(a, 9 * H);
});
