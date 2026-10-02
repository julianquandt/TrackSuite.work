// Stacked-by-project bar chart helpers shared by the desktop and web apps.
// Structural types only (no chart.js import): shared/ has no node_modules, and
// Chart.js accepts these shapes as-is.

import { formatDuration } from "./time.ts";

type ChartLike = { data: { datasets: { data: unknown[] }[] } };

export type BarRadius = { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };

/** Round the top corners of the top-most non-empty segment of each stacked bar. */
export function stackedBarTopRadius(r: number) {
    return (ctx: { dataIndex: number; datasetIndex: number; chart: ChartLike }): BarRadius => {
        const datasets = ctx.chart.data.datasets;
        let topIdx = -1;
        for (let i = 0; i < datasets.length; i++) {
            const v = datasets[i].data[ctx.dataIndex];
            if (typeof v === "number" && v > 0) topIdx = i;
        }
        const isTop = ctx.datasetIndex === topIdx;
        return { topLeft: isTop ? r : 0, topRight: isTop ? r : 0, bottomLeft: 0, bottomRight: 0 };
    };
}

export type ProjectStackDataset = {
    label: string;
    data: number[];
    backgroundColor: string;
    stack: string;
    borderRadius: ReturnType<typeof stackedBarTopRadius>;
    borderSkipped: boolean;
};

export type ProjectLookup = {
    name(uuid: string): string;
    color(uuid: string): string;
    unassignedColor(): string;
};

/**
 * Group hours per bucket and per project into stacked datasets. `contributions`
 * returns the [bucketIndex, hours] pairs one item adds (several when a shift
 * crosses midnight); out-of-range indexes are ignored.
 */
export function buildProjectStackDatasets<T>(
    bucketCount: number,
    items: T[],
    projectOf: (item: T) => string | null | undefined,
    contributions: (item: T) => Iterable<[number, number]>,
    look: ProjectLookup,
): ProjectStackDataset[] {
    const buckets = new Map<string, number[]>();
    for (const item of items) {
        const key = projectOf(item) || "";
        for (const [idx, hours] of contributions(item)) {
            if (idx < 0 || idx >= bucketCount || !(hours > 0)) continue;
            let arr = buckets.get(key);
            if (!arr) { arr = new Array(bucketCount).fill(0); buckets.set(key, arr); }
            arr[idx] += hours;
        }
    }
    const keys = [...buckets.keys()].sort((a, b) =>
        a === "" ? 1 : b === "" ? -1 : look.name(a).localeCompare(look.name(b)));
    const radius = stackedBarTopRadius(4);
    return keys.map((k) => ({
        label: k ? look.name(k) : "Unassigned",
        data: buckets.get(k)!.map((v) => parseFloat(v.toFixed(2))),
        backgroundColor: k ? look.color(k) : look.unassignedColor(),
        stack: "hours",
        borderRadius: radius,
        borderSkipped: false,
    }));
}

type TooltipCtx = { dataset: { label?: string }; raw: unknown; dataIndex: number; chart: ChartLike };

/**
 * Tooltip for stacked project bars: each project as "7h 14m (7.23 h)", plus a
 * footer with the whole bar's total under `totalLabel`.
 */
export function stackedTotalTooltip(totalLabel: string) {
    const fmt = (h: number) => `${formatDuration(h)} (${Math.round(h * 100) / 100} h)`;
    return {
        callbacks: {
            label: (ctx: TooltipCtx) =>
                `${ctx.dataset.label || "Project"}: ${fmt(typeof ctx.raw === "number" ? ctx.raw : 0)}`,
            footer: (items: TooltipCtx[]) => {
                if (!items.length) return "";
                const idx = items[0].dataIndex;
                const total = items[0].chart.data.datasets.reduce((sum, ds) => {
                    const v = ds.data[idx];
                    return sum + (typeof v === "number" ? v : 0);
                }, 0);
                return `${totalLabel}: ${fmt(total)}`;
            },
        },
    };
}
