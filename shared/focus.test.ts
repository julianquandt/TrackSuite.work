import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_FOCUS_SETTINGS, IDLE, isPaused, minutesLeft, normalizeFocusSettings, normalizeFocusState,
    pause, progress, resume, skip, startFocus, tick, type FocusState,
} from "./focus.ts";

const S = { ...DEFAULT_FOCUS_SETTINGS, enabled: true }; // 25 / 5 / 15, long every 4
const M = 60_000;
const phaseOf = (st: FocusState) => st.phase === "idle" ? "idle" : `${st.phase}${st.round}`;

test("a full Pomodoro set: 4 focus rounds, short breaks between, then a long break", () => {
    let st = startFocus(0, S);
    const seen: string[] = [phaseOf(st)];
    for (let i = 0; i < 8; i++) {
        const r = tick(st, (st as { endsAt: number }).endsAt, S);
        assert.equal(r.events.length, 1);
        st = r.state;
        seen.push(phaseOf(st));
    }
    assert.deepEqual(seen, ["focus1", "short1", "focus2", "short2", "focus3", "short3", "focus4", "long4", "focus1"]);
});

test("without auto-continue the timer stops after a break", () => {
    const s = { ...S, autoContinue: false };
    const r1 = tick(startFocus(0, s), 25 * M, s);
    assert.equal(phaseOf(r1.state), "short1");
    const r2 = tick(r1.state, 30 * M, s);
    assert.deepEqual(r2.events, ["break-done"]);
    assert.equal(r2.state, IDLE);
});

test("pause freezes the time left; resume continues from there", () => {
    let st = startFocus(0, S);
    st = pause(st, 10 * M);
    assert.ok(isPaused(st));
    assert.equal(minutesLeft(st, 99 * M), 15);
    assert.deepEqual(tick(st, 99 * M, S).events, [], "a paused period never ends");
    st = resume(st, 100 * M);
    assert.equal(minutesLeft(st, 100 * M), 15);
    assert.equal(progress(st, 107.5 * M), 0.7);
    assert.deepEqual(tick(st, 115 * M, S).events, ["focus-done"]);
});

test("after a long absence the timer waits in the next period, paused, silently", () => {
    const r = tick(startFocus(0, S), 3 * 60 * M, S);
    assert.deepEqual(r.events, []);
    assert.equal(phaseOf(r.state), "short1");
    assert.ok(isPaused(r.state));
    assert.equal(minutesLeft(r.state, 3 * 60 * M), 5);
});

test("skip: focus goes to its break, a break to the next focus", () => {
    const a = skip(startFocus(0, S), 5 * M, S);
    assert.equal(phaseOf(a.state), "short1");
    assert.deepEqual(a.events, ["focus-done"]);
    const b = skip(a.state, 6 * M, S);
    assert.equal(phaseOf(b.state), "focus2");
    assert.equal(minutesLeft(b.state, 6 * M), 25);
});

test("settings: defaults, older keys carried over, validation", () => {
    const old = normalizeFocusSettings({ enabled: true, breakMin: 7, chime: false });
    assert.equal(old.shortBreakMin, 7);
    assert.equal(old.sound, "off");
    assert.equal(normalizeFocusSettings({}).autoContinue, true);
    assert.equal(normalizeFocusSettings({ longEvery: 99 }).longEvery, 4);
    assert.equal(normalizeFocusSettings({ sound: "wood", notify: false }).sound, "wood");
    assert.equal(normalizeFocusSettings({ notify: false }).notify, false);
    assert.deepEqual(normalizeFocusSettings(null), DEFAULT_FOCUS_SETTINGS);
});

test("stored state is validated (an old-format state becomes idle)", () => {
    assert.equal(normalizeFocusState({ phase: "focus", startedAt: 1, endsAt: 5 }).phase, "idle");
    const st = startFocus(0, S);
    assert.deepEqual(normalizeFocusState(JSON.parse(JSON.stringify(st))), st);
});
