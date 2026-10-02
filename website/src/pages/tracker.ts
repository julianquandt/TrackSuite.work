import Chart from "chart.js/auto";
import { escapeHtml, csvCell } from "../../../shared/text.ts";
import {
    getToken,
    listShifts,
    createShift,
    updateShift,
    deleteShift,
    listOffDays,
    createOffDay,
    deleteOffDay,
    updateOffDay,
    listProjects,
    createProject,
    updateProject,
    deleteProject,
    getRemoteSchedule,
    saveRemoteSchedule,
    type ShiftItem,
    type OffDayItem,
    type ProjectItem
} from "../api";
import { navigate } from "../router";
import { getThemePreference, setThemePreference } from "../nav";
import { getMode, setMode, isFullMode } from "../mode";
import {
    addDays, bucketKey, bucketLabel, dayKeyOf, dayStart, endOfLastCompleteWeek, formatDuration, formatSigned,
    localDateKey, localIso, shiftHoursByDay, splitAcrossDays, startOfWeek, weekKey,
} from "../../../shared/time.ts";
import { buildProjectStackDatasets, stackedBarTopRadius, stackedTotalTooltip } from "../../../shared/charts.ts";
import { findGaps, planAssignRange, planCoalesce, overlapping, suggestManualShift, validateTimeEdits, type PlanShift } from "../../../shared/shifts.ts";
import { createTimeline, type TimelineHandle } from "../../../shared/ui/timeline.ts";
import { showToast } from "../../../shared/ui/toast.ts";
import { pushUndo } from "../../../shared/ui/undo.ts";
import { showOffDayMenu } from "../../../shared/ui/menu.ts";
import { reasonInfo, summarizeReasons } from "../../../shared/offdays.ts";
import { createFocusRing, renderFocusSettings } from "../../../shared/ui/focus.ts";
import { renderPresets } from "../../../shared/ui/presets.ts";
import { mountReports } from "./reports";
import { enhanceSelects } from "../../../shared/ui/select.ts";
import "../../../shared/ui/ui.css";

// ── Project helpers (module-level, pure) ─────────────────────────────
const PROJECT_PALETTE = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
];
const UNASSIGNED_FALLBACK = "#94a3b8";
const CURRENT_PROJECT_KEY = "tracksuite.currentProject";

function unassignedColor(): string {
    return getComputedStyle(document.documentElement)
        .getPropertyValue("--project-unassigned").trim() || UNASSIGNED_FALLBACK;
}

/** Readable text color for a given #rrggbb background. */
function contrastText(color: string): string {
    const m = /#?([0-9a-f]{6})/i.exec(color.trim());
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#1f2937" : "#ffffff";
}


// ── Types ────────────────────────────────────────────────────────────
interface WorkSchedule {
    mon: number;
    tue: number;
    wed: number;
    thu: number;
    fri: number;
    sat: number;
    sun: number;
}

const DEFAULT_SCHEDULE: WorkSchedule = {
    mon: 7.2,
    tue: 7.2,
    wed: 7.2,
    thu: 7.2,
    fri: 7.2,
    sat: 0.0,
    sun: 0.0
};

// ── Local Storage Settings Helpers ───────────────────────────────────
function loadWorkSchedule(): WorkSchedule {
    try {
        const val = localStorage.getItem("tracksuite.schedule");
        if (val) {
            const parsed = JSON.parse(val);
            return {
                mon: parseFloat(parsed.mon ?? 7.2),
                tue: parseFloat(parsed.tue ?? 7.2),
                wed: parseFloat(parsed.wed ?? 7.2),
                thu: parseFloat(parsed.thu ?? 7.2),
                fri: parseFloat(parsed.fri ?? 7.2),
                sat: parseFloat(parsed.sat ?? 0.0),
                sun: parseFloat(parsed.sun ?? 0.0)
            };
        }
    } catch (e) {
        console.warn("Failed to load work schedule", e);
    }
    return { ...DEFAULT_SCHEDULE };
}

function saveWorkSchedule(s: WorkSchedule) {
    localStorage.setItem("tracksuite.schedule", JSON.stringify(s));
}

// ── Time & Date Helpers ──────────────────────────────────────────────
function shiftDurationHours(s: ShiftItem): number {
    const start = new Date(s.start_time).getTime();
    const end = s.end_time ? new Date(s.end_time).getTime() : Date.now();
    return (end - start) / 3_600_000;
}

// Shift timestamps are written as naive local wall clock via localIso() (see
// shared/time.ts) — never toISOString(), which emits UTC "Z" and produced
// mixed-frame shifts that 500'd /stats/daily-hours/. Every write re-encodes the
// start too (localIso(new Date(start))), so a legacy "Z" start never ends up
// paired with a local end on the same row.

function getTargetHoursForDate(d: Date, s: WorkSchedule): number {
    const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    if (day === 0) return s.sun;
    if (day === 1) return s.mon;
    if (day === 2) return s.tue;
    if (day === 3) return s.wed;
    if (day === 4) return s.thu;
    if (day === 5) return s.fri;
    return s.sat;
}

function dateInputToLocalDate(dateText: string): Date {
    return new Date(`${dateText}T00:00:00`);
}

function normalizeDateInputValue(dateText: string): string | null {
    const trimmed = dateText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
    const parsed = dateInputToLocalDate(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return localDateKey(parsed) === trimmed ? trimmed : null;
}

function normalizeTimeInputValue(timeText: string): string | null {
    const trimmed = timeText.trim();
    const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}



// ── PWA Install Prompt Listener ──────────────────────────────────────
let deferredPrompt: any = null;
window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById("btn-install-pwa-container");
    if (btn) btn.style.display = "block";
});

// ── Render Page ──────────────────────────────────────────────────────
let activeTimerId: number | null = null;
let weeklyChartInstance: Chart | null = null;
let trendChartInstance: Chart | null = null;

// The SPA router re-runs renderTracker on every navigation, so document/window
// listeners are installed once and delegate to the current instance's handlers.
let globalTrackerListenersInstalled = false;
let activeKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let activePointerMove: ((e: MouseEvent | TouchEvent) => void) | null = null;
let activePointerUp: (() => void) | null = null;
let activeDocClick: ((e: MouseEvent) => void) | null = null;

/** Chart axis/grid colours from the current theme's CSS variables. */
function chartThemeColors(): { text: string; grid: string } {
    const css = getComputedStyle(document.documentElement);
    return {
        text: css.getPropertyValue("--text-secondary").trim() || "#4b5563",
        grid: css.getPropertyValue("--border-subtle").trim() || "#e5e7eb",
    };
}

