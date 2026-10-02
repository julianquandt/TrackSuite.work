// The focus-timer ring next to the Clock button (off unless enabled in
// Settings). A full Pomodoro: focus, short break, focus … and a long break
// after every few rounds, continuing by itself. The ring fills slowly.
//   click         start · pause · resume
//   right-click   pause/resume, skip to the break / skip the break, stop
// When a period ends: an optional soft sound and an optional notification.
// State is per device (localStorage).

import { playChime } from "./chime.ts";
import { enhanceSelect } from "./select.ts";
import { showMenu, type MenuItem } from "./menu.ts";
import { CHIME_SOUNDS } from "../sound.ts";
import {
    IDLE, isPaused, minutesLeft, normalizeFocusSettings, normalizeFocusState, pause, progress, resume, skip, startFocus, tick,
    type FocusEvent, type FocusSettings, type FocusState,
} from "../focus.ts";

const SETTINGS_KEY = "tracksuite.focus.settings";
const STATE_KEY = "tracksuite.focus.state";
const PAUSED_KEY = "tracksuite.focus.pausedTracking";

function read(key: string): unknown {
    try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function write(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
}

export function loadFocusSettings(): FocusSettings {
    return normalizeFocusSettings(read(SETTINGS_KEY));
}
export function saveFocusSettings(s: FocusSettings): void {
    write(SETTINGS_KEY, s);
    window.dispatchEvent(new CustomEvent("tracksuite:focus-settings"));
}

export type FocusHooks = {
    notify(title: string, body: string): void;
    /** End the running shift for the break; true if one was running. */
    pauseTracking?(): Promise<boolean>;
    /** Start a shift again after a break that paused tracking. */
    resumeTracking?(): Promise<void>;
    /** Short status for e.g. the tray tooltip ("" when idle). */
    setStatus?(text: string): void;
};

const R = 9;
const CIRC = 2 * Math.PI * R;

function phaseName(st: FocusState): string {
    return st.phase === "focus" ? "Focus" : st.phase === "short" ? "Short break" : st.phase === "long" ? "Long break" : "";
}

export function createFocusRing(host: HTMLElement, hooks: FocusHooks): { destroy(): void } {
    let settings = loadFocusSettings();
    let state: FocusState = normalizeFocusState(read(STATE_KEY));
    let timer: number | null = null;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-focus";
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
        <circle class="ui-focus-track" cx="12" cy="12" r="${R}"></circle>
        <circle class="ui-focus-fill" cx="12" cy="12" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"></circle>
        <circle class="ui-focus-core" cx="12" cy="12" r="3"></circle>
        <g class="ui-focus-bars"><rect x="9" y="8.5" width="2" height="7" rx="0.6"></rect><rect x="13" y="8.5" width="2" height="7" rx="0.6"></rect></g></svg>`;
    host.appendChild(btn);
    const fill = btn.querySelector<SVGCircleElement>(".ui-focus-fill")!;

    function save() { write(STATE_KEY, state); }

    function status(now: number): string {
        if (state.phase === "idle") return "";
        const left = `${minutesLeft(state, now)} min left`;
        const round = state.phase === "focus" ? ` ${state.round} of ${settings.longEvery}` : "";
        return `${phaseName(state)}${round} · ${isPaused(state) ? `paused, ${left}` : left}`;
    }

    function render() {
        btn.hidden = !settings.enabled;
        btn.dataset.phase = state.phase;
        btn.dataset.paused = isPaused(state) ? "1" : "";
        const now = Date.now();
        fill.setAttribute("stroke-dashoffset", String(CIRC * (1 - progress(state, now))));
        const label = state.phase === "idle"
            ? `Start a ${settings.focusMin}-minute focus · right-click for more`
            : `${status(now)} — click to ${isPaused(state) ? "continue" : "pause"} · right-click for more`;
        btn.title = label;
        btn.setAttribute("aria-label", label);
        hooks.setStatus?.(status(now));
    }

    async function setState(next: FocusState) {
        state = next;
        save();
        render();
        syncTimer();
    }

    // Breaks can pause tracking; the next focus starts it again.
    async function trackingFor(events: FocusEvent[]) {
        for (const ev of events) {
            if (ev === "focus-done" && settings.pauseTracking && hooks.pauseTracking && await hooks.pauseTracking()) write(PAUSED_KEY, true);
        }
        if (state.phase === "focus" && read(PAUSED_KEY) === true) {
            write(PAUSED_KEY, false);
            await hooks.resumeTracking?.();
        }
    }

    // A period ran out by itself: sound and notification (a click needs neither).
    function announce(last: FocusEvent) {
        playChime(settings.sound, last);
        if (!settings.notify) return;
        if (last === "focus-done") {
            if (state.phase === "long") hooks.notify("Long break", `${settings.longBreakMin} minutes — that's ${settings.longEvery} focus rounds. Well done.`);
            else hooks.notify("Short break", `${settings.shortBreakMin} minutes — step away for a moment.`);
        } else if (state.phase === "focus") {
            hooks.notify("Back to focus", `Round ${state.round} of ${settings.longEvery}.`);
        } else {
            hooks.notify("Break's over", "Click the timer when you're ready for the next focus.");
        }
    }

    function syncTimer() {
        const running = settings.enabled && state.phase !== "idle" && !isPaused(state);
        if (running && timer === null) timer = window.setInterval(onTick, 1000);
        else if (!running && timer !== null) { window.clearInterval(timer); timer = null; }
    }

    function onTick() {
        const r = tick(state, Date.now(), settings);
        if (r.state !== state) { state = r.state; save(); }
        render();
        syncTimer();
        if (r.events.length) {
            announce(r.events[r.events.length - 1]);
            void trackingFor(r.events);
        }
    }

    btn.addEventListener("click", async () => {
        const now = Date.now();
        if (state.phase === "idle") { await setState(startFocus(now, settings)); await trackingFor([]); }
        else if (isPaused(state)) await setState(resume(state, now));
        else await setState(pause(state, now));
    });

    btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const now = Date.now();
        const items: MenuItem[] = [];
        if (state.phase === "idle") {
            items.push({ kind: "header", label: "Focus timer" }, { label: `Start a ${settings.focusMin}-minute focus`, run: () => btn.click() });
        } else {
            items.push({ kind: "header", label: status(now) });
            items.push(isPaused(state)
                ? { label: "Continue", run: () => setState(resume(state, Date.now())) }
                : { label: "Pause", run: () => setState(pause(state, Date.now())) });
            items.push({
                label: state.phase === "focus" ? "Skip to the break" : "Skip the break",
                run: async () => {
                    const r = skip(state, Date.now(), settings);
                    await setState(r.state);
                    await trackingFor(r.events);
                },
            });
            items.push({ kind: "separator" }, {
                label: "Stop", danger: true,
                run: () => { write(PAUSED_KEY, false); return setState(IDLE); },
            });
        }
        showMenu(items, { x: e.clientX, y: e.clientY });
    });

    const onSettings = () => {
        settings = loadFocusSettings();
        if (!settings.enabled && state.phase !== "idle") { state = IDLE; save(); }
        render();
        syncTimer();
    };
    window.addEventListener("tracksuite:focus-settings", onSettings);

    // Catch up on time that passed while the app was closed or asleep (the
    // timer then waits, paused, in the period it would be in).
    onTick();

    return {
        destroy() {
            if (timer !== null) window.clearInterval(timer);
            window.removeEventListener("tracksuite:focus-settings", onSettings);
            btn.remove();
        },
    };
}

