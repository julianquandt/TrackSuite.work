// The day timeline editor, shared by the desktop and web apps.
//
// One strip per day. Everything is direct manipulation:
// - Pick a project swatch (or press 0–9 while over the timeline) and drag to
//   paint: over existing time it re-tags it, from empty space it adds time.
//   Where the stroke starts decides which (like the off-day calendar).
// - The 🖌 note brush stamps a note onto every block it touches.
// - With nothing picked up, drag a block's edge to change its time (a boundary
//   shared by two touching blocks moves both), or click a block to edit it.
// - ‹ › / ← → step days; the date opens a picker; "Today" jumps back.
//
// The component never talks to storage: every change goes through the
// adapter, which the app implements (desktop: Tauri/SQLite, web: HTTP).

import { escapeHtml } from "../text.ts";
import { dayStart, formatClock, formatDuration, localDateKey, shiftDayKey, MS_PER_MINUTE } from "../time.ts";
import { findGaps } from "../shifts.ts";
import { showMenu, type MenuItem } from "./menu.ts";
import { showDatePicker } from "./datepicker.ts";

export type TimelineShift = {
    id: number;
    startMs: number;
    endMs: number | null; // null = running
    project: string | null;
    note: string | null;
    autoClosed: boolean;
};

export type TimelineProject = { uuid: string; name: string; color: string };

export type TimeChange = { id: number; startMs: number; endMs: number | null };

export interface TimelineAdapter {
    /** Re-tag the closed time inside [startMs, endMs). */
    assignRange(startMs: number, endMs: number, project: string | null): Promise<void>;
    /** Re-tag several ranges as one step (one Undo). */
    assignRanges(ranges: { startMs: number; endMs: number }[], project: string | null): Promise<void>;
    /** Add closed shifts in the empty parts of [startMs, endMs). */
    fillRange(startMs: number, endMs: number, project: string | null): Promise<void>;
    /** Apply new start/end times atomically (several when a shared edge moves). */
    setTimes(changes: TimeChange[]): Promise<void>;
    setNotes(ids: number[], note: string | null): Promise<void>;
    setProject(id: number, project: string | null): Promise<void>;
    deleteShift(id: number): Promise<void>;
    /** "Looks right" on a shift the app closed automatically. */
    clearAutoClosed(id: number): Promise<void>;
    projectColor(uuid: string | null): string;
    projectName(uuid: string | null): string;
    /** Readable text colour on a block of `background`. */
    textColorOn(background: string): string;
    /** Called after the user moved to another day. */
    onDayChange?(dayKey: string): void;
    /** Map an adapter error to a short sentence (e.g. "overlap"). */
    describeError?(err: unknown): string;
}

export interface TimelineHandle {
    /** All shifts (any day) and the pickable projects, in swatch order. */
    setData(shifts: TimelineShift[], projects: TimelineProject[]): void;
    showDay(dayKey: string): void;
    /** Show the shift's day and open its editor. */
    select(id: number): void;
    day(): string;
    destroy(): void;
}

type Brush = { kind: "project"; project: string | null } | { kind: "note" } | null;

type Block = { s: TimelineShift; startMin: number; endMin: number; live: boolean };

type Drag =
    | { type: "paint"; mode: "retag" | "fill"; anchorMin: number; curMin: number; pointerId: number }
    | { type: "edge"; edits: { id: number; side: "start" | "end" }[]; lo: number; hi: number; origMin: number; curMin: number; pointerId: number }
    | { type: "note"; stroke: Set<number>; pointerId: number };

const SNAP_MIN = 5;
const EDGE_PX = 7;
const MIN_LEN_MIN = 5;
const DEFAULT_SPAN: [number, number] = [8 * 60, 18 * 60];

const HINTS = {
    edit: "Pick a colour below and drag to paint time · drag a block's edge to change its time · click or right-click a block to edit it · Del removes its project",
    project: (name: string) => `Painting <strong>${escapeHtml(name)}</strong> — click a start and an end (or drag) over unassigned time or an empty spot · Ctrl+click: a whole block · click a coloured block to edit it · Esc to stop`,
    note: "Click or drag over blocks to stamp the note · an empty note erases · Alt+click a block to pick up its note",
};

