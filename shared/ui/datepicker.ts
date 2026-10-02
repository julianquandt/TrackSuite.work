// A small month calendar that opens under a button (the timeline's date).
// App-styled, never modal: a click outside, Esc or picking a day closes it.
// Days with tracked time get a dot, so the calendar doubles as an overview.

import { addDays, dayStart, localDateKey, startOfWeek } from "../time.ts";

let openPicker: { el: HTMLDivElement; cleanup: () => void } | null = null;

export function closeDatePicker(): void {
    if (!openPicker) return;
    const { el, cleanup } = openPicker;
    openPicker = null;
    cleanup();
    el.remove();
}

export function showDatePicker(anchor: HTMLElement, opts: {
    value: string; // "YYYY-MM-DD"
    marked?: (dayKey: string) => boolean;
    onPick: (dayKey: string) => void;
}): void {
    closeDatePicker();
    const el = document.createElement("div");
    el.className = "ui-datepicker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Pick a day");
    document.body.appendChild(el);

    const selected = opts.value;
    const today = localDateKey(new Date());
    let month = dayStart(selected);
    month.setDate(1);

    const render = () => {
        const title = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        const first = startOfWeek(month);
        const weekdays = Array.from({ length: 7 }, (_, i) =>
            addDays(first, i).toLocaleDateString(undefined, { weekday: "narrow" }));
        const cells: string[] = [];
        for (let i = 0; i < 42; i++) {
            const d = addDays(first, i);
            const key = localDateKey(d);
            const cls = [
                "ui-dp-day",
                d.getMonth() !== month.getMonth() ? "ui-dp-other" : "",
                key === today ? "ui-dp-today" : "",
                key === selected ? "ui-dp-selected" : "",
                opts.marked?.(key) ? "ui-dp-marked" : "",
            ].filter(Boolean).join(" ");
            cells.push(`<button type="button" class="${cls}" data-day="${key}" aria-label="${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}">${d.getDate()}</button>`);
        }
        el.innerHTML = `
            <div class="ui-dp-head">
                <button type="button" class="ui-dp-nav" data-nav="-1" aria-label="Previous month">‹</button>
                <span class="ui-dp-title">${title}</span>
                <button type="button" class="ui-dp-nav" data-nav="1" aria-label="Next month">›</button>
            </div>
            <div class="ui-dp-grid">${weekdays.map((w) => `<span class="ui-dp-wd">${w}</span>`).join("")}${cells.join("")}</div>
            <div class="ui-dp-foot"><button type="button" class="ui-dp-today-btn">Today</button></div>`;
    };
    render();

    // Place it under the anchor, kept on screen.
    const place = () => {
        const r = anchor.getBoundingClientRect();
        const w = el.offsetWidth, h = el.offsetHeight;
        let y = r.bottom + 6;
        if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - 6 - h);
        el.style.left = `${Math.max(8, Math.min(window.innerWidth - 8 - w, r.left))}px`;
        el.style.top = `${y}px`;
    };
    place();

    const pick = (key: string) => { closeDatePicker(); opts.onPick(key); };
    el.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        const nav = t.closest<HTMLElement>(".ui-dp-nav");
        if (nav) { month.setMonth(month.getMonth() + Number(nav.dataset.nav)); render(); place(); return; }
        const day = t.closest<HTMLElement>(".ui-dp-day");
        if (day?.dataset.day) { pick(day.dataset.day); return; }
        if (t.closest(".ui-dp-today-btn")) pick(today);
    });

    const onOutside = (e: PointerEvent) => {
        const path = e.composedPath();
        if (!path.includes(el) && !path.includes(anchor)) closeDatePicker();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeDatePicker(); anchor.focus(); } };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    openPicker = {
        el,
        cleanup: () => {
            document.removeEventListener("pointerdown", onOutside, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
        },
    };
    el.querySelector<HTMLButtonElement>(".ui-dp-selected, .ui-dp-today")?.focus({ preventScroll: true });
}
