// The Reports form, shared by both apps (same element ids): every choice
// re-renders at once (no Generate button), and the last choices are
// remembered so the page opens the way it was left. A range picked with a
// chip is stored by name ("last-month"), so it stays relative to today.

import { presetRange, type RangePreset } from "../time.ts";
import { renderRangePresets } from "./presets.ts";

const KEY = "tracksuite.reports.last";
const FIELDS = ["rp-style", "rp-detailed", "rp-times", "rp-project", "rp-from", "rp-to"] as const;

type Saved = {
    style?: string; detailed?: boolean; times?: boolean; project?: string;
    range?: RangePreset | null; from?: string; to?: string;
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type ReportChoices = {
    /** Put back the last choices (default: this month so far); returns the saved project. */
    restore(): string;
};

export function wireReportChoices(rangePresets: HTMLElement, render: () => void): ReportChoices {
    const changed = () => {
        highlight();
        const range = rangePresets.querySelector<HTMLElement>(".ui-preset.ui-active")?.dataset.range ?? null;
        const saved: Saved = {
            style: el<HTMLSelectElement>("rp-style").value,
            detailed: el<HTMLInputElement>("rp-detailed").checked,
            times: el<HTMLInputElement>("rp-times").checked,
            project: el<HTMLSelectElement>("rp-project").value,
            range: range as RangePreset | null,
            from: el<HTMLInputElement>("rp-from").value,
            to: el<HTMLInputElement>("rp-to").value,
        };
        try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not remembered */ }
        render();
    };
    const highlight = renderRangePresets(rangePresets, "rp-from", "rp-to", changed);
    for (const id of FIELDS) el(id).addEventListener("change", changed);

    return {
        restore() {
            let saved: Saved = {};
            try { saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { /* ignore */ }
            const [from, to] = saved.range
                ? presetRange(saved.range)
                : saved.from && saved.to ? [saved.from, saved.to] : presetRange("this-month");
            el<HTMLInputElement>("rp-from").value = from;
            el<HTMLInputElement>("rp-to").value = to;
            if (saved.style) el<HTMLSelectElement>("rp-style").value = saved.style;
            if (saved.detailed !== undefined) el<HTMLInputElement>("rp-detailed").checked = saved.detailed;
            if (saved.times !== undefined) el<HTMLInputElement>("rp-times").checked = saved.times;
            highlight();
            return saved.project ?? "";
        },
    };
}
