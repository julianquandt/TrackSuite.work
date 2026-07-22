import Chart from "chart.js/auto";
import {
    getToken,
    listShifts,
    createShift,
    updateShift,
    deleteShift,
    listOffDays,
    createOffDay,
    deleteOffDay,
    listProjects,
    createProject,
    updateProject,
    deleteProject,
    type ShiftItem,
    type OffDayItem,
    type ProjectItem
} from "../api";
import { navigate } from "../router";
import { getMode, setMode, isFullMode } from "../mode";

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

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
    ));
}

function csvCell(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Readable text color for a given #rrggbb background. */
function contrastText(color: string): string {
    const m = /#?([0-9a-f]{6})/i.exec(color.trim());
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#1f2937" : "#ffffff";
}

function formatTimeFromMinutes(minutes: number): string {
    // Round to whole minutes: block-click selections carry fractional minutes
    // (derived from second-precision timestamps) that would otherwise render as
    // "09:03.7833333333".
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseLocalDayStartMs(dateKey: string): number {
    const [y, mo, d] = dateKey.split("-").map(Number);
    return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
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
function formatDuration(hours: number): string {
    const h = Math.floor(Math.abs(hours));
    const m = Math.round((Math.abs(hours) - h) * 60);
    const sign = hours < 0 ? "-" : "";
    return m > 0 ? `${sign}${h}h ${m}m` : `${sign}${h}h`;
}

function formatSigned(hours: number): string {
    const prefix = hours >= 0 ? "+" : "";
    return prefix + formatDuration(hours);
}

function shiftDurationHours(s: ShiftItem): number {
    const start = new Date(s.start_time).getTime();
    const end = s.end_time ? new Date(s.end_time).getTime() : Date.now();
    return (end - start) / 3_600_000;
}

function toDateKey(iso: string): string {
    return iso.slice(0, 10);
}

function localDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// Shift timestamps are stored as naive local wall clock ("2026-07-15T09:00:00",
// no zone) to match what the desktop app writes — never toISOString(), which
// emits UTC "Z" and produced mixed-frame shifts that 500'd /stats/daily-hours/.
// Reading side already parses zoneless date-times as local via new Date(...).
function localIso(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${localDateKey(d)}T${h}:${min}:${s}`;
}

function weekStartDate(): Date {
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday start
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - diff);
    return d;
}

function addDays(d: Date, n: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}

function weekKey(d: Date): string {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d.getTime() - jan1.getTime()) / 86_400_000);
    const wn = Math.ceil((days + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(wn).padStart(2, "0")}`;
}

function bucketKey(d: Date, granularity: string): string {
    if (granularity === "week") return weekKey(d);
    if (granularity === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return localDateKey(d);
}

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

export function renderTracker(app: HTMLElement): void {
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
            <div class="dashboard-header">
                <h2>Time Tracker</h2>
                <p>Clock in/out, view analytics, and manage settings inside the browser app.</p>
            </div>

            <!-- Tabbed Navigation -->
            <div class="tabs-nav">
                <button class="tab-link active" data-target="dashboard">Dashboard</button>
                <button class="tab-link" data-target="statistics">Statistics</button>
                <button class="tab-link" data-target="settings">Settings</button>
            </div>

            <!-- ═══ Tab: Dashboard ═══ -->
            <div class="tab-page" id="tab-dashboard">
                <!-- Stats Grid -->
                <div class="stats-grid">
                    <div class="stat-card" id="card-today">
                        <h4>Worked Today</h4>
                        <div class="stat-value" id="hours-today">0h</div>
                    </div>
                    <div class="stat-card" id="card-week">
                        <h4>Worked This Week</h4>
                        <div class="stat-value" id="hours-week">0h</div>
                    </div>
                    <div class="stat-card" id="card-shifts">
                        <h4>Shifts Logged</h4>
                        <div class="stat-value" id="shifts-count">0</div>
                    </div>
                </div>

                <!-- Auto-closed shift notice (shifts left running, closed by the server) -->
                <div id="auto-closed-banner" class="auto-closed-banner" hidden></div>

                <!-- Tracker Clock Console -->
                <div class="clock-panel" id="clock-console">
                    <span class="badge" id="clock-status">IDLE</span>
                    <div class="clock-timer" id="clock-timer">00:00:00</div>
                    <div class="project-chip-wrap" id="project-chip-wrap"></div>
                    <div class="btn-row">
                        <button class="btn btn-primary" id="btn-clock-action" type="button">Clock In</button>
                        <button class="btn btn-danger" id="btn-clock-discard" type="button" style="display:none;">Discard Current</button>
                        <button class="btn btn-outline" id="btn-add-manual" type="button">Log Shift Manually</button>
                        <button class="btn btn-outline" id="btn-manage-offdays" type="button">Manage Off Days</button>
                    </div>

                    <div class="progress-container">
                        <div class="progress-header">
                            <span>Weekly Progress</span>
                            <span id="week-target-text">Target: 36h</span>
                        </div>
                        <div class="progress-wrap">
                            <div class="progress-bar" id="week-bar" style="width: 0%;"></div>
                        </div>
                    </div>
                </div>

                <!-- Performance Chart -->
                <div class="chart-panel">
                    <h3>Weekly Performance</h3>
                    <div style="position: relative; height: 260px; width: 100%;">
                        <canvas id="weekly-chart"></canvas>
                    </div>
                </div>

                <!-- Day Timeline Editor -->
                <div class="chart-panel" id="timeline-editor-panel">
                    <div class="panel-title-row">
                        <h3>Day Timeline Editor</h3>
                        <span class="help-hint" tabindex="0" title="Click a bar in Weekly Performance to pick a day. Drag across the track to select a range (or click a segment to select it); drag the selection to move it, or its edges to resize. Then Assign a project — or Remove / press Delete to clear an assignment.">ⓘ</span>
                        <span class="muted" id="timeline-day-label" style="margin-left:auto;"></span>
                    </div>
                    <div class="timeline-editor-wrapper" id="timeline-editor-wrapper">
                        <div class="timeline-ticks" id="timeline-ticks"></div>
                        <div class="timeline-container" id="timeline-container">
                            <div class="timeline-track" id="timeline-track">
                                <div class="timeline-selection" id="timeline-selection" style="display:none;">
                                    <div class="timeline-handle handle-left" id="handle-left"></div>
                                    <div class="timeline-handle handle-right" id="handle-right"></div>
                                </div>
                            </div>
                        </div>
                        <p class="timeline-empty" id="timeline-empty" hidden>No shifts recorded on this day.</p>
                    </div>
                    <div class="timeline-controls">
                        <span class="timeline-selection-label" id="timeline-selection-label">No range selected. Drag on the timeline above to select.</span>
                        <div class="timeline-actions">
                            <select id="timeline-project-select" class="timeline-project-select" disabled></select>
                            <button class="btn btn-primary btn-small" id="btn-timeline-assign" disabled>Assign</button>
                            <button class="btn btn-outline btn-small" id="btn-timeline-remove" disabled title="Clear the project from this range (or press Delete)">Remove</button>
                        </div>
                    </div>
                    <div class="timeline-brush" id="timeline-brush">
                        <button class="btn btn-outline btn-small" id="btn-brush-toggle" type="button" title="Paint a note onto shift blocks">🖌 Note brush</button>
                        <input type="text" id="timeline-brush-note" class="timeline-brush-input" placeholder="Turn on the brush, type a note, then click blocks to stamp it" maxlength="500" disabled />
                        <span class="muted timeline-brush-hint" id="timeline-brush-hint"></span>
                    </div>
                </div>

                <!-- Shifts History Section -->
                <section class="dash-section">
                    <div class="section-row" style="display:flex; justify-content:space-between; align-items:center;">
                        <h3>Recent Shifts</h3>
                        <button class="btn btn-outline btn-small" id="btn-export-csv" type="button">Export CSV</button>
                    </div>
                    <div class="table-wrapper">
                        <table class="sessions-table">
                            <thead>
                                <tr>
                                    <th>Date</th>
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
                                    <td colspan="7" class="muted" style="text-align:center; padding: 24px;">Loading shift history…</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
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
                        <h4>Overtime Balance</h4>
                        <div class="stat-value" id="overtime-val">0h</div>
                    </div>
                </div>

                <!-- Averages Controls -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Averages Calculations</h2>
                    </div>
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
                        <label class="ctrl toggle-label" style="margin-top:20px;">
                            <input type="checkbox" id="stats-holidays" checked>
                            <span>Credit expected hours on scheduled off-days</span>
                        </label>
                    </div>
                    <div class="avg-detail" id="avg-detail"></div>
                </section>

                <!-- Trends Chart -->
                <div class="chart-panel">
                        <div class="section-row" style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                            <h3>Performance Trends</h3>
                            <div class="control-row" style="margin-bottom:0; gap:8px;">
                                <label class="ctrl" style="font-size:0.75rem;">Show last
                                    <input type="number" id="trend-count" value="7" min="1" max="90" style="padding:4px 8px; width:70px;">
                                </label>
                                <label class="ctrl" style="font-size:0.75rem;">Unit
                                    <select id="trend-unit" style="padding:4px 8px;">
                                        <option value="days" selected>Days</option>
                                        <option value="weeks">Weeks</option>
                                        <option value="months">Months</option>
                                    </select>
                                </label>
                                <label class="ctrl" style="font-size:0.75rem;">Group By
                                    <select id="trend-granularity" style="padding:4px 8px;">
                                        <option value="day" selected>Day</option>
                                        <option value="week">Week</option>
                                        <option value="month">Month</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        <div style="position: relative; height: 260px; width: 100%;">
                            <canvas id="trend-chart"></canvas>
                        </div>
                        <p class="trend-hint muted">Click a bar to edit that day’s sessions — week/month bars zoom in first.</p>
                        <div class="project-summary" id="project-summary"></div>
                </div>

                <!-- Slide-down day editor: drill into any day from the trend chart -->
                <div id="trend-drill-panel" class="trend-drill-panel" hidden>
                    <div class="trend-drill-head">
                        <div class="trend-drill-crumbs" id="trend-drill-crumbs"></div>
                        <button type="button" class="btn btn-outline trend-drill-close" id="trend-drill-close">Close</button>
                    </div>
                    <div class="trend-drill-slot" id="trend-drill-slot">
                        <p class="muted trend-drill-empty" id="trend-drill-empty">Click a day bar above to edit that day’s sessions.</p>
                    </div>
                </div>

                <!-- Scheduled off days: monthly calendar (moved to the bottom) -->
                <div class="chart-panel" id="offday-calendar-panel">
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
                    <p class="muted offcal-hint">Click a day to toggle it as an off day. Use “Manage Off Days” for bulk ranges.</p>
                </div>
            </div>

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
                        <h2>Work Schedule Configuration</h2>
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
                    <div class="btn-row">
                        <button class="btn btn-primary" id="btn-save-schedule" type="button">Save Work Schedule</button>
                        <span id="schedule-status-text" style="color: var(--success); font-size:0.9rem; align-self:center; display:none; margin-left: 12px;">Saved ✓</span>
                    </div>
                </section>

                <!-- Appearance Panel -->
                <section class="panel">
                    <div class="panel-header">
                        <h2>Theme and Aesthetics</h2>
                    </div>
                    <div class="control-row">
                        <label class="ctrl">Palette Mode
                            <select id="cfg-theme-select">
                                <option value="light">Light Mode</option>
                                <option value="dark">Dark Mode</option>
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

        <!-- Off Day Dialog -->
        <dialog id="dlg-offday" class="modal modal-wide" style="max-width: 440px;">
            <div style="padding: 4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
                    <h3 style="margin:0;">Manage Off Days</h3>
                    <button class="btn btn-ghost" type="button" id="btn-cancel-offday" style="padding: 4px 8px; font-size:1.5rem; line-height:1; border:none; background:none; cursor:pointer; color:var(--text-secondary);">&times;</button>
                </div>
                <p class="modal-note" style="margin-bottom: 16px;">Click the start date, then the end date of a range. Click "Confirm Changes" to apply.</p>
                
                <div class="calendar-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
                    <button class="btn btn-outline btn-small" id="btn-cal-prev" type="button" style="padding: 4px 10px;">&lt;</button>
                    <span id="cal-month-title" style="font-weight:700; font-size:1.1rem; color:var(--text-primary);">July 2026</span>
                    <button class="btn btn-outline btn-small" id="btn-cal-next" type="button" style="padding: 4px 10px;">&gt;</button>
                </div>
                
                <div class="calendar-days-header" style="display:grid; grid-template-columns:repeat(7, 1fr); text-align:center; font-weight:700; font-size:0.75rem; color:var(--text-secondary); margin-bottom:8px; text-transform: uppercase; letter-spacing: 0.05em;">
                    <div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
                </div>
                
                <div class="calendar-grid" id="calendar-days-grid" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:6px; min-height: 200px; margin-bottom: 16px;">
                    <!-- Rendered dynamically -->
                </div>

                <div id="calendar-selection-status" style="font-size:0.85rem; color:var(--text-secondary); margin-bottom: 16px; min-height: 1.25rem;">
                    No range selected.
                </div>

                <div class="btn-row modal-actions" style="display:flex; gap:8px; justify-content:flex-end;">
                    <button class="btn btn-ghost btn-small" type="button" id="btn-cal-clear" style="padding: 6px 12px;">Clear</button>
                    <button class="btn btn-primary btn-small" type="button" id="btn-cal-confirm" disabled style="padding: 6px 12px;">Confirm Changes</button>
                </div>
            </div>
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
    const discardBtn = document.getElementById("btn-clock-discard") as HTMLButtonElement;
    const addManualBtn = document.getElementById("btn-add-manual") as HTMLButtonElement;
    const manageOffdaysBtn = document.getElementById("btn-manage-offdays") as HTMLButtonElement;

    const dlgShift = document.getElementById("dlg-shift") as HTMLDialogElement;
    const formShift = document.getElementById("form-shift") as HTMLFormElement;
    const btnCancelShift = document.getElementById("btn-cancel-shift") as HTMLButtonElement;

    const dlgOffday = document.getElementById("dlg-offday") as HTMLDialogElement;
    const btnCancelOffday = document.getElementById("btn-cancel-offday") as HTMLButtonElement;

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

    // Averages and trends triggers
    const statsUnitEl = document.getElementById("stats-unit") as HTMLSelectElement;
    const statsCountEl = document.getElementById("stats-count") as HTMLInputElement;
    const statsHolidaysEl = document.getElementById("stats-holidays") as HTMLInputElement;

    const trendCountEl = document.getElementById("trend-count") as HTMLInputElement;
    const trendUnitEl = document.getElementById("trend-unit") as HTMLSelectElement;
    const trendGranEl = document.getElementById("trend-granularity") as HTMLSelectElement;

    const statsHandler = () => refreshData();
    [statsUnitEl, statsCountEl, statsHolidaysEl].forEach(el => {
        el.addEventListener("change", statsHandler);
    });
    // Changing the trend range/granularity redefines the root view — drop any
    // active drill so the fresh selection isn't overridden by a stale level.
    [trendCountEl, trendUnitEl, trendGranEl].forEach(el => {
        el.addEventListener("change", () => {
            restoreEditorHome();
            trendDrillStack = [];
            drillDay = null;
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
    const currentTheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    themeSelect.value = currentTheme;
    themeSelect.addEventListener("change", () => {
        const theme = themeSelect.value;
        const iconBtn = document.getElementById("theme-toggle");
        if (theme === "dark") {
            document.documentElement.classList.add("dark");
            document.documentElement.classList.remove("light");
            localStorage.setItem("theme", "dark");
        } else {
            document.documentElement.classList.add("light");
            document.documentElement.classList.remove("dark");
            localStorage.setItem("theme", "light");
        }
        // Dispatch click to update icons in nav menu
        if (iconBtn) {
            // Trigger theme repaint
            refreshData();
        }
    });

    // Tab Switching logic
    tabLinks.forEach(link => {
        link.addEventListener("click", () => {
            const btn = link as HTMLButtonElement;
            const target = btn.dataset.target;
            tabLinks.forEach(l => l.classList.remove("active"));
            btn.classList.add("active");

            tabPages.forEach(page => {
                if (page.id === `tab-${target}`) {
                    page.classList.remove("tab-hidden");
                } else {
                    page.classList.add("tab-hidden");
                }
            });

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

    // Timeline editor state (minutes-since-midnight of the selected day).
    let timelineDayKey = localDateKey(new Date());
    let timelineSpanStart = 8 * 60;
    let timelineSpanEnd = 18 * 60;
    let timelineHasShifts = false;
    let timelineSelStartMin = 0;
    let timelineSelEndMin = 0;
    let timelineStartMin: number | null = null;
    let timelineEndMin: number | null = null;
    let tlDragStartMin = 0;
    let tlDragging = false;
    let tlResizeL = false;
    let tlResizeR = false;
    let tlMoving = false;
    let tlMoveGrab = 0;
    let tlMoveOrigStart = 0;
    let tlMoveOrigEnd = 0;
    let timelineBlocks: { startMin: number; endMin: number; projectUuid: string | null }[] = [];
    // Note-brush state: when active, timeline blocks become clickable/draggable
    // to "stamp" the brush note onto their shift (range-drag is suppressed).
    let brushActive = false;
    let brushPainting = false;
    let brushDirty = false;
    // In-flight note writes from the current brush stroke. The brush-end
    // refreshData() must await these, else its GET can race ahead of the PUTs
    // and revert the freshly-stamped notes.
    let brushPending: Promise<unknown>[] = [];

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
    async function switchToProject(projectUuid: string | null) {
        currentProjectUuid = projectUuid;
        localStorage.setItem(CURRENT_PROJECT_KEY, projectUuid ?? "");
        if (activeShiftCached && (activeShiftCached.project_uuid ?? null) !== projectUuid) {
            const startMs = new Date(activeShiftCached.start_time).getTime();
            const nowMs = Date.now();
            if (nowMs - startMs < 1000) {
                await updateShift(activeShiftCached.id, activeShiftCached.start_time, null, projectUuid);
            } else {
                const nowIso = localIso(new Date(nowMs));
                await updateShift(activeShiftCached.id, activeShiftCached.start_time, nowIso, activeShiftCached.project_uuid ?? null);
                await createShift(nowIso, null, projectUuid);
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
                if (!confirm("Delete this project? Its shifts keep their time but become Unassigned.")) return;
                await deleteProject(id);
                await reloadProjects(); renderProjectsManageList(); renderProjectChip(); await refreshData();
            });
        });
    }
    function openProjectsDialog() {
        renderProjectsManageList();
        (document.getElementById("dlg-projects") as HTMLDialogElement).showModal();
    }

    // ── Client-side split + coalesce (server has no atomic endpoint) ──
    async function assignRangeMs(rangeStartMs: number, rangeEndMs: number, projectUuid: string | null) {
        if (rangeStartMs >= rangeEndMs) return;
        const overlapping = shiftsCached.filter(s => s.end_time && new Date(s.start_time).getTime() < rangeEndMs && new Date(s.end_time).getTime() > rangeStartMs);
        for (const s of overlapping) {
            const sMs = new Date(s.start_time).getTime();
            const eMs = new Date(s.end_time!).getTime();
            const oStart = Math.max(sMs, rangeStartMs);
            const oEnd = Math.min(eMs, rangeEndMs);
            if (oStart >= oEnd) continue;
            const segs: { start: number; end: number; proj: string | null }[] = [];
            if (sMs < oStart) segs.push({ start: sMs, end: oStart, proj: s.project_uuid ?? null });
            segs.push({ start: oStart, end: oEnd, proj: projectUuid });
            if (oEnd < eMs) segs.push({ start: oEnd, end: eMs, proj: s.project_uuid ?? null });
            await updateShift(s.id, localIso(new Date(segs[0].start)), localIso(new Date(segs[0].end)), segs[0].proj);
            for (const seg of segs.slice(1)) {
                await createShift(localIso(new Date(seg.start)), localIso(new Date(seg.end)), seg.proj);
            }
        }
        const fresh = await listShifts();
        if (fresh.ok) await coalesceShifts(fresh.data || []);
        await refreshData();
    }

    async function coalesceShifts(list: ShiftItem[]) {
        const closed = list.filter(s => s.end_time).sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
        let i = 0;
        while (i < closed.length) {
            const keep = closed[i];
            let mergedEndMs = new Date(keep.end_time!).getTime();
            const toDelete: ShiftItem[] = [];
            let j = i + 1;
            while (j < closed.length) {
                const cur = closed[j];
                if (new Date(cur.start_time).getTime() === mergedEndMs && (cur.project_uuid ?? null) === (keep.project_uuid ?? null)) {
                    mergedEndMs = new Date(cur.end_time!).getTime();
                    toDelete.push(cur); j++;
                } else break;
            }
            if (toDelete.length > 0) {
                await updateShift(keep.id, keep.start_time, localIso(new Date(mergedEndMs)), keep.project_uuid ?? null);
                for (const d of toDelete) await deleteShift(d.id);
            }
            i = j;
        }
    }

    // ── Timeline editor ──────────────────────────────────────────────
    function renderTimelineDayLabel() {
        const el = document.getElementById("timeline-day-label");
        if (!el) return;
        const ms = parseLocalDayStartMs(timelineDayKey || localDateKey(new Date()));
        el.textContent = new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    }

    function renderTimelineTicks() {
        const el = document.getElementById("timeline-ticks");
        if (!el) return;
        const span = timelineSpanEnd - timelineSpanStart;
        const parts: string[] = [];
        for (let i = 0; i < 5; i++) {
            const min = Math.round((timelineSpanStart + (span * i) / 4) / 5) * 5;
            parts.push(`<span>${formatTimeFromMinutes(min)}</span>`);
        }
        el.innerHTML = parts.join("");
    }

    function renderTimelineShifts() {
        const track = document.getElementById("timeline-track");
        if (!track) return;
        const selectionEl = document.getElementById("timeline-selection");
        track.innerHTML = "";
        if (selectionEl) track.appendChild(selectionEl);

        const dayStartMs = parseLocalDayStartMs(timelineDayKey);
        const dayEndMs = dayStartMs + 1440 * 60000;
        const blocks = shiftsCached
            .filter(s => s.end_time && new Date(s.start_time).getTime() < dayEndMs && new Date(s.end_time).getTime() > dayStartMs)
            .map(s => {
                const startMin = (Math.max(new Date(s.start_time).getTime(), dayStartMs) - dayStartMs) / 60000;
                const endMin = (Math.min(new Date(s.end_time!).getTime(), dayEndMs) - dayStartMs) / 60000;
                return { s, startMin, endMin, live: false };
            });

        // The running shift has no end_time, so it never lands in `blocks`. Render
        // it as a live block whose right edge tracks "now" (capped to the day) and
        // grows on the 1s clock tick — see updateLiveTimelineBlock().
        const nowMs = Date.now();
        const active = shiftsCached.find(s => s.end_time === null);
        let liveEntry: { s: ShiftItem; startMin: number; endMin: number; live: boolean } | null = null;
        if (active) {
            const st = new Date(active.start_time).getTime();
            if (st < dayEndMs && Math.min(nowMs, dayEndMs) > dayStartMs) {
                liveEntry = {
                    s: active,
                    startMin: (Math.max(st, dayStartMs) - dayStartMs) / 60000,
                    endMin: (Math.min(nowMs, dayEndMs) - dayStartMs) / 60000,
                    live: true,
                };
            }
        }

        const entries = liveEntry ? [...blocks, liveEntry] : blocks;
        timelineHasShifts = entries.length > 0;
        // Range-assign occupancy excludes the open shift: splitting a running shift
        // by range is not supported. The live block stays note-brushable only.
        timelineBlocks = blocks.map(b => ({ startMin: b.startMin, endMin: b.endMin, projectUuid: b.s.project_uuid ?? null }));

        const container = document.getElementById("timeline-container");
        const ticksEl = document.getElementById("timeline-ticks");
        const emptyEl = document.getElementById("timeline-empty");
        if (container) container.style.display = timelineHasShifts ? "" : "none";
        if (ticksEl) ticksEl.style.display = timelineHasShifts ? "" : "none";
        if (emptyEl) (emptyEl as HTMLElement).hidden = timelineHasShifts;
        renderTimelineDayLabel();

        if (!timelineHasShifts) { timelineSpanStart = 8 * 60; timelineSpanEnd = 18 * 60; return; }
        const minStart = Math.min(...entries.map(b => b.startMin));
        const maxEnd = Math.max(...entries.map(b => b.endMin));
        timelineSpanStart = Math.max(0, Math.floor((minStart - 30) / 30) * 30);
        timelineSpanEnd = Math.min(1440, Math.ceil((maxEnd + 30) / 30) * 30);
        if (timelineSpanEnd - timelineSpanStart < 60) timelineSpanEnd = Math.min(1440, timelineSpanStart + 60);
        const span = timelineSpanEnd - timelineSpanStart;

        for (const b of entries) {
            const start = new Date(b.s.start_time);
            const color = projectColor(b.s.project_uuid);
            const div = document.createElement("div");
            div.className = "timeline-shift";
            const note = b.s.note ?? "";
            if (note) div.classList.add("has-note");
            if (brushActive) div.classList.add("brushable");
            if (b.live) { div.classList.add("timeline-live"); div.id = "timeline-live-block"; }
            div.dataset.shiftId = String(b.s.id);
            div.style.left = `${((b.startMin - timelineSpanStart) / span) * 100}%`;
            div.style.width = `${((b.endMin - b.startMin) / span) * 100}%`;
            div.style.backgroundColor = color;
            div.style.color = contrastText(color);
            const name = projectName(b.s.project_uuid);
            div.innerHTML = `<span class="tl-shift-label">${escapeHtml(name)} (${((b.endMin - b.startMin) / 60).toFixed(1)}h)</span>${note ? `<span class="tl-note-dot" title="${escapeHtml(note)}">•</span>` : ""}`;
            const from = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            if (b.live) {
                div.title = note ? `${name}: ${from} – now (running)\nNote: ${note}` : `${name}: ${from} – now (running)`;
            } else {
                const times = `${from} – ${new Date(b.s.end_time!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
                div.title = note ? `${name}: ${times}\nNote: ${note}` : `${name}: ${times}`;
            }
            track.appendChild(div);
        }
        renderTimelineTicks();
    }

    // Grow the live (running-shift) block each second without a full re-render,
    // so the timeline reflects the active session in real time. Re-pads the whole
    // strip only when the block outgrows the padded span, and never yanks the DOM
    // out from under an in-progress drag/brush stroke.
    function updateLiveTimelineBlock() {
        if (!activeShiftCached) return;
        const el = document.getElementById("timeline-live-block") as HTMLElement | null;
        if (!el) return;
        if (tlDragging || tlResizeL || tlResizeR || tlMoving || brushPainting) return;
        const dayStartMs = parseLocalDayStartMs(timelineDayKey);
        const dayEndMs = dayStartMs + 1440 * 60000;
        const st = new Date(activeShiftCached.start_time).getTime();
        if (st >= dayEndMs) return;
        const startMin = (Math.max(st, dayStartMs) - dayStartMs) / 60000;
        const endMin = (Math.min(Date.now(), dayEndMs) - dayStartMs) / 60000;
        if (endMin > timelineSpanEnd) { renderTimelineShifts(); return; }
        const span = timelineSpanEnd - timelineSpanStart;
        el.style.left = `${((startMin - timelineSpanStart) / span) * 100}%`;
        el.style.width = `${((endMin - startMin) / span) * 100}%`;
        const label = el.querySelector(".tl-shift-label");
        if (label) label.textContent = `${projectName(activeShiftCached.project_uuid)} (${((endMin - startMin) / 60).toFixed(1)}h)`;
    }

    function setTimelineDay(dateKey: string) {
        timelineDayKey = dateKey;
        timelineSelStartMin = 0; timelineSelEndMin = 0;
        updateSelectionUI();
        renderTimelineShifts();
        renderTimelineProjectSelect();
        document.getElementById("timeline-editor-wrapper")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // ── Trend-chart drill-down: reach & edit ANY day's sessions ──────
    // The trend chart already spans arbitrary history; clicking a bar drills in.
    // A day bar opens that day's timeline editor (moved into the slide-down slot);
    // a week/month bar zooms the chart into its days first. A breadcrumb walks
    // back out. This is the only path to backfill projects/notes on old days.
    type TrendDrillLevel = { start: Date; end: Date; granularity: string; label: string };
    let trendDrillStack: TrendDrillLevel[] = [];
    let trendBucketRange: Record<string, { start: number; end: number }> = {};
    let trendLabelsCurrent: string[] = [];
    let trendGranularityCurrent = "day";
    let drillDay: string | null = null;
    let drillEditorOrigParent: HTMLElement | null = null;
    let drillEditorOrigNext: Node | null = null;

    // What range/granularity the trend chart should show: the top drill level, or
    // the user's configured selects at the root.
    function currentTrendView(): { start: Date | null; end: Date; granularity: string } {
        const top = trendDrillStack[trendDrillStack.length - 1];
        if (top) return { start: top.start, end: top.end, granularity: top.granularity };
        const g = (document.getElementById("trend-granularity") as HTMLSelectElement)?.value || "day";
        return { start: null, end: new Date(), granularity: g };
    }

    // Relocate the whole timeline-editor PANEL (bar + assign controls + brush,
    // which are siblings) into the drill slot and back, so the full editor is
    // reused with zero duplication. Moving only the bar left the controls behind.
    function moveEditorIntoSlot() {
        const panel = document.getElementById("timeline-editor-panel");
        const slot = document.getElementById("trend-drill-slot");
        if (!panel || !slot || panel.parentElement === slot) return;
        drillEditorOrigParent = panel.parentElement;
        drillEditorOrigNext = panel.nextSibling;
        slot.appendChild(panel);
    }
    function restoreEditorHome() {
        const panel = document.getElementById("timeline-editor-panel");
        if (panel && drillEditorOrigParent) {
            if (drillEditorOrigNext && drillEditorOrigNext.parentNode === drillEditorOrigParent)
                drillEditorOrigParent.insertBefore(panel, drillEditorOrigNext);
            else drillEditorOrigParent.appendChild(panel);
        }
        drillEditorOrigParent = null; drillEditorOrigNext = null;
    }

    function openDayDrill(dateKey: string) {
        drillDay = dateKey;
        moveEditorIntoSlot();
        const empty = document.getElementById("trend-drill-empty");
        if (empty) empty.hidden = true;
        setTimelineDay(dateKey);
        syncDrillUI();
        document.getElementById("trend-drill-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function closeTrendDrill() {
        restoreEditorHome();
        trendDrillStack = [];
        drillDay = null;
        syncDrillUI();
        void refreshData();
    }

    // Pop the drill stack to a level (-1 = root) and drop any open day.
    function drillToLevel(level: number) {
        restoreEditorHome();
        trendDrillStack = level < 0 ? [] : trendDrillStack.slice(0, level + 1);
        drillDay = null;
        const empty = document.getElementById("trend-drill-empty");
        if (empty) empty.hidden = false;
        void refreshData();
    }

    // Click on a trend bar: day bucket → open editor; week/month → zoom into days.
    function onTrendBarClick(index: number) {
        const bk = trendLabelsCurrent[index];
        if (bk == null) return;
        if (trendGranularityCurrent === "day") { openDayDrill(bk); return; }
        const range = trendBucketRange[bk];
        if (!range) return;
        const startD = new Date(range.start);
        const label = trendGranularityCurrent === "week"
            ? "Wk of " + startD.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : startD.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        trendDrillStack.push({ start: startD, end: new Date(range.end), granularity: "day", label });
        drillDay = null;
        const empty = document.getElementById("trend-drill-empty");
        if (empty) empty.hidden = false;
        void refreshData();
    }

    // Show/hide the slide-down panel and paint the breadcrumb trail.
    function syncDrillUI() {
        const panel = document.getElementById("trend-drill-panel");
        const crumbs = document.getElementById("trend-drill-crumbs");
        if (!panel || !crumbs) return;
        const open = trendDrillStack.length > 0 || drillDay != null;
        panel.hidden = !open;
        if (!open) return;
        const parts = [`<button type="button" class="crumb" data-level="-1">All</button>`];
        trendDrillStack.forEach((lvl, i) => {
            parts.push(`<span class="crumb-sep">▸</span><button type="button" class="crumb" data-level="${i}">${escapeHtml(lvl.label)}</button>`);
        });
        if (drillDay) {
            const d = new Date(drillDay + "T00:00:00");
            parts.push(`<span class="crumb-sep">▸</span><span class="crumb crumb-current">${escapeHtml(d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</span>`);
        }
        crumbs.innerHTML = parts.join("");
        crumbs.querySelectorAll(".crumb[data-level]").forEach(b =>
            b.addEventListener("click", () => drillToLevel(parseInt((b as HTMLElement).dataset.level!))));
    }

    function renderTimelineProjectSelect() {
        const select = document.getElementById("timeline-project-select") as HTMLSelectElement | null;
        if (!select) return;
        const prev = select.value || currentProjectUuid || "";
        const active = projectsCached.filter(p => !p.archived);
        select.innerHTML = [`<option value="">Unassigned</option>`, ...active.map(p => `<option value="${p.uuid}">${escapeHtml(p.name)}</option>`)].join("");
        select.value = active.some(p => p.uuid === prev) ? prev : "";
    }

    function updateSelectionUI() {
        const selectionEl = document.getElementById("timeline-selection") as HTMLElement | null;
        const labelEl = document.getElementById("timeline-selection-label");
        const selectEl = document.getElementById("timeline-project-select") as HTMLSelectElement | null;
        const assignBtn = document.getElementById("btn-timeline-assign") as HTMLButtonElement | null;
        const removeBtn = document.getElementById("btn-timeline-remove") as HTMLButtonElement | null;
        if (!selectionEl || !labelEl || !selectEl || !assignBtn) return;
        if (timelineSelStartMin === timelineSelEndMin) {
            selectionEl.style.display = "none";
            labelEl.textContent = "No range selected. Drag on the timeline above to select.";
            selectEl.disabled = true; assignBtn.disabled = true; if (removeBtn) removeBtn.disabled = true;
            timelineStartMin = null; timelineEndMin = null;
        } else {
            selectionEl.style.display = "block";
            const span = timelineSpanEnd - timelineSpanStart;
            selectionEl.style.left = `${((timelineSelStartMin - timelineSpanStart) / span) * 100}%`;
            selectionEl.style.width = `${((timelineSelEndMin - timelineSelStartMin) / span) * 100}%`;
            const durMin = Math.round(timelineSelEndMin - timelineSelStartMin);
            const h = Math.floor(durMin / 60), m = durMin % 60;
            labelEl.textContent = `Selected: ${formatTimeFromMinutes(timelineSelStartMin)} to ${formatTimeFromMinutes(timelineSelEndMin)} (${h > 0 ? `${h}h ${m}m` : `${m}m`})`;
            selectEl.disabled = false; assignBtn.disabled = false; if (removeBtn) removeBtn.disabled = false;
            timelineStartMin = timelineSelStartMin; timelineEndMin = timelineSelEndMin;
        }
    }

    function getMinutesFromEvent(e: MouseEvent | TouchEvent, trackEl: HTMLElement): number {
        const rect = trackEl.getBoundingClientRect();
        const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const span = timelineSpanEnd - timelineSpanStart;
        return Math.round((timelineSpanStart + pct * span) / 5) * 5;
    }

    // Stamp the brush note onto one shift block, updating the DOM optimistically
    // and persisting. Skips a no-op so dragging across a block doesn't re-write it.
    async function stampNoteOnBlock(el: HTMLElement): Promise<void> {
        const id = Number(el.dataset.shiftId);
        const s = shiftsCached.find(x => x.id === id);
        if (!s) return;
        const raw = (document.getElementById("timeline-brush-note") as HTMLInputElement).value.trim();
        const newNote = raw === "" ? null : raw;
        if ((s.note ?? null) === newNote) return;
        s.note = newNote;
        el.classList.toggle("has-note", !!newNote);
        el.classList.add("just-stamped");
        setTimeout(() => el.classList.remove("just-stamped"), 400);
        let dot = el.querySelector(".tl-note-dot");
        if (newNote && !dot) el.insertAdjacentHTML("beforeend", `<span class="tl-note-dot">•</span>`);
        else if (!newNote && dot) dot.remove();
        brushDirty = true;
        // Persist; the optimistic DOM stays even on failure — the brush-end
        // refreshData() reconciles against the server either way.
        await updateShift(id, s.start_time, s.end_time, undefined, newNote);
    }

    function initBrush() {
        const toggle = document.getElementById("btn-brush-toggle") as HTMLButtonElement | null;
        const input = document.getElementById("timeline-brush-note") as HTMLInputElement | null;
        const hint = document.getElementById("timeline-brush-hint");
        const wrapper = document.getElementById("timeline-editor-wrapper");
        if (!toggle || !input || !hint || !wrapper) return;
        toggle.addEventListener("click", () => {
            brushActive = !brushActive;
            toggle.classList.toggle("active", brushActive);
            wrapper.classList.toggle("brush-mode", brushActive);
            input.disabled = !brushActive;
            // Brush mode and range-assign are mutually exclusive interactions.
            if (brushActive) {
                timelineSelStartMin = timelineSelEndMin = 0;
                updateSelectionUI();
                hint.textContent = "Click a block to stamp the note; drag across to cover several. Empty note = erase.";
                input.focus();
            } else {
                hint.textContent = "";
            }
            renderTimelineShifts();
        });
    }

    function initTimelineDrag() {
        const track = document.getElementById("timeline-track");
        const handleLeft = document.getElementById("handle-left");
        const handleRight = document.getElementById("handle-right");
        const selectionEl = document.getElementById("timeline-selection");
        if (!track || !handleLeft || !handleRight || !selectionEl) return;

        const startDrag = (e: MouseEvent | TouchEvent) => {
            if (brushActive) return; // brush mode owns block clicks; no range-select
            if (selectionEl.contains(e.target as Node)) return;
            tlDragging = true;
            tlDragStartMin = getMinutesFromEvent(e, track);
            timelineSelStartMin = tlDragStartMin; timelineSelEndMin = tlDragStartMin;
            updateSelectionUI();
            if (e.cancelable) e.preventDefault();
        };
        track.addEventListener("mousedown", startDrag);
        track.addEventListener("touchstart", startDrag, { passive: false });

        // Note-brush painting: stamp the brush note onto blocks in brush mode.
        const brushBlockFromEvent = (e: Event): HTMLElement | null =>
            (e.target as HTMLElement)?.closest(".timeline-shift") as HTMLElement | null;
        const brushDown = (e: MouseEvent | TouchEvent) => {
            if (!brushActive) return;
            const blk = brushBlockFromEvent(e);
            if (!blk) return;
            if (e.cancelable) e.preventDefault();
            brushPainting = true;
            brushPending.push(stampNoteOnBlock(blk));
        };
        const brushOver = (e: MouseEvent) => {
            if (!brushActive || !brushPainting) return;
            const blk = brushBlockFromEvent(e);
            if (blk) brushPending.push(stampNoteOnBlock(blk));
        };
        track.addEventListener("mousedown", brushDown);
        track.addEventListener("touchstart", brushDown, { passive: false });
        track.addEventListener("mouseover", brushOver);
        track.addEventListener("touchmove", (e) => {
            if (!brushActive || !brushPainting) return;
            const t = e.touches[0];
            const el = document.elementFromPoint(t.clientX, t.clientY)?.closest(".timeline-shift") as HTMLElement | null;
            if (el) brushPending.push(stampNoteOnBlock(el));
        }, { passive: true });

        const startMove = (e: MouseEvent | TouchEvent) => {
            if (e.target === handleLeft || e.target === handleRight) return;
            e.stopPropagation();
            tlMoving = true;
            tlMoveGrab = getMinutesFromEvent(e, track);
            tlMoveOrigStart = timelineSelStartMin; tlMoveOrigEnd = timelineSelEndMin;
            if (e.cancelable) e.preventDefault();
        };
        selectionEl.addEventListener("mousedown", startMove);
        selectionEl.addEventListener("touchstart", startMove, { passive: false });

        handleLeft.addEventListener("mousedown", (e) => { e.stopPropagation(); tlResizeL = true; });
        handleLeft.addEventListener("touchstart", (e) => { e.stopPropagation(); tlResizeL = true; }, { passive: true });
        handleRight.addEventListener("mousedown", (e) => { e.stopPropagation(); tlResizeR = true; });
        handleRight.addEventListener("touchstart", (e) => { e.stopPropagation(); tlResizeR = true; }, { passive: true });

        const onMove = (e: MouseEvent | TouchEvent) => {
            if (tlDragging) {
                const cur = getMinutesFromEvent(e, track);
                timelineSelStartMin = Math.min(tlDragStartMin, cur);
                timelineSelEndMin = Math.max(tlDragStartMin, cur);
                updateSelectionUI();
            } else if (tlResizeL) {
                const cur = getMinutesFromEvent(e, track);
                if (cur < timelineSelEndMin) { timelineSelStartMin = cur; updateSelectionUI(); }
            } else if (tlResizeR) {
                const cur = getMinutesFromEvent(e, track);
                if (cur > timelineSelStartMin) { timelineSelEndMin = cur; updateSelectionUI(); }
            } else if (tlMoving) {
                const width = tlMoveOrigEnd - tlMoveOrigStart;
                const delta = getMinutesFromEvent(e, track) - tlMoveGrab;
                const ns = Math.max(timelineSpanStart, Math.min(tlMoveOrigStart + delta, timelineSpanEnd - width));
                timelineSelStartMin = ns; timelineSelEndMin = ns + width;
                updateSelectionUI();
            }
        };
        const onEnd = () => {
            if (brushPainting) {
                brushPainting = false;
                if (brushDirty) {
                    brushDirty = false;
                    // Wait for the stroke's writes to commit before reconciling,
                    // or the GET races the PUTs and reverts the stamped notes.
                    const pend = brushPending; brushPending = [];
                    void Promise.allSettled(pend).then(() => refreshData());
                }
            }
            const wasClick = tlDragging && timelineSelStartMin === timelineSelEndMin;
            tlDragging = false; tlResizeL = false; tlResizeR = false; tlMoving = false;
            if (wasClick) {
                const min = timelineSelStartMin;
                const blk = timelineBlocks.find(b => min >= b.startMin && min < b.endMin);
                if (blk) {
                    timelineSelStartMin = blk.startMin; timelineSelEndMin = blk.endMin;
                    const sel = document.getElementById("timeline-project-select") as HTMLSelectElement | null;
                    if (sel) sel.value = blk.projectUuid || "";
                    updateSelectionUI();
                }
            }
        };
        activePointerMove = onMove;
        activePointerUp = onEnd;
    }

    async function applyTimelineRange(projectUuid: string | null) {
        if (timelineStartMin === null || timelineEndMin === null) return;
        const dayStartMs = parseLocalDayStartMs(timelineDayKey);
        const rangeStartMs = dayStartMs + timelineStartMin * 60000;
        const rangeEndMs = dayStartMs + timelineEndMin * 60000;
        timelineSelStartMin = 0; timelineSelEndMin = 0; updateSelectionUI();
        await assignRangeMs(rangeStartMs, rangeEndMs, projectUuid);
    }

    // ── Stacked-by-project chart datasets ────────────────────────────
    type BarRadius = { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };
    function stackedBarTopRadius(r: number) {
        return (ctx: { dataIndex: number; datasetIndex: number; chart: Chart }): BarRadius => {
            const datasets = ctx.chart.data.datasets;
            let topIdx = -1;
            for (let i = 0; i < datasets.length; i++) { const v = datasets[i].data[ctx.dataIndex] as number; if (v && v > 0) topIdx = i; }
            const isTop = ctx.datasetIndex === topIdx;
            return { topLeft: isTop ? r : 0, topRight: isTop ? r : 0, bottomLeft: 0, bottomRight: 0 };
        };
    }
    function buildProjectStackDatasets(bucketCount: number, list: ShiftItem[], hoursOf: (s: ShiftItem) => number, bucketOf: (s: ShiftItem) => number) {
        const buckets = new Map<string, number[]>();
        const ensure = (k: string) => { let a = buckets.get(k); if (!a) { a = new Array(bucketCount).fill(0); buckets.set(k, a); } return a; };
        for (const s of list) { const b = bucketOf(s); if (b < 0 || b >= bucketCount) continue; ensure(s.project_uuid || "")[b] += hoursOf(s); }
        const keys = [...buckets.keys()].sort((a, b) => a === "" ? 1 : b === "" ? -1 : projectName(a).localeCompare(projectName(b)));
        const radius = stackedBarTopRadius(4);
        return keys.map(k => ({
            label: k ? projectName(k) : "Unassigned",
            data: buckets.get(k)!.map(v => parseFloat(v.toFixed(2))),
            backgroundColor: k ? projectColor(k) : unassignedColor(),
            stack: "hours", borderRadius: radius, borderSkipped: false,
        }));
    }
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
    renderTimelineDayLabel();
    initTimelineDrag();
    initBrush();
    document.getElementById("trend-drill-close")?.addEventListener("click", closeTrendDrill);
    document.getElementById("btn-timeline-assign")?.addEventListener("click", () => {
        const sel = document.getElementById("timeline-project-select") as HTMLSelectElement;
        void applyTimelineRange(sel.value || null);
    });
    document.getElementById("btn-timeline-remove")?.addEventListener("click", () => void applyTimelineRange(null));

    document.getElementById("btn-export-csv")?.addEventListener("click", () => {
        const rows: string[] = [];
        rows.push("[Shifts]");
        rows.push(["ID", "Start Time", "End Time", "Duration (Hours)", "Project"].join(","));
        for (const s of shiftsCached) {
            const dur = shiftDurationHours(s).toFixed(2);
            rows.push([String(s.id), s.start_time, s.end_time ?? "", dur, csvCell(projectName(s.project_uuid))].join(","));
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
    // Number keys: 0 = Unassigned, 1–9 = Nth project. Delete clears a timeline selection.
    activeKeydownHandler = (e) => {
        const tag = (e.target as HTMLElement | null)?.tagName;
        const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
        if ((e.key === "Delete" || e.key === "Backspace") && !typing && timelineStartMin !== null && timelineEndMin !== null) {
            e.preventDefault();
            void applyTimelineRange(null);
            return;
        }
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
        const todayStr = localDateKey(new Date());
        (document.getElementById("inp-shift-start-date") as HTMLInputElement).value = todayStr;
        (document.getElementById("inp-shift-end-date") as HTMLInputElement).value = todayStr;
        (document.getElementById("inp-shift-start-time") as HTMLInputElement).value = "09:00";
        (document.getElementById("inp-shift-end-time") as HTMLInputElement).value = "17:00";
        (document.getElementById("inp-shift-note") as HTMLInputElement).value = "";
        const errEl = document.getElementById("shift-error")!;
        errEl.textContent = "";
        errEl.style.display = "none";
        dlgShift.showModal();
    });

    btnCancelShift.addEventListener("click", () => dlgShift.close());

    let calYear = new Date().getFullYear();
    let calMonth = new Date().getMonth();
    let selectionStart: string | null = null;
    let selectionEnd: string | null = null;

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

    function updateCalendarView() {
        const grid = document.getElementById("calendar-days-grid");
        const title = document.getElementById("cal-month-title");
        if (!grid || !title) return;

        title.textContent = `${monthNames[calMonth]} ${calYear}`;
        grid.innerHTML = "";

        const firstDay = new Date(calYear, calMonth, 1);
        let startOffset = firstDay.getDay();
        startOffset = startOffset === 0 ? 6 : startOffset - 1;

        const numDays = new Date(calYear, calMonth + 1, 0).getDate();
        const offDayDates = new Map(offDaysCached.map(o => [o.date, o.id]));
        const todayStr = localDateKey(new Date());

        for (let i = 0; i < startOffset; i++) {
            const emptyCell = document.createElement("div");
            emptyCell.className = "cal-empty";
            grid.appendChild(emptyCell);
        }

        for (let day = 1; day <= numDays; day++) {
            const cell = document.createElement("div");
            cell.textContent = String(day);

            const mStr = String(calMonth + 1).padStart(2, "0");
            const dStr = String(day).padStart(2, "0");
            const dateKey = `${calYear}-${mStr}-${dStr}`;

            if (dateKey === todayStr) {
                cell.classList.add("cal-today");
            }

            const offDayId = offDayDates.get(dateKey);
            if (offDayId !== undefined) {
                cell.classList.add("cal-offday");
            }

            if (selectionStart !== null && selectionEnd !== null) {
                if (dateKey >= selectionStart && dateKey <= selectionEnd) {
                    cell.classList.add("cal-selected");
                }
            }

            cell.addEventListener("click", () => {
                if (selectionStart === null) {
                    selectionStart = dateKey;
                    selectionEnd = dateKey;
                } else if (selectionStart !== null && selectionEnd === selectionStart) {
                    selectionEnd = dateKey;
                    if (selectionEnd < selectionStart) {
                        const tmp = selectionStart;
                        selectionStart = selectionEnd;
                        selectionEnd = tmp;
                    }
                } else {
                    selectionStart = dateKey;
                    selectionEnd = dateKey;
                }
                updateCalendarView();
            });

            grid.appendChild(cell);
        }

        // Update Selection Status and Buttons
        const statusEl = document.getElementById("calendar-selection-status");
        const confirmBtn = document.getElementById("btn-cal-confirm") as HTMLButtonElement;

        if (statusEl && confirmBtn) {
            if (selectionStart === null || selectionEnd === null) {
                statusEl.textContent = "No range selected. Click a start date, then end date.";
                confirmBtn.disabled = true;
            } else {
                const rangeDates = getDatesInRange(selectionStart, selectionEnd);
                const toAdd = rangeDates.filter(d => !offDayDates.has(d));
                const toRemove = rangeDates.filter(d => offDayDates.has(d));
                statusEl.textContent = `Selected: ${selectionStart} to ${selectionEnd} (${rangeDates.length} days: ${toAdd.length} to add, ${toRemove.length} to remove).`;
                confirmBtn.disabled = false;
            }
        }
    }

    // Inline monthly off-day calendar on the Statistics tab. Clicking a day
    // toggles it; bulk ranges still go through the "Manage Off Days" modal.
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
            if (dateKey === todayStr) cell.classList.add("cal-today");
            const offId = offDayIds.get(dateKey);
            if (offId !== undefined) cell.classList.add("cal-offday");
            cell.title = offId !== undefined ? "Off day — click to remove" : "Click to mark as an off day";
            cell.addEventListener("click", async () => {
                try {
                    if (offId !== undefined) await deleteOffDay(offId);
                    else await createOffDay(dateKey);
                    await refreshData();
                } catch (err) { console.error("Failed to toggle off day", err); }
            });
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

    manageOffdaysBtn.addEventListener("click", () => {
        calYear = new Date().getFullYear();
        calMonth = new Date().getMonth();
        selectionStart = null;
        selectionEnd = null;
        updateCalendarView();
        dlgOffday.showModal();
    });

    btnCancelOffday.addEventListener("click", () => dlgOffday.close());

    document.getElementById("btn-cal-prev")?.addEventListener("click", () => {
        calMonth--;
        if (calMonth < 0) {
            calMonth = 11;
            calYear--;
        }
        updateCalendarView();
    });

    document.getElementById("btn-cal-next")?.addEventListener("click", () => {
        calMonth++;
        if (calMonth > 11) {
            calMonth = 0;
            calYear++;
        }
        updateCalendarView();
    });

    document.getElementById("btn-cal-clear")?.addEventListener("click", () => {
        selectionStart = null;
        selectionEnd = null;
        updateCalendarView();
    });

    const btnCalConfirm = document.getElementById("btn-cal-confirm") as HTMLButtonElement;
    btnCalConfirm?.addEventListener("click", async () => {
        if (!selectionStart || !selectionEnd) return;
        btnCalConfirm.disabled = true;
        btnCalConfirm.textContent = "Saving...";

        const rangeDates = getDatesInRange(selectionStart, selectionEnd);
        const offDayDates = new Map(offDaysCached.map(o => [o.date, o.id]));

        for (const date of rangeDates) {
            try {
                const offDayId = offDayDates.get(date);
                if (offDayId !== undefined) {
                    await deleteOffDay(offDayId);
                } else {
                    await createOffDay(date);
                }
            } catch (err) {
                console.error(`Failed to toggle off day for ${date}:`, err);
            }
        }

        selectionStart = null;
        selectionEnd = null;
        await refreshData();
        btnCalConfirm.textContent = "Confirm Changes";
        dlgOffday.close();
    });

    // Save Work Schedule
    document.getElementById("btn-save-schedule")?.addEventListener("click", () => {
        const schedule: WorkSchedule = {
            mon: parseFloat((document.getElementById("cfg-hours-mon") as HTMLInputElement).value) || 0,
            tue: parseFloat((document.getElementById("cfg-hours-tue") as HTMLInputElement).value) || 0,
            wed: parseFloat((document.getElementById("cfg-hours-wed") as HTMLInputElement).value) || 0,
            thu: parseFloat((document.getElementById("cfg-hours-thu") as HTMLInputElement).value) || 0,
            fri: parseFloat((document.getElementById("cfg-hours-fri") as HTMLInputElement).value) || 0,
            sat: parseFloat((document.getElementById("cfg-hours-sat") as HTMLInputElement).value) || 0,
            sun: parseFloat((document.getElementById("cfg-hours-sun") as HTMLInputElement).value) || 0
        };
        saveWorkSchedule(schedule);
        currentSchedule = schedule;

        const savedText = document.getElementById("schedule-status-text")!;
        savedText.style.display = "inline";
        setTimeout(() => { savedText.style.display = "none"; }, 2000);

        refreshData();
    });

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
        clockBtn.disabled = true;
        try {
            if (activeShiftCached) {
                // Clock Out
                const end = localIso(new Date());
                const res = await updateShift(activeShiftCached.id, activeShiftCached.start_time, end);
                if (res.ok) {
                    stopTimer();
                    await refreshData();
                } else {
                    alert("Failed to clock out: server error");
                }
            } else {
                // Clock In (tagged with the current project)
                const start = localIso(new Date());
                const res = await createShift(start, null, currentProjectUuid);
                if (res.ok) {
                    await refreshData();
                } else {
                    alert("Failed to clock in: server error");
                }
            }
        } catch (e) {
            console.error(e);
        } finally {
            clockBtn.disabled = false;
        }
    });

    // Clock Discard Action
    discardBtn.addEventListener("click", async () => {
        if (activeShiftCached && confirm("Discard the current active shift? This time will not be recorded.")) {
            discardBtn.disabled = true;
            try {
                const res = await deleteShift(activeShiftCached.id);
                if (res.ok) {
                    stopTimer();
                    await refreshData();
                } else {
                    alert("Failed to delete shift: server error");
                }
            } catch (e) {
                console.error(e);
            } finally {
                discardBtn.disabled = false;
            }
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
                timerEl.textContent = "00:00:00";
                return;
            }
            const sec = Math.floor(elapsedMs / 1000) % 60;
            const min = Math.floor(elapsedMs / 60000) % 60;
            const hrs = Math.floor(elapsedMs / 3600000);
            timerEl.textContent = `${String(hrs).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
            updateLiveTimelineBlock();
        };

        updateText();
        activeTimerId = window.setInterval(updateText, 1000);
    }

    function stopTimer() {
        if (activeTimerId !== null) {
            clearInterval(activeTimerId);
            activeTimerId = null;
        }
        document.getElementById("clock-timer")!.textContent = "00:00:00";
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
            .map(s => toDateKey(s.start_time))
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

    async function refreshData() {
        const [shiftsResp, offdaysResp, projectsResp] = await Promise.all([listShifts(), listOffDays(), listProjects()]);

        if (!shiftsResp.ok || !offdaysResp.ok) {
            if (shiftsResp.status === 401 || offdaysResp.status === 401) {
                stopTimer();
                navigate("#/login");
                return;
            }
            return;
        }

        shiftsCached = shiftsResp.data || [];
        offDaysCached = offdaysResp.data || [];
        if (projectsResp.ok) projectsCached = projectsResp.data || [];
        activeShiftCached = shiftsCached.find(s => s.end_time === null) || null;

        // Project chip, timeline, and per-shift picker options.
        renderProjectChip();
        renderTimelineProjectSelect();
        renderTimelineShifts();
        renderAutoClosedBanner();

        const offDayDates = new Set(offDaysCached.map(o => o.date));
        const now = new Date();

        // 1. Clock panel active state & Discard button
        const statusEl = document.getElementById("clock-status")!;
        if (activeShiftCached) {
            statusEl.textContent = "TRACKING";
            statusEl.className = "badge badge-success";
            clockBtn.textContent = "Clock Out";
            clockBtn.className = "btn btn-danger";
            discardBtn.style.display = "inline-block";
            startTimer(activeShiftCached.start_time);
        } else {
            statusEl.textContent = "IDLE";
            statusEl.className = "badge";
            clockBtn.textContent = "Clock In";
            clockBtn.className = "btn btn-primary";
            discardBtn.style.display = "none";
            stopTimer();
        }

        // 2. Today hours
        const todayKey = localDateKey(now);
        const todayHours = shiftsCached
            .filter(s => toDateKey(s.start_time) === todayKey)
            .reduce((sum, s) => sum + shiftDurationHours(s), 0);
        document.getElementById("hours-today")!.textContent = formatDuration(todayHours);

        // 3. Week hours & chart data
        const ws = weekStartDate();
        const dayLabels: string[] = [];
        const dayKeys: string[] = [];
        let weekTotal = 0;
        const isDark = document.documentElement.classList.contains("dark");

        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            const key = localDateKey(d);
            dayKeys.push(key);
            dayLabels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
            weekTotal += shiftsCached
                .filter(s => toDateKey(s.start_time) === key)
                .reduce((sum, s) => sum + shiftDurationHours(s), 0);
        }

        document.getElementById("hours-week")!.textContent = formatDuration(weekTotal);
        document.getElementById("shifts-count")!.textContent = String(shiftsCached.filter(s => s.end_time !== null).length);

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
            const textColor = isDark ? "#888888" : "#4b5563";
            const gridColor = isDark ? "#222222" : "#e5e7eb";
            const weekDatasets = buildProjectStackDatasets(7, shiftsCached, shiftDurationHours, (s) => dayKeys.indexOf(toDateKey(s.start_time)));
            if (weeklyChartInstance) weeklyChartInstance.destroy();
            weeklyChartInstance = new Chart(weeklyCanvas, {
                type: "bar",
                data: { labels: dayLabels, datasets: weekDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: weekDatasets.length > 1, position: "bottom", labels: { color: textColor } } },
                    scales: {
                        x: { stacked: true, grid: { color: gridColor }, ticks: { color: textColor } },
                        y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, stepSize: 2 } }
                    },
                    onClick: (evt, _els, chart) => {
                        const native = evt.native as Event | null;
                        if (!native) return;
                        const pts = chart.getElementsAtEventForMode(native, "index", { intersect: false }, false);
                        if (!pts.length) return;
                        // The weekly bar edits in the editor's home slot; if a trend
                        // drill has it in the slide-down, send it back first.
                        if (drillDay != null || trendDrillStack.length) { restoreEditorHome(); trendDrillStack = []; drillDay = null; syncDrillUI(); }
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
        const dayOfWeek = now.getDay();
        const daysSinceSunday = dayOfWeek === 0 ? 0 : dayOfWeek;
        const endOfLastWeek = new Date(now);
        endOfLastWeek.setDate(endOfLastWeek.getDate() - daysSinceSunday - 1);
        endOfLastWeek.setHours(23, 59, 59, 999);

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

        for (const s of shiftsCached) {
            if (!s.end_time) continue;
            const st = new Date(s.start_time);
            const en = new Date(s.end_time);
            if (st < statsStart || st > endOfLastWeek) continue;

            const dur = (en.getTime() - st.getTime()) / 3_600_000;
            totalActual += dur;
            const dayKey = toDateKey(s.start_time);
            hoursPerDay[dayKey] = (hoursPerDay[dayKey] ?? 0) + dur;
            const wk = weekKey(st);
            hoursPerWeek[wk] = (hoursPerWeek[wk] ?? 0) + dur;
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

        const daysWorked = Object.keys(hoursPerDay).length;
        const weeksWorked = Object.keys(hoursPerWeek).length;
        const totalForAvg = Object.values(hoursPerDay).reduce((a, b) => a + b, 0);
        const avgDaily = daysWorked > 0 ? totalForAvg / daysWorked : 0;
        const avgWeekly = weeksWorked > 0 ? totalForAvg / weeksWorked : 0;
        const overtime = totalActual - expectedHours;

        document.getElementById("avg-daily")!.textContent = formatDuration(avgDaily);
        document.getElementById("avg-weekly")!.textContent = formatDuration(avgWeekly);
        document.getElementById("overtime-val")!.textContent = formatSigned(overtime);

        const otCard = document.getElementById("overtime-card")!;
        otCard.classList.toggle("overtime-pos", overtime >= 0);
        otCard.classList.toggle("overtime-neg", overtime < 0);

        document.getElementById("avg-detail")!.innerHTML = `
            <p>Period: <strong>${statsStart.toLocaleDateString()} – ${endOfLastWeek.toLocaleDateString()}</strong></p>
            <p>Days with logged hours: <strong>${daysWorked}</strong> · Complete weeks: <strong>${weeksWorked}</strong></p>
            <p>Total logged: <strong>${formatDuration(totalActual)}</strong> · Expected: <strong>${formatDuration(expectedHours)}</strong></p>
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
            trendRelevant,
            (s) => (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 3_600_000,
            (s) => (s.end_time ? idxOf(bucketKey(new Date(s.start_time), granularity)) : -1),
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
            const textColor = isDark ? "#888888" : "#4b5563";
            const gridColor = isDark ? "#222222" : "#e5e7eb";
            if (trendChartInstance) trendChartInstance.destroy();
            trendChartInstance = new Chart(trendCanvas, {
                type: "bar",
                data: { labels: trendLabels, datasets: trendDatasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    onClick: (_evt, els) => { if (els.length) onTrendBarClick(els[0].index); },
                    onHover: (evt, els) => { const t = (evt.native?.target as HTMLElement | undefined); if (t) t.style.cursor = els.length ? "pointer" : "default"; },
                    plugins: { legend: { display: trendDatasets.length > 1, position: "bottom", labels: { color: textColor } } },
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
            tableBody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center; padding: 24px;">No completed shifts logged.</td></tr>`;
        } else {
            tableBody.innerHTML = sortedShifts.slice(0, 25).map(s => {
                const startLocal = new Date(s.start_time);
                const endLocal = s.end_time ? new Date(s.end_time) : new Date();
                const dur = shiftDurationHours(s);

                return `
                    <tr>
                        <td><strong>${startLocal.toLocaleDateString()}</strong></td>
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
                else alert("Failed to save note: server error.");
            };
            tableBody.querySelectorAll<HTMLInputElement>(".shift-note-input").forEach(input => {
                input.addEventListener("change", () => void saveNoteInput(input));
                // Carry-down flow: Enter saves and drops to the next row; ↓ copies
                // the note from the row above (fast repeats without copy-paste).
                input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        void saveNoteInput(input);
                        const next = input.closest("tr")?.nextElementSibling?.querySelector(".shift-note-input") as HTMLInputElement | null;
                        next?.focus();
                    } else if (e.key === "ArrowDown") {
                        const prev = input.closest("tr")?.previousElementSibling?.querySelector(".shift-note-input") as HTMLInputElement | null;
                        if (prev) {
                            e.preventDefault();
                            input.value = prev.value;
                            void saveNoteInput(input);
                        }
                    }
                });
            });

            tableBody.querySelectorAll(".delete-shift-btn").forEach(btn => {
                btn.addEventListener("click", async (e) => {
                    const target = e.currentTarget as HTMLButtonElement;
                    const id = Number(target.dataset.id);
                    if (id && confirm("Are you sure you want to delete this shift record?")) {
                        target.disabled = true;
                        try {
                            const delRes = await deleteShift(id);
                            if (delRes.ok) {
                                await refreshData();
                            } else {
                                alert("Failed to delete shift: Server error.");
                            }
                        } catch (err) {
                            console.error("Error deleting shift:", err);
                            alert("Failed to delete shift: Network or server error.");
                        } finally {
                            target.disabled = false;
                        }
                    }
                });
            });
        }
        updateCalendarView();
    }

    // Run Initial Data Pull
    refreshData();
}
