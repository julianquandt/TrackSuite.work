import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonInfo, summarizeReasons } from "./offdays.ts";

test("reason labels and summary", () => {
    assert.equal(reasonInfo("sick").label, "Sick leave");
    assert.equal(reasonInfo(null).label, "Off day");
    assert.equal(reasonInfo("unknown").label, "Off day");
    assert.equal(summarizeReasons(["vacation", "vacation", null, "sick"]), "2 vacation · 1 off · 1 sick leave");
});
