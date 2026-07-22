import {
    getProfile,
    getToken,
    listOffDays,
    listProjects,
    listShifts,
    saveProfile,
    type OffDayItem,
    type ProfileCustomField,
    type ProjectItem,
    type ReportProfile,
    type ShiftItem,
} from "../api";
import { navigate } from "../router";
import { isFullMode } from "../mode";

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function csvCell(v: string): string {
    // Guard against CSV/formula injection and quote fields containing separators.
    let s = v ?? "";
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function shiftHours(s: ShiftItem): number {
    if (!s.end_time) return 0;
    const ms = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
    return ms > 0 ? ms / 3_600_000 : 0;
}

function fmtHours(h: number): string {
    return h.toFixed(2);
}

function signedHours(h: number): string {
    const rounded = Math.round(h * 100) / 100;
    return (rounded >= 0 ? "+" : "") + rounded.toFixed(2);
}

function fmtMoney(amount: number): string {
    return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function localDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type WorkSchedule = Record<(typeof SCHEDULE_KEYS)[number], number>;

// Mirrors the tracker's work-schedule store (localStorage "tracksuite.schedule")
// so the Timesheet style can compare worked hours against daily targets.
function loadWorkSchedule(): WorkSchedule {
    const fallback: WorkSchedule = { sun: 0, mon: 7.2, tue: 7.2, wed: 7.2, thu: 7.2, fri: 7.2, sat: 0 };
    try {
        const val = localStorage.getItem("tracksuite.schedule");
        if (!val) return fallback;
        const parsed = JSON.parse(val);
        const out = { ...fallback };
        for (const k of SCHEDULE_KEYS) {
            const n = parseFloat(parsed[k]);
            if (!Number.isNaN(n)) out[k] = n;
        }
        return out;
    } catch {
        return fallback;
    }
}

function targetHoursForDate(d: Date, s: WorkSchedule): number {
    return s[SCHEDULE_KEYS[d.getDay()]];
}

interface LineItem {
    date: string;
    startTime: string;
    endTime: string | null;
    projectName: string;
    projectUuid: string | null;
    note: string;
    hours: number;
    rate: number | null;
    currency: string;
    amount: number | null;
}

// A report line, either one shift (with work times) or a same-day/project pool.
interface DetailRow {
    date: string;
    times: string;
    projectName: string;
    note: string;
    hours: number;
    amount: number | null;
    currency: string;
}

function fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function renderReports(app: HTMLElement): void {
    if (!getToken()) {
        navigate("#/login");
        return;
    }
    // Reports are a Full-mode feature; bounce to the tracker in Simple mode.
    if (!isFullMode()) {
        navigate("#/tracker");
        return;
    }

    let profile: ReportProfile = {};
    let projects: ProjectItem[] = [];
    let shifts: ShiftItem[] = [];
    let offDaySet = new Set<string>();
    const schedule = loadWorkSchedule();

    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    app.innerHTML = `
        <div class="reports-page">
            <div class="dashboard-header">
                <h2>Reports</h2>
                <p>Generate a billable summary of your tracked time. Set your letterhead and per-project rates, pick a date range, then export as CSV or print to PDF.</p>
            </div>

            <details class="dash-section" id="profile-section">
                <summary class="reports-summary-toggle"><h3 style="display:inline;">Letterhead &amp; Profile</h3><span class="muted"> — appears at the top of printed reports</span></summary>
                <div class="reports-profile-grid">
                    <label>Your name<input type="text" id="pf-name" maxlength="120" placeholder="e.g. Alex Rivera" /></label>
                    <label>Company<input type="text" id="pf-company" maxlength="120" placeholder="ACME GmbH" /></label>
                    <label>Email<input type="text" id="pf-email" maxlength="160" placeholder="you@example.com" /></label>
                    <label>Default currency<input type="text" id="pf-currency" maxlength="8" placeholder="EUR" /></label>
                    <label class="span2">Address<textarea id="pf-address" rows="2" placeholder="Street 1&#10;12345 City"></textarea></label>
                    <label class="span2">Letterhead / header note<textarea id="pf-header" rows="2" placeholder="Invoice — freelance software work"></textarea></label>
                    <label class="span2">Footer<textarea id="pf-footer" rows="2" placeholder="Bank: … · IBAN: …"></textarea></label>
                </div>
                <div class="reports-custom-fields">
                    <h4>Custom fields</h4>
                    <p class="muted">Extra key/value lines for the letterhead (e.g. VAT ID, tax number).</p>
                    <div id="pf-custom-list"></div>
                    <button class="btn btn-outline btn-small" type="button" id="pf-add-field">+ Add field</button>
                </div>
                <div class="btn-row" style="margin-top:16px;">
                    <button class="btn btn-primary" type="button" id="pf-save">Save profile</button>
                    <span class="muted" id="pf-status"></span>
                </div>
            </details>

            <section class="dash-section no-print">
                <h3>Generate report</h3>
                <p class="muted" style="margin-top:-4px;">Hourly rates are set per project — open the project menu on the Tracker and choose <strong>Manage projects</strong>.</p>
                <div class="reports-filter-grid">
                    <label>Style<select id="rp-style">
                        <option value="client">Client report (hours × rate)</option>
                        <option value="timesheet">Timesheet (hours vs target)</option>
                    </select></label>
                    <label>From<input type="date" id="rp-from" value="${localDateKey(firstOfMonth)}" /></label>
                    <label>To<input type="date" id="rp-to" value="${localDateKey(today)}" /></label>
                    <label>Project<select id="rp-project"><option value="">All projects</option></select></label>
                    <label class="reports-check" id="rp-detailed-wrap"><input type="checkbox" id="rp-detailed" checked /> Itemized breakdown</label>
                    <label class="reports-check" id="rp-times-wrap"><input type="checkbox" id="rp-times" /> Show work times (don't pool same day)</label>
                </div>
                <div class="btn-row" style="margin-top:12px;">
                    <button class="btn btn-primary" type="button" id="rp-generate">Generate</button>
                    <button class="btn btn-outline" type="button" id="rp-csv">Export CSV</button>
                    <button class="btn btn-outline" type="button" id="rp-print">Print / Save as PDF</button>
                </div>
            </section>

            <section class="report-output" id="report-output" hidden></section>
        </div>
    `;

    // ── Profile editor ───────────────────────────────────────────────
    const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const customListEl = $("pf-custom-list");

    function renderCustomFields(fields: ProfileCustomField[]) {
        customListEl.innerHTML = fields.map((f, i) => `
            <div class="pf-custom-row" data-i="${i}">
                <input type="text" class="pf-cf-label" value="${escapeHtml(f.label)}" placeholder="Label (e.g. VAT ID)" maxlength="60" />
                <input type="text" class="pf-cf-value" value="${escapeHtml(f.value)}" placeholder="Value" maxlength="120" />
                <button class="btn-icon pf-cf-remove" type="button" title="Remove">&times;</button>
            </div>
        `).join("");
        customListEl.querySelectorAll<HTMLButtonElement>(".pf-cf-remove").forEach(btn => {
            btn.addEventListener("click", () => {
                const row = btn.closest(".pf-custom-row") as HTMLElement;
                row.remove();
            });
        });
    }

    function collectCustomFields(): ProfileCustomField[] {
        return Array.from(customListEl.querySelectorAll<HTMLElement>(".pf-custom-row"))
            .map(row => ({
                label: (row.querySelector(".pf-cf-label") as HTMLInputElement).value.trim(),
                value: (row.querySelector(".pf-cf-value") as HTMLInputElement).value.trim(),
            }))
            .filter(f => f.label !== "" || f.value !== "");
    }

    function fillProfileForm() {
        ($("pf-name") as HTMLInputElement).value = profile.name ?? "";
        ($("pf-company") as HTMLInputElement).value = profile.company ?? "";
        ($("pf-email") as HTMLInputElement).value = profile.email ?? "";
        ($("pf-currency") as HTMLInputElement).value = profile.default_currency ?? "";
        ($("pf-address") as HTMLTextAreaElement).value = profile.address ?? "";
        ($("pf-header") as HTMLTextAreaElement).value = profile.letter_header ?? "";
        ($("pf-footer") as HTMLTextAreaElement).value = profile.footer ?? "";
        renderCustomFields(profile.custom_fields ?? []);
    }

    function readProfileForm(): ReportProfile {
        return {
            name: ($("pf-name") as HTMLInputElement).value.trim(),
            company: ($("pf-company") as HTMLInputElement).value.trim(),
            email: ($("pf-email") as HTMLInputElement).value.trim(),
            default_currency: ($("pf-currency") as HTMLInputElement).value.trim().toUpperCase(),
            address: ($("pf-address") as HTMLTextAreaElement).value.trim(),
            letter_header: ($("pf-header") as HTMLTextAreaElement).value.trim(),
            footer: ($("pf-footer") as HTMLTextAreaElement).value.trim(),
            custom_fields: collectCustomFields(),
        };
    }

    $("pf-add-field").addEventListener("click", () => {
        const fields = collectCustomFields();
        fields.push({ label: "", value: "" });
        renderCustomFields(fields);
    });

    $("pf-save").addEventListener("click", async () => {
        const status = $("pf-status");
        const btn = $("pf-save") as HTMLButtonElement;
        btn.disabled = true;
        status.textContent = "Saving…";
        profile = readProfileForm();
        const res = await saveProfile(profile);
        btn.disabled = false;
        if (res.ok) {
            status.textContent = "Saved.";
            setTimeout(() => (status.textContent = ""), 2500);
        } else {
            status.textContent = "Failed to save (server error).";
        }
    });

    // ── Report generation ────────────────────────────────────────────
    function projectByUuid(uuid: string | null): ProjectItem | undefined {
        if (!uuid) return undefined;
        return projects.find(p => p.uuid === uuid);
    }

    function buildLineItems(): LineItem[] {
        const fromMs = new Date(($("rp-from") as HTMLInputElement).value + "T00:00:00").getTime();
        const toMs = new Date(($("rp-to") as HTMLInputElement).value + "T23:59:59.999").getTime();
        const projFilter = ($("rp-project") as HTMLSelectElement).value || null;
        const defaultCurrency = (profile.default_currency ?? "").toUpperCase();

        return shifts
            .filter(s => s.end_time !== null)
            .filter(s => {
                const startMs = new Date(s.start_time).getTime();
                return startMs >= fromMs && startMs <= toMs;
            })
            .filter(s => (projFilter ? (s.project_uuid ?? null) === projFilter : true))
            .sort((a, b) => a.start_time.localeCompare(b.start_time))
            .map(s => {
                const proj = projectByUuid(s.project_uuid ?? null);
                const hours = shiftHours(s);
                const rate = proj && proj.rate != null && proj.rate !== "" ? parseFloat(proj.rate) : null;
                const currency = (proj?.currency && proj.currency !== "" ? proj.currency : defaultCurrency).toUpperCase();
                const amount = rate != null && !Number.isNaN(rate) ? hours * rate : null;
                return {
                    date: localDateKey(new Date(s.start_time)),
                    startTime: s.start_time,
                    endTime: s.end_time,
                    projectName: proj?.name ?? "Unassigned",
                    projectUuid: s.project_uuid ?? null,
                    note: s.note ?? "",
                    hours,
                    rate: rate != null && Number.isNaN(rate) ? null : rate,
                    currency,
                    amount,
                };
            });
    }

    // Detail lines for the client report: one row per shift (with work times)
    // when `withTimes`, otherwise same day + project pooled into a single row
    // (hours/amount summed, distinct notes joined).
    function buildDetailRows(withTimes: boolean): DetailRow[] {
        const items = buildLineItems();
        if (withTimes) {
            return items.map(it => ({
                date: it.date,
                times: it.endTime ? `${fmtTime(it.startTime)}–${fmtTime(it.endTime)}` : fmtTime(it.startTime),
                projectName: it.projectName,
                note: it.note,
                hours: it.hours,
                amount: it.amount,
                currency: it.currency,
            }));
        }
        const pooled = new Map<string, DetailRow & { notes: Set<string> }>();
        for (const it of items) {
            const key = it.date + "|" + (it.projectUuid ?? "unassigned") + "|" + it.currency;
            let row = pooled.get(key);
            if (!row) {
                row = { date: it.date, times: "", projectName: it.projectName, note: "", hours: 0, amount: it.amount != null ? 0 : null, currency: it.currency, notes: new Set() };
                pooled.set(key, row);
            }
            row.hours += it.hours;
            if (it.amount != null) row.amount = (row.amount ?? 0) + it.amount;
            if (it.note.trim()) row.notes.add(it.note.trim());
        }
        return Array.from(pooled.values()).map(r => ({
            date: r.date, times: r.times, projectName: r.projectName,
            note: Array.from(r.notes).join("; "), hours: r.hours, amount: r.amount, currency: r.currency,
        }));
    }

    function currentStyle(): string {
        return ($("rp-style") as HTMLSelectElement).value;
    }

    function renderReport() {
        // The "Itemized" + "work times" toggles only apply to the client report;
        // "work times" only matters when the itemized breakdown is shown.
        const isClient = currentStyle() === "client";
        ($("rp-detailed-wrap") as HTMLElement).style.display = isClient ? "" : "none";
        ($("rp-times-wrap") as HTMLElement).style.display =
            isClient && ($("rp-detailed") as HTMLInputElement).checked ? "" : "none";
        if (currentStyle() === "timesheet") {
            renderTimesheet();
        } else {
            renderClientReport();
        }
        $("report-output").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderClientReport() {
        const detailed = ($("rp-detailed") as HTMLInputElement).checked;
        const items = buildLineItems();
        const out = $("report-output");
        out.hidden = false;

        const fromV = ($("rp-from") as HTMLInputElement).value;
        const toV = ($("rp-to") as HTMLInputElement).value;

        // Group by project for the summary.
        const groups = new Map<string, { name: string; hours: number; rate: number | null; currency: string; amount: number | null }>();
        for (const it of items) {
            const key = (it.projectUuid ?? "unassigned") + "|" + it.currency;
            const g = groups.get(key);
            if (g) {
                g.hours += it.hours;
                if (it.amount != null) g.amount = (g.amount ?? 0) + it.amount;
            } else {
                groups.set(key, { name: it.projectName, hours: it.hours, rate: it.rate, currency: it.currency, amount: it.amount });
            }
        }

        // Totals per currency.
        const totalsByCurrency = new Map<string, number>();
        for (const it of items) {
            if (it.amount != null) {
                totalsByCurrency.set(it.currency, (totalsByCurrency.get(it.currency) ?? 0) + it.amount);
            }
        }
        const totalHours = items.reduce((sum, it) => sum + it.hours, 0);

        const letterhead = renderLetterhead(profile, fromV, toV);

        const summaryRows = Array.from(groups.values()).map(g => `
            <tr>
                <td>${escapeHtml(g.name)}</td>
                <td class="num">${fmtHours(g.hours)}</td>
                <td class="num">${g.rate != null ? fmtMoney(g.rate) + " " + escapeHtml(g.currency) : "—"}</td>
                <td class="num">${g.amount != null ? fmtMoney(g.amount) + " " + escapeHtml(g.currency) : "—"}</td>
            </tr>
        `).join("");

        const totalsRows = Array.from(totalsByCurrency.entries()).map(([cur, amt]) => `
            <tr class="report-total-row">
                <td colspan="3" class="num"><strong>Total (${escapeHtml(cur || "—")})</strong></td>
                <td class="num"><strong>${fmtMoney(amt)} ${escapeHtml(cur)}</strong></td>
            </tr>
        `).join("");

        const withTimes = ($("rp-times") as HTMLInputElement).checked;
        const detailRows = detailed ? buildDetailRows(withTimes) : [];
        const detailTable = detailed ? `
            <h4 class="report-h">Itemized entries</h4>
            <table class="report-table">
                <thead><tr><th>Date</th>${withTimes ? "<th>Time</th>" : ""}<th>Project</th><th>Note</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead>
                <tbody>
                    ${detailRows.map(r => `
                        <tr>
                            <td>${escapeHtml(r.date)}</td>
                            ${withTimes ? `<td>${escapeHtml(r.times)}</td>` : ""}
                            <td>${escapeHtml(r.projectName)}</td>
                            <td>${escapeHtml(r.note)}</td>
                            <td class="num">${fmtHours(r.hours)}</td>
                            <td class="num">${r.amount != null ? fmtMoney(r.amount) + " " + escapeHtml(r.currency) : "—"}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        ` : "";

        out.innerHTML = `
            ${letterhead}
            ${items.length === 0 ? `<p class="muted">No completed shifts in this range.</p>` : `
            <h4 class="report-h">Summary by project</h4>
            <table class="report-table">
                <thead><tr><th>Project</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
                <tbody>
                    ${summaryRows}
                    <tr class="report-total-row"><td class="num"><strong>Total hours</strong></td><td class="num"><strong>${fmtHours(totalHours)}</strong></td><td></td><td></td></tr>
                    ${totalsRows}
                </tbody>
            </table>
            ${detailTable}
            `}
            ${profile.footer ? `<div class="report-footer">${escapeHtml(profile.footer).replace(/\n/g, "<br>")}</div>` : ""}
        `;
    }

    interface TimesheetRow { date: string; weekday: string; worked: number; target: number; diff: number; }

    // Per-day worked-vs-target rows for the selected range (respects the
    // project filter). Off-days count as a 0h target (holiday).
    function buildTimesheet(): TimesheetRow[] {
        const fromV = ($("rp-from") as HTMLInputElement).value;
        const toV = ($("rp-to") as HTMLInputElement).value;
        const projFilter = ($("rp-project") as HTMLSelectElement).value || null;

        const workedByDay = new Map<string, number>();
        for (const s of shifts) {
            if (!s.end_time) continue;
            if (projFilter && (s.project_uuid ?? null) !== projFilter) continue;
            const key = localDateKey(new Date(s.start_time));
            workedByDay.set(key, (workedByDay.get(key) ?? 0) + shiftHours(s));
        }

        const rows: TimesheetRow[] = [];
        const cursor = new Date(fromV + "T00:00:00");
        const end = new Date(toV + "T00:00:00");
        while (cursor.getTime() <= end.getTime()) {
            const key = localDateKey(cursor);
            const worked = workedByDay.get(key) ?? 0;
            const target = offDaySet.has(key) ? 0 : targetHoursForDate(cursor, schedule);
            if (worked > 0 || target > 0) {
                rows.push({ date: key, weekday: WEEKDAY_NAMES[cursor.getDay()], worked, target, diff: worked - target });
            }
            cursor.setDate(cursor.getDate() + 1);
        }
        return rows;
    }

    function renderTimesheet() {
        const rows = buildTimesheet();
        const out = $("report-output");
        out.hidden = false;
        const fromV = ($("rp-from") as HTMLInputElement).value;
        const toV = ($("rp-to") as HTMLInputElement).value;

        const totalWorked = rows.reduce((s, r) => s + r.worked, 0);
        const totalTarget = rows.reduce((s, r) => s + r.target, 0);
        const totalDiff = totalWorked - totalTarget;

        const bodyRows = rows.map(r => `
            <tr>
                <td>${escapeHtml(r.date)}</td>
                <td>${escapeHtml(r.weekday)}</td>
                <td class="num">${fmtHours(r.worked)}</td>
                <td class="num">${fmtHours(r.target)}</td>
                <td class="num">${signedHours(r.diff)}</td>
            </tr>
        `).join("");

        out.innerHTML = `
            ${renderLetterhead(profile, fromV, toV)}
            ${rows.length === 0 ? `<p class="muted">No working days in this range.</p>` : `
            <h4 class="report-h">Timesheet</h4>
            <table class="report-table">
                <thead><tr><th>Date</th><th>Day</th><th class="num">Worked</th><th class="num">Target</th><th class="num">+/−</th></tr></thead>
                <tbody>
                    ${bodyRows}
                    <tr class="report-total-row">
                        <td colspan="2"><strong>Total</strong></td>
                        <td class="num"><strong>${fmtHours(totalWorked)}</strong></td>
                        <td class="num"><strong>${fmtHours(totalTarget)}</strong></td>
                        <td class="num"><strong>${signedHours(totalDiff)}</strong></td>
                    </tr>
                </tbody>
            </table>
            `}
            ${profile.footer ? `<div class="report-footer">${escapeHtml(profile.footer).replace(/\n/g, "<br>")}</div>` : ""}
        `;
    }

    function renderLetterhead(p: ReportProfile, from: string, to: string): string {
        const custom = (p.custom_fields ?? []).filter(f => f.label || f.value);
        return `
            <div class="report-letterhead">
                <div class="report-sender">
                    ${p.name ? `<div class="report-name">${escapeHtml(p.name)}</div>` : ""}
                    ${p.company ? `<div>${escapeHtml(p.company)}</div>` : ""}
                    ${p.address ? `<div class="report-addr">${escapeHtml(p.address).replace(/\n/g, "<br>")}</div>` : ""}
                    ${p.email ? `<div>${escapeHtml(p.email)}</div>` : ""}
                    ${custom.map(f => `<div class="report-cf"><span>${escapeHtml(f.label)}:</span> ${escapeHtml(f.value)}</div>`).join("")}
                </div>
                <div class="report-meta">
                    ${p.letter_header ? `<div class="report-title">${escapeHtml(p.letter_header)}</div>` : `<div class="report-title">Time report</div>`}
                    <div class="muted">${escapeHtml(from)} — ${escapeHtml(to)}</div>
                    <div class="muted">Generated ${escapeHtml(localDateKey(new Date()))}</div>
                </div>
            </div>
        `;
    }

    function downloadCsv(header: string[], rows: string[][]) {
        const csv = [header, ...rows].map(r => r.map(c => csvCell(String(c))).join(",")).join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const kind = currentStyle() === "timesheet" ? "timesheet" : "report";
        a.download = `${kind}_${($("rp-from") as HTMLInputElement).value}_${($("rp-to") as HTMLInputElement).value}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportCsv() {
        if (currentStyle() === "timesheet") {
            const rows = buildTimesheet();
            if (rows.length === 0) { alert("No working days in this range to export."); return; }
            downloadCsv(
                ["Date", "Day", "Worked", "Target", "Difference"],
                rows.map(r => [r.date, r.weekday, fmtHours(r.worked), fmtHours(r.target), signedHours(r.diff)]),
            );
            return;
        }
        const withTimes = ($("rp-times") as HTMLInputElement).checked;
        const rows = buildDetailRows(withTimes);
        if (rows.length === 0) { alert("No completed shifts in this range to export."); return; }
        const header = withTimes
            ? ["Date", "Time", "Project", "Note", "Hours", "Currency", "Amount"]
            : ["Date", "Project", "Note", "Hours", "Currency", "Amount"];
        downloadCsv(
            header,
            rows.map(r => {
                const base = [r.date];
                if (withTimes) base.push(r.times);
                base.push(r.projectName, r.note, fmtHours(r.hours), r.currency, r.amount != null ? r.amount.toFixed(2) : "");
                return base;
            }),
        );
    }

    $("rp-generate").addEventListener("click", renderReport);
    $("rp-style").addEventListener("change", renderReport);
    $("rp-detailed").addEventListener("change", renderReport);
    $("rp-times").addEventListener("change", renderReport);
    $("rp-csv").addEventListener("click", exportCsv);
    $("rp-print").addEventListener("click", () => {
        if ($("report-output").hidden) renderReport();
        window.print();
    });

    // ── Initial data load ────────────────────────────────────────────
    (async () => {
        const [profileRes, projectsRes, shiftsRes, offDaysRes] = await Promise.all([
            getProfile(),
            listProjects(),
            listShifts(),
            listOffDays(),
        ]);
        if (profileRes.ok && profileRes.data.profile) profile = profileRes.data.profile;
        if (projectsRes.ok) projects = projectsRes.data;
        if (shiftsRes.ok) shifts = shiftsRes.data;
        if (offDaysRes.ok) offDaySet = new Set((offDaysRes.data as OffDayItem[]).map(o => o.date));

        fillProfileForm();

        const sel = $("rp-project") as HTMLSelectElement;
        for (const p of projects.filter(p => !p.archived)) {
            const opt = document.createElement("option");
            opt.value = p.uuid ?? "";
            opt.textContent = p.name;
            sel.appendChild(opt);
        }

        renderReport();
    })();
}