export function createTimeline(root: HTMLElement, adapter: TimelineAdapter, initialDay: string = localDateKey(new Date())): TimelineHandle {
    let dayKey = initialDay;
    let allShifts: TimelineShift[] = [];
    let projects: TimelineProject[] = [];
    let blocks: Block[] = [];
    let spanStart = DEFAULT_SPAN[0];
    let spanEnd = DEFAULT_SPAN[1];
    let brush: Brush = null;
    let drag: Drag | null = null;
    let selectedId: number | null = null;
    let hoverId: number | null = null;
    // Click-click painting: the first click fixes the start, the next the end.
    let pendingPaint: { anchorMin: number; mode: "retag" | "fill" } | null = null;
    // Ctrl held over an unassigned block previews painting the whole block.
    let ctrlHeld = false;
    let lastPointerX: number | null = null;
    let hovered = false;
    let pending = 0;
    let liveTimer: number | null = null;
    // Data that arrived mid-drag or mid-save; drawn as soon as the user is done.
    let staleRender = false;
    let statusTimer: number | null = null;

    root.classList.add("tl");
    root.tabIndex = 0;
    root.innerHTML = `
        <div class="tl-head">
            <button type="button" class="tl-nav" data-nav="-1" aria-label="Previous day">‹</button>
            <button type="button" class="tl-date" title="Pick a day"></button>
            <button type="button" class="tl-nav" data-nav="1" aria-label="Next day">›</button>
            <button type="button" class="tl-today">Today</button>
            <span class="tl-total"></span>
        </div>
        <div class="tl-ticks"></div>
        <div class="tl-track" role="application" aria-label="Day timeline">
            <div class="tl-blocks"></div>
            <div class="tl-preview" hidden><span class="tl-preview-label"></span></div>
            <div class="tl-guide" hidden><span class="tl-guide-label"></span></div>
            <div class="tl-now" hidden></div>
            <p class="tl-empty" hidden>No time on this day yet — pick a colour below and drag to add some.</p>
        </div>
        <div class="tl-popover" hidden></div>
        <div class="tl-tools">
            <div class="tl-swatches"></div>
            <div class="tl-notebrush">
                <button type="button" class="tl-tool tl-note-btn" title="Note brush: paint a note onto blocks">🖌 Note</button>
                <input type="text" class="tl-note-input" maxlength="500" placeholder="Note to paint…" hidden>
                <div class="tl-note-chips"></div>
            </div>
        </div>
        <p class="tl-hint"></p>`;

    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    const elDate = q<HTMLButtonElement>(".tl-date");
    const elToday = q<HTMLButtonElement>(".tl-today");
    const elTotal = q<HTMLSpanElement>(".tl-total");
    const elTicks = q<HTMLDivElement>(".tl-ticks");
    const elTrack = q<HTMLDivElement>(".tl-track");
    const elBlocks = q<HTMLDivElement>(".tl-blocks");
    const elPreview = q<HTMLDivElement>(".tl-preview");
    const elPreviewLabel = q<HTMLSpanElement>(".tl-preview-label");
    const elGuide = q<HTMLDivElement>(".tl-guide");
    const elGuideLabel = q<HTMLSpanElement>(".tl-guide-label");
    const elNow = q<HTMLDivElement>(".tl-now");
    const elEmpty = q<HTMLParagraphElement>(".tl-empty");
    const elPopover = q<HTMLDivElement>(".tl-popover");
    const elSwatches = q<HTMLDivElement>(".tl-swatches");
    const elNoteBtn = q<HTMLButtonElement>(".tl-note-btn");
    const elNoteInput = q<HTMLInputElement>(".tl-note-input");
    const elNoteChips = q<HTMLDivElement>(".tl-note-chips");
    const elHint = q<HTMLParagraphElement>(".tl-hint");

    // ── Geometry ────────────────────────────────────────────────────
    const dayStartMs = () => dayStart(dayKey).getTime();
    const minToMs = (min: number) => dayStartMs() + min * MS_PER_MINUTE;
    const span = () => spanEnd - spanStart;
    const pct = (min: number) => ((min - spanStart) / span()) * 100;
    const nowMin = () => (Date.now() - dayStartMs()) / MS_PER_MINUTE;
    const snap = (min: number) => Math.round(min / SNAP_MIN) * SNAP_MIN;

    function minFromX(clientX: number): number {
        const rect = elTrack.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return spanStart + f * span();
    }
    function pxPerMin(): number {
        return elTrack.getBoundingClientRect().width / span();
    }
    const blockAt = (min: number) => blocks.find((b) => min >= b.startMin && min < b.endMin) ?? null;

    // ── Rendering ───────────────────────────────────────────────────
    function computeBlocks() {
        const ds = dayStartMs();
        const de = ds + 1440 * MS_PER_MINUTE;
        const now = Date.now();
        blocks = allShifts
            .filter((s) => s.startMs < de && (s.endMs ?? now) > ds)
            .map((s) => ({
                s,
                startMin: (Math.max(s.startMs, ds) - ds) / MS_PER_MINUTE,
                endMin: (Math.min(s.endMs ?? Math.min(now, de), de) - ds) / MS_PER_MINUTE,
                live: s.endMs === null,
            }))
            .filter((b) => b.endMin > b.startMin || b.live)
            .sort((a, b) => a.startMin - b.startMin);
        // Show the worked span padded by 30 min, and always at least 08:00–18:00
        // so there is room to paint forgotten time onto an empty morning.
        let lo = DEFAULT_SPAN[0], hi = DEFAULT_SPAN[1];
        for (const b of blocks) { lo = Math.min(lo, b.startMin - 30); hi = Math.max(hi, b.endMin + 30); }
        spanStart = Math.max(0, Math.floor(lo / 30) * 30);
        spanEnd = Math.min(1440, Math.ceil(hi / 30) * 30);
    }

    function render() {
        computeBlocks();
        renderHead();
        renderTicks();
        elBlocks.innerHTML = "";
        for (const b of blocks) {
            const div = document.createElement("div");
            div.className = "tl-block";
            div.dataset.id = String(b.s.id);
            const color = adapter.projectColor(b.s.project);
            div.style.left = `${pct(b.startMin)}%`;
            div.style.width = `${pct(b.endMin) - pct(b.startMin)}%`;
            div.style.background = color;
            div.style.color = adapter.textColorOn(color);
            if (b.live) div.classList.add("tl-live");
            if (b.s.note) div.classList.add("tl-has-note");
            if (b.s.autoClosed) div.classList.add("tl-auto-closed");
            if (b.s.id === selectedId) div.classList.add("tl-selected");
            const name = adapter.projectName(b.s.project);
            div.innerHTML = `<span class="tl-label">${escapeHtml(name)} · ${formatDuration((b.endMin - b.startMin) / 60)}</span>${b.s.note ? `<span class="tl-note-dot" aria-hidden="true"></span>` : ""}`;
            const range = `${formatClock(b.startMin)}–${b.live ? "now" : formatClock(b.endMin)}`;
            div.title = [
                `${name}: ${range}`,
                b.s.note ? `Note: ${b.s.note}` : "",
                b.s.autoClosed ? "Closed automatically — check the end time" : "",
            ].filter(Boolean).join("\n");
            elBlocks.appendChild(div);
        }
        elEmpty.hidden = blocks.length > 0;
        renderNow();
        renderPopover();
        syncLiveTimer();
    }

    function renderHead() {
        const d = dayStart(dayKey);
        elDate.textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
        const isToday = dayKey === localDateKey(new Date());
        elToday.hidden = isToday;
        const total = blocks.reduce((sum, b) => sum + (b.endMin - b.startMin), 0) / 60;
        elTotal.textContent = total > 0 ? formatDuration(total) : "";
    }

    function renderTicks() {
        const step = span() > 12 * 60 ? 180 : span() > 6 * 60 ? 120 : 60;
        const parts: string[] = [];
        for (let m = Math.ceil(spanStart / step) * step; m <= spanEnd; m += step) {
            parts.push(`<span style="left:${pct(m)}%">${formatClock(m)}</span>`);
        }
        elTicks.innerHTML = parts.join("");
    }

    function renderNow() {
        const n = nowMin();
        const show = n > spanStart && n < spanEnd;
        elNow.hidden = !show;
        if (show) elNow.style.left = `${pct(n)}%`;
    }

    function renderSwatches() {
        const sw = (uuid: string | null, name: string, color: string, key: string | null) => {
            const active = brush?.kind === "project" && brush.project === uuid;
            return `<button type="button" class="tl-tool tl-swatch${active ? " tl-active" : ""}" data-project="${escapeHtml(uuid ?? "")}" title="Paint ${escapeHtml(name)}${key ? ` (key ${key})` : ""}">
                <span class="tl-dot" style="background:${escapeHtml(color)}"></span><span class="tl-swatch-name">${escapeHtml(name)}</span>${key ? `<kbd>${key}</kbd>` : ""}</button>`;
        };
        elSwatches.innerHTML = [
            sw(null, "Unassigned", adapter.projectColor(null), "0"),
            ...projects.map((p, i) => sw(p.uuid, p.name, p.color, i < 9 ? String(i + 1) : null)),
        ].join("");
    }

    function recentNotes(): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const s of [...allShifts].sort((a, b) => b.startMs - a.startMs)) {
            const n = s.note?.trim();
            if (n && !seen.has(n)) { seen.add(n); out.push(n); if (out.length >= 5) break; }
        }
        return out;
    }

    function renderTools() {
        renderSwatches();
        const noteOn = brush?.kind === "note";
        elNoteBtn.classList.toggle("tl-active", noteOn);
        elNoteInput.hidden = !noteOn;
        elNoteChips.hidden = !noteOn;
        elNoteChips.innerHTML = noteOn
            ? recentNotes().map((n) => `<button type="button" class="tl-chip" title="Use this note">${escapeHtml(n)}</button>`).join("")
            : "";
        root.dataset.brush = brush ? brush.kind : "";
        if (brush?.kind === "project") {
            root.style.setProperty("--tl-brush", adapter.projectColor(brush.project));
            elHint.innerHTML = HINTS.project(adapter.projectName(brush.project));
        } else {
            root.style.removeProperty("--tl-brush");
            elHint.textContent = noteOn ? HINTS.note : HINTS.edit;
        }
    }

    function flash(message: string) {
        elHint.textContent = message;
        elHint.classList.add("tl-hint-alert");
        if (statusTimer !== null) window.clearTimeout(statusTimer);
        statusTimer = window.setTimeout(() => { elHint.classList.remove("tl-hint-alert"); renderTools(); }, 3500);
    }

    // ── Popover (click a block in edit mode) ────────────────────────
    function renderPopover() {
        const b = blocks.find((x) => x.s.id === selectedId);
        if (!b || brush?.kind === "note") { elPopover.hidden = true; return; }
        const s = b.s;
        const ds = dayStartMs();
        const startMin = (s.startMs - ds) / MS_PER_MINUTE;
        const endMin = s.endMs === null ? null : (s.endMs - ds) / MS_PER_MINUTE;
        const dots = [{ uuid: null as string | null, name: "Unassigned", color: adapter.projectColor(null) }, ...projects]
            .map((p) => `<button type="button" class="tl-pop-dot${(p.uuid ?? null) === (s.project ?? null) ? " tl-active" : ""}" data-project="${escapeHtml(p.uuid ?? "")}" title="${escapeHtml(p.name)}" style="background:${escapeHtml(p.color)}"></button>`)
            .join("");
        const timeOf = (min: number) => (min >= 0 && min <= 1440 ? formatClock(min) : "");
        elPopover.innerHTML = `
            <div class="tl-pop-row">
                <input type="time" class="tl-pop-start" value="${timeOf(startMin)}" ${startMin < 0 ? "disabled title=\"Starts on an earlier day\"" : ""}>
                <span>–</span>
                ${endMin === null
                    ? `<span class="tl-pop-running">now (running)</span>`
                    : `<input type="time" class="tl-pop-end" value="${timeOf(endMin)}" ${endMin > 1440 ? "disabled title=\"Ends on a later day\"" : ""}>`}
                <span class="tl-pop-dur">${formatDuration((b.endMin - b.startMin) / 60)}</span>
                <button type="button" class="tl-pop-close" aria-label="Close">×</button>
            </div>
            <div class="tl-pop-row tl-pop-dots">${dots}</div>
            <input type="text" class="tl-pop-note" maxlength="500" placeholder="What did you work on?" value="${escapeHtml(s.note ?? "")}">
            <div class="tl-pop-row tl-pop-actions">
                ${s.autoClosed ? `<span class="tl-pop-warn">Closed automatically — is the end time right?</span><button type="button" class="tl-pop-ok">Looks right</button>` : ""}
                <button type="button" class="tl-pop-delete">Delete shift</button>
            </div>`;
        elPopover.hidden = false;
        positionPopover();
    }

    // Fixed to the viewport under the selected block, so no overflow:hidden
    // panel clips it; kept on screen, and follows the block on scroll/resize.
    function positionPopover() {
        const b = blocks.find((x) => x.s.id === selectedId);
        if (!b || elPopover.hidden) return;
        const track = elTrack.getBoundingClientRect();
        const popW = elPopover.offsetWidth;
        const popH = elPopover.offsetHeight;
        const mid = track.left + (((pct(b.startMin) + pct(b.endMin)) / 2) / 100) * track.width;
        const left = Math.max(8 + popW / 2, Math.min(window.innerWidth - 8 - popW / 2, mid));
        const below = track.bottom + 8;
        const top = below + popH > window.innerHeight - 8 ? Math.max(8, track.top - 8 - popH) : below;
        elPopover.style.left = `${left}px`;
        elPopover.style.top = `${top}px`;
    }

    function closePopover() {
        selectedId = null;
        elPopover.hidden = true;
        elBlocks.querySelectorAll(".tl-selected").forEach((el) => el.classList.remove("tl-selected"));
    }

    function parseTimeInput(value: string): number | null {
        const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
        if (!m) return null;
        const h = Number(m[1]), min = Number(m[2]);
        if (h > 23 || min > 59) return null;
        return h * 60 + min;
    }

    elPopover.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        const id = selectedId;
        if (id === null) return;
        if (t.closest(".tl-pop-close")) { closePopover(); return; }
        if (t.closest(".tl-pop-delete")) { closePopover(); void run(() => adapter.deleteShift(id)); return; }
        if (t.closest(".tl-pop-ok")) { void run(() => adapter.clearAutoClosed(id)); return; }
        const dot = t.closest<HTMLElement>(".tl-pop-dot");
        if (dot) void run(() => adapter.setProject(id, dot.dataset.project || null));
    });
    elPopover.addEventListener("change", (e) => {
        const t = e.target as HTMLInputElement;
        const id = selectedId;
        const s = allShifts.find((x) => x.id === id);
        if (id === null || !s) return;
        if (t.classList.contains("tl-pop-note")) {
            const note = t.value.trim() || null;
            if (note !== (s.note ?? null)) void run(() => adapter.setNotes([id], note));
            return;
        }
        if (t.classList.contains("tl-pop-start") || t.classList.contains("tl-pop-end")) {
            const startIn = elPopover.querySelector<HTMLInputElement>(".tl-pop-start");
            const endIn = elPopover.querySelector<HTMLInputElement>(".tl-pop-end");
            const sMin = startIn && !startIn.disabled ? parseTimeInput(startIn.value) : null;
            const eMin = endIn && !endIn.disabled ? parseTimeInput(endIn.value) : null;
            const startMs = sMin === null ? s.startMs : minToMs(sMin);
            const endMs = s.endMs === null ? null : eMin === null ? s.endMs : minToMs(eMin);
            if (endMs !== null && endMs <= startMs) { flash("The end must be after the start."); renderPopover(); return; }
            if (s.endMs === null && startMs > Date.now()) { flash("A running shift can't start in the future."); renderPopover(); return; }
            void run(() => adapter.setTimes([{ id, startMs, endMs }]));
        }
    });
    elPopover.addEventListener("keydown", (e) => {
        if (e.key === "Enter") (e.target as HTMLElement).blur();
        if (e.key === "Escape") { closePopover(); root.focus(); }
        e.stopPropagation(); // typing here must not trigger timeline keys
    });

    // ── Running actions ─────────────────────────────────────────────
    async function run(action: () => Promise<void>) {
        pending++;
        root.classList.add("tl-saving");
        try {
            await action();
        } catch (err) {
            flash(adapter.describeError?.(err) ?? `Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            pending--;
            if (!pending) {
                root.classList.remove("tl-saving");
                if (staleRender && !drag) { staleRender = false; renderTools(); render(); }
            }
        }
    }

    // ── Pointer handling ────────────────────────────────────────────
    type EdgeHit = { edits: { id: number; side: "start" | "end" }[]; lo: number; hi: number; at: number };
    function edgeAt(clientX: number): EdgeHit | null {
        const min = minFromX(clientX);
        const tol = EDGE_PX / pxPerMin();
        const now = nowMin();
        let best: EdgeHit | null = null;
        let bestDist = Infinity;
        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const prev = blocks[i - 1];
            const next = blocks[i + 1];
            // Start edge (only if the shift really starts on this day).
            if (b.s.startMs >= dayStartMs()) {
                const d = Math.abs(min - b.startMin);
                if (d <= tol && d < bestDist) {
                    const shared = prev && !prev.live && Math.abs(prev.endMin - b.startMin) < 0.5;
                    bestDist = d;
                    best = shared
                        ? { edits: [{ id: prev.s.id, side: "end" }, { id: b.s.id, side: "start" }], lo: prev.startMin + MIN_LEN_MIN, hi: b.endMin - MIN_LEN_MIN, at: b.startMin }
                        : { edits: [{ id: b.s.id, side: "start" }], lo: prev ? prev.endMin : spanStart, hi: (b.live ? Math.min(b.endMin, now) : b.endMin) - MIN_LEN_MIN, at: b.startMin };
                }
            }
            // End edge (closed shifts that end on this day; a shared edge is handled above).
            if (!b.live && b.s.endMs !== null && b.s.endMs <= dayStartMs() + 1440 * MS_PER_MINUTE) {
                const sharedWithNext = next && Math.abs(next.startMin - b.endMin) < 0.5;
                const d = Math.abs(min - b.endMin);
                if (!sharedWithNext && d <= tol && d < bestDist) {
                    bestDist = d;
                    best = { edits: [{ id: b.s.id, side: "end" }], lo: b.startMin + MIN_LEN_MIN, hi: next ? next.startMin : Math.min(spanEnd, Math.max(now, b.endMin)), at: b.endMin };
                }
            }
        }
        return best;
    }

    function showPreview(fromMin: number, toMin: number, label: string) {
        const a = Math.min(fromMin, toMin), b = Math.max(fromMin, toMin);
        elPreview.hidden = false;
        elPreview.style.left = `${pct(a)}%`;
        elPreview.style.width = `${pct(b) - pct(a)}%`;
        elPreviewLabel.textContent = label;
    }
    function hidePreview() { elPreview.hidden = true; }

    function paintLabel(d: { anchorMin: number; curMin: number; mode: "retag" | "fill" }): string {
        const a = Math.min(d.anchorMin, d.curMin), b = Math.max(d.anchorMin, d.curMin);
        const base = `${formatClock(a)}–${formatClock(b)} · ${formatDuration((b - a) / 60)}`;
        if (d.mode === "retag") {
            const tagged = unassignedRanges(a, b).reduce((sum, r) => sum + (r.endMin - r.startMin), 0) / 60;
            return `${base} · tags ${formatDuration(tagged)}`;
        }
        if (d.mode === "fill") {
            const now = Date.now();
            const occupied = allShifts.map((s) => ({ startMs: s.startMs, endMs: s.endMs ?? now }));
            const added = findGaps(occupied, minToMs(a), minToMs(b)).reduce((sum, g) => sum + (g.endMs - g.startMs), 0) / 3_600_000;
            return `${base} · adds ${formatDuration(added)}`;
        }
        return base;
    }

    /** The closed, unassigned parts of [a, b] (minutes), as separate ranges. */
    function unassignedRanges(a: number, b: number): { startMin: number; endMin: number }[] {
        return blocks
            .filter((blk) => !blk.live && !blk.s.project && blk.startMin < b && blk.endMin > a)
            .map((blk) => ({ startMin: Math.max(a, blk.startMin), endMin: Math.min(b, blk.endMin) }))
            .filter((r) => r.endMin > r.startMin);
    }
    const isAssigned = (blk: Block | null) => !!blk?.s.project;

    /** Paint [a, b] (either order): tag unassigned time, or add time in the gaps. */
    async function commitPaint(mode: "retag" | "fill", x: number, y: number, project: string | null) {
        const a = Math.min(x, y), b = Math.max(x, y);
        if (b - a < SNAP_MIN) return;
        if (mode === "retag") {
            // Assigned time is protected: only the unassigned parts get the project.
            const ranges = unassignedRanges(a, b).map((r) => ({ startMs: minToMs(r.startMin), endMs: minToMs(r.endMin) }));
            if (!ranges.length) { flash("That time already has a project. Del or right-click removes it first."); return; }
            await run(() => adapter.assignRanges(ranges, project));
            return;
        }
        const fromMs = minToMs(a), toMs = minToMs(b);
        // New time can't reach into the future.
        const fillTo = Math.min(toMs, Date.now());
        if (fillTo - fromMs < SNAP_MIN * MS_PER_MINUTE) { flash("Time can only be added up to now."); return; }
        await run(() => adapter.fillRange(fromMs, fillTo, project));
    }

    function stampNote(b: Block, stroke: Set<number>) {
        if (stroke.has(b.s.id)) return;
        stroke.add(b.s.id);
        const note = elNoteInput.value.trim() || null;
        const el = elBlocks.querySelector<HTMLElement>(`.tl-block[data-id="${b.s.id}"]`);
        if (!el) return;
        el.classList.toggle("tl-has-note", !!note);
        el.classList.remove("tl-stamped");
        void el.offsetWidth; // restart the stamp animation
        el.classList.add("tl-stamped");
        const dot = el.querySelector(".tl-note-dot");
        if (note && !dot) el.insertAdjacentHTML("beforeend", `<span class="tl-note-dot" aria-hidden="true"></span>`);
        if (!note) dot?.remove();
    }

    elTrack.addEventListener("pointerleave", () => {
        hoverId = null;
        lastPointerX = null;
        elGuide.hidden = true;
        if (!pendingPaint && !drag) hidePreview();
    });

    /**
     * Pointer over the track with a project brush: a vertical line with the
     * time it would paint at; over an assigned block a normal pointer (a click
     * selects it); with Ctrl over an unassigned block, a preview of the block.
     */
    function brushHover(clientX: number) {
        const blk = blockAt(minFromX(clientX));
        const m = Math.max(spanStart, Math.min(spanEnd, snap(minFromX(clientX))));
        if (pendingPaint) {
            showGuide(m);
            showPreview(pendingPaint.anchorMin, m, paintLabel({ ...pendingPaint, curMin: m }));
            return;
        }
        if (isAssigned(blk)) {
            elGuide.hidden = true;
            hidePreview();
            elTrack.style.cursor = "pointer";
            return;
        }
        if (ctrlHeld && blk) {
            elGuide.hidden = true;
            elTrack.style.cursor = "pointer";
            showPreview(blk.startMin, blk.endMin, `${formatClock(blk.startMin)}–${blk.live ? "now" : formatClock(blk.endMin)} · whole block`);
            return;
        }
        hidePreview();
        showGuide(m);
    }

    function showGuide(m: number) {
        elTrack.style.cursor = "";
        elGuide.hidden = false;
        elGuide.style.left = `${pct(m)}%`;
        elGuideLabel.textContent = formatClock(m);
        elGuide.classList.toggle("tl-guide-flip", pct(m) > 85);
    }

    const onCtrl = (e: KeyboardEvent) => {
        if (e.key !== "Control" && e.key !== "Meta") return;
        ctrlHeld = e.type === "keydown";
        if (brush?.kind === "project" && lastPointerX !== null && !drag) brushHover(lastPointerX);
    };
    window.addEventListener("keydown", onCtrl);
    window.addEventListener("keyup", onCtrl);
    elTrack.addEventListener("pointermove", (e) => {
        if (drag) { onDragMove(e); return; }
        hoverId = blockAt(minFromX(e.clientX))?.s.id ?? null;
        lastPointerX = e.clientX;
        if (brush?.kind === "project") { brushHover(e.clientX); return; }
        if (brush) { elTrack.style.cursor = ""; return; }
        const edge = edgeAt(e.clientX);
        elTrack.style.cursor = edge ? "ew-resize" : blockAt(minFromX(e.clientX)) ? "pointer" : "";
    });

    elTrack.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || pending) return;
        const min = minFromX(e.clientX);
        const blk = blockAt(min);

        // Eyedropper: Alt+click a block picks up its note.
        if (e.altKey && blk) {
            e.preventDefault();
            brush = { kind: "note" };
            elNoteInput.value = blk.s.note ?? "";
            closePopover();
            renderTools();
            elNoteInput.focus();
            return;
        }

        if (brush?.kind === "note") {
            if (!blk) return;
            e.preventDefault();
            // Move focus off the note field, so Ctrl+Z undoes the stroke
            // rather than the typing in that field.
            root.focus({ preventScroll: true });
            elTrack.setPointerCapture(e.pointerId);
            drag = { type: "note", stroke: new Set(), pointerId: e.pointerId };
            stampNote(blk, drag.stroke);
            return;
        }

        if (brush?.kind === "project") {
            e.preventDefault();
            root.focus({ preventScroll: true });
            const project = brush.project;
            // Second click: the end of the range started by the first click.
            if (pendingPaint) {
                const p = pendingPaint;
                pendingPaint = null;
                hidePreview();
                void commitPaint(p.mode, p.anchorMin, Math.max(spanStart, Math.min(spanEnd, snap(min))), project);
                return;
            }
            // An assigned block is protected: a click selects it for editing,
            // with the brush still in hand.
            if (blk && isAssigned(blk)) {
                hidePreview();
                selectedId = selectedId === blk.s.id ? null : blk.s.id;
                render();
                return;
            }
            // Ctrl/Cmd+click on unassigned time: the whole block.
            if ((e.ctrlKey || e.metaKey) && blk) {
                hidePreview();
                if (blk.live) { void run(() => adapter.setProject(blk.s.id, project)); return; }
                void run(() => adapter.assignRange(minToMs(blk.startMin), minToMs(blk.endMin), project));
                return;
            }
            elTrack.setPointerCapture(e.pointerId);
            const start = snap(min);
            drag = { type: "paint", mode: blk ? "retag" : "fill", anchorMin: start, curMin: start, pointerId: e.pointerId };
            root.classList.add("tl-painting");
            return;
        }

        // Edit mode: an edge drags, a block click opens its editor.
        const edge = edgeAt(e.clientX);
        if (edge) {
            e.preventDefault();
            elTrack.setPointerCapture(e.pointerId);
            closePopover();
            drag = { type: "edge", edits: edge.edits, lo: edge.lo, hi: edge.hi, origMin: edge.at, curMin: edge.at, pointerId: e.pointerId };
            root.classList.add("tl-resizing");
            return;
        }
        if (blk) {
            selectedId = selectedId === blk.s.id ? null : blk.s.id;
            render();
            return;
        }
        closePopover();
        flash("Pick a colour below to paint time onto the day.");
    });

    function onDragMove(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const min = minFromX(e.clientX);
        if (drag.type === "note") {
            const blk = blockAt(min);
            if (blk) stampNote(blk, drag.stroke);
        } else if (drag.type === "paint") {
            drag.curMin = Math.max(spanStart, Math.min(spanEnd, snap(min)));
            showPreview(drag.anchorMin, drag.curMin, paintLabel(drag));
        } else {
            drag.curMin = Math.max(drag.lo, Math.min(drag.hi, snap(min)));
            showPreview(drag.origMin, drag.curMin, `${formatClock(drag.curMin)}`);
            const d = drag;
            for (const ed of d.edits) {
                const el = elBlocks.querySelector<HTMLElement>(`.tl-block[data-id="${ed.id}"]`);
                const b = blocks.find((x) => x.s.id === ed.id);
                if (!el || !b) continue;
                const s = ed.side === "start" ? d.curMin : b.startMin;
                const en = ed.side === "end" ? d.curMin : b.endMin;
                el.style.left = `${pct(s)}%`;
                el.style.width = `${pct(en) - pct(s)}%`;
            }
        }
    }

    async function onDragEnd(e: PointerEvent) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const d = drag;
        drag = null;
        root.classList.remove("tl-painting", "tl-resizing");
        hidePreview();
        if (staleRender && !pending) { staleRender = false; renderTools(); render(); }
        if (d.type === "note") {
            if (d.stroke.size) {
                const note = elNoteInput.value.trim() || null;
                await run(() => adapter.setNotes([...d.stroke], note));
            }
            return;
        }
        if (d.type === "paint" && brush?.kind === "project") {
            if (Math.abs(d.curMin - d.anchorMin) < SNAP_MIN) {
                // A click: it fixes the start; the next click sets the end.
                pendingPaint = { anchorMin: d.anchorMin, mode: d.mode };
                showPreview(d.anchorMin, d.anchorMin, `${formatClock(d.anchorMin)} → click the end · Esc cancels`);
                return;
            }
            await commitPaint(d.mode, d.anchorMin, d.curMin, brush.project);
            return;
        }
        if (d.type === "edge") {
            if (Math.abs(d.curMin - d.origMin) < 0.5) { render(); return; }
            const changes = d.edits.map((ed) => {
                const s = allShifts.find((x) => x.id === ed.id)!;
                return {
                    id: ed.id,
                    startMs: ed.side === "start" ? minToMs(d.curMin) : s.startMs,
                    endMs: ed.side === "end" ? minToMs(d.curMin) : s.endMs,
                };
            });
            await run(() => adapter.setTimes(changes));
            render(); // snaps back if the save failed; fresh data re-renders anyway
        }
    }
    elTrack.addEventListener("pointerup", (e) => void onDragEnd(e));
    elTrack.addEventListener("pointercancel", (e) => void onDragEnd(e));
    elTrack.addEventListener("lostpointercapture", (e) => { if (drag && drag.pointerId === e.pointerId) void onDragEnd(e); });

    // ── Right-click menu ────────────────────────────────────────────
    elTrack.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (drag) return;
        const blk = blockAt(minFromX(e.clientX));
        if (!blk) {
            showMenu([{ kind: "header", label: "Pick a colour below and drag here to add time" }], { x: e.clientX, y: e.clientY });
            return;
        }
        const s = blk.s;
        const id = s.id;
        const name = adapter.projectName(s.project);
        const items: MenuItem[] = [
            { kind: "header", label: `${name} · ${formatClock(blk.startMin)}–${blk.live ? "now" : formatClock(blk.endMin)}` },
            { label: "Edit…", run: () => { selectedId = id; render(); } },
        ];
        if (s.project) items.push({ label: "Remove project", hint: "Del", run: () => run(() => adapter.setProject(id, null)) });
        if (s.note) {
            items.push({ label: "Remove note", run: () => run(() => adapter.setNotes([id], null)) });
            items.push({ label: "Paint this note elsewhere", run: () => { brush = { kind: "note" }; elNoteInput.value = s.note ?? ""; closePopover(); renderTools(); } });
        }
        const others = [{ uuid: null as string | null, name: "Unassigned", color: adapter.projectColor(null) }, ...projects]
            .filter((p) => (p.uuid ?? null) !== (s.project ?? null) && p.uuid !== null);
        if (others.length) {
            items.push({ kind: "separator" }, { kind: "header", label: "Move to" });
            for (const p of others) items.push({ label: p.name, color: p.color, run: () => run(() => adapter.setProject(id, p.uuid)) });
        }
        items.push({ kind: "separator" }, { label: "Delete shift", danger: true, hint: "⇧ Del", run: () => { closePopover(); return run(() => adapter.deleteShift(id)); } });
        showMenu(items, { x: e.clientX, y: e.clientY });
    });

    // ── Tools ───────────────────────────────────────────────────────
    function pickProject(uuid: string | null) {
        pendingPaint = null;
        hidePreview();
        elGuide.hidden = true;
        const same = brush?.kind === "project" && brush.project === uuid;
        brush = same ? null : { kind: "project", project: uuid };
        closePopover();
        renderTools();
    }
    elSwatches.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>(".tl-swatch");
        if (btn) pickProject(btn.dataset.project || null);
    });
    elNoteBtn.addEventListener("click", () => {
        brush = brush?.kind === "note" ? null : { kind: "note" };
        closePopover();
        renderTools();
        if (brush) elNoteInput.focus();
    });
    elNoteChips.addEventListener("click", (e) => {
        const chip = (e.target as HTMLElement).closest<HTMLElement>(".tl-chip");
        if (chip) { elNoteInput.value = chip.textContent ?? ""; elNoteInput.focus(); }
    });
    elNoteInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { brush = null; renderTools(); root.focus(); }
        if (e.key === "Enter") root.focus();
        e.stopPropagation();
    });

    // ── Days ────────────────────────────────────────────────────────
    function goTo(key: string) {
        if (key === dayKey) return;
        pendingPaint = null;
        hidePreview();
        dayKey = key;
        closePopover();
        render();
        adapter.onDayChange?.(dayKey);
    }
    root.querySelectorAll<HTMLButtonElement>(".tl-nav").forEach((b) =>
        b.addEventListener("click", () => goTo(shiftDayKey(dayKey, Number(b.dataset.nav)))));
    elToday.addEventListener("click", () => goTo(localDateKey(new Date())));
    // App-styled month calendar (the system picker is modal on Linux); days
    // with tracked time carry a dot.
    elDate.addEventListener("click", () => {
        const tracked = new Set<string>();
        for (const s of allShifts) tracked.add(localDateKey(new Date(s.startMs)));
        showDatePicker(elDate, { value: dayKey, marked: (k) => tracked.has(k), onPick: goTo });
    });

    // ── Keys: only while the pointer is over the timeline or it has focus ──
    root.addEventListener("pointerenter", () => { hovered = true; });
    root.addEventListener("pointerleave", () => { hovered = false; });
    const onKey = (e: KeyboardEvent) => {
        const inside = hovered || root.contains(document.activeElement);
        if (!inside || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        let handled = true;
        if (e.key >= "0" && e.key <= "9") {
            const n = Number(e.key);
            if (n === 0) pickProject(null);
            else if (projects[n - 1]) pickProject(projects[n - 1].uuid);
            else handled = false;
        } else if (e.key === "Escape") {
            if (pendingPaint) { pendingPaint = null; hidePreview(); }
            else if (selectedId !== null) closePopover();
            else if (brush) { brush = null; elGuide.hidden = true; elTrack.style.cursor = ""; renderTools(); }
        } else if (e.key === "ArrowLeft") goTo(shiftDayKey(dayKey, -1));
        else if (e.key === "ArrowRight") goTo(shiftDayKey(dayKey, 1));
        else if ((e.key === "Delete" || e.key === "Backspace") && (hoverId ?? selectedId) !== null) {
            // Del on the pointed-at (or selected) block: with the note brush it
            // removes the note, otherwise the project. Shift+Del deletes the
            // shift. All can be undone.
            const id = (hoverId ?? selectedId)!;
            const s = allShifts.find((x) => x.id === id);
            if (e.shiftKey) { closePopover(); void run(() => adapter.deleteShift(id)); }
            else if (brush?.kind === "note") {
                if (s?.note) void run(() => adapter.setNotes([id], null));
            } else if (s?.project) void run(() => adapter.setProject(id, null));
            else flash("This block has no project. Shift+Del deletes the shift.");
        } else if (e.key.toLowerCase() === "t") goTo(localDateKey(new Date()));
        else handled = false;
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation(); // the app's own 0–9 / Delete keys must not also fire
        }
    };
    // Capture phase on window runs before the apps' document-level key handlers.
    window.addEventListener("keydown", onKey, true);

    // The event path, not root.contains(target): a click on a block re-renders
    // the blocks, so the target may already be detached from the page.
    const onDocPointer = (e: PointerEvent) => {
        if (selectedId !== null && !e.composedPath().includes(root)) closePopover();
    };
    document.addEventListener("pointerdown", onDocPointer);
    const onViewportMove = () => positionPopover();
    window.addEventListener("scroll", onViewportMove, true);
    window.addEventListener("resize", onViewportMove);

    // ── Live block ──────────────────────────────────────────────────
    function syncLiveTimer() {
        const hasLive = blocks.some((b) => b.live);
        if (hasLive && liveTimer === null) liveTimer = window.setInterval(tickLive, 1000);
        else if (!hasLive && liveTimer !== null) { window.clearInterval(liveTimer); liveTimer = null; }
    }
    function tickLive() {
        renderNow();
        if (drag) return;
        const live = blocks.find((b) => b.live);
        if (!live) return;
        const end = Math.min(nowMin(), 1440);
        if (end > spanEnd) { render(); return; }
        live.endMin = end;
        const el = elBlocks.querySelector<HTMLElement>(".tl-block.tl-live");
        if (!el) return;
        el.style.width = `${pct(live.endMin) - pct(live.startMin)}%`;
        const label = el.querySelector(".tl-label");
        if (label) label.textContent = `${adapter.projectName(live.s.project)} · ${formatDuration((live.endMin - live.startMin) / 60)}`;
        renderHead();
    }

    renderTools();
    render();

    return {
        setData(shifts, projs) {
            allShifts = shifts;
            projects = projs;
            // Drop a picked-up project that was archived or deleted meanwhile.
            const picked = brush?.kind === "project" ? brush.project : null;
            if (picked && !projs.some((p) => p.uuid === picked)) brush = null;
            if (selectedId !== null && !shifts.some((s) => s.id === selectedId)) selectedId = null;
            // Never redraw under a drag or while a save is still running (the
            // app refreshes mid-save); catch up once that finishes.
            if (drag || pending) { staleRender = true; return; }
            renderTools();
            render();
        },
        showDay(key) { if (key !== dayKey) { dayKey = key; closePopover(); render(); } },
        select(id) {
            const s = allShifts.find((x) => x.id === id);
            if (!s) return;
            const key = localDateKey(new Date(s.startMs));
            if (key !== dayKey) { dayKey = key; adapter.onDayChange?.(dayKey); }
            brush = null;
            selectedId = id;
            renderTools();
            render();
        },
        day: () => dayKey,
        destroy() {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("keydown", onCtrl);
            window.removeEventListener("keyup", onCtrl);
            document.removeEventListener("pointerdown", onDocPointer);
            window.removeEventListener("scroll", onViewportMove, true);
            window.removeEventListener("resize", onViewportMove);
            if (liveTimer !== null) window.clearInterval(liveTimer);
            if (statusTimer !== null) window.clearTimeout(statusTimer);
            root.innerHTML = "";
        },
    };
}