export function renderTracker(app: HTMLElement): (() => void) | void {
    if (!getToken()) {
        navigate("#/login");
        return;
    }

    if (!globalTrackerListenersInstalled) {
        globalTrackerListenersInstalled = true;
        document.addEventListener("keydown", (e) => activeKeydownHandler?.(e));
        document.addEventListener("click", (e) => activeDocClick?.(e));
        window.addEventListener("mousemove", (e) => activePointerMove?.(e));
        window.addEventListener("touchmove", (e) => activePointerMove?.(e), { passive: false });
        window.addEventListener("mouseup", () => activePointerUp?.());
        window.addEventListener("touchend", () => activePointerUp?.());
    }

    app.innerHTML = `
        <div class="dashboard">
            <p id="offline-banner" class="offline-banner" role="status" hidden></p>

            <!-- Same layout as the desktop app: tabs, project, focus timer and
                 clock in one bar that stays at the top while the page scrolls. -->
            <div class="tracker-bar">
                <div class="tabs-nav">
                    <button class="tab-link active" data-target="dashboard">Dashboard</button>
                    <button class="tab-link" data-target="statistics">Statistics</button>
                    ${isFullMode() ? `<button class="tab-link" data-target="reports">Reports</button>` : ""}
                    <button class="tab-link" data-target="settings">Settings</button>
                </div>
                <div class="tracker-actions">
                    <div class="project-chip-wrap" id="project-chip-wrap"></div>
                    <span id="focus-wrap" class="focus-wrap"></span>
                    <button class="btn btn-primary" id="btn-clock-action" type="button">Clock In</button>
                </div>
            </div>

            <!-- ═══ Tab: Dashboard ═══ -->
            <div class="tab-page" id="tab-dashboard">
                <!-- Stats Grid -->
                <div class="stats-grid">
                    <div class="stat-card" id="card-today">
                        <h4>Today</h4>
                        <div class="stat-value" id="hours-today">0h</div>
                        <p class="stat-sub" id="today-sub"></p>
                    </div>
                    <div class="stat-card" id="card-week">
                        <h4>This week</h4>
                        <div class="stat-value" id="hours-week">0h</div>
                    </div>
                    <div class="stat-card" id="card-status">
                        <h4>Status</h4>
                        <div class="stat-value" id="clock-status">Idle</div>
                        <input type="text" id="running-note" class="running-note" maxlength="500" placeholder="What are you working on?" autocomplete="off" hidden>
                    </div>
                </div>

                <!-- Auto-closed shift notice (shifts left running, closed by the server) -->
                <div id="auto-closed-banner" class="auto-closed-banner" hidden></div>

                <!-- Performance Chart -->
                <div class="chart-panel">
                    <div class="section-row week-head">
                        <h3>This week</h3>
                        <span class="muted" id="week-target-text">Target: 36h</span>
                    </div>
                    <div class="progress-wrap">
                        <div class="progress-bar" id="week-bar" style="width: 0%;"></div>
                    </div>
                    <div style="position: relative; height: 260px; width: 100%;">
                        <canvas id="weekly-chart"></canvas>
                    </div>
                </div>

                <!-- Day timeline (shared/ui/timeline.ts) -->
                <div class="chart-panel" id="timeline-editor-panel">
                    <div class="panel-title-row">
                        <h3>Day</h3>
                        <button type="button" class="btn btn-outline btn-small" id="btn-back-to-stats" hidden>← Back to Statistics</button>
                    </div>
                    <div id="timeline-root"></div>
                </div>

                <!-- Shifts History Section -->
                <section class="dash-section">
                    <div class="section-row" style="display:flex; justify-content:space-between; align-items:center;">
                        <h3>Recent shifts</h3>
                        <div class="btn-row">
                            <button class="btn btn-outline btn-small" id="btn-add-manual" type="button">+ Add shift</button>
                            <button class="btn btn-outline btn-small" id="btn-jump-offdays" type="button" title="Jump to the off-days calendar">Off days ↓</button>
                        </div>
                    </div>
                    <div class="table-wrapper">
                        <table class="sessions-table">
                            <thead>
                                <tr>
                                    <th>Start</th>
                                    <th>End</th>
                                    <th>Duration</th>
                                    <th>Project</th>
                                    <th>Note</th>
                                    <th style="text-align: right;">Action</th>
                                </tr>
                            </thead>
                            <tbody id="shift-table-body">
                                <tr>
                                    <td colspan="6" class="muted" style="text-align:center; padding: 24px;">Loading shift history…</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <!-- Scheduled off days: monthly calendar (drag to paint) -->
                <section class="dash-section" id="offday-calendar-panel">
                    <div class="section-row" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <h3>Scheduled Off Days</h3>
                        <div class="offcal-nav">
                            <button type="button" class="btn btn-outline btn-small" id="offcal-prev" aria-label="Previous month">‹</button>
                            <span class="offcal-title" id="offcal-title"></span>
                            <button type="button" class="btn btn-outline btn-small" id="offcal-next" aria-label="Next month">›</button>
                        </div>
                    </div>
                    <div class="calendar-days-header" style="display:grid; grid-template-columns:repeat(7, 1fr); text-align:center; font-weight:700; font-size:0.7rem; color:var(--text-secondary); margin-bottom:8px; text-transform:uppercase; letter-spacing:0.05em;">
                        <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
                    </div>
                    <div class="calendar-grid" id="offcal-grid" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:6px;"></div>
                    <p class="muted offcal-hint">Drag across days to mark them as off days — drag over existing off days to clear them. Right-click a day to give it a reason (vacation, sick leave, …).</p>
                </section>
            </div>

            <!-- ═══ Tab: Statistics ═══ -->
            <div class="tab-page tab-hidden" id="tab-statistics">
                <!-- Stats Grid -->
                <div class="stats-grid">
                    <div class="stat-card">
                        <h4>Avg Daily</h4>
                        <div class="stat-value" id="avg-daily">0h</div>
                    </div>
                    <div class="stat-card">
                        <h4>Avg Weekly</h4>
                        <div class="stat-value" id="avg-weekly">0h</div>
                    </div>
                    <div class="stat-card" id="overtime-card">
                        <h4>Overtime</h4>
                        <div class="stat-value" id="overtime-val">0h</div>
                    </div>
                </div>

                <!-- Averages Controls -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Averages</h2>
                    </div>
                    <div id="avg-presets"></div>
                    <details class="ui-custom">
                    <summary>Custom range</summary>
                    <div class="control-row">
                        <label class="ctrl">Period
                            <select id="stats-unit">
                                <option value="days">Days</option>
                                <option value="weeks" selected>Weeks</option>
                                <option value="months">Months</option>
                                <option value="ytd">Year to date</option>
                            </select>
                        </label>
                        <label class="ctrl" id="stats-count-wrap">Count
                            <input type="number" id="stats-count" value="4" min="1" max="365">
                        </label>
                    </div>
                    </details>
                    <div class="control-row">
                        <label class="ctrl toggle-label">
                            <input type="checkbox" id="stats-holidays">
                            <span>Credit expected hours on scheduled off-days</span>
                        </label>
                    </div>
                    <div class="avg-detail" id="avg-detail"></div>
                </section>

                <!-- Trends Chart -->
                <div class="chart-panel">
                        <h3>Trends</h3>
                        <div id="trend-presets"></div>
                        <details class="ui-custom">
                            <summary>Custom range</summary>
                            <div class="control-row" style="gap:8px;">
                                <label class="ctrl">Show last
                                    <input type="number" id="trend-count" value="7" min="1" max="365" style="width:80px;">
                                </label>
                                <label class="ctrl">Unit
                                    <select id="trend-unit">
                                        <option value="days" selected>Days</option>
                                        <option value="weeks">Weeks</option>
                                        <option value="months">Months</option>
                                    </select>
                                </label>
                                <label class="ctrl">Group by
                                    <select id="trend-granularity">
                                        <option value="day" selected>Day</option>
                                        <option value="week">Week</option>
                                        <option value="month">Month</option>
                                    </select>
                                </label>
                            </div>
                        </details>
                        <div style="position: relative; height: 260px; width: 100%;">
                            <canvas id="trend-chart"></canvas>
                        </div>
                        <p class="trend-hint muted">Click a day to open it — week and month bars zoom in first.</p>
                        <div class="project-summary" id="project-summary"></div>
                </div>

                <!-- Zoomed trend view: breadcrumbs back out -->
                <div id="trend-drill-panel" class="trend-drill-panel" hidden>
                    <div class="trend-drill-head">
                        <div class="trend-drill-crumbs" id="trend-drill-crumbs"></div>
                        <button type="button" class="btn btn-outline trend-drill-close" id="trend-drill-close">Close</button>
                    </div>
                </div>

            </div>

            <!-- ═══ Tab: Reports (Full mode; filled when opened) ═══ -->
            <div class="tab-page tab-hidden" id="tab-reports"></div>

            <!-- ═══ Tab: Settings ═══ -->
            <div class="tab-page tab-hidden" id="tab-settings">
                <!-- App Mode -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Mode</h2>
                        <p class="muted"><strong>Simple</strong> keeps the app focused on tracking. <strong>Full</strong> adds billing rates, a report letterhead, and the Reports page. Shift notes are available in both.</p>
                    </div>
                    <div class="control-row">
                        <label class="ctrl">App Mode
                            <select id="cfg-mode-select">
                                <option value="simple">Simple</option>
                                <option value="full">Full (reports &amp; billing)</option>
                            </select>
                        </label>
                    </div>
                </section>

                <!-- Work Schedule settings -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Work schedule</h2>
                        <p class="muted">Set the target hours for each workday. Set non-working days (e.g. Sat/Sun) to 0.0.</p>
                    </div>
                    <div class="schedule-hours-grid">
                        <label class="schedule-hour-row"><span>Monday</span><input type="number" id="cfg-hours-mon" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Tuesday</span><input type="number" id="cfg-hours-tue" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Wednesday</span><input type="number" id="cfg-hours-wed" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Thursday</span><input type="number" id="cfg-hours-thu" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Friday</span><input type="number" id="cfg-hours-fri" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Saturday</span><input type="number" id="cfg-hours-sat" min="0" step="0.1" max="24" /></label>
                        <label class="schedule-hour-row"><span>Sunday</span><input type="number" id="cfg-hours-sun" min="0" step="0.1" max="24" /></label>
                    </div>
                    <p class="muted" id="schedule-status-text" role="status"></p>
                </section>

                <!-- Focus timer (shared/ui/focus.ts) -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Focus timer</h2>
                        <p class="muted">An optional timer for focus and breaks. It sits next to the clock button and never starts a round by itself.</p>
                    </div>
                    <div id="focus-settings"></div>
                </section>

                <!-- Your data -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Your data</h2>
                        <p class="muted">All your shifts (with project and note) and off days as a CSV file. The full account export (JSON) is on the Account page.</p>
                    </div>
                    <button class="btn btn-outline btn-small" id="btn-export-csv" type="button">Export CSV</button>
                </section>

                <!-- Appearance Panel -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Appearance</h2>
                    </div>
                    <div class="control-row">
                        <label class="ctrl">Theme
                            <select id="cfg-theme-select">
                                <option value="system">Same as system</option>
                                <option value="light">Light</option>
                                <option value="dark">Dark</option>
                            </select>
                        </label>
                    </div>
                </section>

                <!-- Custom PWA Install Panel -->
                <section class="panel" id="btn-install-pwa-container" style="display: none;">
                    <div class="panel-header">
                        <h2>Install Desktop App</h2>
                        <p class="muted">Install TrackSuite.work to your local system for offline launches and quick taskbar access.</p>
                    </div>
                    <button class="btn btn-primary" id="btn-install-pwa" type="button">Install Web App</button>
                </section>
            </div>
        </div>

        <!-- Add Shift Dialog -->
        <dialog id="dlg-shift" class="modal modal-wide">
            <form id="form-shift">
                <h3>Add Shift Manually</h3>
                <p class="modal-note">Enter dates in YYYY-MM-DD format and times as 24-hour HH:MM.</p>
                <div class="modal-error" id="shift-error" style="display:none;"></div>
                <div class="modal-grid">
                    <label>Start Date
                        <input type="text" id="inp-shift-start-date" placeholder="2026-07-11" required />
                    </label>
                    <label>Start Time
                        <input type="text" id="inp-shift-start-time" placeholder="09:00" required />
                    </label>
                    <label>End Date
                        <input type="text" id="inp-shift-end-date" placeholder="2026-07-11" required />
                    </label>
                    <label>End Time
                        <input type="text" id="inp-shift-end-time" placeholder="17:00" required />
                    </label>
                </div>
                <label style="display:block; margin-top: 12px;">Note (optional)
                    <input type="text" id="inp-shift-note" placeholder="What did you work on?" maxlength="500" />
                </label>
                <div class="btn-row modal-actions">
                    <button class="btn btn-primary" type="submit">Add Shift</button>
                    <button class="btn btn-ghost" type="button" id="btn-cancel-shift">Cancel</button>
                </div>
            </form>
        </dialog>

        <!-- Manage Projects Dialog -->
        <dialog id="dlg-projects" class="modal modal-wide">
            <h3>Manage Projects</h3>
            <p class="modal-note">Rename, recolor, or archive projects. Archived projects stay on past shifts but drop out of the picker.</p>
            <div id="projects-manage-list" class="projects-manage-list"></div>
            <form id="form-new-project" class="new-project-row">
                <input type="color" id="new-project-color" value="#3b82f6" title="Project color">
                <input type="text" id="new-project-name" placeholder="New project name" autocomplete="off" maxlength="60">
                <button class="btn btn-primary btn-small" type="submit">Add</button>
            </form>
            <div class="btn-row" style="margin-top:16px;">
                <button class="btn btn-outline" type="button" id="btn-close-projects">Done</button>
            </div>
        </dialog>
    `;

    // ── Wire DOM Controls ────────────────────────────────────────────
    const clockBtn = document.getElementById("btn-clock-action") as HTMLButtonElement;
    const addManualBtn = document.getElementById("btn-add-manual") as HTMLButtonElement;
    const runningNote = document.getElementById("running-note") as HTMLInputElement;
    const BASE_TITLE = document.title;

    const dlgShift = document.getElementById("dlg-shift") as HTMLDialogElement;
    const formShift = document.getElementById("form-shift") as HTMLFormElement;
    const btnCancelShift = document.getElementById("btn-cancel-shift") as HTMLButtonElement;

    const tabLinks = document.querySelectorAll(".tab-link");
    const tabPages = document.querySelectorAll(".tab-page");

    // Load schedule configurations
    let currentSchedule = loadWorkSchedule();

    // Fill Settings Input Values
    const fillScheduleInputs = () => {
        (document.getElementById("cfg-hours-mon") as HTMLInputElement).value = String(currentSchedule.mon);
        (document.getElementById("cfg-hours-tue") as HTMLInputElement).value = String(currentSchedule.tue);
        (document.getElementById("cfg-hours-wed") as HTMLInputElement).value = String(currentSchedule.wed);
        (document.getElementById("cfg-hours-thu") as HTMLInputElement).value = String(currentSchedule.thu);
        (document.getElementById("cfg-hours-fri") as HTMLInputElement).value = String(currentSchedule.fri);
        (document.getElementById("cfg-hours-sat") as HTMLInputElement).value = String(currentSchedule.sat);
        (document.getElementById("cfg-hours-sun") as HTMLInputElement).value = String(currentSchedule.sun);
    };
    fillScheduleInputs();

    // ── Work-schedule sync (server is the cross-device source of truth) ──
    // The schedule lived only in localStorage, so it differed per device (and
    // was lost on a storage reset). Now it round-trips through the server with
    // last-write-wins, keyed by a stored server timestamp.
    const SCHEDULE_TS_KEY = "tracksuite.schedule.updatedAt";

    /** Save locally and to the server; true when the server has it too. */
    async function persistSchedule(schedule: WorkSchedule): Promise<boolean> {
        saveWorkSchedule(schedule);
        currentSchedule = schedule;
        localStorage.setItem(SCHEDULE_TS_KEY, new Date().toISOString()); // provisional
        try {
            const resp = await saveRemoteSchedule(schedule as unknown as Record<string, number>);
            if (resp.ok && resp.data?.schedule_updated_at) {
                localStorage.setItem(SCHEDULE_TS_KEY, resp.data.schedule_updated_at);
            }
            return resp.ok;
        } catch {
            return false;
        }
    }

    // Reconcile local vs server on boot. Only push the local schedule if the user
    // actually saved one (a bare localStorage default must not clobber the server).
    async function reconcileSchedule() {
        const resp = await getRemoteSchedule();
        if (!resp.ok) return; // offline / unauthenticated: keep local
        const remote = resp.data;
        const localTs = localStorage.getItem(SCHEDULE_TS_KEY);
        const localExplicit = localStorage.getItem("tracksuite.schedule") !== null;
        if (remote?.schedule && remote.schedule_updated_at) {
            if (!localExplicit || !localTs || remote.schedule_updated_at > localTs) {
                saveWorkSchedule(remote.schedule as unknown as WorkSchedule);
                localStorage.setItem(SCHEDULE_TS_KEY, remote.schedule_updated_at);
                currentSchedule = loadWorkSchedule();
                fillScheduleInputs();
                void refreshData();
                return;
            }
        }
        if (localExplicit) {
            const put = await saveRemoteSchedule(currentSchedule as unknown as Record<string, number>);
            if (put.ok && put.data?.schedule_updated_at) {
                localStorage.setItem(SCHEDULE_TS_KEY, put.data.schedule_updated_at);
            }
        }
    }

    // Averages and trends triggers
    const statsUnitEl = document.getElementById("stats-unit") as HTMLSelectElement;
    const statsCountEl = document.getElementById("stats-count") as HTMLInputElement;
    const statsHolidaysEl = document.getElementById("stats-holidays") as HTMLInputElement;

    const trendCountEl = document.getElementById("trend-count") as HTMLInputElement;
    const trendUnitEl = document.getElementById("trend-unit") as HTMLSelectElement;
    const trendGranEl = document.getElementById("trend-granularity") as HTMLSelectElement;

    // One-click ranges; the selects stay under "Custom range".
    const highlightAvgPresets = renderPresets(document.getElementById("avg-presets")!, [
        { label: "Last 4 weeks", values: { "stats-unit": "weeks", "stats-count": "4" } },
        { label: "Last 12 weeks", values: { "stats-unit": "weeks", "stats-count": "12" } },
        { label: "Last 6 months", values: { "stats-unit": "months", "stats-count": "6" } },
        { label: "Year to date", values: { "stats-unit": "ytd" } },
    ], () => void refreshData());
    const highlightTrendPresets = renderPresets(document.getElementById("trend-presets")!, [
        { label: "7 days", values: { "trend-count": "7", "trend-unit": "days", "trend-granularity": "day" } },
        { label: "30 days", values: { "trend-count": "30", "trend-unit": "days", "trend-granularity": "day" } },
        { label: "12 weeks", values: { "trend-count": "12", "trend-unit": "weeks", "trend-granularity": "week" } },
        { label: "12 months", values: { "trend-count": "12", "trend-unit": "months", "trend-granularity": "month" } },
    ], () => { trendDrillStack = []; void refreshData(); });

    const statsHandler = () => { highlightAvgPresets(); void refreshData(); };
    [statsUnitEl, statsCountEl, statsHolidaysEl].forEach(el => {
        el.addEventListener("change", statsHandler);
    });
    // Changing the trend range/granularity redefines the root view — drop any
    // active drill so the fresh selection isn't overridden by a stale level.
    [trendCountEl, trendUnitEl, trendGranEl].forEach(el => {
        el.addEventListener("change", () => {
            trendDrillStack = [];
            highlightTrendPresets();
            void refreshData();
        });
    });

    // App mode selector: switching to Full reveals billing/reports surfaces.
    // Reload so the nav (Reports link) and mode-gated UI re-render everywhere.
    const modeSelect = document.getElementById("cfg-mode-select") as HTMLSelectElement;
    modeSelect.value = getMode();
    modeSelect.addEventListener("change", () => {
        setMode(modeSelect.value === "full" ? "full" : "simple");
        window.location.reload();
    });

    // Theme selector setup
    const themeSelect = document.getElementById("cfg-theme-select") as HTMLSelectElement;
    themeSelect.value = getThemePreference();
    themeSelect.addEventListener("change", () => {
        setThemePreference(themeSelect.value as "system" | "light" | "dark");
    });

    // Tab Switching logic
    tabLinks.forEach(link => {
        link.addEventListener("click", () => {
            const btn = link as HTMLButtonElement;
            const target = btn.dataset.target;
            // "Back to Statistics" only makes sense right after opening a day from there.
            if (target !== "dashboard") {
                const back = document.getElementById("btn-back-to-stats");
                if (back) back.hidden = true;
            }
            tabLinks.forEach(l => l.classList.remove("active"));
            btn.classList.add("active");
            history.replaceState(null, "", target === "dashboard" ? "#/tracker" : `#/tracker?tab=${target}`);

            tabPages.forEach(page => {
                if (page.id === `tab-${target}`) {
                    page.classList.remove("tab-hidden");
                } else {
                    page.classList.add("tab-hidden");
                }
            });

            // Reports load fresh data each time the tab is opened.
            if (target === "reports") mountReports(document.getElementById("tab-reports")!);

            // Re-render charts upon target switch
            if (target === "dashboard" || target === "statistics") {
                setTimeout(refreshData, 50);
            }
        });
    });

    let shiftsCached: ShiftItem[] = [];
    let offDaysCached: OffDayItem[] = [];
    // Inline off-day calendar (Statistics tab) — its own month cursor.
    let offCalYear = new Date().getFullYear();
    let offCalMonth = new Date().getMonth();
    let activeShiftCached: ShiftItem | null = null;

    // ── Projects state ───────────────────────────────────────────────
    let projectsCached: ProjectItem[] = [];
    let currentProjectUuid: string | null = localStorage.getItem(CURRENT_PROJECT_KEY) || null;

    // The day shown in the timeline (shared component; see buildTimeline()).
    let timelineDayKey = localDateKey(new Date());
    let timeline: TimelineHandle | null = null;

    function projectById(uuid: string | null | undefined): ProjectItem | null {
        if (!uuid) return null;
        return projectsCached.find(p => p.uuid === uuid) ?? null;
    }
    function projectColor(uuid: string | null | undefined): string {
        return projectById(uuid)?.color || unassignedColor();
    }
    function projectName(uuid: string | null | undefined): string {
        return projectById(uuid)?.name ?? "Unassigned";
    }
    function nextProjectColor(): string {
        const used = new Set(projectsCached.map(p => p.color).filter(Boolean));
        return PROJECT_PALETTE.find(c => !used.has(c)) ?? PROJECT_PALETTE[projectsCached.length % PROJECT_PALETTE.length];
    }
    async function reloadProjects() {
        const res = await listProjects();
        if (res.ok) projectsCached = res.data || [];
    }

    // Switch the sticky current project; auto-split the running shift (client-side).
    // One switch at a time: a second key press while the first is still saving
    // would split the same (stale) shift twice and leave two shifts open.
    let switchInFlight = false;
    async function switchToProject(projectUuid: string | null) {
        if (switchInFlight || dataStale) return;
        switchInFlight = true;
        try {
            await doSwitchToProject(projectUuid);
        } catch {
            setDataStale(true);
        } finally {
            switchInFlight = false;
        }
    }
    async function doSwitchToProject(projectUuid: string | null) {
        currentProjectUuid = projectUuid;
        localStorage.setItem(CURRENT_PROJECT_KEY, projectUuid ?? "");
        if (activeShiftCached && (activeShiftCached.project_uuid ?? null) !== projectUuid) {
            const startMs = new Date(activeShiftCached.start_time).getTime();
            const nowMs = Date.now();
            const startIso = localIso(new Date(startMs));
            // Within the first minute just retag, so a quick correction after
            // clock-in doesn't leave a few-second fragment.
            if (nowMs - startMs < 60_000) {
                await updateShift(activeShiftCached.id, startIso, null, projectUuid);
            } else {
                const nowIso = localIso(new Date(nowMs));
                const closed = await updateShift(activeShiftCached.id, startIso, nowIso, activeShiftCached.project_uuid ?? null);
                // Only open the next segment if the close landed, or two shifts would be open.
                if (closed.ok) await createShift(nowIso, null, projectUuid);
            }
        }
        await refreshData();
    }

    function renderProjectChip() {
        const wrap = document.getElementById("project-chip-wrap");
        if (!wrap) return;
        const active = projectsCached.filter(p => !p.archived);
        const items = [
            `<button class="project-menu-item ${!currentProjectUuid ? "selected" : ""}" data-select="" type="button"><span class="project-dot" style="background:${unassignedColor()}"></span><span class="project-menu-name">Unassigned</span><kbd class="project-slot">0</kbd></button>`,
            ...active.map((p, i) => `<button class="project-menu-item ${p.uuid === currentProjectUuid ? "selected" : ""}" data-select="${p.uuid}" type="button"><span class="project-dot" style="background:${p.color || unassignedColor()}"></span><span class="project-menu-name">${escapeHtml(p.name)}</span>${i < 9 ? `<kbd class="project-slot">${i + 1}</kbd>` : ""}</button>`),
        ].join("");
        wrap.innerHTML = `
            <button id="project-chip" class="project-chip" title="Current project" type="button">
                <span class="project-dot" style="background:${projectColor(currentProjectUuid)}"></span>
                <span class="project-chip-name">${escapeHtml(projectName(currentProjectUuid))}</span>
                <span class="project-chip-caret">▾</span>
            </button>
            <div id="project-menu" class="project-menu" hidden>
                <div class="project-menu-list">${items}</div>
                <form id="chip-new-project" class="project-menu-new"><input type="text" id="chip-new-name" placeholder="＋ New project" autocomplete="off" maxlength="60"></form>
                <button class="project-menu-manage" id="chip-manage" type="button">Manage projects…</button>
            </div>`;
        const menu = document.getElementById("project-menu") as HTMLDivElement;
        document.getElementById("project-chip")!.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
        menu.querySelectorAll<HTMLButtonElement>(".project-menu-item").forEach(btn => {
            btn.addEventListener("click", () => { menu.hidden = true; void switchToProject(btn.dataset.select || null); });
        });
        (document.getElementById("chip-new-project") as HTMLFormElement).addEventListener("submit", async (e) => {
            e.preventDefault();
            const input = document.getElementById("chip-new-name") as HTMLInputElement;
            const name = input.value.trim();
            if (!name) return;
            input.value = ""; menu.hidden = true;
            const res = await createProject(name, nextProjectColor());
            await reloadProjects();
            if (res.ok && res.data?.uuid) await switchToProject(res.data.uuid);
            else await refreshData();
        });
        document.getElementById("chip-manage")!.addEventListener("click", () => { menu.hidden = true; openProjectsDialog(); });
    }

    function renderProjectsManageList() {
        const el = document.getElementById("projects-manage-list");
        if (!el) return;
        if (projectsCached.length === 0) { el.innerHTML = `<p class="muted">No projects yet — add one below.</p>`; return; }
        const showBilling = isFullMode();
        const billingHint = showBilling
            ? `<p class="pm-billing-hint">The <strong>Rate</strong> and <strong>Cur.</strong> boxes set each project's hourly rate + currency for reports (leave currency blank to use your default).</p>`
            : "";
        el.innerHTML = billingHint + projectsCached.map(p => `
            <div class="project-manage-row" data-id="${p.id}">
                <input type="color" class="pm-color" value="${p.color || UNASSIGNED_FALLBACK}" title="Color">
                <input type="text" class="pm-name" value="${escapeHtml(p.name)}" maxlength="60">
                ${showBilling ? `
                <input type="text" class="pm-rate" value="${escapeHtml(p.rate ?? "")}" placeholder="Rate" title="Hourly rate for reports" inputmode="decimal">
                <input type="text" class="pm-currency" value="${escapeHtml(p.currency ?? "")}" placeholder="Cur." title="Currency (e.g. EUR); blank uses your profile default" maxlength="8">
                ` : ""}
                <label class="pm-archive"><input type="checkbox" class="pm-archived" ${p.archived ? "checked" : ""}> Archived</label>
                <button class="btn-icon pm-delete" type="button" title="Delete project">&times;</button>
            </div>`).join("");
        el.querySelectorAll<HTMLDivElement>(".project-manage-row").forEach(row => {
            const id = Number(row.dataset.id);
            const nameEl = row.querySelector(".pm-name") as HTMLInputElement;
            const colorEl = row.querySelector(".pm-color") as HTMLInputElement;
            const rateEl = row.querySelector(".pm-rate") as HTMLInputElement | null;
            const currencyEl = row.querySelector(".pm-currency") as HTMLInputElement | null;
            const archEl = row.querySelector(".pm-archived") as HTMLInputElement;
            const save = async () => {
                const fields: { name: string; color: string; archived: boolean; rate?: string | null; currency?: string | null } = {
                    name: nameEl.value.trim() || "Untitled",
                    color: colorEl.value,
                    archived: archEl.checked,
                };
                // Only touch billing when the fields are shown (Full mode), so a
                // Simple-mode save never clears a rate set elsewhere.
                if (rateEl && currencyEl) {
                    const rate = rateEl.value.trim();
                    const currency = currencyEl.value.trim().toUpperCase();
                    currencyEl.value = currency;
                    fields.rate = rate === "" ? null : rate;
                    fields.currency = currency === "" ? null : currency;
                }
                await updateProject(id, fields);
                await reloadProjects(); renderProjectChip();
            };
            nameEl.addEventListener("change", save);
            colorEl.addEventListener("change", save);
            rateEl?.addEventListener("change", save);
            currencyEl?.addEventListener("change", save);
            archEl.addEventListener("change", save);
            row.querySelector(".pm-delete")!.addEventListener("click", async () => {
                // Delete at once; Undo recreates the project and re-tags its shifts.
                const proj = projectsCached.find(p => p.id === id);
                if (!proj) return;
                const tagged = shiftsCached.filter(s => s.project_uuid && s.project_uuid === proj.uuid).map(s => ({ ...s }));
                const res = await deleteProject(id);
                if (!res.ok) { showToast("Couldn't delete the project.", { tone: "error" }); return; }
                await reloadProjects(); renderProjectsManageList(); renderProjectChip(); await refreshData();
                pushUndo(`Deleted project ${proj.name}`, async () => {
                    const again = await createProject(proj.name, proj.color ?? nextProjectColor());
                    if (!again.ok || !again.data?.uuid) throw new Error("server error");
                    if (again.data.id && (proj.archived || proj.rate || proj.currency)) {
                        await updateProject(again.data.id, { name: proj.name, color: proj.color ?? "", archived: proj.archived, rate: proj.rate ?? null, currency: proj.currency ?? null });
                    }
                    for (const s of tagged) await updateShift(s.id, localIso(new Date(s.start_time)), s.end_time ? localIso(new Date(s.end_time)) : null, again.data.uuid);
                    await reloadProjects(); renderProjectsManageList(); renderProjectChip(); await refreshData();
                });
            });
        });
    }
    function openProjectsDialog() {
        renderProjectsManageList();
        (document.getElementById("dlg-projects") as HTMLDialogElement).showModal();
    }

    // ── Client-side split + coalesce (server has no atomic endpoint) ──
    // The rules live in shared/shifts.ts (same as the desktop's Rust): split
    // pieces keep their note, and touching shifts merge only when project AND
    // note match, scoped to the edited day(s) so old history is never rewritten.
    const toPlanShift = (s: ShiftItem): PlanShift => ({
        key: s.id,
        startMs: new Date(s.start_time).getTime(),
        endMs: s.end_time ? new Date(s.end_time).getTime() : null,
        project: s.project_uuid ?? null,
        note: s.note ?? null,
    });

    async function assignRangeMs(rangeStartMs: number, rangeEndMs: number, projectUuid: string | null) {
        if (rangeStartMs >= rangeEndMs) return;
        const plan = planAssignRange(shiftsCached.map(toPlanShift), rangeStartMs, rangeEndMs, projectUuid);
        for (const u of plan.updates) {
            await updateShift(u.key, localIso(new Date(u.startMs)), localIso(new Date(u.endMs)), u.project);
        }
        for (const c of plan.creates) {
            await createShift(localIso(new Date(c.startMs)), localIso(new Date(c.endMs)), c.project, c.note);
        }
        const fresh = await listShifts();
        if (fresh.ok) await coalesceShifts(fresh.data || [], rangeStartMs, rangeEndMs);
        await refreshData();
    }

    async function coalesceShifts(list: ShiftItem[], fromMs: number, toMs: number) {
        const dayFrom = dayStart(localDateKey(new Date(fromMs))).getTime();
        const dayTo = addDays(dayStart(localDateKey(new Date(toMs))), 1).getTime();
        const scoped = overlapping(list.map(toPlanShift), dayFrom, dayTo, Date.now());
        const plan = planCoalesce(scoped);
        const byId = new Map(list.map(s => [s.id, s]));
        for (const u of plan.updates) {
            const keep = byId.get(u.key)!;
            await updateShift(keep.id, localIso(new Date(keep.start_time)), localIso(new Date(u.endMs)), keep.project_uuid ?? null);
        }
        for (const id of plan.deletes) await deleteShift(id);
    }

    // ── Undo (shared/ui/undo.ts) ─────────────────────────────────────
    // Before an edit, keep a copy of the shifts it can touch; Undo writes the
    // copies back and deletes rows the edit created. Rows deleted meanwhile
    // come back as new rows (the server has no "undelete").
    const snapshotRange = (fromMs: number, toMs: number): ShiftItem[] =>
        shiftsCached
            .filter(s => new Date(s.start_time).getTime() < toMs && (s.end_time ? new Date(s.end_time).getTime() : Date.now()) > fromMs)
            .map(s => ({ ...s }));

    async function restoreSnapshot(before: ShiftItem[], fromMs: number, toMs: number) {
        const fresh = await listShifts();
        if (!fresh.ok) throw new Error("server unreachable");
        const now = fresh.data || [];
        const beforeIds = new Set(before.map(b => b.id));
        const created = now.filter(s => !beforeIds.has(s.id)
            && new Date(s.start_time).getTime() < toMs
            && (s.end_time ? new Date(s.end_time).getTime() : Date.now()) > fromMs);
        for (const c of created) await deleteShift(c.id);
        const nowIds = new Set(now.map(s => s.id));
        for (const b of before) {
            const start = localIso(new Date(b.start_time));
            const end = b.end_time ? localIso(new Date(b.end_time)) : null;
            if (nowIds.has(b.id)) await updateShift(b.id, start, end, b.project_uuid ?? null, b.note ?? null);
            else await createShift(start, end, b.project_uuid ?? null, b.note ?? null);
        }
        await refreshData();
    }

    /**
     * Run an edit of shifts within [fromMs, toMs) and offer to undo it. The
     * snapshot covers the whole local days: merging touching shifts can change
     * a neighbour outside the edited range.
     */
    async function undoable(label: string, fromMs: number, toMs: number, action: () => Promise<void>) {
        const lo = dayRangeOf(fromMs)[0];
        const hi = dayRangeOf(Math.max(fromMs, toMs - 1))[1];
        const before = snapshotRange(lo, hi);
        await action();
        // Nothing changed: no Undo entry, or the next Undo would do nothing.
        const key = (s: ShiftItem) => [s.id, s.start_time, s.end_time, s.project_uuid ?? "", s.note ?? ""].join("|");
        const after = snapshotRange(lo, hi);
        if (before.length === after.length && after.every(s => before.some(b => key(b) === key(s)))) return;
        pushUndo(label, () => restoreSnapshot(before, lo, hi));
    }

    const dayRangeOf = (ms: number): [number, number] => {
        const start = dayStart(localDateKey(new Date(ms))).getTime();
        return [start, addDays(new Date(start), 1).getTime()];
    };

    /** Delete a shift at once, with Undo (no "Are you sure?"). */
    async function deleteShiftUndoable(id: number, label = "Shift deleted") {
        const s = shiftsCached.find(x => x.id === id);
        if (!s) return;
        const [lo] = dayRangeOf(new Date(s.start_time).getTime());
        const hi = s.end_time ? new Date(s.end_time).getTime() : Date.now();
        try {
            await undoable(label, lo, hi, async () => {
                const res = await deleteShift(id);
                if (!res.ok) throw new Error("server error");
                await refreshData();
            });
        } catch {
            showToast("Couldn't delete the shift — the server didn't answer.", { tone: "error" });
        }
    }

    // ── Timeline (shared/ui/timeline.ts) ─────────────────────────────
    function shiftById(id: number): ShiftItem {
        const s = shiftsCached.find(x => x.id === id);
        if (!s) throw new Error("That shift no longer exists.");
        return s;
    }

    async function fillRangeMs(fromMs: number, toMs: number, projectUuid: string | null) {
        const now = Date.now();
        const occupied = shiftsCached.map(s => ({ startMs: new Date(s.start_time).getTime(), endMs: s.end_time ? new Date(s.end_time).getTime() : now }));
        for (const g of findGaps(occupied, fromMs, Math.min(toMs, now))) {
            await createShift(localIso(new Date(g.startMs)), localIso(new Date(g.endMs)), projectUuid);
        }
        const fresh = await listShifts();
        if (fresh.ok) await coalesceShifts(fresh.data || [], fromMs, toMs);
        await refreshData();
    }

    function buildTimeline() {
        const root = document.getElementById("timeline-root");
        if (!root) return;
        timeline = createTimeline(root, {
            assignRange: (fromMs, toMs, project) => undoable(`Painted ${projectName(project)}`, fromMs, toMs, () => assignRangeMs(fromMs, toMs, project)),
            assignRanges: (ranges, project) => undoable(`Painted ${projectName(project)}`,
                Math.min(...ranges.map(r => r.startMs)), Math.max(...ranges.map(r => r.endMs)), async () => {
                    for (const r of ranges) await assignRangeMs(r.startMs, r.endMs, project);
                }),
            fillRange: (fromMs, toMs, project) => undoable(`Added time to ${projectName(project)}`, fromMs, toMs, () => fillRangeMs(fromMs, toMs, project)),
            setTimes: async (changes) => {
                const err = validateTimeEdits(shiftsCached.map(toPlanShift), changes.map(c => ({ key: c.id, startMs: c.startMs, endMs: c.endMs })), Date.now());
                if (err) throw new Error(err);
                const lo = Math.min(...changes.map(c => Math.min(c.startMs, new Date(shiftById(c.id).start_time).getTime())));
                const hi = Math.max(...changes.map(c => Math.max(c.endMs ?? Date.now(), shiftById(c.id).end_time ? new Date(shiftById(c.id).end_time!).getTime() : Date.now())));
                await undoable("Changed shift times", lo, hi, async () => {
                    for (const c of changes) {
                        const res = await updateShift(c.id, localIso(new Date(c.startMs)), c.endMs === null ? null : localIso(new Date(c.endMs)));
                        if (!res.ok) throw new Error("server error");
                    }
                    await refreshData();
                });
            },
            setNotes: async (ids, note) => {
                const spans = ids.map(id => shiftById(id));
                const lo = Math.min(...spans.map(s => new Date(s.start_time).getTime()));
                const hi = Math.max(...spans.map(s => s.end_time ? new Date(s.end_time).getTime() : Date.now()));
                await undoable(note ? "Painted note" : "Erased note", lo, hi, async () => {
                    for (const s of spans) await updateShift(s.id, s.start_time, s.end_time, undefined, note);
                    await refreshData();
                });
            },
            setProject: async (id, project) => {
                const s = shiftById(id);
                const [lo, hi] = [new Date(s.start_time).getTime(), s.end_time ? new Date(s.end_time).getTime() : Date.now()];
                await undoable(project ? `Moved to ${projectName(project)}` : "Removed project", lo, hi, async () => {
                    await updateShift(s.id, localIso(new Date(s.start_time)), s.end_time ? localIso(new Date(s.end_time)) : null, project);
                    // Touching pieces with the same project and note merge back into one.
                    if (s.end_time) {
                        const fresh = await listShifts();
                        if (fresh.ok) await coalesceShifts(fresh.data || [], lo, hi);
                    }
                    // Re-tagging the running shift also changes what you're tracking now.
                    if (!s.end_time) { currentProjectUuid = project; localStorage.setItem(CURRENT_PROJECT_KEY, project ?? ""); }
                    await refreshData();
                });
            },
            deleteShift: async (id) => {
                const s = shiftById(id);
                const [lo, hi] = [new Date(s.start_time).getTime(), s.end_time ? new Date(s.end_time).getTime() : Date.now()];
                await undoable("Shift deleted", lo, hi, async () => {
                    const res = await deleteShift(id);
                    if (!res.ok) throw new Error("server error");
                    await refreshData();
                });
            },
            clearAutoClosed: async (id) => {
                const s = shiftById(id);
                await updateShift(s.id, s.start_time, s.end_time, undefined, undefined, { clearAutoClosed: true });
                await refreshData();
            },
            projectColor: (uuid) => projectColor(uuid),
            projectName: (uuid) => projectName(uuid),
            textColorOn: contrastText,
            onDayChange: (key) => { timelineDayKey = key; },
            describeError: (err) => err instanceof Error ? err.message : "Couldn't save that change.",
        }, timelineDayKey);
    }

    function pushTimelineData() {
        if (!timeline) return;
        timeline.setData(
            shiftsCached.map(s => ({
                id: s.id,
                startMs: new Date(s.start_time).getTime(),
                endMs: s.end_time ? new Date(s.end_time).getTime() : null,
                project: s.project_uuid ?? null,
                note: s.note ?? null,
                autoClosed: !!s.auto_closed_at,
            })),
            projectsCached.filter(p => !p.archived && p.uuid).map(p => ({ uuid: p.uuid!, name: p.name, color: p.color || unassignedColor() })),
        );
    }

    /** Open a day in the timeline (from a chart bar) and bring it into view. */
    function setTimelineDay(dateKey: string) {
        timelineDayKey = dateKey;
        timeline?.showDay(dateKey);
        document.getElementById("timeline-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // ── Trend-chart drill-down ───────────────────────────────────────
    // Week/month bars zoom the chart into their days (breadcrumbs walk back);
    // a day bar opens that day in the Dashboard timeline, with a way back.
    type TrendDrillLevel = { start: Date; end: Date; granularity: string; label: string };
    let trendDrillStack: TrendDrillLevel[] = [];
    let trendBucketRange: Record<string, { start: number; end: number }> = {};
    let trendLabelsCurrent: string[] = [];
    let trendGranularityCurrent = "day";

    function currentTrendView(): { start: Date | null; end: Date; granularity: string } {
        const top = trendDrillStack[trendDrillStack.length - 1];
        if (top) return { start: top.start, end: top.end, granularity: top.granularity };
        const g = (document.getElementById("trend-granularity") as HTMLSelectElement)?.value || "day";
        return { start: null, end: new Date(), granularity: g };
    }

    function showTab(target: string) {
        (document.querySelector(`.tab-link[data-target="${target}"]`) as HTMLButtonElement | null)?.click();
    }

    function openDayFromStats(dateKey: string) {
        showTab("dashboard");
        const back = document.getElementById("btn-back-to-stats");
        if (back) back.hidden = false;
        setTimelineDay(dateKey);
    }

    function drillToLevel(level: number) {
        trendDrillStack = level < 0 ? [] : trendDrillStack.slice(0, level + 1);
        void refreshData();
    }

    function onTrendBarClick(index: number) {
        const bk = trendLabelsCurrent[index];
        if (bk == null) return;
        if (trendGranularityCurrent === "day") { openDayFromStats(bk); return; }
        const range = trendBucketRange[bk];
        if (!range) return;
        const startD = new Date(range.start);
        const label = trendGranularityCurrent === "week"
            ? "Wk of " + startD.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
            : startD.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        trendDrillStack.push({ start: startD, end: new Date(range.end), granularity: "day", label });
        void refreshData();
    }

    function syncDrillUI() {
        const panel = document.getElementById("trend-drill-panel");
        const crumbs = document.getElementById("trend-drill-crumbs");
        if (!panel || !crumbs) return;
        panel.hidden = trendDrillStack.length === 0;
        if (panel.hidden) return;
        const parts = [`<button type="button" class="crumb" data-level="-1">All</button>`];
        trendDrillStack.forEach((lvl, i) => {
            parts.push(`<span class="crumb-sep">▸</span><button type="button" class="crumb" data-level="${i}">${escapeHtml(lvl.label)}</button>`);
        });
        crumbs.innerHTML = parts.join("");
        crumbs.querySelectorAll(".crumb[data-level]").forEach(b =>
            b.addEventListener("click", () => drillToLevel(parseInt((b as HTMLElement).dataset.level!))));
    }

    // ── Stacked-by-project chart datasets (shared/charts.ts) ─────────
    const projectLook = { name: (u: string) => projectName(u), color: (u: string) => projectColor(u), unassignedColor };
    function renderProjectSummary(datasets: { label: string; backgroundColor: string; data: number[] }[]) {
        const el = document.getElementById("project-summary");
        if (!el) return;
        const totals = datasets
            .map(d => ({ label: d.label, color: d.backgroundColor, hours: d.data.reduce((a, b) => a + b, 0) }))
            .filter(t => t.hours > 0.001)
            .sort((a, b) => b.hours - a.hours);
        el.innerHTML = totals.length === 0 ? "" : totals
            .map(t => `<span class="ps-item"><span class="project-dot" style="background:${t.color}"></span><span class="ps-name">${escapeHtml(t.label)}</span><span class="ps-hours">${formatDuration(t.hours)}</span></span>`)
            .join("");
    }

    // ── One-time project/timeline wiring ─────────────────────────────
    buildTimeline();
    // App-styled dropdowns (the native selects stay underneath).
    enhanceSelects(app);
    document.getElementById("trend-drill-close")?.addEventListener("click", () => drillToLevel(-1));
    document.getElementById("btn-back-to-stats")?.addEventListener("click", (e) => {
        (e.currentTarget as HTMLElement).hidden = true;
        showTab("statistics");
    });

    document.getElementById("btn-export-csv")?.addEventListener("click", () => {
        const rows: string[] = [];
        rows.push("[Shifts]");
        rows.push(["ID", "Start Time", "End Time", "Duration (Hours)", "Project", "Note"].join(","));
        for (const s of shiftsCached) {
            const dur = shiftDurationHours(s).toFixed(2);
            // Times in the naive local frame, the same as desktop exports.
            const start = localIso(new Date(s.start_time));
            const end = s.end_time ? localIso(new Date(s.end_time)) : "";
            rows.push([String(s.id), start, end, dur, csvCell(projectName(s.project_uuid)), csvCell(s.note ?? "")].join(","));
        }
        rows.push("");
        rows.push("[Off Days]");
        rows.push("Date");
        for (const o of offDaysCached) rows.push(o.date);

        const blob = new Blob([rows.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tracksuite-work-export-${localDateKey(new Date())}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
    (document.getElementById("btn-close-projects") as HTMLButtonElement).addEventListener("click", () => (document.getElementById("dlg-projects") as HTMLDialogElement).close());
    (document.getElementById("form-new-project") as HTMLFormElement).addEventListener("submit", async (e) => {
        e.preventDefault();
        const nameEl = document.getElementById("new-project-name") as HTMLInputElement;
        const colorEl = document.getElementById("new-project-color") as HTMLInputElement;
        const name = nameEl.value.trim();
        if (!name) return;
        nameEl.value = "";
        await createProject(name, colorEl.value);
        await reloadProjects(); renderProjectsManageList(); renderProjectChip(); await refreshData();
    });
    // Close the chip menu on outside click.
    activeDocClick = (e) => {
        const menu = document.getElementById("project-menu");
        if (!menu || menu.hidden) return;
        const wrap = document.getElementById("project-chip-wrap");
        if (wrap && !wrap.contains(e.target as Node)) menu.hidden = true;
    };
    // Number keys: 0 = Unassigned, 1–9 = Nth project (over the timeline they pick a brush instead).
    activeKeydownHandler = (e) => {
        const tag = (e.target as HTMLElement | null)?.tagName;
        const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key < "0" || e.key > "9" || typing) return;
        if (e.key === "0") { e.preventDefault(); void switchToProject(null); return; }
        const active = projectsCached.filter(p => !p.archived);
        const target = active[Number(e.key) - 1];
        if (!target || !target.uuid) return;
        e.preventDefault();
        void switchToProject(target.uuid);
    };

    // Toggle Modal Dialogs
    addManualBtn.addEventListener("click", () => {
        // Prefill: the day shown in the timeline, right after its last shift.
        const day = timeline?.day() ?? localDateKey(new Date());
        const dayStartMs = dayStart(day).getTime();
        const offDays = new Set(offDaysCached.map(o => o.date));
        const spans = shiftsCached.map(s => ({ startMs: new Date(s.start_time).getTime(), endMs: s.end_time ? new Date(s.end_time).getTime() : Date.now() }));
        const [a, b] = suggestManualShift(spans, dayStartMs, Date.now(), offDays.has(day) ? 0 : getTargetHoursForDate(new Date(dayStartMs), currentSchedule));
        const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
        (document.getElementById("inp-shift-start-date") as HTMLInputElement).value = localDateKey(new Date(a));
        (document.getElementById("inp-shift-end-date") as HTMLInputElement).value = localDateKey(new Date(b));
        (document.getElementById("inp-shift-start-time") as HTMLInputElement).value = hhmm(a);
        (document.getElementById("inp-shift-end-time") as HTMLInputElement).value = hhmm(b);
        (document.getElementById("inp-shift-note") as HTMLInputElement).value = "";
        const errEl = document.getElementById("shift-error")!;
        errEl.textContent = "";
        errEl.style.display = "none";
        dlgShift.showModal();
    });

    btnCancelShift.addEventListener("click", () => dlgShift.close());

    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    function getDatesInRange(startStr: string, endStr: string): string[] {
        const dates: string[] = [];
        const start = dateInputToLocalDate(startStr);
        const end = dateInputToLocalDate(endStr);
        const cursor = new Date(start);
        while (cursor.getTime() <= end.getTime()) {
            dates.push(localDateKey(cursor));
            cursor.setDate(cursor.getDate() + 1);
        }
        return dates;
    }

    // Inline monthly off-day calendar on the dashboard. Drag across days to
    // paint them (see initOffdayCalendar); a single click toggles one day.
    function renderOffdayCalendar() {
        const grid = document.getElementById("offcal-grid");
        const title = document.getElementById("offcal-title");
        if (!grid || !title) return;
        title.textContent = `${monthNames[offCalMonth]} ${offCalYear}`;
        grid.innerHTML = "";
        const firstDay = new Date(offCalYear, offCalMonth, 1);
        let startOffset = firstDay.getDay();
        startOffset = startOffset === 0 ? 6 : startOffset - 1; // Monday-first
        const numDays = new Date(offCalYear, offCalMonth + 1, 0).getDate();
        const offDayIds = new Map(offDaysCached.map(o => [o.date, o.id]));
        const todayStr = localDateKey(new Date());
        for (let i = 0; i < startOffset; i++) {
            const empty = document.createElement("div");
            empty.className = "cal-empty";
            grid.appendChild(empty);
        }
        for (let day = 1; day <= numDays; day++) {
            const cell = document.createElement("div");
            cell.textContent = String(day);
            const dateKey = `${offCalYear}-${String(offCalMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            cell.dataset.date = dateKey;
            if (dateKey === todayStr) cell.classList.add("cal-today");
            if (offDayIds.has(dateKey)) {
                cell.classList.add("cal-offday");
                const info = reasonInfo(offDaysCached.find(o => o.date === dateKey)?.reason);
                cell.title = info.label;
                if (info.key) {
                    cell.dataset.reason = info.key;
                    cell.insertAdjacentHTML("beforeend", `<span class="cal-reason" aria-hidden="true">${info.icon}</span>`);
                }
            }
            grid.appendChild(cell);
        }
    }
    document.getElementById("offcal-prev")?.addEventListener("click", () => {
        offCalMonth--; if (offCalMonth < 0) { offCalMonth = 11; offCalYear--; }
        renderOffdayCalendar();
    });
    document.getElementById("offcal-next")?.addEventListener("click", () => {
        offCalMonth++; if (offCalMonth > 11) { offCalMonth = 0; offCalYear++; }
        renderOffdayCalendar();
    });

    // Drag-to-paint off days: press a day and drag to select a range. The day you
    // press sets the mode (press an empty day → add across the drag; press an off
    // day → clear it); a plain click is a one-day range.
    let offDragActive = false;
    let offDragMode: "add" | "remove" = "add";
    let offDragAnchor: string | null = null;
    let offDragCurrent: string | null = null;

    const offRange = (a: string, b: string): string[] => (a <= b ? getDatesInRange(a, b) : getDatesInRange(b, a));

    async function applyOffDays(dates: string[], mode: "add" | "remove") {
        const offIds = new Map(offDaysCached.map(o => [o.date, o.id]));
        for (const d of dates) {
            const offId = offIds.get(d);
            if (mode === "add" && offId === undefined) await createOffDay(d);
            else if (mode === "remove" && offId !== undefined) await deleteOffDay(offId);
        }
    }

    function paintOffDragPreview() {
        const grid = document.getElementById("offcal-grid");
        if (!grid || !offDragAnchor || !offDragCurrent) return;
        const range = new Set(offRange(offDragAnchor, offDragCurrent));
        grid.querySelectorAll<HTMLElement>("[data-date]").forEach(cell => {
            const inRange = range.has(cell.dataset.date!);
            cell.classList.toggle("cal-drag-add", inRange && offDragMode === "add");
            cell.classList.toggle("cal-drag-remove", inRange && offDragMode === "remove");
        });
    }

    async function endOffDrag() {
        if (!offDragActive) return;
        offDragActive = false;
        const anchor = offDragAnchor, current = offDragCurrent;
        offDragAnchor = offDragCurrent = null;
        if (!anchor || !current) return;
        try {
            const mode = offDragMode;
            const had = new Set(offDaysCached.map(o => o.date));
            const changed = offRange(anchor, current).filter(d => (mode === "add") !== had.has(d));
            await applyOffDays(changed, mode);
            await refreshData(); // re-renders the calendar, clearing preview classes
            if (changed.length) {
                const what = `${changed.length} off day${changed.length > 1 ? "s" : ""}`;
                pushUndo(mode === "add" ? `Marked ${what}` : `Cleared ${what}`, async () => {
                    await applyOffDays(changed, mode === "add" ? "remove" : "add");
                    await refreshData();
                });
            }
        } catch (err) {
            console.error("Failed to apply off days", err);
            showToast("Couldn't save the off days.", { tone: "error" });
        }
    }

    const onOffDragMouseUp = () => { void endOffDrag(); };
    const offcalGrid = document.getElementById("offcal-grid");
    if (offcalGrid) {
        const cellDate = (e: Event): string | null =>
            (e.target as HTMLElement)?.closest<HTMLElement>("[data-date]")?.dataset.date ?? null;
        offcalGrid.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return; // right-click opens the reason menu instead
            const d = cellDate(e);
            if (!d) return;
            e.preventDefault(); // don't text-select while dragging
            offDragActive = true;
            offDragAnchor = offDragCurrent = d;
            offDragMode = offDaysCached.some(o => o.date === d) ? "remove" : "add";
            paintOffDragPreview();
        });
        offcalGrid.addEventListener("mouseover", (e) => {
            if (!offDragActive) return;
            const d = cellDate(e);
            if (!d) return;
            offDragCurrent = d;
            paintOffDragPreview();
        });
        window.addEventListener("mouseup", onOffDragMouseUp);

        // Right-click a day: mark it off with a reason (vacation, sick, …),
        // change the reason, or make it a normal day again. Undoable.
        const setReason = async (date: string, reason: string | null) => {
            const existing = offDaysCached.find(o => o.date === date);
            const res = existing ? await updateOffDay(existing.id, reason) : await createOffDay(date, reason);
            if (!res.ok) throw new Error("server error");
        };
        const clearDay = async (date: string) => {
            const existing = offDaysCached.find(o => o.date === date);
            if (existing) await deleteOffDay(existing.id);
        };
        offcalGrid.addEventListener("contextmenu", (e) => {
            const d = cellDate(e);
            if (!d) return;
            e.preventDefault();
            const prev = offDaysCached.find(o => o.date === d);
            const wasOff = !!prev;
            const prevReason = prev?.reason ?? null;
            const label = dayStart(d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
            const restore = async () => {
                if (wasOff) await setReason(d, prevReason); else await clearDay(d);
                await refreshData();
            };
            const apply = async (what: string, action: () => Promise<void>) => {
                try {
                    await action();
                    await refreshData();
                    pushUndo(`${label}: ${what}`, restore);
                } catch {
                    showToast("Couldn't save the off day.", { tone: "error" });
                }
            };
            showOffDayMenu({ x: e.clientX, y: e.clientY }, { label, isOff: wasOff, reason: prevReason }, {
                setReason: (reason) => apply(reasonInfo(reason).label, () => setReason(d, reason)),
                clear: () => apply("not an off day", () => clearDay(d)),
            });
        });
    }

    // "Off days ↓" in the clock panel scrolls the dashboard to the calendar.
    document.getElementById("btn-jump-offdays")?.addEventListener("click", () => {
        document.getElementById("offday-calendar-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Save Work Schedule
    // The schedule saves itself shortly after you stop typing (no Save button).
    let scheduleSaveTimer: number | null = null;
    document.querySelectorAll<HTMLInputElement>('[id^="cfg-hours-"]').forEach(input => {
        input.addEventListener("input", () => {
            if (scheduleSaveTimer !== null) window.clearTimeout(scheduleSaveTimer);
            scheduleSaveTimer = window.setTimeout(() => void saveScheduleFromInputs(), 700);
        });
    });
    async function saveScheduleFromInputs() {
        scheduleSaveTimer = null;
        const schedule: WorkSchedule = {
            mon: parseFloat((document.getElementById("cfg-hours-mon") as HTMLInputElement).value) || 0,
            tue: parseFloat((document.getElementById("cfg-hours-tue") as HTMLInputElement).value) || 0,
            wed: parseFloat((document.getElementById("cfg-hours-wed") as HTMLInputElement).value) || 0,
            thu: parseFloat((document.getElementById("cfg-hours-thu") as HTMLInputElement).value) || 0,
            fri: parseFloat((document.getElementById("cfg-hours-fri") as HTMLInputElement).value) || 0,
            sat: parseFloat((document.getElementById("cfg-hours-sat") as HTMLInputElement).value) || 0,
            sun: parseFloat((document.getElementById("cfg-hours-sun") as HTMLInputElement).value) || 0
        };
        const status = document.getElementById("schedule-status-text")!;
        status.textContent = "Saving…";
        const onServer = await persistSchedule(schedule);
        status.textContent = onServer ? "Saved ✓" : "Saved on this device — couldn't reach the server, will retry next time.";
        void refreshData();
    }

    // PWA Custom Button Setup
    const installPwaBtn = document.getElementById("btn-install-pwa");
    if (deferredPrompt) {
        document.getElementById("btn-install-pwa-container")!.style.display = "block";
    }
    installPwaBtn?.addEventListener("click", async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`PWA Prompt Outcome: ${outcome}`);
            deferredPrompt = null;
            document.getElementById("btn-install-pwa-container")!.style.display = "none";
        }
    });

    // Clock In/Out Action
    clockBtn.addEventListener("click", async () => {
        if (dataStale) return;
        clockBtn.disabled = true;
        try {
            if (activeShiftCached) {
                // Clock Out
                const end = localIso(new Date());
                const res = await updateShift(activeShiftCached.id, localIso(new Date(activeShiftCached.start_time)), end);
                if (res.ok) {
                    stopTimer();
                    await refreshData();
                } else {
                    showToast("Couldn't clock out — the server didn't accept it. Try again.", { tone: "error" });
                }
            } else {
                // Clock In (tagged with the current project)
                const start = localIso(new Date());
                const res = await createShift(start, null, currentProjectUuid);
                if (res.ok) {
                    await refreshData();
                } else {
                    showToast("Couldn't clock in — the server didn't accept it. Try again.", { tone: "error" });
                }
            }
        } catch (e) {
            console.error(e);
            setDataStale(true);
        } finally {
            clockBtn.disabled = dataStale;
        }
    });

    // Submit Manual Shift Form
    formShift.addEventListener("submit", async (e) => {
        e.preventDefault();
        const startD = (document.getElementById("inp-shift-start-date") as HTMLInputElement).value;
        const startT = (document.getElementById("inp-shift-start-time") as HTMLInputElement).value;
        const endD = (document.getElementById("inp-shift-end-date") as HTMLInputElement).value;
        const endT = (document.getElementById("inp-shift-end-time") as HTMLInputElement).value;

        const errEl = document.getElementById("shift-error")!;
        errEl.style.display = "none";

        const startIso = combineManualDateTime(startD, startT);
        const endIso = combineManualDateTime(endD, endT);

        if (!startIso || !endIso) {
            errEl.textContent = "Invalid dates or times. Use YYYY-MM-DD and HH:MM.";
            errEl.style.display = "block";
            return;
        }

        if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
            errEl.textContent = "End time must be after start time.";
            errEl.style.display = "block";
            return;
        }

        const noteVal = (document.getElementById("inp-shift-note") as HTMLInputElement).value.trim();
        const res = await createShift(
            startIso,
            endIso,
            undefined,
            noteVal === "" ? undefined : noteVal,
        );
        if (res.ok) {
            dlgShift.close();
            await refreshData();
        } else {
            errEl.textContent = "Failed to add shift: " + res.status;
            errEl.style.display = "block";
        }
    });



    // Helper: Combine Manual Date & Time to ISO
    function combineManualDateTime(dateText: string, timeText: string): string | null {
        const date = normalizeDateInputValue(dateText);
        const time = normalizeTimeInputValue(timeText);
        if (!date || !time) return null;
        return `${date}T${time}:00`;
    }

    // ── Timer Functions ──────────────────────────────────────────────
    function startTimer(startTimeStr: string) {
        if (activeTimerId !== null) clearInterval(activeTimerId);
        const timerEl = document.getElementById("clock-timer")!;
        const startMs = new Date(startTimeStr).getTime();

        const updateText = () => {
            const elapsedMs = Date.now() - startMs;
            if (elapsedMs < 0) {
                timerEl.textContent = "· 0:00";
                return;
            }
            const sec = Math.floor(elapsedMs / 1000) % 60;
            const min = Math.floor(elapsedMs / 60000) % 60;
            const hrs = Math.floor(elapsedMs / 3600000);
            timerEl.textContent = `· ${hrs}:${String(min).padStart(2, "0")}`;
            // The running time in the browser tab, so it's visible from any tab.
            document.title = `${hrs}:${String(min).padStart(2, "0")} · ${BASE_TITLE}`;
            if (sec === 0) renderToday();
        };

        updateText();
        activeTimerId = window.setInterval(updateText, 1000);
    }

    function stopTimer() {
        if (activeTimerId !== null) {
            clearInterval(activeTimerId);
            activeTimerId = null;
        }
        document.title = BASE_TITLE;
    }

    // "Today" grows while tracking; the line under it says how much is left
    // of today's target and, while tracking, when you'd be done.
    let todayBase = { hours: 0, atMs: Date.now(), targetHours: 0 };
    function renderToday() {
        const now = Date.now();
        const tracking = !!activeShiftCached;
        const today = todayBase.hours + (tracking ? (now - todayBase.atMs) / 3_600_000 : 0);
        const todayEl = document.getElementById("hours-today");
        if (todayEl) todayEl.textContent = formatDuration(today);
        const sub = document.getElementById("today-sub");
        if (!sub) return;
        const left = todayBase.targetHours - today;
        if (todayBase.targetHours <= 0) sub.textContent = "";
        else if (left <= 0) sub.textContent = "Target reached ✓";
        else if (tracking) {
            const done = new Date(now + left * 3_600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            sub.textContent = `${formatDuration(left)} to go · done ≈ ${done}`;
        } else sub.textContent = `${formatDuration(left)} to go`;
    }

    // ── Fetch & Draw Stats ───────────────────────────────────────────
    // Notify about shifts the server auto-closed (left running while a newer one
    // started). Dismissal is remembered per newest auto-close so it won't nag,
    // but a fresh auto-close re-surfaces it. Editing a shift clears its flag.
    const AUTO_CLOSED_ACK_KEY = "autoClosedAckAt";
    function renderAutoClosedBanner() {
        const el = document.getElementById("auto-closed-banner");
        if (!el) return;
        const flagged = shiftsCached.filter(s => s.auto_closed_at);
        const latest = flagged.reduce((m, s) => (s.auto_closed_at! > m ? s.auto_closed_at! : m), "");
        const ackAt = localStorage.getItem(AUTO_CLOSED_ACK_KEY) || "";
        if (flagged.length === 0 || (latest && latest <= ackAt)) {
            el.hidden = true;
            el.innerHTML = "";
            return;
        }
        const dates = flagged
            .map(s => dayKeyOf(s.start_time))
            .filter((d, i, a) => a.indexOf(d) === i)
            .sort()
            .map(d => `<strong>${escapeHtml(d)}</strong>`)
            .join(", ");
        const plural = flagged.length > 1;
        el.hidden = false;
        el.innerHTML = `
            <div class="auto-closed-body">
                <span class="auto-closed-icon">⚠️</span>
                <div class="auto-closed-copy">
                    <div class="auto-closed-title">${flagged.length} shift${plural ? "s were" : " was"} left running and automatically closed.</div>
                    <div class="auto-closed-text">Their end time is an estimate (end of the start day): ${dates}. Open the day in the timeline and set the correct end time — the note clears once you edit it.</div>
                </div>
                <button class="btn btn-outline auto-closed-dismiss" type="button">Dismiss</button>
            </div>`;
        el.querySelector(".auto-closed-dismiss")!.addEventListener("click", () => {
            localStorage.setItem(AUTO_CLOSED_ACK_KEY, latest || new Date().toISOString());
            el.hidden = true;
        });
    }

    // When a refresh fails the page still shows the last data. Clocking in or
    // out from that stale view could open a second shift, so the clock waits
    // until a refresh succeeds again.
    let dataStale = false;
    function setDataStale(stale: boolean) {
        dataStale = stale;
        const el = document.getElementById("offline-banner");
        if (el) {
            el.hidden = !stale;
            el.textContent = stale ? "Can't reach the server — showing your last loaded data. Retrying…" : "";
        }
        clockBtn.disabled = stale;
    }

    async function refreshData() {
        let shiftsResp, offdaysResp, projectsResp;
        try {
            [shiftsResp, offdaysResp, projectsResp] = await Promise.all([listShifts(), listOffDays(), listProjects()]);
        } catch {
            setDataStale(true);
            return;
        }

        if (!shiftsResp.ok || !offdaysResp.ok) {
            if (shiftsResp.status === 401 || offdaysResp.status === 401) {
                stopTimer();
                navigate("#/login");
                return;
            }
            setDataStale(true);
            return;
        }
        setDataStale(false);

        shiftsCached = shiftsResp.data || [];
        offDaysCached = offdaysResp.data || [];
        if (projectsResp.ok) projectsCached = projectsResp.data || [];
        activeShiftCached = shiftsCached.find(s => s.end_time === null) || null;

        // Project chip, timeline, and per-shift picker options.
        renderProjectChip();
        pushTimelineData();
        renderAutoClosedBanner();

        const offDayDates = new Set(offDaysCached.map(o => o.date));
        const now = new Date();

        // 1. Clock panel active state & Discard button
        const statusEl = document.getElementById("clock-status")!;
        if (activeShiftCached) {
            // "Tracking · 1:23" like the desktop Status card.
            if (!document.getElementById("clock-timer")) statusEl.innerHTML = `Tracking <span class="clock-elapsed" id="clock-timer"></span>`;
            document.getElementById("card-status")?.classList.add("tracking");
            clockBtn.textContent = "Clock Out";
            clockBtn.className = "btn btn-danger";
            runningNote.hidden = false;
            if (document.activeElement !== runningNote) runningNote.value = activeShiftCached.note ?? "";
            startTimer(activeShiftCached.start_time);
        } else {
            statusEl.textContent = "Idle";
            document.getElementById("card-status")?.classList.remove("tracking");
            clockBtn.textContent = "Clock In";
            clockBtn.className = "btn btn-primary";
            runningNote.hidden = true;
            stopTimer();
        }

        // 2. Today hours
        const todayKey = localDateKey(now);
        // Hours per local day, split at midnight (a night shift counts on both days).
        const hoursByDay = new Map<string, number>();
        for (const s of shiftsCached) {
            for (const [day, h] of shiftHoursByDay(s.start_time, s.end_time)) hoursByDay.set(day, (hoursByDay.get(day) ?? 0) + h);
        }
        const todayHours = hoursByDay.get(todayKey) ?? 0;
        todayBase = { hours: todayHours, atMs: Date.now(), targetHours: offDayDates.has(todayKey) ? 0 : getTargetHoursForDate(now, currentSchedule) };
        renderToday();

        // 3. Week hours & chart data
        const ws = startOfWeek(now);
        const dayLabels: string[] = [];
        const dayKeys: string[] = [];
        let weekTotal = 0;

        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            const key = localDateKey(d);
            dayKeys.push(key);
            dayLabels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
            weekTotal += hoursByDay.get(key) ?? 0;
        }

        document.getElementById("hours-week")!.textContent = formatDuration(weekTotal);

        // Weekly Target Bar
        let weekTarget = 0;
        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            const key = localDateKey(d);
            if (offDayDates.has(key)) continue;
            weekTarget += getTargetHoursForDate(d, currentSchedule);
        }

        document.getElementById("week-target-text")!.textContent = `Target: ${weekTarget.toFixed(1)}h`;
        const pct = weekTarget > 0 ? Math.min((weekTotal / weekTarget) * 100, 100) : 100;
        const bar = document.getElementById("week-bar") as HTMLDivElement;
        bar.style.width = `${pct}%`;
        bar.classList.toggle("bar-full", pct >= 100);

        // 4. Weekly Performance Chart (stacked by project; click a bar to load its day)
        const weeklyCanvas = document.getElementById("weekly-chart") as HTMLCanvasElement;
        if (weeklyCanvas) {
            const { text: textColor, grid: gridColor } = chartThemeColors();
            const weekDatasets = buildProjectStackDatasets(
                7, shiftsCached, s => s.project_uuid,
                s => [...shiftHoursByDay(s.start_time, s.end_time)].map(([day, h]): [number, number] => [dayKeys.indexOf(day), h]),
                projectLook,
            );
            if (weeklyChartInstance) weeklyChartInstance.destroy();
            weeklyChartInstance = new Chart(weeklyCanvas, {
                type: "bar",
                data: { labels: dayLabels, datasets: weekDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: weekDatasets.length > 1, position: "bottom", labels: { color: textColor } },
                        tooltip: stackedTotalTooltip("Day Total"),
                    },
                    scales: {
                        x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor } },
                        y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, stepSize: 2 } }
                    },
                    onClick: (evt, _els, chart) => {
                        const native = evt.native as Event | null;
                        if (!native) return;
                        const pts = chart.getElementsAtEventForMode(native, "index", { intersect: false }, false);
                        if (!pts.length) return;
                        setTimelineDay(dayKeys[pts[0].index]);
                    },
                    onHover: (evt, els) => { const el = evt.native?.target as HTMLElement | undefined; if (el) el.style.cursor = els.length ? "pointer" : "default"; }
                }
            });
        }

        // 5. ── Statistics tab Calculations ──────────────────────────
        const statsUnit = statsUnitEl.value;
        const statsCount = parseInt(statsCountEl.value) || 4;
        const includeHolidays = statsHolidaysEl.checked;

        // Hide count input for YTD
        document.getElementById("stats-count-wrap")!.style.display = statsUnit === "ytd" ? "none" : "";

        // Get end of last week
        // (Monday–Sunday weeks; this used to stop on Saturday.)
        const endOfLastWeek = endOfLastCompleteWeek(now);

        let statsStart: Date;
        if (statsUnit === "days") statsStart = addDays(endOfLastWeek, -(statsCount - 1));
        else if (statsUnit === "weeks") statsStart = addDays(endOfLastWeek, -statsCount * 7 + 1);
        else if (statsUnit === "months") statsStart = addDays(endOfLastWeek, -statsCount * 30);
        else statsStart = new Date(now.getFullYear(), 0, 1); // YTD
        statsStart.setHours(0, 0, 0, 0);

        // Clip start date to the earliest shift logged
        let firstShiftDate: Date | null = null;
        for (const s of shiftsCached) {
            const d = new Date(s.start_time);
            if (!firstShiftDate || d < firstShiftDate) firstShiftDate = d;
        }
        if (firstShiftDate && statsStart < firstShiftDate) {
            statsStart = new Date(firstShiftDate);
            statsStart.setHours(0, 0, 0, 0);
        }

        const hoursPerDay: Record<string, number> = {};
        const hoursPerWeek: Record<string, number> = {};
        let totalActual = 0;

        const statsFromMs = statsStart.getTime();
        const statsToMs = endOfLastWeek.getTime() + 1;
        for (const s of shiftsCached) {
            if (!s.end_time) continue;
            const st = Math.max(new Date(s.start_time).getTime(), statsFromMs);
            const en = Math.min(new Date(s.end_time).getTime(), statsToMs);
            for (const [dayKey, h] of splitAcrossDays(st, en)) {
                totalActual += h;
                hoursPerDay[dayKey] = (hoursPerDay[dayKey] ?? 0) + h;
                const wk = weekKey(dayStart(dayKey));
                hoursPerWeek[wk] = (hoursPerWeek[wk] ?? 0) + h;
            }
        }

        // Expected hours and off-day crediting
        let expectedHours = 0;
        const cursor = new Date(statsStart);
        while (cursor <= endOfLastWeek) {
            const targetHours = getTargetHoursForDate(cursor, currentSchedule);
            if (targetHours > 0) {
                const dk = localDateKey(cursor);
                if (!offDayDates.has(dk)) {
                    expectedHours += targetHours;
                } else if (includeHolidays) {
                    hoursPerDay[dk] = (hoursPerDay[dk] ?? 0) + targetHours;
                    const wk = weekKey(cursor);
                    hoursPerWeek[wk] = (hoursPerWeek[wk] ?? 0) + targetHours;
                }
            }
            cursor.setDate(cursor.getDate() + 1);
        }

        const periodOffDays = offDaysCached.filter(o => {
            const t = dayStart(o.date).getTime();
            return t >= statsStart.getTime() && t <= endOfLastWeek.getTime();
        });
        const daysWorked = Object.keys(hoursPerDay).length;
        const weeksWorked = Object.keys(hoursPerWeek).length;
        const totalForAvg = Object.values(hoursPerDay).reduce((a, b) => a + b, 0);
        const avgDaily = daysWorked > 0 ? totalForAvg / daysWorked : 0;
        const avgWeekly = weeksWorked > 0 ? totalForAvg / weeksWorked : 0;
        const overtime = totalActual - expectedHours;

        // Averages use complete weeks only. Before the first one ends there is
        // nothing to average: say when there will be, instead of "0h".
        const noFullWeek = statsStart > endOfLastWeek;
        document.getElementById("avg-daily")!.textContent = noFullWeek ? "–" : formatDuration(avgDaily);
        document.getElementById("avg-weekly")!.textContent = noFullWeek ? "–" : formatDuration(avgWeekly);
        // Overtime against a schedule the user never set is a made-up number:
        // ask for the schedule instead.
        const otVal = document.getElementById("overtime-val")!;
        const otCard = document.getElementById("overtime-card")!;
        if (noFullWeek) {
            otVal.textContent = "–";
            otCard.classList.remove("overtime-pos", "overtime-neg");
        } else if (localStorage.getItem("tracksuite.schedule") !== null) {
            otVal.textContent = formatSigned(overtime);
            otCard.classList.toggle("overtime-pos", overtime >= 0);
            otCard.classList.toggle("overtime-neg", overtime < 0);
        } else {
            otVal.innerHTML = `<button type="button" class="link-btn" id="btn-set-schedule">Set your schedule →</button>`;
            otCard.classList.remove("overtime-pos", "overtime-neg");
            document.getElementById("btn-set-schedule")!.addEventListener("click", () => {
                (document.querySelector('.tab-link[data-target="settings"]') as HTMLButtonElement | null)?.click();
                document.getElementById("cfg-hours-mon")?.focus();
            });
        }

        document.getElementById("avg-detail")!.innerHTML = noFullWeek
            ? `<p>Averages count complete weeks (Mon–Sun). Your first one is done on <strong>${escapeHtml(addDays(endOfLastWeek, 7).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}</strong>.</p>`
            : `
            <p>Period: <strong>${statsStart.toLocaleDateString()} – ${endOfLastWeek.toLocaleDateString()}</strong></p>
            <p>Days with logged hours: <strong>${daysWorked}</strong> · Complete weeks: <strong>${weeksWorked}</strong></p>
            <p>Total logged: <strong>${formatDuration(totalActual)}</strong> · Expected: <strong>${formatDuration(expectedHours)}</strong></p>
            ${periodOffDays.length ? `<p>Off days: <strong>${escapeHtml(summarizeReasons(periodOffDays.map(o => o.reason)))}</strong></p>` : ""}
        `;

        // 6. ── Trends Chart & Calculations ────────────────────────────
        // Honour the drill stack: a drilled-in view fixes the range + granularity
        // (e.g. the 7 days of a clicked week); otherwise use the user's selects.
        const drillView = currentTrendView();
        const granularity = drillView.granularity;
        let trendStart: Date;
        let trendEnd = now;
        if (drillView.start) {
            trendStart = new Date(drillView.start);
            trendEnd = new Date(drillView.end);
        } else {
            const trendCount = parseInt(trendCountEl.value) || 7;
            const trendUnit = trendUnitEl.value;
            if (trendUnit === "days") trendStart = addDays(now, -trendCount);
            else if (trendUnit === "weeks") trendStart = addDays(now, -trendCount * 7);
            else trendStart = addDays(now, -trendCount * 30);
        }
        trendStart.setHours(0, 0, 0, 0);
        const trendEndMs = new Date(trendEnd).setHours(23, 59, 59, 999);

        const trendRelevant = shiftsCached.filter(s => {
            const t = new Date(s.start_time).getTime();
            return t >= trendStart.getTime() && t <= trendEndMs;
        });

        // Ordered buckets, each bucket's day range (for drill), + off-day credit.
        const bucketKeysList: string[] = [];
        const bucketRange: Record<string, { start: number; end: number }> = {};
        const offdayCredit: Record<string, number> = {};
        const trendCursor = new Date(trendStart);
        while (trendCursor.getTime() <= trendEndMs) {
            const bk = bucketKey(trendCursor, granularity);
            if (!bucketKeysList.includes(bk)) bucketKeysList.push(bk);
            const dayMs = trendCursor.getTime();
            const r = bucketRange[bk];
            if (!r) bucketRange[bk] = { start: dayMs, end: dayMs };
            else { if (dayMs < r.start) r.start = dayMs; if (dayMs > r.end) r.end = dayMs; }
            const dk = localDateKey(trendCursor);
            const targetHours = getTargetHoursForDate(trendCursor, currentSchedule);
            if (includeHolidays && offDayDates.has(dk) && targetHours > 0) {
                offdayCredit[bk] = (offdayCredit[bk] ?? 0) + targetHours;
            }
            trendCursor.setDate(trendCursor.getDate() + 1);
        }
        const trendLabels = [...bucketKeysList].sort();
        const idxOf = (bk: string) => trendLabels.indexOf(bk);
        // Cache for the bar-click drill handler.
        trendLabelsCurrent = trendLabels;
        trendGranularityCurrent = granularity;
        trendBucketRange = bucketRange;

        const trendDatasets = buildProjectStackDatasets(
            trendLabels.length,
            trendRelevant.filter(s => s.end_time),
            s => s.project_uuid,
            s => [...shiftHoursByDay(s.start_time, s.end_time)].map(([day, h]): [number, number] =>
                [idxOf(bucketKey(dayStart(day), granularity)), h]),
            projectLook,
        );
        if (Object.keys(offdayCredit).length > 0) {
            let un = trendDatasets.find(d => d.label === "Unassigned");
            if (!un) {
                un = { label: "Unassigned", data: new Array(trendLabels.length).fill(0), backgroundColor: unassignedColor(), stack: "hours", borderRadius: stackedBarTopRadius(4), borderSkipped: false };
                trendDatasets.push(un);
            }
            const unRef = un;
            trendLabels.forEach((bk, i) => { if (offdayCredit[bk]) unRef.data[i] = parseFloat((unRef.data[i] + offdayCredit[bk]).toFixed(2)); });
        }

        const trendCanvas = document.getElementById("trend-chart") as HTMLCanvasElement;
        if (trendCanvas) {
            const { text: textColor, grid: gridColor } = chartThemeColors();
            if (trendChartInstance) trendChartInstance.destroy();
            trendChartInstance = new Chart(trendCanvas, {
                type: "bar",
                data: { labels: trendLabels.map(k => bucketLabel(k, granularity)), datasets: trendDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    // Anywhere in a column counts, so an empty day can be opened to add time.
                    onClick: (evt, _els, chart) => {
                        const native = evt.native as Event | null;
                        if (!native) return;
                        const pts = chart.getElementsAtEventForMode(native, "index", { intersect: false }, false);
                        if (pts.length) onTrendBarClick(pts[0].index);
                    },
                    onHover: (evt, els) => { const t = (evt.native?.target as HTMLElement | undefined); if (t) t.style.cursor = els.length ? "pointer" : "default"; },
                    plugins: {
                        legend: { display: trendDatasets.length > 1, position: "bottom", labels: { color: textColor } },
                        tooltip: stackedTotalTooltip(granularity === "month" ? "Month Total" : granularity === "week" ? "Week Total" : "Day Total"),
                    },
                    scales: {
                        x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor } },
                        y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, stepSize: 2 } }
                    }
                }
            });
        }
        renderProjectSummary(trendDatasets);
        syncDrillUI();

        // 7. ── Render the monthly off-day calendar ────────────────────
        renderOffdayCalendar();

        // 8. ── Render Shifts Table History ────────────────────────────
        const tableBody = document.getElementById("shift-table-body")!;
        const sortedShifts = shiftsCached
            .filter(s => s.end_time !== null)
            .sort((a, b) => b.start_time.localeCompare(a.start_time));

        if (sortedShifts.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center; padding: 24px;">No completed shifts yet.</td></tr>`;
        } else {
            // Grouped by day, each day with its total; a click on a row opens
            // that shift in the timeline editor (times, project, note, delete).
            let lastDay = "";
            tableBody.innerHTML = sortedShifts.slice(0, 25).map(s => {
                const startLocal = new Date(s.start_time);
                const endLocal = s.end_time ? new Date(s.end_time) : new Date();
                const dur = shiftDurationHours(s);
                const day = localDateKey(startLocal);
                const dayHeader = day === lastDay ? "" : `<tr class="day-row"><td colspan="6"><span>${escapeHtml(
                    startLocal.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}</span><span class="day-total">${formatDuration(hoursByDay.get(day) ?? 0)}</span></td></tr>`;
                lastDay = day;

                return dayHeader + `
                    <tr class="shift-row" data-id="${s.id}" title="Open in the timeline">
                        <td>${startLocal.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                        <td>${s.end_time ? endLocal.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "active"}</td>
                        <td><span class="badge badge-success">${formatDuration(dur)}</span></td>
                        <td><span class="shift-project-tag"><span class="project-dot" style="background:${projectColor(s.project_uuid)}"></span>${escapeHtml(projectName(s.project_uuid))}</span></td>
                        <td><input type="text" class="shift-note-input" data-id="${s.id}" value="${escapeHtml(s.note ?? "")}" placeholder="Add note…" maxlength="500" title="Enter: save and move down · ↓: copy the note from the row above" /></td>
                        <td style="text-align: right;">
                            <button class="btn btn-outline btn-small btn-danger delete-shift-btn" data-id="${s.id}" style="padding: 4px 8px;">Delete</button>
                        </td>
                    </tr>
                `;
            }).join("");

            const saveNoteInput = async (input: HTMLInputElement) => {
                const id = Number(input.dataset.id);
                const s = shiftsCached.find(x => x.id === id);
                if (!s) return;
                const note = input.value.trim();
                const newNote = note === "" ? null : note;
                if ((s.note ?? null) === newNote) return;
                const res = await updateShift(id, s.start_time, s.end_time, undefined, newNote);
                if (res.ok) s.note = res.data?.note ?? newNote;
                else showToast("Couldn't save the note.", { tone: "error" });
            };
            tableBody.querySelectorAll<HTMLInputElement>(".shift-note-input").forEach(input => {
                input.addEventListener("change", () => void saveNoteInput(input));
                // Carry-down flow: Enter saves and drops to the next row; ↓ copies
                // the note from the row above (fast repeats without copy-paste).
                input.addEventListener("keydown", (e) => {
                    // Neighbouring note fields, skipping the day header rows.
                    const all = [...tableBody.querySelectorAll<HTMLInputElement>(".shift-note-input")];
                    const i = all.indexOf(input);
                    if (e.key === "Enter") {
                        e.preventDefault();
                        void saveNoteInput(input);
                        all[i + 1]?.focus();
                    } else if (e.key === "ArrowDown") {
                        const prev = all[i - 1] ?? null;
                        if (prev) {
                            e.preventDefault();
                            input.value = prev.value;
                            void saveNoteInput(input);
                        }
                    }
                });
            });

            tableBody.querySelectorAll<HTMLTableRowElement>(".shift-row").forEach(row => {
                row.addEventListener("click", (e) => {
                    if ((e.target as HTMLElement).closest("input, button")) return;
                    timeline?.select(Number(row.dataset.id));
                    document.getElementById("timeline-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                });
            });

            tableBody.querySelectorAll(".delete-shift-btn").forEach(btn => {
                btn.addEventListener("click", async (e) => {
                    const target = e.currentTarget as HTMLButtonElement;
                    const id = Number(target.dataset.id);
                    if (!id) return;
                    target.disabled = true;
                    await deleteShiftUndoable(id);
                });
            });
        }
    }

    // A note for what you're doing right now, without opening the table.
    runningNote.addEventListener("change", async () => {
        const s = activeShiftCached;
        if (!s) return;
        await updateShift(s.id, s.start_time, s.end_time, undefined, runningNote.value.trim() || null);
        await refreshData();
    });
    runningNote.addEventListener("keydown", (e) => { if (e.key === "Enter") runningNote.blur(); });

    // Optional focus/break timer (Settings → Focus timer; off by default).
    const focusRing = createFocusRing(document.getElementById("focus-wrap")!, {
        notify: (title, body) => {
            if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
            else showToast(`${title} — ${body}`, { timeoutMs: 10000 });
        },
        pauseTracking: async () => {
            const s = activeShiftCached;
            if (!s) return false;
            const res = await updateShift(s.id, localIso(new Date(s.start_time)), localIso(new Date()));
            await refreshData();
            return res.ok;
        },
        resumeTracking: async () => {
            if (activeShiftCached) return;
            await createShift(localIso(new Date()), null, currentProjectUuid);
            await refreshData();
        },
    });
    renderFocusSettings(document.getElementById("focus-settings")!, {
        // Ask once, when the user turns the timer on (a user gesture).
        onEnable: () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission(); },
    });

    // Keep the open tab in the URL (#/tracker?tab=statistics), so a reload or a
    // link lands where you were.
    const tabFromUrl = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
    if (tabFromUrl && tabFromUrl !== "dashboard") showTab(tabFromUrl);

    // The tracker bar sticks right under the site nav, whatever its height.
    const navObserver = new ResizeObserver(() => {
        const nav = document.querySelector<HTMLElement>(".site-nav");
        document.documentElement.style.setProperty("--site-nav-h", `${nav?.offsetHeight ?? 0}px`);
    });
    window.setTimeout(() => {
        const nav = document.querySelector<HTMLElement>(".site-nav");
        if (nav) navObserver.observe(nav);
    }, 0);

    // Run Initial Data Pull
    refreshData();
    // Pull the shared work schedule (may adopt a newer server copy and re-render).
    void reconcileSchedule().catch(() => { /* offline: keep the local schedule */ });

    // Another device may have clocked in/out: pull fresh state whenever the tab
    // comes back, and retry every 30 s while the server is unreachable.
    const onVisible = () => { if (document.visibilityState === "visible") void refreshData(); };
    const onFocus = () => void refreshData();
    const onTheme = () => void refreshData();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("tracksuite:themechange", onTheme);
    const retryTimer = window.setInterval(() => { if (dataStale) void refreshData(); }, 30_000);

    // Leaving the tracker: nothing of it may keep acting on the next page.
    return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("tracksuite:themechange", onTheme);
        window.clearInterval(retryTimer);
        window.removeEventListener("mouseup", onOffDragMouseUp);
        if (activeTimerId !== null) { clearInterval(activeTimerId); activeTimerId = null; }
        activeKeydownHandler = null;
        activePointerMove = null;
        activePointerUp = null;
        activeDocClick = null;
        timeline?.destroy(); timeline = null;
        focusRing.destroy();
        navObserver.disconnect();
        document.title = BASE_TITLE;
        weeklyChartInstance?.destroy(); weeklyChartInstance = null;
        trendChartInstance?.destroy(); trendChartInstance = null;
    };
}
