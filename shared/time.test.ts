import { test } from "node:test";
import assert from "node:assert/strict";
import {
    dayKeyOf, endOfLastCompleteWeek, formatDuration, localDateKey, localIso, presetRange, shiftDayKey, splitAcrossDays, startOfWeek, weekKey, bucketKey,
} from "./time.ts";

test("weekKey starts weeks on Monday", () => {
    // Sun 5 Apr 2026 belongs to the week of Mon 30 Mar; Mon 6 Apr starts a new one.
    assert.equal(weekKey(new Date(2026, 3, 5, 12)), "2026-03-30");
    assert.equal(weekKey(new Date(2026, 3, 6, 0)), "2026-04-06");
    assert.equal(weekKey(new Date(2026, 3, 12, 23, 59)), "2026-04-06");
});

test("weekKey does not split a week at New Year", () => {
    // Wed 31 Dec 2025 and Thu 1 Jan 2026 are in the same Monday-start week.
    assert.equal(weekKey(new Date(2025, 11, 31)), weekKey(new Date(2026, 0, 1)));
    assert.equal(weekKey(new Date(2026, 0, 1)), "2025-12-29");
});

test("startOfWeek is local midnight on Monday", () => {
    const d = startOfWeek(new Date(2026, 9, 1, 15, 30)); // Thu 1 Oct 2026
    assert.equal(d.getDay(), 1);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDate(), 28);
});

test("dayKeyOf reads naive timestamps as local and Z timestamps as UTC", () => {
    assert.equal(dayKeyOf("2026-04-03T00:30:00"), "2026-04-03");
    const z = "2026-04-02T22:30:00Z";
    const expected = new Date(z);
    const p = (n: number) => String(n).padStart(2, "0");
    assert.equal(dayKeyOf(z), `${expected.getFullYear()}-${p(expected.getMonth() + 1)}-${p(expected.getDate())}`);
});

test("formatDuration rounds to whole minutes and never prints 60m", () => {
    assert.equal(formatDuration(7.999), "8h");
    assert.equal(formatDuration(7 + 59.6 / 60), "8h");
    assert.equal(formatDuration(1.5), "1h 30m");
    assert.equal(formatDuration(-0.5), "-0h 30m");
    assert.equal(formatDuration(0), "0h");
    assert.equal(formatDuration(-0.001), "0h");
});

test("splitAcrossDays splits a shift at local midnight", () => {
    const start = new Date(2026, 3, 3, 22, 0).getTime();
    const end = new Date(2026, 3, 4, 2, 0).getTime();
    const parts = splitAcrossDays(start, end);
    assert.equal(parts.get("2026-04-03"), 2);
    assert.equal(parts.get("2026-04-04"), 2);
    assert.equal(splitAcrossDays(end, start).size, 0);
});

test("shiftDayKey steps calendar days across DST", () => {
    // Europe DST starts on Sun 29 Mar 2026; stepping must not skip or repeat a day.
    assert.equal(shiftDayKey("2026-03-28", 1), "2026-03-29");
    assert.equal(shiftDayKey("2026-03-29", 1), "2026-03-30");
    assert.equal(shiftDayKey("2026-01-01", -1), "2025-12-31");
});

test("localIso writes the naive local frame", () => {
    assert.equal(localIso(new Date(2026, 3, 3, 9, 5, 7)), "2026-04-03T09:05:07");
});

test("bucketKey per granularity", () => {
    const d = new Date(2026, 3, 8);
    assert.equal(bucketKey(d, "day"), "2026-04-08");
    assert.equal(bucketKey(d, "week"), "2026-04-06");
    assert.equal(bucketKey(d, "month"), "2026-04");
});

test("presetRange: past periods are whole, current periods end today", () => {
    const now = new Date(2026, 0, 14); // Wed 14 Jan 2026
    assert.deepEqual(presetRange("this-week", now), ["2026-01-12", "2026-01-14"]);
    assert.deepEqual(presetRange("last-week", now), ["2026-01-05", "2026-01-11"]);
    assert.deepEqual(presetRange("this-month", now), ["2026-01-01", "2026-01-14"]);
    assert.deepEqual(presetRange("last-month", now), ["2025-12-01", "2025-12-31"]);
    assert.deepEqual(presetRange("this-year", now), ["2026-01-01", "2026-01-14"]);
});

test("endOfLastCompleteWeek is the previous Sunday night", () => {
    const thu = endOfLastCompleteWeek(new Date(2026, 9, 1, 12)); // Thu 1 Oct 2026
    assert.equal(localDateKey(thu), "2026-09-27");
    assert.equal(thu.getDay(), 0);
    assert.equal(thu.getHours(), 23);
    // On a Sunday the current week is not complete yet.
    assert.equal(localDateKey(endOfLastCompleteWeek(new Date(2026, 9, 4, 20))), "2026-09-27");
    assert.equal(localDateKey(endOfLastCompleteWeek(new Date(2026, 9, 5, 1))), "2026-10-04");
});
