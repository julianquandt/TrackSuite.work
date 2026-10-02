// Reasons for off days. Stored as a short key (null = a plain off day); the
// labels and icons live here so both apps show the same thing.

export type OffDayReason = "vacation" | "sick" | "holiday" | "other";

export const OFF_DAY_REASONS: { key: OffDayReason | null; label: string; icon: string }[] = [
    { key: null, label: "Off day", icon: "" },
    { key: "vacation", label: "Vacation", icon: "☀" },
    { key: "sick", label: "Sick leave", icon: "✚" },
    { key: "holiday", label: "Public holiday", icon: "★" },
    { key: "other", label: "Other", icon: "◆" },
];

export function reasonInfo(key: string | null | undefined) {
    return OFF_DAY_REASONS.find((r) => r.key === (key ?? null)) ?? OFF_DAY_REASONS[0];
}

/** "3 vacation · 1 sick leave" for the off days in a list (plain ones counted as "off"). */
export function summarizeReasons(reasons: (string | null | undefined)[]): string {
    const counts = new Map<string, number>();
    for (const r of reasons) {
        const label = r ? reasonInfo(r).label.toLowerCase() : "off";
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, n]) => `${n} ${label}`).join(" · ");
}