/** The Settings block. Saves on every change. */
export function renderFocusSettings(container: HTMLElement, opts: { onEnable?(): void } = {}): void {
    const s = loadFocusSettings();
    const num = (k: keyof FocusSettings, v: number, max = 180) =>
        `<input type="number" data-k="${k}" min="1" max="${max}" value="${v}">`;
    container.classList.add("ui-focus-settings");
    container.innerHTML = `
        <label class="ui-fs-row"><input type="checkbox" data-k="enabled" ${s.enabled ? "checked" : ""}> <span>Show the focus timer next to the clock button</span></label>
        <div class="ui-fs-row ui-fs-mins">
            <label>Focus ${num("focusMin", s.focusMin)} min</label>
            <label>Short break ${num("shortBreakMin", s.shortBreakMin)} min</label>
            <label>Long break ${num("longBreakMin", s.longBreakMin)} min</label>
            <label>after every ${num("longEvery", s.longEvery, 12)} focus rounds</label>
        </div>
        <label class="ui-fs-row"><input type="checkbox" data-k="autoContinue" ${s.autoContinue ? "checked" : ""}> <span>Continue automatically (the next period starts by itself)</span></label>
        <label class="ui-fs-row"><input type="checkbox" data-k="pauseTracking" ${s.pauseTracking ? "checked" : ""}> <span>Pause tracking during breaks (breaks show as gaps on the timeline)</span></label>
        <div class="ui-fs-row">
            <span>Sound when a period ends</span>
            <select data-k="sound">
                <option value="off" ${s.sound === "off" ? "selected" : ""}>Off</option>
                ${CHIME_SOUNDS.map((c) => `<option value="${c.key}" ${s.sound === c.key ? "selected" : ""}>${c.label}</option>`).join("")}
            </select>
            <button type="button" class="ui-fs-preview">▶ Play</button>
        </div>
        <p class="ui-fs-note">A short rising sound ends a focus, a falling one ends a break — the preview plays both.</p>
        <label class="ui-fs-row"><input type="checkbox" data-k="notify" ${s.notify ? "checked" : ""}> <span>Show a notification when a period ends</span></label>
        <p class="ui-fs-note">On the timer: click to start, pause or continue; right-click to skip or stop.</p>`;
    enhanceSelect(container.querySelector<HTMLSelectElement>('[data-k="sound"]')!);
    container.querySelector(".ui-fs-preview")!.addEventListener("click", () => {
        const sound = loadFocusSettings().sound;
        if (sound === "off") return;
        playChime(sound, "focus-done");
        window.setTimeout(() => playChime(sound, "break-done"), 1600);
    });
    const sync = () => {
        const on = (container.querySelector<HTMLInputElement>('[data-k="enabled"]')!).checked;
        container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input:not([data-k="enabled"]), button, select').forEach((i) => { i.disabled = !on; });
    };
    sync();
    container.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement;
        const k = t.dataset.k as keyof FocusSettings | undefined;
        if (!k) return;
        const next = loadFocusSettings() as Record<keyof FocusSettings, unknown>;
        next[k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
        const clean = normalizeFocusSettings(next);
        if (t.type === "number") t.value = String(clean[k]);
        saveFocusSettings(clean);
        if (k === "enabled" && clean.enabled) opts.onEnable?.();
        sync();
    });
}
