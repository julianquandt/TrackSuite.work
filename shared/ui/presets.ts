// One-click presets for a group of form controls (e.g. "Last 4 weeks" sets
// Period = Weeks and Count = 4). The chip matching the current values is
// highlighted; the controls themselves stay available under "Custom".

import { presetRange, type RangePreset } from "../time.ts";

export type Preset = { label: string; values: Record<string, string> };

export function renderPresets(container: HTMLElement, presets: Preset[], onApply: () => void): () => void {
    container.classList.add("ui-presets");
    container.innerHTML = presets
        .map((p, i) => `<button type="button" class="ui-preset" data-i="${i}">${p.label.replace(/[<>&]/g, "")}</button>`)
        .join("");
    const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    const highlight = () => {
        container.querySelectorAll<HTMLButtonElement>(".ui-preset").forEach((btn) => {
            const p = presets[Number(btn.dataset.i)];
            btn.classList.toggle("ui-active", Object.entries(p.values).every(([id, v]) => field(id)?.value === v));
        });
    };
    container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".ui-preset");
        if (!btn) return;
        for (const [id, v] of Object.entries(presets[Number(btn.dataset.i)].values)) {
            const el = field(id);
            if (el) el.value = v;
        }
        highlight();
        onApply();
    });
    highlight();
    return highlight;
}

const RANGE_LABELS: [RangePreset, string][] = [
    ["this-month", "This month"], ["last-month", "Last month"],
    ["this-week", "This week"], ["last-week", "Last week"], ["this-year", "This year"],
];

/**
 * Date-range chips for a From/To pair of <input type="date">. Ranges are
 * computed at click time (never stale across midnight); the chip matching the
 * current dates is highlighted.
 */
export function renderRangePresets(container: HTMLElement, fromId: string, toId: string, onApply: () => void): () => void {
    container.classList.add("ui-presets");
    container.innerHTML = RANGE_LABELS
        .map(([key, label]) => `<button type="button" class="ui-preset" data-range="${key}">${label}</button>`)
        .join("");
    const from = () => document.getElementById(fromId) as HTMLInputElement;
    const to = () => document.getElementById(toId) as HTMLInputElement;
    const highlight = () => {
        container.querySelectorAll<HTMLButtonElement>(".ui-preset").forEach((btn) => {
            const [a, b] = presetRange(btn.dataset.range as RangePreset);
            btn.classList.toggle("ui-active", from().value === a && to().value === b);
        });
    };
    container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".ui-preset");
        if (!btn) return;
        const [a, b] = presetRange(btn.dataset.range as RangePreset);
        from().value = a;
        to().value = b;
        highlight();
        onApply();
    });
    highlight();
    return highlight;
}
