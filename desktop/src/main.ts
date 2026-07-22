import Chart from "chart.js/auto";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./styles.css";
import { shifts, offDays, projects, settings } from "./lib/storage";
import {
  DEFAULT_AUTO_RESUME_CONFIG,
  WORKDAY_KEYS,
  type AutoResumeConfig,
  type ProjectRecord,
  type ShiftRecord,
  type SyncConfig,
  type AppearanceConfig,
  type WorkScheduleConfig,
  type WorkdayHours,
  type WorkdayKey,
} from "./lib/domain";
import { DEFAULT_WORK_SCHEDULE, getAdjustedWeeklyTargetHours, getTargetHoursForDate, getWeeklyTargetHours } from "./lib/workSchedule";
import { isFullMode, loadMode, setModePersisted } from "./lib/mode";
import { getRemoteProfile, saveRemoteProfile, getRemoteSchedule, saveRemoteSchedule, type ReportProfile } from "./lib/api";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found");

let notificationPermissionGranted: boolean | null = null;

// ── Project state ───────────────────────────────────────────────────
let projectsCache: ProjectRecord[] = [];
let currentProjectUuid: string | null = null;
let timelineDate = "";
// The visible window is the day's worked span (earliest→latest shift, padded),
// expressed in minutes-since-midnight — not a fixed 24h.
let timelineSpanStart = 8 * 60;
let timelineSpanEnd = 18 * 60;
let timelineHasShifts = false;
let timelineStartMin: number | null = null;
let timelineEndMin: number | null = null;
let timelineDragStartMin = 0;
let timelineSelStartMin = 0;
let timelineSelEndMin = 0;
let isTimelineDragging = false;
let isTimelineResizingLeft = false;
let isTimelineResizingRight = false;
let isTimelineMoving = false;
let timelineMoveGrabMin = 0;
let timelineMoveOrigStart = 0;
let timelineMoveOrigEnd = 0;
// The day's rendered segments, for click-to-select on the track.
let timelineBlocks: { startMin: number; endMin: number; projectUuid: string | null }[] = [];
// Note-brush state: when active, timeline blocks become clickable/draggable to
// "stamp" the brush note onto their shift (range-drag is suppressed).
let brushActive = false;
let brushPainting = false;
let brushDirty = false;
let brushStroke = new Set<number>();
// In-flight note writes from the current stroke; the brush-end refresh must
// await these, else its read can race ahead of the writes and revert the notes.
let brushPending: Promise<unknown>[] = [];

const PROJECT_PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
];
const UNASSIGNED_FALLBACK = "#94a3b8";

/** Neutral color for unassigned time, theme-aware (light in dark mode). */
function unassignedColor(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--project-unassigned").trim() || UNASSIGNED_FALLBACK;
}

function projectById(uuid: string | null | undefined): ProjectRecord | null {
  if (!uuid) return null;
  return projectsCache.find((p) => p.uuid === uuid) ?? null;
}

function projectColor(uuid: string | null | undefined): string {
  return projectById(uuid)?.color || unassignedColor();
}

function projectName(uuid: string | null | undefined): string {
  return projectById(uuid)?.name ?? "Unassigned";
}

/** Readable text color (dark or light) for a given #rrggbb background. */
function contrastText(color: string): string {
  const m = /#?([0-9a-f]{6})/i.exec(color.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#1f2937" : "#ffffff";
}

/** Pick the first palette color not already used by an existing project. */
function nextProjectColor(): string {
  const used = new Set(projectsCache.map((p) => p.color).filter(Boolean));
  return PROJECT_PALETTE.find((c) => !used.has(c))
    ?? PROJECT_PALETTE[projectsCache.length % PROJECT_PALETTE.length];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
  ));
}

async function loadProjects() {
  const [list, current] = await Promise.all([
    projects.getProjects(),
    projects.getCurrentProject(),
  ]);
  projectsCache = list;
  currentProjectUuid = current;
}

/** Send a desktop notification (silently no-ops if permissions denied). */
async function notify(title: string, body?: string) {
  try {
    try {
      await invoke("show_native_notification", { title, body: body ?? null });
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "native-linux-notifications-unsupported") {
        console.warn("Desktop notification failed", error);
        return;
      }
    }

    if (notificationPermissionGranted === null) {
      notificationPermissionGranted = await isPermissionGranted();
      if (!notificationPermissionGranted) {
        notificationPermissionGranted = (await requestPermission()) === "granted";
      }
    }
    if (notificationPermissionGranted) {
      sendNotification({ title, body });
    }
  } catch (error) {
    console.warn("Desktop notification failed", error);
  }
}

async function autostartIsEnabled() {
  return await invoke<boolean>("autostart_is_enabled");
}

async function autostartEnable() {
  await invoke("autostart_enable");
}

async function autostartDisable() {
  await invoke("autostart_disable");
}

/** Update the tray menu label and icon to match current tracking state. */
async function syncTrayState() {
  try {
    await invoke("update_tray_label", { label: isTracking ? "Clock Out" : "Clock In" });
    await invoke("update_tray_icon", { tracking: isTracking });
  } catch { /* tray not available in dev */ }
}


let currentWorkSchedule: WorkScheduleConfig = {
  dailyHours: { ...DEFAULT_WORK_SCHEDULE.dailyHours },
};
let currentAutoResumeConfig: AutoResumeConfig = { ...DEFAULT_AUTO_RESUME_CONFIG };

const AUTO_RESUME_PENDING_KEY = "auto_resume_pending";

type AutoResumePendingState = {
  date: string;
  endedAt: string;
};

const WORKDAY_LABELS: Record<WorkdayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};


function formatHoursValue(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

// ── Helpers ─────────────────────────────────────────────────────────

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

function shiftDurationHours(s: ShiftRecord): number {
  const start = new Date(s.startTime).getTime();
  const end = s.endTime ? new Date(s.endTime).getTime() : Date.now();
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

function formatTimeFromMinutes(minutes: number): string {
  // Round to whole minutes: block-click selections carry fractional minutes
  // (derived from second-precision timestamps) that would otherwise render as
  // "09:03.7833333333".
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseLocalDate(dateStr: string, timeStr: string): Date {
  const parts = dateStr.split("-").map(Number);
  const timeParts = timeStr.split(":").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1], timeParts[2] || 0);
}

function weekStartDate(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = start
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

function combineManualDateTime(dateText: string, timeText: string): string | null {
  const date = normalizeDateInputValue(dateText);
  const time = normalizeTimeInputValue(timeText);
  if (!date || !time) return null;
  return `${date}T${time}:00`;
}

function setDialogError(elementId: string, message: string) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearDialogError(elementId: string) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = "";
  el.hidden = true;
}

function inclusiveDateRange(startDate: string, endDate: string): string[] {
  let start = dateInputToLocalDate(startDate);
  let end = dateInputToLocalDate(endDate);
  if (start > end) [start, end] = [end, start];

  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function setScheduleStatus(message: string) {
  document.getElementById("schedule-status")!.textContent = message;
}

function timeTextToMinutes(timeText: string): number {
  const [hours, minutes] = timeText.split(":").map(Number);
  return hours * 60 + minutes;
}

function setAutoResumeStatus(message: string) {
  const el = document.getElementById("auto-resume-status");
  if (el) el.textContent = message;
}

function updateAutoResumeInputsDisabledState() {
  const enabled = (document.getElementById("cfg-auto-resume-enabled") as HTMLInputElement | null)?.checked ?? false;
  const startInput = document.getElementById("cfg-auto-resume-start") as HTMLInputElement | null;
  const endInput = document.getElementById("cfg-auto-resume-end") as HTMLInputElement | null;
  if (startInput) startInput.disabled = !enabled;
  if (endInput) endInput.disabled = !enabled;
}

function readAutoResumeConfigFromInputs(): AutoResumeConfig | null {
  const enabled = (document.getElementById("cfg-auto-resume-enabled") as HTMLInputElement | null)?.checked ?? false;
  const startTime = normalizeTimeInputValue((document.getElementById("cfg-auto-resume-start") as HTMLInputElement | null)?.value ?? "");
  const endTime = normalizeTimeInputValue((document.getElementById("cfg-auto-resume-end") as HTMLInputElement | null)?.value ?? "");

  if (!startTime || !endTime) return null;
  if (timeTextToMinutes(startTime) >= timeTextToMinutes(endTime)) return null;

  return { enabled, startTime, endTime };
}

function setAutoResumeInputs(config: AutoResumeConfig) {
  const enabledInput = document.getElementById("cfg-auto-resume-enabled") as HTMLInputElement | null;
  const startInput = document.getElementById("cfg-auto-resume-start") as HTMLInputElement | null;
  const endInput = document.getElementById("cfg-auto-resume-end") as HTMLInputElement | null;

  if (enabledInput) enabledInput.checked = config.enabled;
  if (startInput) startInput.value = config.startTime;
  if (endInput) endInput.value = config.endTime;

  updateAutoResumeInputsDisabledState();
}

async function setAutoResumePending(pending: AutoResumePendingState | null) {
  await invoke("set_config", {
    key: AUTO_RESUME_PENDING_KEY,
    value: pending ? JSON.stringify(pending) : "",
  });
}

async function readAutoResumePending(): Promise<AutoResumePendingState | null> {
  const raw = await invoke<string | null>("get_config", { key: AUTO_RESUME_PENDING_KEY });
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AutoResumePendingState>;
    if (
      typeof parsed.date === "string"
      && normalizeDateInputValue(parsed.date)
      && typeof parsed.endedAt === "string"
    ) {
      return {
        date: parsed.date,
        endedAt: parsed.endedAt,
      };
    }
  } catch {
    // Ignore invalid persisted pending state.
  }

  return null;
}

async function consumeAutoResumePending(): Promise<AutoResumePendingState | null> {
  const pending = await readAutoResumePending();
  await setAutoResumePending(null);
  return pending;
}

function shouldAutoResumeShift(now: Date, config: AutoResumeConfig): boolean {
  if (!config.enabled) return false;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= timeTextToMinutes(config.startTime)
    && currentMinutes <= timeTextToMinutes(config.endTime);
}

async function saveAutoResumeConfigFromInputs() {
  const config = readAutoResumeConfigFromInputs();
  updateAutoResumeInputsDisabledState();

  if (!config) {
    setAutoResumeStatus("Start time must be earlier than end time.");
    return;
  }

  await settings.saveAutoResumeConfig(config);
  currentAutoResumeConfig = { ...config };
  setAutoResumeStatus("Saved ✓");
}

async function handleSystemSuspend() {
  const activeShift = await shifts.getActiveShift();
  if (!activeShift) {
    await setAutoResumePending(null);
    return;
  }

  await shifts.endShift();

  if (currentAutoResumeConfig.enabled) {
    await setAutoResumePending({
      date: localDateKey(new Date()),
      endedAt: new Date().toISOString(),
    });
  } else {
    await setAutoResumePending(null);
  }

  await refresh();
  notify("Auto Clock-Out", "System is suspending — shift ended automatically");
  performSync();
}

async function handleSystemResume() {
  const pending = await consumeAutoResumePending();
  if (!pending) return;

  const now = new Date();
  if (pending.date !== localDateKey(now)) return;
  if (!shouldAutoResumeShift(now, currentAutoResumeConfig)) return;
  if (await shifts.getActiveShift()) return;

  await shifts.startShift();
  await refresh();
  notify("Auto Clock-In", "Shift resumed after system wake");
}

// ── Liveness heartbeat + stale-session recovery ─────────────────────
// system-suspend is unreliable (no inhibitor lock; never fires on crash or
// power loss), so a shift can be left open and later closed to "now" —
// producing runaway durations. While tracking we stamp last_active_at every
// few minutes; on startup / resume / focus / tick we retro-close any
// desktop-origin shift whose heartbeat has gone stale, to its last active
// time (the Rust side does the check and the close).
const HEARTBEAT_MS = 5 * 60 * 1000;
const STALE_MINUTES = 11; // ~2 missed beats before we consider a session dead
let heartbeatTimer: number | null = null;
let liveBlockTimer: number | null = null;

function updateHeartbeat() {
  if (isTracking && heartbeatTimer === null) {
    heartbeatTimer = window.setInterval(() => {
      void (async () => {
        // A fired tick after a long gap means the app was frozen/asleep:
        // recover first, then beat for the (possibly fresh) shift.
        await checkStaleAndRecover();
        if (isTracking) await shifts.heartbeat();
      })();
    }, HEARTBEAT_MS);
  } else if (!isTracking && heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Per-second ticker that grows the live timeline block while tracking. There's
  // no other sub-minute UI clock in the desktop app, so this is dedicated.
  if (isTracking && liveBlockTimer === null) {
    liveBlockTimer = window.setInterval(updateLiveTimelineBlock, 1000);
  } else if (!isTracking && liveBlockTimer !== null) {
    window.clearInterval(liveBlockTimer);
    liveBlockTimer = null;
  }
}

async function checkStaleAndRecover() {
  let closed;
  try {
    closed = await shifts.reconcileStaleShift(STALE_MINUTES);
  } catch {
    return; // non-critical; try again on the next trigger
  }
  if (!closed) return;
  await refresh();
  const endLabel = new Date(closed.endTime).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  notify(
    "Shift auto-closed",
    `A shift left running was closed at ${endLabel}. Review it if the time looks off.`,
  );
  // Within work hours, resume a fresh shift (mirrors suspend/resume behaviour).
  if (
    currentAutoResumeConfig.enabled &&
    shouldAutoResumeShift(new Date(), currentAutoResumeConfig) &&
    !(await shifts.getActiveShift())
  ) {
    await shifts.startShift();
    await refresh();
    notify("Auto Clock-In", "Shift resumed");
  }
  performSync();
}

function getScheduleHoursInput(day: WorkdayKey): HTMLInputElement | null {
  return document.getElementById(`cfg-hours-${day}`) as HTMLInputElement | null;
}

function updateHolidayToggleLabel() {
  const label = document.getElementById("stats-holidays-label");
  if (!label) return;
  label.textContent = "Include off-days as credited hours";
}

function readWorkScheduleFromInputs(): WorkScheduleConfig | null {
  const dailyHours = {} as WorkdayHours;

  for (const day of WORKDAY_KEYS) {
    const input = getScheduleHoursInput(day);
    const parsed = Number(input?.value ?? "");
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    dailyHours[day] = Math.round(parsed * 100) / 100;
  }

  return { dailyHours };
}

function setWorkScheduleInputs(schedule: WorkScheduleConfig) {
  for (const day of WORKDAY_KEYS) {
    const input = getScheduleHoursInput(day);
    if (input) input.value = formatHoursValue(schedule.dailyHours[day] ?? 0);
  }
}

function renderWorkScheduleSummary(schedule: WorkScheduleConfig) {
  const summary = document.getElementById("schedule-summary");
  if (!summary) return;

  const weeklyTarget = getWeeklyTargetHours(schedule);
  const daySummaries = WORKDAY_KEYS
    .filter((day) => (schedule.dailyHours[day] ?? 0) > 0)
    .map((day) => `${WORKDAY_LABELS[day]} ${formatHoursValue(schedule.dailyHours[day])} h`);

  if (daySummaries.length === 0) {
    summary.textContent = `Weekly target: ${formatHoursValue(weeklyTarget)} h. No scheduled workdays configured.`;
    return;
  }

  summary.textContent = `Weekly target: ${formatHoursValue(weeklyTarget)} h. ${daySummaries.join(" · ")}`;
}

function updateWorkSchedulePreview() {
  const schedule = readWorkScheduleFromInputs();
  if (!schedule) {
    const summary = document.getElementById("schedule-summary");
    if (summary) summary.textContent = "Enter 0 hours or more for each day.";
    return;
  }

  renderWorkScheduleSummary(schedule);
}

// ── Tab state ───────────────────────────────────────────────────────

type Tab = "dashboard" | "statistics" | "reports" | "settings";

function switchTab(tab: Tab) {
  // The trend drill borrows the timeline editor into the Statistics tab; send it
  // home before showing any other tab (esp. the dashboard, which owns it).
  if (tab !== "statistics") restoreDrill();
  document.querySelectorAll<HTMLElement>(".tab-page").forEach((p) => {
    const active = p.dataset.tab === tab;
    p.classList.toggle("tab-hidden", !active);
  });
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((b) => {
    b.classList.toggle("tab-active", b.dataset.tab === tab);
  });
  if (tab === "dashboard") { refresh(); }
  if (tab === "settings") loadSettings();
  if (tab === "reports") renderReportsTab();
  if (tab === "statistics") {
    refreshStats();
    if (trendChart) trendChart.resize();
  }
}

// ── Render ──────────────────────────────────────────────────────────

app.innerHTML = `
  <div id="update-bar" class="update-bar" style="display:none">
    <span id="update-msg">A new version is available!</span>
    <button id="btn-update">Install &amp; Restart</button>
    <span id="update-alt-hint" class="update-alt-hint" style="display:none"></span>
    <button id="btn-update-alt" style="display:none"></button>
    <button id="btn-dismiss-update" class="btn-link">Dismiss</button>
  </div>
  <main class="shell">
    <header class="dash-header">
      <h1>TrackSuite.work</h1>
      <nav class="tab-bar">
        <button class="tab-btn tab-active" data-tab="dashboard">Dashboard</button>
        <button class="tab-btn" data-tab="statistics">Statistics</button>
        <button class="tab-btn tab-full-only" data-tab="reports" hidden>Reports</button>
        <button class="tab-btn" data-tab="settings">Settings</button>
      </nav>
      <div id="project-chip-wrap" class="project-chip-wrap"></div>
      <div id="clock-btn-wrap"></div>
    </header>

    <!-- ═══ Dashboard tab ═══ -->
    <div class="tab-page" data-tab="dashboard">
      <section class="stats-grid">
        <div class="stat-card" id="stat-today">
          <p class="stat-label">Today</p>
          <p class="stat-value" id="today-hours">–</p>
        </div>
        <div class="stat-card" id="stat-week">
          <p class="stat-label">This week</p>
          <p class="stat-value" id="week-hours">–</p>
        </div>
        <div class="stat-card" id="stat-status">
          <p class="stat-label">Status</p>
          <p class="stat-value" id="status-text">–</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Weekly hours</h2>
          <p class="muted" id="week-target">Target: ${formatHoursValue(getWeeklyTargetHours(DEFAULT_WORK_SCHEDULE))} h</p>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar" id="week-bar"></div>
        </div>
        <div class="chart-wrap" style="height:220px"><canvas id="weekly-chart"></canvas></div>
      </section>

      <!-- Day Timeline Editor -->
      <section class="panel" id="timeline-editor-panel">
        <div class="panel-header">
          <div class="panel-title-row">
            <h2>Day timeline editor</h2>
            <span class="help-hint" tabindex="0" title="Click a bar in Weekly hours to pick a day. Drag across the track to select a range (or click a segment to select it); drag the selection to move it, or its edges to resize. Then Assign a project — or Remove / press Delete to clear an assignment.">ⓘ</span>
          </div>
          <span class="muted" id="timeline-day-label"></span>
        </div>

        <div class="timeline-editor-wrapper" id="timeline-editor-wrapper">
          <div class="timeline-ticks" id="timeline-ticks"></div>
          <div class="timeline-container" id="timeline-container">
            <div class="timeline-track" id="timeline-track">
              <div class="timeline-selection" id="timeline-selection" style="display: none;">
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
            <button class="btn btn-primary btn-sm" id="btn-timeline-assign" disabled>Assign</button>
            <button class="btn btn-ghost btn-sm" id="btn-timeline-remove" disabled title="Clear the project from this range (or press Delete)">Remove</button>
          </div>
        </div>
        <div class="timeline-brush" id="timeline-brush">
          <button class="btn btn-ghost btn-sm" id="btn-brush-toggle" type="button" title="Paint a note onto shift blocks">🖌 Note brush</button>
          <input type="text" id="timeline-brush-note" class="timeline-brush-input" placeholder="Turn on the brush, type a note, then click blocks to stamp it" maxlength="500" disabled>
          <span class="muted timeline-brush-hint" id="timeline-brush-hint"></span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Recent shifts</h2>
          <div class="btn-row">
            <button class="btn btn-sm" id="btn-add-shift">+ Add shift</button>
            <button class="btn btn-sm" id="btn-jump-offdays" title="Jump to the off-days calendar">Off days ↓</button>
            <button class="btn btn-sm" id="btn-export">Export CSV</button>
            <button class="btn btn-sm" id="btn-import">Import CSV</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Start</th><th>End</th><th>Duration</th><th>Project</th><th>Note</th><th></th></tr>
            </thead>
            <tbody id="shift-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" id="offdays-panel">
        <div class="panel-header">
          <h2>Off days</h2>
          <div class="btn-row offcal-nav">
            <button class="btn btn-sm" id="offcal-prev" aria-label="Previous month">‹</button>
            <span class="offcal-title" id="offcal-title"></span>
            <button class="btn btn-sm" id="offcal-next" aria-label="Next month">›</button>
          </div>
        </div>
        <div class="calendar-days-header">
          <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
        </div>
        <div class="calendar-grid" id="offcal-grid"></div>
        <p class="muted offcal-hint">Drag across days to mark them as off days — drag over existing off days to clear them. Click a single day to toggle it.</p>
      </section>
    </div>

    <!-- ═══ Statistics tab ═══ -->
    <div class="tab-page tab-hidden" data-tab="statistics">
      <section class="stats-grid">
        <div class="stat-card">
          <p class="stat-label">Avg daily</p>
          <p class="stat-value" id="avg-daily">–</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Avg weekly</p>
          <p class="stat-value" id="avg-weekly">–</p>
        </div>
        <div class="stat-card" id="overtime-card">
          <p class="stat-label">Overtime</p>
          <p class="stat-value" id="overtime-val">–</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Averages</h2>
        </div>
        <div class="control-row">
          <label class="ctrl">
            Period
            <select id="stats-unit">
              <option value="days">Days</option>
              <option value="weeks" selected>Weeks</option>
              <option value="months">Months</option>
              <option value="ytd">Year to date</option>
            </select>
          </label>
          <label class="ctrl" id="stats-count-wrap">
            Count
            <input type="number" id="stats-count" value="4" min="1" max="365">
          </label>
          <label class="ctrl toggle-label">
            <input type="checkbox" id="stats-holidays">
            <span id="stats-holidays-label">Include off-days as credited hours</span>
          </label>
        </div>
        <div class="avg-detail" id="avg-detail"></div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Trends</h2>
        </div>
        <div class="control-row">
          <label class="ctrl">
            Show last
            <input type="number" id="trend-count" value="7" min="1" max="365">
          </label>
          <label class="ctrl">
            Unit
            <select id="trend-unit">
              <option value="days" selected>Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </label>
          <label class="ctrl">
            Group by
            <select id="trend-granularity">
              <option value="day" selected>Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
        </div>
        <div class="chart-wrap" style="height:280px"><canvas id="trend-chart"></canvas></div>
        <p class="trend-hint muted">Click a bar to edit that day’s sessions — week/month bars zoom in first.</p>
        <div class="project-summary" id="project-summary"></div>

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
      </section>
    </div>

    <!-- ═══ Reports tab (Full mode) ═══ -->
    <div class="tab-page tab-hidden" data-tab="reports">
      <section class="panel">
        <div class="panel-header"><h2>Reports</h2></div>
        <p class="muted">Generate a billable summary or a timesheet from your tracked time. Set your letterhead and per-project rates, pick a range, then export CSV or print to PDF.</p>
      </section>

      <details class="panel" id="rp-profile-panel">
        <summary class="reports-summary-toggle"><strong>Letterhead &amp; Profile</strong><span class="muted"> — appears at the top of printed reports</span></summary>
        <div id="rp-profile-unavailable" class="muted" hidden>Configure sync (server URL + key) in Settings to use the shared report profile.</div>
        <div id="rp-profile-body" hidden>
          <div class="reports-profile-grid">
            <label>Your name<input type="text" id="pf-name" maxlength="120" placeholder="e.g. Alex Rivera"></label>
            <label>Company<input type="text" id="pf-company" maxlength="120" placeholder="ACME GmbH"></label>
            <label>Email<input type="text" id="pf-email" maxlength="160" placeholder="you@example.com"></label>
            <label>Default currency<input type="text" id="pf-currency" maxlength="8" placeholder="EUR"></label>
            <label class="span2">Address<textarea id="pf-address" rows="2" placeholder="Street 1&#10;12345 City"></textarea></label>
            <label class="span2">Letterhead / header note<textarea id="pf-header" rows="2" placeholder="Invoice — freelance software work"></textarea></label>
            <label class="span2">Footer<textarea id="pf-footer" rows="2" placeholder="Bank: … · IBAN: …"></textarea></label>
          </div>
          <div class="reports-custom-fields">
            <h4>Custom fields</h4>
            <p class="muted">Extra key/value lines for the letterhead (e.g. VAT ID).</p>
            <div id="pf-custom-list"></div>
            <button class="btn btn-outline btn-small" type="button" id="pf-add-field">+ Add field</button>
          </div>
          <div class="btn-row" style="margin-top:16px">
            <button class="btn btn-primary" type="button" id="pf-save">Save profile</button>
            <span class="muted" id="pf-status"></span>
          </div>
        </div>
      </details>

      <section class="panel no-print">
        <div class="panel-header"><h2>Generate</h2></div>
        <p class="muted">Hourly rates are set per project — open the project menu and choose <strong>Manage projects</strong>.</p>
        <div class="reports-filter-grid">
          <label>Style<select id="rp-style">
            <option value="client">Client report (hours × rate)</option>
            <option value="timesheet">Timesheet (hours vs target)</option>
          </select></label>
          <label>From<input type="date" id="rp-from"></label>
          <label>To<input type="date" id="rp-to"></label>
          <label>Project<select id="rp-project"><option value="">All projects</option></select></label>
          <label class="reports-check" id="rp-detailed-wrap"><input type="checkbox" id="rp-detailed" checked> Itemized breakdown</label>
          <label class="reports-check" id="rp-times-wrap"><input type="checkbox" id="rp-times"> Show work times (don't pool same day)</label>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary" type="button" id="rp-generate">Generate</button>
          <button class="btn btn-outline" type="button" id="rp-csv">Export CSV</button>
          <button class="btn btn-outline" type="button" id="rp-print">Print / Save as PDF</button>
        </div>
      </section>

      <section class="report-output" id="report-output" hidden></section>
    </div>

    <!-- ═══ Settings tab ═══ -->
    <div class="tab-page tab-hidden" data-tab="settings">
      <section class="panel">
        <div class="panel-header"><h2>Mode</h2></div>
        <p class="muted"><strong>Simple</strong> keeps the app focused on tracking. <strong>Full</strong> adds billing rates, a report letterhead, and the Reports tab. Shift notes are available in both.</p>
        <div class="form-grid">
          <label class="form-label">App Mode
            <select id="cfg-mode">
              <option value="simple">Simple</option>
              <option value="full">Full (reports &amp; billing)</option>
            </select>
          </label>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header"><h2>Work schedule</h2></div>
        <p class="muted">Set the scheduled hours for each day. Days with 0 hours are treated as non-working days, and off-days reduce your target by the configured hours for that specific date.</p>
        <div class="schedule-hours-grid">
          <label class="schedule-hour-row"><span>Monday</span><input type="number" id="cfg-hours-mon" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Tuesday</span><input type="number" id="cfg-hours-tue" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Wednesday</span><input type="number" id="cfg-hours-wed" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Thursday</span><input type="number" id="cfg-hours-thu" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Friday</span><input type="number" id="cfg-hours-fri" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Saturday</span><input type="number" id="cfg-hours-sat" min="0" step="0.1" inputmode="decimal"></label>
          <label class="schedule-hour-row"><span>Sunday</span><input type="number" id="cfg-hours-sun" min="0" step="0.1" inputmode="decimal"></label>
        </div>
        <p class="muted" id="schedule-summary"></p>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" id="btn-save-schedule">Save work schedule</button>
          <span class="muted" id="schedule-status"></span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header"><h2>Appearance</h2></div>
        <div class="form-grid">
          <label class="form-label">Theme
            <select id="cfg-theme">
              <option value="system">System Default</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label class="form-label">Color Palette
            <select id="cfg-palette">
              <option value="default">Classic Blue</option>
              <option value="minimal">Minimal Mono</option>
              <option value="emerald">Mossy Waters</option>
              <option value="nord">Nordic Fjord</option>
              <option value="forest">Deep Forest</option>
              <option value="pastel">Lavender Field</option>
              <option value="sunset">Ember Dusk</option>
            </select>
          </label>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header"><h2>System</h2></div>
        <div class="form-grid">
          <label class="form-label toggle-label">
            <span>Launch on login</span>
            <input type="checkbox" id="cfg-autostart">
          </label>
          <label class="form-label toggle-label">
            <span>Auto-resume after suspend during working hours</span>
            <input type="checkbox" id="cfg-auto-resume-enabled">
          </label>
          <div class="auto-resume-time-grid">
            <label class="form-label">Working hours start
              <input type="time" id="cfg-auto-resume-start" step="60">
            </label>
            <label class="form-label">Working hours end
              <input type="time" id="cfg-auto-resume-end" step="60">
            </label>
          </div>
          <p class="muted">Only resumes shifts that were ended automatically on suspend, only on the same day, and only within the configured local time window.</p>
          <p class="muted" id="auto-resume-status"></p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header"><h2>Server sync</h2></div>
        <p class="muted">Generate and manage sync API keys in the TrackSuite.work web dashboard. The desktop app only needs the API base URL and one sync key.</p>
        <div class="form-grid">
          <label class="form-label">Server URL
            <input type="url" id="cfg-url" placeholder="https://example.com/api or https://example.com/tracksuite-work-api">
          </label>
          <label class="form-label">Sync API Key
            <input type="password" id="cfg-key" placeholder="your-api-key">
          </label>
        </div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" id="btn-save-cfg">Save</button>
          <button class="btn" id="btn-sync-now">Sync now</button>
          <span class="muted" id="sync-status"></span>
        </div>
      </section>
    </div>
  </main>

  <!-- Add shift dialog -->
  <dialog id="dlg-shift" class="modal modal-wide">
    <form id="form-shift">
      <h3>Add shift manually</h3>
      <p class="modal-note">Enter dates as YYYY-MM-DD and times as 24-hour HH:MM.</p>
      <p id="shift-form-error" class="modal-error" hidden></p>
      <div class="modal-grid">
        <label>Start date
          <input type="text" id="inp-shift-start-date" placeholder="2026-04-01" inputmode="numeric" autocomplete="off" spellcheck="false" required>
        </label>
        <label>Start time
          <input type="text" id="inp-shift-start-time" placeholder="09:00" inputmode="numeric" autocomplete="off" spellcheck="false" required>
        </label>
        <label>End date
          <input type="text" id="inp-shift-end-date" placeholder="2026-04-01" inputmode="numeric" autocomplete="off" spellcheck="false" required>
        </label>
        <label>End time
          <input type="text" id="inp-shift-end-time" placeholder="17:30" inputmode="numeric" autocomplete="off" spellcheck="false" required>
        </label>
      </div>
      <label style="display:block; margin-top: 10px;">Note (optional)
        <input type="text" id="inp-shift-note" placeholder="What did you work on?" maxlength="500" autocomplete="off">
      </label>
      <div class="btn-row modal-actions">
        <button class="btn btn-primary" type="submit">Add</button>
        <button class="btn btn-ghost" type="button" id="btn-cancel-shift">Cancel</button>
      </div>
    </form>
  </dialog>

  <!-- Manage projects dialog -->
  <dialog id="dlg-projects" class="modal modal-wide">
    <h3>Manage projects</h3>
    <p class="modal-note">Rename, recolor, or archive projects. Archived projects stay on past shifts but drop out of the picker.</p>
    <div id="projects-manage-list" class="projects-manage-list"></div>
    <form id="form-new-project" class="new-project-row">
      <input type="color" id="new-project-color" value="#3b82f6" title="Project color">
      <input type="text" id="new-project-name" placeholder="New project name" autocomplete="off" spellcheck="false" maxlength="60">
      <button class="btn btn-primary btn-sm" type="submit">Add</button>
    </form>
    <div class="btn-row modal-actions">
      <button class="btn btn-ghost" type="button" id="btn-close-projects">Done</button>
    </div>
  </dialog>

  <!-- Onboarding dialog -->
  <dialog id="dlg-whats-new" class="modal">
    <h3>What's New</h3>
    <div id="whats-new-body" class="whats-new-body"></div>
    <div class="btn-row modal-actions">
      <button class="btn btn-primary" type="button" id="btn-whats-new-close">Got it</button>
    </div>
  </dialog>

  <dialog id="dlg-onboarding" class="modal onboarding">
    <div class="onboarding-step" data-step="welcome">
      <h3>Welcome to TrackSuite.work</h3>
      <p>Track your working hours effortlessly. TrackSuite.work runs in your system tray and keeps a local record of every shift.</p>
      <ul class="onboarding-features">
        <li>Clock in &amp; out with one click</li>
        <li>Automatic clock-out on system suspend</li>
        <li>Weekly charts &amp; statistics</li>
        <li>Optional server sync for backups</li>
      </ul>
      <div class="btn-row modal-actions">
        <button class="btn btn-primary" id="onb-next-1">Get started</button>
      </div>
    </div>

    <div class="onboarding-step" data-step="autostart" style="display:none">
      <h3>Launch on login?</h3>
      <p>TrackSuite.work can start automatically when you log in so you never forget to clock in.</p>
      <label class="form-label toggle-label" style="margin:18px 0">
        <span>Enable autostart</span>
        <input type="checkbox" id="onb-autostart" checked>
      </label>
      <div class="btn-row modal-actions">
        <button class="btn btn-ghost" id="onb-back-2">Back</button>
        <button class="btn btn-primary" id="onb-next-2">Next</button>
      </div>
    </div>

    <div class="onboarding-step" data-step="sync" style="display:none">
      <h3>Server sync (optional)</h3>
      <p>If you have a TrackSuite.work server, enter the API base URL and sync key below. You can always configure this later in Settings.</p>
      <label class="form-label">API Base URL
        <input type="url" id="onb-url" placeholder="https://example.com/api or https://example.com/tracksuite-work-api">
      </label>
      <label class="form-label">API Key
        <input type="password" id="onb-key" placeholder="your-api-key">
      </label>
      <div class="btn-row modal-actions">
        <button class="btn btn-ghost" id="onb-back-3">Back</button>
        <button class="btn btn-primary" id="onb-finish">Finish</button>
      </div>
    </div>
  </dialog>
`;

// ── Wire tab buttons ────────────────────────────────────────────────
initTimeline();

document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab as Tab));
});

// ── State ───────────────────────────────────────────────────────────

let weeklyChart: Chart | null = null;
let trendChart: Chart | null = null;
let isTracking = false;

function setSyncStatus(message: string) {
  document.getElementById("sync-status")!.textContent = message;
}

// ═══════════════════════════════════════════════════════════════════
//  PROJECTS
// ═══════════════════════════════════════════════════════════════════

/**
 * Switch the sticky current project (auto-splitting the running shift). Shared
 * by the chip menu and the number-key shortcuts.
 */
async function switchToProject(projectUuid: string | null) {
  const didSplit = await projects.setCurrentProject(projectUuid);
  if (didSplit) notify("Project switched", `Now tracking ${projectName(projectUuid)}`);
  await refresh();
  performSync();
}

/** Render the sticky current-project chip + switch/create/manage menu. */
function renderProjectChip() {
  const wrap = document.getElementById("project-chip-wrap");
  if (!wrap) return;
  const active = projectsCache.filter((p) => !p.archived);
  const items = [
    `<button class="project-menu-item ${!currentProjectUuid ? "selected" : ""}" data-select="">
       <span class="project-dot" style="background:${unassignedColor()}"></span><span class="project-menu-name">Unassigned</span><kbd class="project-slot">0</kbd></button>`,
    ...active.map((p, i) => `
      <button class="project-menu-item ${p.uuid === currentProjectUuid ? "selected" : ""}" data-select="${p.uuid}">
        <span class="project-dot" style="background:${p.color || unassignedColor()}"></span><span class="project-menu-name">${escapeHtml(p.name)}</span>${i < 9 ? `<kbd class="project-slot">${i + 1}</kbd>` : ""}</button>`),
  ].join("");

  wrap.innerHTML = `
    <button id="project-chip" class="project-chip" title="Current project">
      <span class="project-dot" style="background:${projectColor(currentProjectUuid)}"></span>
      <span class="project-chip-name">${escapeHtml(projectName(currentProjectUuid))}</span>
      <span class="project-chip-caret">▾</span>
    </button>
    <div id="project-menu" class="project-menu" hidden>
      <div class="project-menu-list">${items}</div>
      <form id="chip-new-project" class="project-menu-new">
        <input type="text" id="chip-new-name" placeholder="＋ New project" autocomplete="off" spellcheck="false" maxlength="60">
      </form>
      <button class="project-menu-manage" id="chip-manage" type="button">Manage projects…</button>
    </div>`;

  const menu = document.getElementById("project-menu") as HTMLDivElement;
  document.getElementById("project-chip")!.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  menu.querySelectorAll<HTMLButtonElement>(".project-menu-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      menu.hidden = true;
      void switchToProject(btn.dataset.select || null);
    });
  });

  (document.getElementById("chip-new-project") as HTMLFormElement).addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chip-new-name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    menu.hidden = true;
    const created = await projects.createProject(name, nextProjectColor());
    await projects.setCurrentProject(created.uuid);
    await refresh();
    performSync();
  });

  document.getElementById("chip-manage")!.addEventListener("click", () => {
    menu.hidden = true;
    openProjectsDialog();
  });
}

function renderProjectsManageList() {
  const el = document.getElementById("projects-manage-list");
  if (!el) return;
  if (projectsCache.length === 0) {
    el.innerHTML = `<p class="muted">No projects yet — add one below.</p>`;
    return;
  }
  const showBilling = isFullMode();
  const billingHint = showBilling
    ? `<p class="pm-billing-hint">The <strong>Rate</strong> and <strong>Cur.</strong> boxes set each project's hourly rate + currency for reports (leave currency blank to use your default).</p>`
    : "";
  el.innerHTML = billingHint + projectsCache.map((p) => `
    <div class="project-manage-row" data-uuid="${p.uuid}">
      <input type="color" class="pm-color" value="${p.color || UNASSIGNED_FALLBACK}" title="Color">
      <input type="text" class="pm-name" value="${escapeHtml(p.name)}" maxlength="60">
      ${showBilling ? `
      <input type="text" class="pm-rate" value="${escapeHtml(p.rate ?? "")}" placeholder="Rate" title="Hourly rate for reports" inputmode="decimal">
      <input type="text" class="pm-currency" value="${escapeHtml(p.currency ?? "")}" placeholder="Cur." title="Currency (e.g. EUR); blank uses your profile default" maxlength="8">
      ` : ""}
      <label class="pm-archive"><input type="checkbox" class="pm-archived" ${p.archived ? "checked" : ""}> Archived</label>
      <button class="btn-icon pm-delete" type="button" title="Delete project">&times;</button>
    </div>`).join("");

  el.querySelectorAll<HTMLDivElement>(".project-manage-row").forEach((row) => {
    const uuid = row.dataset.uuid!;
    const nameEl = row.querySelector(".pm-name") as HTMLInputElement;
    const colorEl = row.querySelector(".pm-color") as HTMLInputElement;
    const rateEl = row.querySelector(".pm-rate") as HTMLInputElement | null;
    const currencyEl = row.querySelector(".pm-currency") as HTMLInputElement | null;
    const archEl = row.querySelector(".pm-archived") as HTMLInputElement;
    const proj = projectsCache.find((x) => x.uuid === uuid);
    const save = async () => {
      // Preserve existing billing when the fields aren't shown (Simple mode);
      // otherwise take the edited values so a rename never wipes a rate.
      let rate = proj?.rate ?? null;
      let currency = proj?.currency ?? null;
      if (rateEl && currencyEl) {
        currency = currencyEl.value.trim().toUpperCase();
        currencyEl.value = currency;
        rate = rateEl.value.trim() === "" ? null : rateEl.value.trim();
        currency = currency === "" ? null : currency;
      }
      await projects.updateProject(uuid, nameEl.value.trim() || "Untitled", colorEl.value, archEl.checked, { rate, currency });
      await loadProjects();
      renderProjectChip();
      performSync();
    };
    nameEl.addEventListener("change", save);
    colorEl.addEventListener("change", save);
    rateEl?.addEventListener("change", save);
    currencyEl?.addEventListener("change", save);
    archEl.addEventListener("change", save);
    row.querySelector(".pm-delete")!.addEventListener("click", async () => {
      await projects.deleteProject(uuid);
      await loadProjects();
      renderProjectsManageList();
      renderProjectChip();
      await refresh();
      performSync();
    });
  });
}

function openProjectsDialog() {
  renderProjectsManageList();
  (document.getElementById("dlg-projects") as HTMLDialogElement).showModal();
}

let timelineShiftsCache: ShiftRecord[] = [];

// Stamp the brush note onto one shift block: optimistic DOM update + persist.
// Skips blocks already painted in this stroke so a drag doesn't re-write them.
async function stampNoteOnBlock(el: HTMLElement): Promise<void> {
  const id = Number(el.dataset.shiftId);
  if (!id || brushStroke.has(id)) return;
  brushStroke.add(id);
  const raw = (document.getElementById("timeline-brush-note") as HTMLInputElement).value.trim();
  const newNote = raw === "" ? null : raw;
  el.classList.toggle("has-note", !!newNote);
  el.classList.add("just-stamped");
  setTimeout(() => el.classList.remove("just-stamped"), 400);
  const dot = el.querySelector(".tl-note-dot");
  if (newNote && !dot) el.insertAdjacentHTML("beforeend", `<span class="tl-note-dot">•</span>`);
  else if (!newNote && dot) dot.remove();
  brushDirty = true;
  await shifts.setShiftNote(id, newNote);
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
    if (brushActive) {
      timelineSelStartMin = timelineSelEndMin = 0;
      updateSelectionUI();
      hint.textContent = "Click a block to stamp the note; drag across to cover several. Empty note = erase.";
      input.focus();
    } else {
      hint.textContent = "";
    }
    renderTimelineShifts(timelineShiftsCache);
  });
}

function renderTimelineShifts(allShifts: ShiftRecord[]) {
  timelineShiftsCache = allShifts;
  const track = document.getElementById("timeline-track");
  if (!track) return;

  // Clear existing shift blocks (keep the selection element!)
  const selectionEl = document.getElementById("timeline-selection");
  track.innerHTML = "";
  if (selectionEl) {
    track.appendChild(selectionEl);
  }

  if (!timelineDate) {
    timelineDate = localDateKey(new Date());
  }

  const dayStartMs = parseLocalDate(timelineDate, "00:00:00").getTime();
  const dayEndMs = dayStartMs + 1440 * 60000;

  // Closed shifts overlapping this day, clamped to day bounds, in minutes.
  const blocks = allShifts
    .filter((s) => s.endTime && new Date(s.startTime).getTime() < dayEndMs && new Date(s.endTime).getTime() > dayStartMs)
    .map((s) => {
      const startMin = (Math.max(new Date(s.startTime).getTime(), dayStartMs) - dayStartMs) / 60000;
      const endMin = (Math.min(new Date(s.endTime!).getTime(), dayEndMs) - dayStartMs) / 60000;
      return { s, startMin, endMin, live: false };
    });

  // The running shift has no endTime, so it never lands in `blocks`. Render it as
  // a live block whose right edge tracks "now" (capped to the day) and grows on a
  // per-second tick — see updateLiveTimelineBlock().
  const nowMs = Date.now();
  const active = allShifts.find((s) => !s.endTime);
  let liveEntry: { s: ShiftRecord; startMin: number; endMin: number; live: boolean } | null = null;
  if (active) {
    const st = new Date(active.startTime).getTime();
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
  const container = document.getElementById("timeline-container");
  const ticksEl = document.getElementById("timeline-ticks");
  const emptyEl = document.getElementById("timeline-empty");
  if (container) container.style.display = timelineHasShifts ? "" : "none";
  if (ticksEl) ticksEl.style.display = timelineHasShifts ? "" : "none";
  if (emptyEl) emptyEl.hidden = timelineHasShifts;

  renderTimelineDayLabel();
  // Range-assign occupancy excludes the open shift: splitting a running shift by
  // range is not supported. The live block stays note-brushable only.
  timelineBlocks = blocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin, projectUuid: b.s.projectUuid ?? null }));

  if (!timelineHasShifts) {
    timelineSpanStart = 8 * 60;
    timelineSpanEnd = 18 * 60;
    return;
  }

  // Zoom the window to the worked span (± 30 min padding, snapped to 30 min).
  const minStart = Math.min(...entries.map((b) => b.startMin));
  const maxEnd = Math.max(...entries.map((b) => b.endMin));
  timelineSpanStart = Math.max(0, Math.floor((minStart - 30) / 30) * 30);
  timelineSpanEnd = Math.min(1440, Math.ceil((maxEnd + 30) / 30) * 30);
  if (timelineSpanEnd - timelineSpanStart < 60) {
    timelineSpanEnd = Math.min(1440, timelineSpanStart + 60);
  }
  const span = timelineSpanEnd - timelineSpanStart;

  for (const b of entries) {
    const start = new Date(b.s.startTime);
    const blockColor = projectColor(b.s.projectUuid);
    const shiftDiv = document.createElement("div");
    shiftDiv.className = "timeline-shift";
    const note = b.s.note ?? "";
    if (note) shiftDiv.classList.add("has-note");
    if (brushActive) shiftDiv.classList.add("brushable");
    if (b.live) { shiftDiv.classList.add("timeline-live"); shiftDiv.id = "timeline-live-block"; }
    shiftDiv.dataset.shiftId = String(b.s.id);
    shiftDiv.style.left = `${((b.startMin - timelineSpanStart) / span) * 100}%`;
    shiftDiv.style.width = `${((b.endMin - b.startMin) / span) * 100}%`;
    shiftDiv.style.backgroundColor = blockColor;
    shiftDiv.style.color = contrastText(blockColor);
    shiftDiv.style.textShadow = "none";

    const name = projectName(b.s.projectUuid);
    const durHours = (b.endMin - b.startMin) / 60;
    shiftDiv.innerHTML = `<span class="tl-shift-label">${escapeHtml(name)} (${durHours.toFixed(1)}h)</span>${note ? `<span class="tl-note-dot">•</span>` : ""}`;
    const from = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (b.live) {
      shiftDiv.title = note ? `${name}: ${from} – now (running)\nNote: ${note}` : `${name}: ${from} – now (running)`;
    } else {
      const times = `${from} – ${new Date(b.s.endTime!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      shiftDiv.title = note ? `${name}: ${times}\nNote: ${note}` : `${name}: ${times}`;
    }
    track.appendChild(shiftDiv);
  }

  renderTimelineTicks();
}

// Grow the live (running-shift) block each second without a full re-render, so
// the timeline reflects the active session in real time. Re-pads the whole strip
// only when the block outgrows the padded span, and never yanks the DOM out from
// under an in-progress drag/brush stroke.
function updateLiveTimelineBlock() {
  const active = timelineShiftsCache.find((s) => !s.endTime);
  if (!active) return;
  const el = document.getElementById("timeline-live-block") as HTMLElement | null;
  if (!el) return;
  if (isTimelineDragging || isTimelineResizingLeft || isTimelineResizingRight || isTimelineMoving || brushPainting) return;
  const dayStartMs = parseLocalDate(timelineDate || localDateKey(new Date()), "00:00:00").getTime();
  const dayEndMs = dayStartMs + 1440 * 60000;
  const st = new Date(active.startTime).getTime();
  if (st >= dayEndMs) return;
  const startMin = (Math.max(st, dayStartMs) - dayStartMs) / 60000;
  const endMin = (Math.min(Date.now(), dayEndMs) - dayStartMs) / 60000;
  if (endMin > timelineSpanEnd) { renderTimelineShifts(timelineShiftsCache); return; }
  const span = timelineSpanEnd - timelineSpanStart;
  el.style.left = `${((startMin - timelineSpanStart) / span) * 100}%`;
  el.style.width = `${((endMin - startMin) / span) * 100}%`;
  const label = el.querySelector(".tl-shift-label");
  if (label) label.textContent = `${projectName(active.projectUuid)} (${((endMin - startMin) / 60).toFixed(1)}h)`;
}

function renderTimelineTicks() {
  const el = document.getElementById("timeline-ticks");
  if (!el) return;
  const span = timelineSpanEnd - timelineSpanStart;
  const N = 5;
  const parts: string[] = [];
  for (let i = 0; i < N; i++) {
    const min = Math.round((timelineSpanStart + (span * i) / (N - 1)) / 5) * 5;
    parts.push(`<span>${formatTimeFromMinutes(min)}</span>`);
  }
  el.innerHTML = parts.join("");
}

function renderTimelineDayLabel() {
  const el = document.getElementById("timeline-day-label");
  if (!el) return;
  const d = parseLocalDate(timelineDate || localDateKey(new Date()), "00:00:00");
  el.textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Switch the timeline to a given day (from clicking a weekly bar). */
function setTimelineDay(dateKey: string, allShifts: ShiftRecord[]) {
  timelineDate = dateKey;
  timelineSelStartMin = 0;
  timelineSelEndMin = 0;
  updateSelectionUI();
  renderTimelineShifts(allShifts);
  document.getElementById("timeline-editor-wrapper")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTimelineProjectSelect() {
  const select = document.getElementById("timeline-project-select") as HTMLSelectElement;
  if (!select) return;
  // Preserve the user's in-progress choice across re-renders; otherwise default
  // to the current project so "Assign" does something useful out of the box.
  const prev = select.value || currentProjectUuid || "";
  const active = projectsCache.filter((p) => !p.archived);
  const opts = [
    `<option value="">Unassigned</option>`,
    ...active.map((p) => `<option value="${p.uuid}">${escapeHtml(p.name)}</option>`),
  ];
  select.innerHTML = opts.join("");
  select.value = active.some((p) => p.uuid === prev) ? prev : "";
}

function updateSelectionUI() {
  const selectionEl = document.getElementById("timeline-selection");
  const labelEl = document.getElementById("timeline-selection-label");
  const selectEl = document.getElementById("timeline-project-select") as HTMLSelectElement;
  const assignBtn = document.getElementById("btn-timeline-assign") as HTMLButtonElement;
  const removeBtn = document.getElementById("btn-timeline-remove") as HTMLButtonElement | null;

  if (!selectionEl || !labelEl || !selectEl || !assignBtn) return;

  if (timelineSelStartMin === timelineSelEndMin) {
    selectionEl.style.display = "none";
    labelEl.innerText = "No range selected. Drag on the timeline above to select.";
    selectEl.disabled = true;
    assignBtn.disabled = true;
    if (removeBtn) removeBtn.disabled = true;
    timelineStartMin = null;
    timelineEndMin = null;
  } else {
    selectionEl.style.display = "block";
    const span = timelineSpanEnd - timelineSpanStart;
    const left = ((timelineSelStartMin - timelineSpanStart) / span) * 100;
    const width = ((timelineSelEndMin - timelineSelStartMin) / span) * 100;
    selectionEl.style.left = `${left}%`;
    selectionEl.style.width = `${width}%`;

    const startStr = formatTimeFromMinutes(timelineSelStartMin);
    const endStr = formatTimeFromMinutes(timelineSelEndMin);
    const durMin = Math.round(timelineSelEndMin - timelineSelStartMin);
    const h = Math.floor(durMin / 60);
    const m = durMin % 60;
    const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

    labelEl.innerText = `Selected: ${startStr} to ${endStr} (${durStr})`;
    selectEl.disabled = false;
    assignBtn.disabled = false;
    if (removeBtn) removeBtn.disabled = false;
    timelineStartMin = timelineSelStartMin;
    timelineEndMin = timelineSelEndMin;
  }
}

function getMinutesFromEvent(e: MouseEvent | TouchEvent, trackEl: HTMLElement): number {
  const rect = trackEl.getBoundingClientRect();
  const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const span = timelineSpanEnd - timelineSpanStart;
  return Math.round((timelineSpanStart + pct * span) / 5) * 5;
}

function initTimelineDrag() {
  const track = document.getElementById("timeline-track");
  const handleLeft = document.getElementById("handle-left");
  const handleRight = document.getElementById("handle-right");
  const selectionEl = document.getElementById("timeline-selection");

  if (!track || !handleLeft || !handleRight || !selectionEl) return;

  const startDrag = (e: MouseEvent | TouchEvent) => {
    if (brushActive) return; // brush mode owns block clicks; no range-select
    // Clicks on the selection are handled by its own move/resize listeners.
    if (selectionEl.contains(e.target as Node)) return;

    isTimelineDragging = true;
    timelineDragStartMin = getMinutesFromEvent(e, track);
    timelineSelStartMin = timelineDragStartMin;
    timelineSelEndMin = timelineDragStartMin;
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
    brushStroke = new Set();
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

  // Grab the selection body to move the whole window.
  const startMove = (e: MouseEvent | TouchEvent) => {
    if (e.target === handleLeft || e.target === handleRight) return;
    e.stopPropagation();
    isTimelineMoving = true;
    timelineMoveGrabMin = getMinutesFromEvent(e, track);
    timelineMoveOrigStart = timelineSelStartMin;
    timelineMoveOrigEnd = timelineSelEndMin;
    if (e.cancelable) e.preventDefault();
  };
  selectionEl.addEventListener("mousedown", startMove);
  selectionEl.addEventListener("touchstart", startMove, { passive: false });

  handleLeft.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    isTimelineResizingLeft = true;
  });
  handleLeft.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    isTimelineResizingLeft = true;
  }, { passive: true });

  handleRight.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    isTimelineResizingRight = true;
  });
  handleRight.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    isTimelineResizingRight = true;
  }, { passive: true });

  const onMove = (e: MouseEvent | TouchEvent) => {
    if (isTimelineDragging) {
      const currentMin = getMinutesFromEvent(e, track);
      timelineSelStartMin = Math.min(timelineDragStartMin, currentMin);
      timelineSelEndMin = Math.max(timelineDragStartMin, currentMin);
      updateSelectionUI();
    } else if (isTimelineResizingLeft) {
      const currentMin = getMinutesFromEvent(e, track);
      if (currentMin < timelineSelEndMin) {
        timelineSelStartMin = currentMin;
        updateSelectionUI();
      }
    } else if (isTimelineResizingRight) {
      const currentMin = getMinutesFromEvent(e, track);
      if (currentMin > timelineSelStartMin) {
        timelineSelEndMin = currentMin;
        updateSelectionUI();
      }
    } else if (isTimelineMoving) {
      const width = timelineMoveOrigEnd - timelineMoveOrigStart;
      const delta = getMinutesFromEvent(e, track) - timelineMoveGrabMin;
      let ns = timelineMoveOrigStart + delta;
      ns = Math.max(timelineSpanStart, Math.min(ns, timelineSpanEnd - width));
      timelineSelStartMin = ns;
      timelineSelEndMin = ns + width;
      updateSelectionUI();
    }
  };

  const onEnd = () => {
    if (brushPainting) {
      brushPainting = false;
      if (brushDirty) {
        brushDirty = false;
        // Await the stroke's writes before reconciling, or the refresh read
        // races the writes and reverts the freshly-stamped notes.
        const pend = brushPending; brushPending = [];
        void Promise.allSettled(pend).then(() => { void refresh(); performSync(); });
      }
    }
    // A click (drag with no movement) on a segment selects that segment's range.
    const wasClick = isTimelineDragging && timelineSelStartMin === timelineSelEndMin;
    isTimelineDragging = false;
    isTimelineResizingLeft = false;
    isTimelineResizingRight = false;
    isTimelineMoving = false;

    if (wasClick) {
      const min = timelineSelStartMin;
      const blk = timelineBlocks.find((b) => min >= b.startMin && min < b.endMin);
      if (blk) {
        timelineSelStartMin = blk.startMin;
        timelineSelEndMin = blk.endMin;
        const sel = document.getElementById("timeline-project-select") as HTMLSelectElement | null;
        if (sel) sel.value = blk.projectUuid || "";
        updateSelectionUI();
      }
    }
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onEnd);
  window.addEventListener("touchend", onEnd);
}

/**
 * Build a local "%Y-%m-%dT%H:%M:%S" timestamp from a day + minutes-since-midnight,
 * correctly rolling 1440 (the far-right edge) to the next day's 00:00:00 rather
 * than emitting an invalid "24:00:00".
 */
function timelineDateTime(dateStr: string, minutes: number): string {
  const dt = new Date(parseLocalDate(dateStr, "00:00:00").getTime() + minutes * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

async function applyTimelineRange(projectUuid: string | null) {
  if (timelineStartMin === null || timelineEndMin === null) return;
  const startStr = timelineDateTime(timelineDate, timelineStartMin);
  const endStr = timelineDateTime(timelineDate, timelineEndMin);

  await projects.assignProjectToRange(startStr, endStr, projectUuid);

  timelineSelStartMin = 0;
  timelineSelEndMin = 0;
  updateSelectionUI();

  await refresh();
  performSync();
}

function onTimelineAssignSubmit() {
  const select = document.getElementById("timeline-project-select") as HTMLSelectElement;
  void applyTimelineRange(select.value || null);
}

/** Clear any project from the selected range (revert to Unassigned). */
function onTimelineRemove() {
  if (timelineStartMin === null || timelineEndMin === null) return;
  void applyTimelineRange(null);
}

function initTimeline() {
  if (!timelineDate) timelineDate = localDateKey(new Date());
  renderTimelineDayLabel();

  document.getElementById("btn-timeline-assign")?.addEventListener("click", onTimelineAssignSubmit);
  document.getElementById("btn-timeline-remove")?.addEventListener("click", onTimelineRemove);

  // Delete / Backspace clears the current selection's project (unless typing).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (timelineStartMin === null || timelineEndMin === null) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    e.preventDefault();
    onTimelineRemove();
  });

  initTimelineDrag();
  initBrush();
}

type BarRadius = { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };
type ProjectStackDataset = {
  label: string;
  data: number[];
  backgroundColor: string;
  stack: string;
  borderRadius: (ctx: { datasetIndex: number; dataIndex: number; chart: Chart }) => BarRadius;
  borderSkipped: boolean;
};

/** Round the top corners of the top-most segment of each stacked bar (per bar). */
function stackedBarTopRadius(r: number) {
  return (ctx: { dataIndex: number; datasetIndex: number; chart: Chart }): BarRadius => {
    const datasets = ctx.chart.data.datasets;
    let topIdx = -1;
    for (let i = 0; i < datasets.length; i++) {
      const v = datasets[i].data[ctx.dataIndex] as number;
      if (v && v > 0) topIdx = i;
    }
    const isTop = ctx.datasetIndex === topIdx;
    return { topLeft: isTop ? r : 0, topRight: isTop ? r : 0, bottomLeft: 0, bottomRight: 0 };
  };
}

/**
 * Group hours per bucket (day/period) and per project into stacked Chart.js
 * datasets. `bucketOf` maps a shift to a bucket index, or -1 to exclude it.
 */
function buildProjectStackDatasets(
  bucketCount: number,
  list: ShiftRecord[],
  hoursOf: (s: ShiftRecord) => number,
  bucketOf: (s: ShiftRecord) => number,
): ProjectStackDataset[] {
  const buckets = new Map<string, number[]>();
  const ensure = (k: string) => {
    let arr = buckets.get(k);
    if (!arr) { arr = new Array(bucketCount).fill(0); buckets.set(k, arr); }
    return arr;
  };
  for (const s of list) {
    const b = bucketOf(s);
    if (b < 0 || b >= bucketCount) continue;
    ensure(s.projectUuid || "")[b] += hoursOf(s);
  }
  const keys = [...buckets.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : projectName(a).localeCompare(projectName(b)));
  const radius = stackedBarTopRadius(4);
  return keys.map((k) => ({
    label: k ? projectName(k) : "Unassigned",
    data: buckets.get(k)!.map((v) => parseFloat(v.toFixed(2))),
    backgroundColor: k ? projectColor(k) : unassignedColor(),
    stack: "hours",
    borderRadius: radius,
    borderSkipped: false,
  }));
}

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════

async function refresh() {
  const [allShifts, activeShift, offDayList] = await Promise.all([
    shifts.getAllShifts(),
    shifts.getActiveShift(),
    offDays.getOffDays(),
    loadProjects(),
  ]);

  isTracking = activeShift !== null;
  updateHeartbeat();
  const offDayDates = new Set(offDayList.map((o) => o.date));

  // ── Project chip ────────────────────────────────────────────────
  renderProjectChip();

  renderTimelineShifts(allShifts);
  renderTimelineProjectSelect();
  updateSelectionUI();

  // ── Clock button ────────────────────────────────────────────────
  const wrap = document.getElementById("clock-btn-wrap")!;
  wrap.innerHTML = `<button class="btn ${isTracking ? "btn-danger" : "btn-primary"}" id="btn-clock">
        ${isTracking ? "Clock Out" : "Clock In"}</button>`;
  document.getElementById("btn-clock")!.addEventListener("click", async () => {
    const wasClockedIn = isTracking;
    let clockedShift: ShiftRecord | null = null;
    if (wasClockedIn) clockedShift = await shifts.getActiveShift();
    if (isTracking) await shifts.endShift();
    else await shifts.startShift();
    await refresh();
    if (wasClockedIn) {
      // Notify clock-out with duration
      if (clockedShift) {
        const dur = formatDuration(shiftDurationHours({ ...clockedShift, endTime: new Date().toISOString() }));
        notify("Clocked Out", `Tracked ${dur}`);
      }
      // Auto-sync after clock-out (fire-and-forget)
      performSync();
    } else {
      notify("Clocked In", "Time tracking started");
      // Push the freshly-opened shift so it's visible on other devices.
      performSync();
    }
  });

  // ── Status ──────────────────────────────────────────────────────
  document.getElementById("status-text")!.textContent = isTracking ? "Tracking" : "Idle";
  document.getElementById("stat-status")!.classList.toggle("tracking", isTracking);

  // ── Today hours ─────────────────────────────────────────────────
  const todayKey = localDateKey(new Date());
  const todayHours = allShifts
    .filter((s) => toDateKey(s.startTime) === todayKey)
    .reduce((sum, s) => sum + shiftDurationHours(s), 0);
  document.getElementById("today-hours")!.textContent = formatDuration(todayHours);

  // ── Week hours & chart data ─────────────────────────────────────
  const ws = weekStartDate();
  const dayLabels: string[] = [];
  const dayKeys: string[] = [];
  let weekTotal = 0;

  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const key = localDateKey(d);
    dayKeys.push(key);
    dayLabels.push(d.toLocaleDateString(undefined, { weekday: "short" }));
    weekTotal += allShifts
      .filter((s) => toDateKey(s.startTime) === key)
      .reduce((sum, s) => sum + shiftDurationHours(s), 0);
  }

  document.getElementById("week-hours")!.textContent = formatDuration(weekTotal);

  const weekTarget = getAdjustedWeeklyTargetHours(currentWorkSchedule, offDayDates, ws);
  document.getElementById("week-target")!.textContent =
    `Target: ${formatHoursValue(weekTarget)} h`;

  const pct = weekTarget > 0 ? Math.min((weekTotal / weekTarget) * 100, 100) : 100;
  const bar = document.getElementById("week-bar") as HTMLDivElement;
  bar.style.width = `${pct}%`;
  bar.classList.toggle("bar-full", pct >= 100);

  // ── Chart (stacked by project) ──────────────────────────────────
  const weekDatasets = buildProjectStackDatasets(
    7, allShifts, shiftDurationHours, (s) => dayKeys.indexOf(toDateKey(s.startTime)),
  );
  if (weeklyChart) weeklyChart.destroy();
  {
    const canvas = document.getElementById("weekly-chart") as HTMLCanvasElement;
    weeklyChart = new Chart(canvas, {
      type: "bar",
      data: { labels: dayLabels, datasets: weekDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: weekDatasets.length > 1, position: "bottom" } },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 2 } },
        },
        // Click a day's column to load it into the timeline editor below.
        onClick: (evt, _els, chart) => {
          const native = evt.native as Event | null;
          if (!native) return;
          const pts = chart.getElementsAtEventForMode(native, "index", { intersect: false }, false);
          if (pts.length) setTimelineDay(dayKeys[pts[0].index], allShifts);
        },
        onHover: (evt, els) => {
          const el = evt.native?.target as HTMLElement | undefined;
          if (el) el.style.cursor = els.length ? "pointer" : "default";
        },
      },
    });
  }

  // ── Shift table ─────────────────────────────────────────────────
  const tbody = document.getElementById("shift-body")!;
  const recent = allShifts.slice(0, 20);
  tbody.innerHTML = recent
    .map((s) => {
      const d = shiftDurationHours(s);
      const dateStr = new Date(s.startTime).toLocaleDateString();
      const startStr = new Date(s.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const endStr = s.endTime ? new Date(s.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "active";
      return `<tr style="box-shadow: inset 3px 0 0 ${projectColor(s.projectUuid)}">
        <td>${dateStr}</td><td>${startStr}</td><td>${endStr}</td>
        <td>${formatDuration(d)}</td>
        <td><span class="shift-project-tag"><span class="project-dot" style="background:${projectColor(s.projectUuid)}"></span>${escapeHtml(projectName(s.projectUuid))}</span></td>
        <td><input type="text" class="shift-note-input" data-id="${s.id}" value="${escapeHtml(s.note ?? "")}" placeholder="Add note…" maxlength="500" title="Enter: save and move down · ↓: copy the note from the row above"></td>
        <td><button class="btn-icon delete-shift" data-id="${s.id}" title="Delete">&times;</button></td>
      </tr>`;
    })
    .join("");

  const saveNoteInput = async (input: HTMLInputElement) => {
    const id = Number(input.dataset.id);
    if (!id) return;
    const note = input.value.trim();
    const newNote = note === "" ? null : note;
    const rec = allShifts.find((x) => x.id === id);
    if (rec && (rec.note ?? null) === newNote) return;
    await shifts.setShiftNote(id, newNote);
    if (rec) rec.note = newNote;
    performSync();
  };
  tbody.querySelectorAll<HTMLInputElement>(".shift-note-input").forEach((input) => {
    input.addEventListener("change", () => void saveNoteInput(input));
    // Carry-down flow: Enter saves and drops to the next row; ↓ copies the note
    // from the row above (fast repeats without copy-paste).
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

  tbody.querySelectorAll<HTMLButtonElement>(".delete-shift").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      if (id) { await shifts.deleteShift(id); await refresh(); performSync(); }
    });
  });

  // ── Off days: monthly calendar ──────────────────────────────────
  offDayDatesCache = new Set(offDayList.map((o) => o.date));
  renderOffdayCalendar();

  syncTrayState();
}

// Inline monthly off-day calendar on the dashboard. Clicking a day toggles it;
// bulk ranges still go through the "Manage" (date-range) dialog.
let offCalYear = new Date().getFullYear();
let offCalMonth = new Date().getMonth();
let offDayDatesCache = new Set<string>();

function renderOffdayCalendar() {
  const grid = document.getElementById("offcal-grid");
  const title = document.getElementById("offcal-title");
  if (!grid || !title) return;
  title.textContent = new Date(offCalYear, offCalMonth, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  grid.innerHTML = "";
  const firstDay = new Date(offCalYear, offCalMonth, 1);
  let startOffset = firstDay.getDay();
  startOffset = startOffset === 0 ? 6 : startOffset - 1; // Monday-first
  const numDays = new Date(offCalYear, offCalMonth + 1, 0).getDate();
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
    if (offDayDatesCache.has(dateKey)) cell.classList.add("cal-offday");
    grid.appendChild(cell);
  }
}

// Drag-to-paint off days on the calendar. The cell you press sets the mode
// (press an empty day → add across the drag; press an off day → clear across
// it); a plain click is just a one-day range. Wired once — the #offcal-grid node
// persists across re-renders (renderOffdayCalendar only swaps its innerHTML).
let offDragActive = false;
let offDragMode: "add" | "remove" = "add";
let offDragAnchor: string | null = null;
let offDragCurrent: string | null = null;

async function applyOffDays(dates: string[], mode: "add" | "remove") {
  for (const d of dates) {
    const isOff = offDayDatesCache.has(d);
    if (mode === "add" && !isOff) await offDays.addOffDay(d);
    else if (mode === "remove" && isOff) await offDays.removeOffDay(d);
  }
}

function paintOffDragPreview() {
  const grid = document.getElementById("offcal-grid");
  if (!grid || !offDragAnchor || !offDragCurrent) return;
  const range = new Set(inclusiveDateRange(offDragAnchor, offDragCurrent));
  grid.querySelectorAll<HTMLElement>("[data-date]").forEach((cell) => {
    const inRange = range.has(cell.dataset.date!);
    cell.classList.toggle("cal-drag-add", inRange && offDragMode === "add");
    cell.classList.toggle("cal-drag-remove", inRange && offDragMode === "remove");
  });
}

async function endOffDrag() {
  if (!offDragActive) return;
  offDragActive = false;
  const anchor = offDragAnchor;
  const current = offDragCurrent;
  offDragAnchor = offDragCurrent = null;
  if (!anchor || !current) return;
  try {
    await applyOffDays(inclusiveDateRange(anchor, current), offDragMode);
    await refresh(); // re-renders the calendar, clearing the preview classes
    performSync();
  } catch (err) {
    console.error("Failed to apply off days", err);
    renderOffdayCalendar(); // at least clear the preview highlight
  }
}

function initOffdayCalendar() {
  const grid = document.getElementById("offcal-grid");
  if (!grid) return;
  const cellDate = (e: Event): string | null =>
    (e.target as HTMLElement)?.closest<HTMLElement>("[data-date]")?.dataset.date ?? null;
  grid.addEventListener("mousedown", (e) => {
    const d = cellDate(e);
    if (!d) return;
    e.preventDefault(); // don't text-select while dragging
    offDragActive = true;
    offDragAnchor = offDragCurrent = d;
    offDragMode = offDayDatesCache.has(d) ? "remove" : "add";
    paintOffDragPreview();
  });
  grid.addEventListener("mouseover", (e) => {
    if (!offDragActive) return;
    const d = cellDate(e);
    if (!d) return;
    offDragCurrent = d;
    paintOffDragPreview();
  });
  window.addEventListener("mouseup", () => { void endOffDrag(); });
}

// ═══════════════════════════════════════════════════════════════════
//  STATISTICS
// ═══════════════════════════════════════════════════════════════════

async function refreshStats() {
  const [allShifts, offDayList] = await Promise.all([shifts.getAllShifts(), offDays.getOffDays()]);
  const offDayDates = new Set(offDayList.map((o) => o.date));
  const now = new Date();

  // ── Average calculations ──────────────────────────────────────────
  const unitEl = document.getElementById("stats-unit") as HTMLSelectElement;
  const countEl = document.getElementById("stats-count") as HTMLInputElement;
  const holidayEl = document.getElementById("stats-holidays") as HTMLInputElement;
  const unit = unitEl.value;
  const count = parseInt(countEl.value) || 4;
  const includeHolidays = holidayEl.checked;

  // Hide count for YTD
  document.getElementById("stats-count-wrap")!.style.display = unit === "ytd" ? "none" : "";

  // End of last complete week (Sunday 23:59:59 — week starts Monday)
  const dayOfWeek = now.getDay(); // 0=Sun
  const daysSinceSunday = dayOfWeek === 0 ? 0 : dayOfWeek;
  const endOfLastWeek = new Date(now);
  endOfLastWeek.setDate(endOfLastWeek.getDate() - daysSinceSunday - 1);
  endOfLastWeek.setHours(23, 59, 59, 999);

  let startDate: Date;
  if (unit === "days") startDate = addDays(endOfLastWeek, -(count - 1));
  else if (unit === "weeks") startDate = addDays(endOfLastWeek, -count * 7 + 1);
  else if (unit === "months") startDate = addDays(endOfLastWeek, -count * 30);
  else startDate = new Date(now.getFullYear(), 0, 1); // YTD
  startDate.setHours(0, 0, 0, 0);

  // Find first shift date to avoid counting before any data
  let firstShiftDate: Date | null = null;
  for (const s of allShifts) {
    const d = new Date(s.startTime);
    if (!firstShiftDate || d < firstShiftDate) firstShiftDate = d;
  }
  if (firstShiftDate && startDate < firstShiftDate) {
    startDate = new Date(firstShiftDate);
    startDate.setHours(0, 0, 0, 0);
  }

  const hoursPerDay: Record<string, number> = {};
  const hoursPerWeek: Record<string, number> = {};
  let totalActual = 0;

  for (const s of allShifts) {
    if (!s.endTime) continue;
    const st = new Date(s.startTime);
    const en = new Date(s.endTime);
    if (st < startDate || st > endOfLastWeek) continue;
    const dur = (en.getTime() - st.getTime()) / 3_600_000;
    totalActual += dur;
    const dayKey = toDateKey(s.startTime);
    hoursPerDay[dayKey] = (hoursPerDay[dayKey] ?? 0) + dur;
    const wk = weekKey(st);
    hoursPerWeek[wk] = (hoursPerWeek[wk] ?? 0) + dur;
  }

  // Expected hours & holiday virtual hours
  let expectedHours = 0;
  const cursor = new Date(startDate);
  while (cursor <= endOfLastWeek) {
    const targetHours = getTargetHoursForDate(cursor, currentWorkSchedule);
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
  document.getElementById("overtime-card")!.classList.toggle("overtime-pos", overtime >= 0);
  document.getElementById("overtime-card")!.classList.toggle("overtime-neg", overtime < 0);

  document.getElementById("avg-detail")!.innerHTML = `
    <p>Period: <strong>${startDate.toLocaleDateString()} – ${endOfLastWeek.toLocaleDateString()}</strong></p>
    <p>Days with shifts: <strong>${daysWorked}</strong> · Weeks: <strong>${weeksWorked}</strong></p>
    <p>Total worked: <strong>${formatDuration(totalActual)}</strong> · Expected: <strong>${formatDuration(expectedHours)}</strong></p>
  `;

  // ── Trend chart ─────────────────────────────────────────────────
  refreshTrendChart(allShifts, offDayDates, includeHolidays);
}

function weekKey(d: Date): string {
  // ISO week-ish key: year + week number (Monday start)
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86_400_000);
  const wn = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(wn).padStart(2, "0")}`;
}

// ── Trend-chart drill-down: reach & edit ANY day's sessions ──────────
// The trend chart already spans arbitrary history; clicking a bar drills in.
// A day bar opens that day's timeline editor (moved into the slide-down slot in
// the Statistics tab); a week/month bar zooms the chart into its days first. A
// breadcrumb walks back out. This is the only path to backfill projects/notes on
// days older than the current week.
type TrendDrillLevel = { start: Date; end: Date; granularity: string; label: string };
let trendDrillStack: TrendDrillLevel[] = [];
let trendBucketRange: Record<string, { start: number; end: number }> = {};
let trendLabelsCurrent: string[] = [];
let trendGranularityCurrent = "day";
let drillDay: string | null = null;
let drillEditorOrigParent: HTMLElement | null = null;
let drillEditorOrigNext: Node | null = null;
// Cached inputs so drill navigation can re-render the chart without refreshStats.
let trendLastShifts: ShiftRecord[] = [];
let trendLastOffDays: Set<string> = new Set();
let trendLastHolidays = false;

function currentTrendView(): { start: Date | null; end: Date; granularity: string } {
  const top = trendDrillStack[trendDrillStack.length - 1];
  if (top) return { start: top.start, end: top.end, granularity: top.granularity };
  const g = (document.getElementById("trend-granularity") as HTMLSelectElement)?.value || "day";
  return { start: null, end: new Date(), granularity: g };
}

// Relocate the whole timeline-editor PANEL (bar + assign controls + brush, which
// are siblings) into the drill slot and back. Moving only the bar left the assign
// controls and brush behind in the dashboard tab.
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
  drillEditorOrigParent = null;
  drillEditorOrigNext = null;
}

function rerenderTrend() {
  refreshTrendChart(trendLastShifts, trendLastOffDays, trendLastHolidays);
}

function openDayDrill(dateKey: string) {
  drillDay = dateKey;
  moveEditorIntoSlot();
  const empty = document.getElementById("trend-drill-empty");
  if (empty) empty.hidden = true;
  setTimelineDay(dateKey, trendLastShifts);
  syncDrillUI();
  document.getElementById("trend-drill-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Restore the editor to its dashboard home and reset drill state. Used both by
// the Close button and when leaving the Statistics tab.
function restoreDrill() {
  restoreEditorHome();
  trendDrillStack = [];
  drillDay = null;
  const empty = document.getElementById("trend-drill-empty");
  if (empty) empty.hidden = false;
  const panel = document.getElementById("trend-drill-panel");
  if (panel) panel.hidden = true;
}

function closeTrendDrill() {
  restoreDrill();
  rerenderTrend();
}

function drillToLevel(level: number) {
  restoreEditorHome();
  trendDrillStack = level < 0 ? [] : trendDrillStack.slice(0, level + 1);
  drillDay = null;
  const empty = document.getElementById("trend-drill-empty");
  if (empty) empty.hidden = false;
  rerenderTrend();
}

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
  rerenderTrend();
}

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
  crumbs.querySelectorAll(".crumb[data-level]").forEach((b) =>
    b.addEventListener("click", () => drillToLevel(parseInt((b as HTMLElement).dataset.level!))));
}

function refreshTrendChart(allShifts: ShiftRecord[], offDayDates: Set<string>, includeHolidays: boolean) {
  // Cache inputs so drill navigation can re-render without a full refreshStats.
  trendLastShifts = allShifts;
  trendLastOffDays = offDayDates;
  trendLastHolidays = includeHolidays;

  const countEl = document.getElementById("trend-count") as HTMLInputElement;
  const unitEl = document.getElementById("trend-unit") as HTMLSelectElement;
  const now = new Date();

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
    const trendCount = parseInt(countEl.value) || 7;
    const trendUnit = unitEl.value;
    if (trendUnit === "days") trendStart = addDays(now, -trendCount);
    else if (trendUnit === "weeks") trendStart = addDays(now, -trendCount * 7);
    else trendStart = addDays(now, -trendCount * 30);
  }
  trendStart.setHours(0, 0, 0, 0);
  const trendEndMs = new Date(trendEnd).setHours(23, 59, 59, 999);

  const relevant = allShifts.filter((s) => {
    const t = new Date(s.startTime).getTime();
    return t >= trendStart.getTime() && t <= trendEndMs;
  });

  // Ordered buckets, each bucket's day range (for drill), + off-day credit.
  const bucketKeys: string[] = [];
  const bucketRange: Record<string, { start: number; end: number }> = {};
  const offdayCredit: Record<string, number> = {};
  const cursor = new Date(trendStart);
  while (cursor.getTime() <= trendEndMs) {
    const bk = bucketKey(cursor, granularity);
    if (!bucketKeys.includes(bk)) bucketKeys.push(bk);
    const dayMs = cursor.getTime();
    const r = bucketRange[bk];
    if (!r) bucketRange[bk] = { start: dayMs, end: dayMs };
    else { if (dayMs < r.start) r.start = dayMs; if (dayMs > r.end) r.end = dayMs; }
    const dk = localDateKey(cursor);
    const targetHours = getTargetHoursForDate(cursor, currentWorkSchedule);
    if (includeHolidays && offDayDates.has(dk) && targetHours > 0) {
      offdayCredit[bk] = (offdayCredit[bk] ?? 0) + targetHours;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  const labels = [...bucketKeys].sort();
  const idxOf = (bk: string) => labels.indexOf(bk);
  // Cache for the bar-click drill handler.
  trendLabelsCurrent = labels;
  trendGranularityCurrent = granularity;
  trendBucketRange = bucketRange;

  const datasets = buildProjectStackDatasets(
    labels.length,
    relevant,
    (s) => (new Date(s.endTime!).getTime() - new Date(s.startTime).getTime()) / 3_600_000,
    (s) => (s.endTime ? idxOf(bucketKey(new Date(s.startTime), granularity)) : -1),
  );

  // Fold off-day credited hours into the Unassigned segment.
  if (Object.keys(offdayCredit).length > 0) {
    let un = datasets.find((d) => d.label === "Unassigned");
    if (!un) {
      un = { label: "Unassigned", data: new Array(labels.length).fill(0), backgroundColor: unassignedColor(), stack: "hours", borderRadius: stackedBarTopRadius(4), borderSkipped: false };
      datasets.push(un);
    }
    const unDataset = un;
    labels.forEach((bk, i) => {
      if (offdayCredit[bk]) unDataset.data[i] = parseFloat((unDataset.data[i] + offdayCredit[bk]).toFixed(2));
    });
  }

  if (trendChart) trendChart.destroy();
  {
    const canvas = document.getElementById("trend-chart") as HTMLCanvasElement;
    trendChart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (_evt, els) => { if (els.length) onTrendBarClick(els[0].index); },
        onHover: (evt, els) => { const t = evt.native?.target as HTMLElement | undefined; if (t) t.style.cursor = els.length ? "pointer" : "default"; },
        plugins: { legend: { display: datasets.length > 1, position: "bottom" } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 45 } },
          y: { stacked: true, beginAtZero: true },
        },
      },
    });
  }

  renderProjectSummary(datasets);
  syncDrillUI();
}

/** Compact "Hours by project" totals for the trend range, shown under the chart. */
function renderProjectSummary(datasets: ProjectStackDataset[]) {
  const el = document.getElementById("project-summary");
  if (!el) return;
  const totals = datasets
    .map((d) => ({ label: d.label, color: d.backgroundColor, hours: d.data.reduce((a, b) => a + b, 0) }))
    .filter((t) => t.hours > 0.001)
    .sort((a, b) => b.hours - a.hours);

  if (totals.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = totals
    .map((t) => `<span class="ps-item"><span class="project-dot" style="background:${t.color}"></span><span class="ps-name">${escapeHtml(t.label)}</span><span class="ps-hours">${formatDuration(t.hours)}</span></span>`)
    .join("");
}

function bucketKey(d: Date, granularity: string): string {
  if (granularity === "week") return weekKey(d);
  if (granularity === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return localDateKey(d); // day
}

// Wire stats controls
for (const id of ["stats-unit", "stats-count", "stats-holidays", "trend-count", "trend-unit", "trend-granularity"]) {
  document.getElementById(id)!.addEventListener("change", () => {
    // Changing the trend range/granularity redefines the root view — drop any
    // active drill so the fresh selection isn't overridden by a stale level.
    if (id.startsWith("trend-")) restoreDrill();
    refreshStats();
  });
}
document.getElementById("trend-drill-close")!.addEventListener("click", closeTrendDrill);

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS + SYNC
// ═══════════════════════════════════════════════════════════════════

/**
 * Run a full bidirectional (last-write-wins) sync via the native layer, then
 * refresh the UI to reflect anything that arrived from the server. The heavy
 * lifting lives in Rust (`sync_now`) so desktop and tray share one code path.
 * Returns true on success, false on failure/skip.
 */
let _syncInFlight = false;
async function performSync(statusEl?: HTMLElement | null): Promise<boolean> {
  if (_syncInFlight) return false;
  _syncInFlight = true;
  try {
    if (statusEl) statusEl.textContent = "Syncing…";
    const result = await invoke<string>("sync_now");
    if (result === "not_configured") {
      if (statusEl) statusEl.textContent = "Not configured";
      return false;
    }

    // The local DB may have changed (pulled shifts/off-days); refresh views.
    await refresh();
    await refreshStats();
    if (statusEl) statusEl.textContent = "Synced ✓";
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) statusEl.textContent = `Failed: ${msg}`;
    notify("Sync Failed", msg);
    return false;
  } finally {
    _syncInFlight = false;
  }
}

function applyAppearance(cfg: AppearanceConfig) {
  const root = document.documentElement;
  const theme = cfg.theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : cfg.theme;

  root.setAttribute("data-theme", theme);
  root.setAttribute("data-palette", cfg.palette);

  // Update Chart.js axis colors from CSS variables (safe to read after setAttribute)
  const style = getComputedStyle(root);
  const textColor = style.getPropertyValue("--text-muted").trim();
  const gridColor = style.getPropertyValue("--border-color").trim();
  // Set globally so charts recreated on later refreshes stay themed
  // (grid lines default to Chart.defaults.borderColor).
  Chart.defaults.color = textColor;
  Chart.defaults.borderColor = gridColor;

  const applyAxis = (chart: Chart | null) => {
    if (!chart) return;
    chart.options.scales!.y!.grid!.color = gridColor;
    chart.options.scales!.x!.grid!.color = gridColor;
    chart.options.scales!.y!.ticks!.color = textColor;
    chart.options.scales!.x!.ticks!.color = textColor;
    chart.update();
  };
  applyAxis(weeklyChart);
  applyAxis(trendChart);

  // Refresh both views so bar colors update immediately
  refresh();
  if (trendChart) refreshStats();
}

async function loadSettings() {
  const [sync, app, workSchedule, autoResumeConfig] = await Promise.all([
    settings.getSyncConfig(),
    settings.getAppearance(),
    settings.getWorkSchedule(),
    settings.getAutoResumeConfig(),
  ]);
  currentWorkSchedule = {
    dailyHours: { ...workSchedule.dailyHours },
  };
  currentAutoResumeConfig = { ...autoResumeConfig };

  const serverUrl = await settings.getServerUrl();

  (document.getElementById("cfg-url") as HTMLInputElement).value = serverUrl;
  if (sync) {
    (document.getElementById("cfg-key") as HTMLInputElement).value = sync.apiKey;
  }
  setWorkScheduleInputs(currentWorkSchedule);
  renderWorkScheduleSummary(currentWorkSchedule);
  setAutoResumeInputs(currentAutoResumeConfig);
  setAutoResumeStatus("");
  updateHolidayToggleLabel();
  if (app) {
    (document.getElementById("cfg-theme") as HTMLSelectElement).value = app.theme;
    (document.getElementById("cfg-palette") as HTMLSelectElement).value = app.palette;
    applyAppearance(app);
  }

  (document.getElementById("cfg-mode") as HTMLSelectElement).value = isFullMode() ? "full" : "simple";

  // Autostart state
  try {
    (document.getElementById("cfg-autostart") as HTMLInputElement).checked = await autostartIsEnabled();
  } catch { /* plugin may not be available in dev */ }
}

// Show/hide Full-mode-only surfaces (the Reports tab button) based on mode.
function applyMode() {
  const full = isFullMode();
  document.querySelectorAll<HTMLElement>(".tab-full-only").forEach((el) => {
    el.hidden = !full;
  });
  if (!full) {
    const reportsActive = document.querySelector<HTMLElement>('.tab-page[data-tab="reports"]:not(.tab-hidden)');
    if (reportsActive) switchTab("dashboard");
  }
}

document.getElementById("cfg-mode")?.addEventListener("change", async (e) => {
  const mode = (e.target as HTMLSelectElement).value === "full" ? "full" : "simple";
  await setModePersisted(mode);
  applyMode();
  // Re-render project management so rate/currency fields appear/disappear.
  renderProjectsManageList();
});

document.getElementById("cfg-theme")?.addEventListener("change", async (e) => {
  const theme = (e.target as HTMLSelectElement).value as any;
  const palette = (document.getElementById("cfg-palette") as HTMLSelectElement).value;
  const cfg = { theme, palette };
  await settings.saveAppearance(cfg);
  applyAppearance(cfg);
});

document.getElementById("cfg-palette")?.addEventListener("change", async (e) => {
  const palette = (e.target as HTMLSelectElement).value;
  const theme = (document.getElementById("cfg-theme") as HTMLSelectElement).value as any;
  const cfg = { theme, palette };
  await settings.saveAppearance(cfg);
  applyAppearance(cfg);
});

document.getElementById("cfg-autostart")?.addEventListener("change", async (e) => {
  try {
    if ((e.target as HTMLInputElement).checked) await autostartEnable();
    else await autostartDisable();
  } catch { /* plugin may not be available in dev */ }
});

document.getElementById("cfg-auto-resume-enabled")?.addEventListener("change", () => {
  void saveAutoResumeConfigFromInputs();
});

document.getElementById("cfg-auto-resume-start")?.addEventListener("change", () => {
  void saveAutoResumeConfigFromInputs();
});

document.getElementById("cfg-auto-resume-end")?.addEventListener("change", () => {
  void saveAutoResumeConfigFromInputs();
});

WORKDAY_KEYS.forEach((day) => {
  getScheduleHoursInput(day)?.addEventListener("input", () => {
    setScheduleStatus("");
    updateWorkSchedulePreview();
  });
});

// ── Work-schedule sync (server = cross-device source of truth) ───────
// The schedule used to be device-local, so web and desktop could disagree
// (mismatched overtime). It now round-trips through the server with LWW. Wire
// format is the flat {mon..sun} object (config.dailyHours), matching the web app.
async function persistScheduleRemote(config: WorkScheduleConfig) {
  const sync = await settings.getSyncConfig();
  if (!sync) return; // sync not configured: local save only
  await settings.setWorkScheduleUpdatedAt(new Date().toISOString()); // provisional
  try {
    const res = await saveRemoteSchedule(sync.serverUrl, sync.apiKey, config.dailyHours as unknown as Record<string, number>);
    if (res.ok && res.data?.schedule_updated_at) {
      await settings.setWorkScheduleUpdatedAt(res.data.schedule_updated_at);
    }
  } catch { /* offline: local save stands; next reconcile pushes it */ }
}

// Reconcile local vs server on boot. Only push the local schedule if the user
// has actually saved one, so a default never clobbers the server.
async function reconcileScheduleRemote() {
  const sync = await settings.getSyncConfig();
  if (!sync) return;
  let res;
  try { res = await getRemoteSchedule(sync.serverUrl, sync.apiKey); } catch { return; }
  if (!res.ok) return;
  const remote = res.data;
  const localTs = await settings.getWorkScheduleUpdatedAt();
  const localExplicit = await settings.hasExplicitWorkSchedule();
  if (remote?.schedule && remote.schedule_updated_at) {
    if (!localExplicit || !localTs || remote.schedule_updated_at > localTs) {
      await settings.saveWorkSchedule({ dailyHours: remote.schedule } as unknown as WorkScheduleConfig);
      await settings.setWorkScheduleUpdatedAt(remote.schedule_updated_at);
      currentWorkSchedule = await settings.getWorkSchedule();
      setWorkScheduleInputs(currentWorkSchedule);
      renderWorkScheduleSummary(currentWorkSchedule);
      updateHolidayToggleLabel();
      await refresh();
      await refreshStats();
      return;
    }
  }
  if (localExplicit) {
    try {
      const put = await saveRemoteSchedule(sync.serverUrl, sync.apiKey, currentWorkSchedule.dailyHours as unknown as Record<string, number>);
      if (put.ok && put.data?.schedule_updated_at) await settings.setWorkScheduleUpdatedAt(put.data.schedule_updated_at);
    } catch { /* offline: retry next boot */ }
  }
}

document.getElementById("btn-save-schedule")!.addEventListener("click", async () => {
  const config = readWorkScheduleFromInputs();

  if (!config) {
    setScheduleStatus("Enter 0 hours or more for each day.");
    return;
  }

  await settings.saveWorkSchedule(config);
  currentWorkSchedule = {
    dailyHours: { ...config.dailyHours },
  };
  void persistScheduleRemote(currentWorkSchedule);
  renderWorkScheduleSummary(currentWorkSchedule);
  updateHolidayToggleLabel();
  setScheduleStatus("Saved ✓");
  await refresh();
  await refreshStats();
});

document.getElementById("btn-save-cfg")!.addEventListener("click", async () => {
  const cfg: SyncConfig = {
    serverUrl: (document.getElementById("cfg-url") as HTMLInputElement).value.trim(),
    apiKey: (document.getElementById("cfg-key") as HTMLInputElement).value.trim(),
  };
  await settings.saveSyncConfig(cfg);
  await settings.saveServerUrl(cfg.serverUrl);
  setSyncStatus("Saved ✓");
});

document.getElementById("btn-sync-now")!.addEventListener("click", async () => {
  await performSync(document.getElementById("sync-status"));
});

// ═══════════════════════════════════════════════════════════════════
//  CSV EXPORT
// ═══════════════════════════════════════════════════════════════════

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

document.getElementById("btn-export")!.addEventListener("click", async () => {
  const allShifts = await shifts.getAllShifts();
  const allOffDays = await offDays.getOffDays();
  await loadProjects();

  const rows: string[] = [];

  // Shifts section
  rows.push("[Shifts]");
  rows.push(["ID", "Start Time", "End Time", "Duration (Hours)", "Project"].join(","));
  for (const s of allShifts) {
    const dur = shiftDurationHours(s).toFixed(2);
    rows.push([String(s.id), s.startTime, s.endTime ?? "", dur, csvCell(projectName(s.projectUuid))].join(","));
  }

  // Off-days section
  rows.push("");
  rows.push("[Off Days]");
  rows.push("Date");
  for (const d of allOffDays) {
    rows.push(d.date);
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tracksuite-work-export-${localDateKey(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ═══════════════════════════════════════════════════════════════════
//  CSV IMPORT
// ═══════════════════════════════════════════════════════════════════

document.getElementById("btn-import")!.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,text/csv";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const content = await file.text();
    try {
      const result = await invoke<{
        shifts_imported: number;
        shifts_skipped: number;
        offdays_imported: number;
        offdays_skipped: number;
      }>("import_csv", { content });
      const parts: string[] = [];
      if (result.shifts_imported > 0) parts.push(`${result.shifts_imported} shifts imported`);
      if (result.shifts_skipped > 0) parts.push(`${result.shifts_skipped} shifts skipped (duplicates)`);
      if (result.offdays_imported > 0) parts.push(`${result.offdays_imported} off-days imported`);
      if (result.offdays_skipped > 0) parts.push(`${result.offdays_skipped} off-days skipped (duplicates)`);
      alert(parts.length > 0 ? parts.join("\n") : "No data found in file.");
      await refresh();
    } catch (err) {
      alert("Import failed: " + err);
    }
  });
  input.click();
});

// ── Dialog handlers ─────────────────────────────────────────────────

document.getElementById("btn-add-shift")!.addEventListener("click", () => {
  clearDialogError("shift-form-error");
  const today = localDateKey(new Date());
  (document.getElementById("inp-shift-start-date") as HTMLInputElement).value = today;
  (document.getElementById("inp-shift-end-date") as HTMLInputElement).value = today;
  (document.getElementById("inp-shift-start-time") as HTMLInputElement).value = "";
  (document.getElementById("inp-shift-end-time") as HTMLInputElement).value = "";
  (document.getElementById("inp-shift-note") as HTMLInputElement).value = "";
  (document.getElementById("dlg-shift") as HTMLDialogElement).showModal();
  (document.getElementById("inp-shift-start-date") as HTMLInputElement).focus();
});
(document.getElementById("btn-cancel-shift") as HTMLButtonElement).addEventListener("click", () => {
  (document.getElementById("dlg-shift") as HTMLDialogElement).close("cancel");
});
(document.getElementById("dlg-shift") as HTMLDialogElement).addEventListener("close", () => {
  clearDialogError("shift-form-error");
});
(document.getElementById("form-shift") as HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  clearDialogError("shift-form-error");

  const start = combineManualDateTime(
    (document.getElementById("inp-shift-start-date") as HTMLInputElement).value,
    (document.getElementById("inp-shift-start-time") as HTMLInputElement).value,
  );
  const end = combineManualDateTime(
    (document.getElementById("inp-shift-end-date") as HTMLInputElement).value,
    (document.getElementById("inp-shift-end-time") as HTMLInputElement).value,
  );

  if (!start || !end) {
    setDialogError("shift-form-error", "Use YYYY-MM-DD for dates and HH:MM for times.");
    return;
  }

  if (new Date(start).getTime() >= new Date(end).getTime()) {
    setDialogError("shift-form-error", "End must be later than start.");
    return;
  }

  const noteVal = (document.getElementById("inp-shift-note") as HTMLInputElement).value.trim();
  await shifts.addManualShift(start, end, noteVal === "" ? null : noteVal);
  (document.getElementById("dlg-shift") as HTMLDialogElement).close("ok");
  await refresh();
  performSync();
});

document.getElementById("offcal-prev")!.addEventListener("click", () => {
  offCalMonth--; if (offCalMonth < 0) { offCalMonth = 11; offCalYear--; }
  renderOffdayCalendar();
});
document.getElementById("offcal-next")!.addEventListener("click", () => {
  offCalMonth++; if (offCalMonth > 11) { offCalMonth = 0; offCalYear++; }
  renderOffdayCalendar();
});
// Drag-to-paint off days on the calendar (replaces the old bulk-range dialog).
initOffdayCalendar();

// "Off days ↓" next to Add shift scrolls the dashboard to the calendar.
document.getElementById("btn-jump-offdays")!.addEventListener("click", () => {
  document.getElementById("offdays-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

(document.getElementById("btn-close-projects") as HTMLButtonElement).addEventListener("click", () => {
  (document.getElementById("dlg-projects") as HTMLDialogElement).close();
});

// Close the project chip menu when clicking anywhere outside it. The chip's own
// toggle uses stopPropagation, so this only fires for outside clicks.
document.addEventListener("click", (e) => {
  const menu = document.getElementById("project-menu");
  if (!menu || menu.hidden) return;
  const wrap = document.getElementById("project-chip-wrap");
  if (wrap && !wrap.contains(e.target as Node)) menu.hidden = true;
});

// Quick project switch: 0 sets Unassigned, 1–9 jump to the Nth project (each
// auto-splits the running shift). Ignored while typing or with modifiers held.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key < "0" || e.key > "9") return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "0") {
    e.preventDefault();
    void switchToProject(null);
    return;
  }
  const active = projectsCache.filter((p) => !p.archived);
  const target = active[Number(e.key) - 1];
  if (!target) return;
  e.preventDefault();
  void switchToProject(target.uuid);
});

(document.getElementById("form-new-project") as HTMLFormElement).addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById("new-project-name") as HTMLInputElement;
  const colorEl = document.getElementById("new-project-color") as HTMLInputElement;
  const name = nameEl.value.trim();
  if (!name) return;
  nameEl.value = "";

  await projects.createProject(name, colorEl.value);
  await loadProjects();
  renderProjectsManageList();
  renderProjectChip();
  await refresh();
  performSync();
});

// ── Onboarding ──────────────────────────────────────────────────────

const onbDlg = document.getElementById("dlg-onboarding") as HTMLDialogElement;
const onbSteps = onbDlg.querySelectorAll<HTMLDivElement>(".onboarding-step");

function showOnbStep(name: string) {
  onbSteps.forEach((s) => (s.style.display = s.dataset.step === name ? "" : "none"));
}

document.getElementById("onb-next-1")!.addEventListener("click", () => showOnbStep("autostart"));
document.getElementById("onb-back-2")!.addEventListener("click", () => showOnbStep("welcome"));
document.getElementById("onb-next-2")!.addEventListener("click", () => showOnbStep("sync"));
document.getElementById("onb-back-3")!.addEventListener("click", () => showOnbStep("autostart"));

document.getElementById("onb-finish")!.addEventListener("click", async () => {
  // Apply autostart preference
  try {
    if ((document.getElementById("onb-autostart") as HTMLInputElement).checked) {
      await autostartEnable();
    }
  } catch { /* non-critical */ }

  // Save sync config if provided
  const url = (document.getElementById("onb-url") as HTMLInputElement).value.trim();
  const key = (document.getElementById("onb-key") as HTMLInputElement).value.trim();
  if (url && key) {
    await settings.saveSyncConfig({ serverUrl: url, apiKey: key });
  }

  // Mark onboarding complete
  await invoke("set_config", { key: "onboarding_complete", value: "1" });
  onbDlg.close();
  refresh();
  performSync();
});

// Prevent closing onboarding with Escape
onbDlg.addEventListener("cancel", (e) => e.preventDefault());

async function maybeShowOnboarding() {
  const done = await invoke<string | null>("get_config", { key: "onboarding_complete" });
  if (!done) {
    showOnbStep("welcome");
    onbDlg.showModal();
  }
}

// ── What's New (shown once per version, on the first launch after an update) ──

type ChangelogEntry = { version: string; date: string; title?: string; changes: string[] };

// Newest first. Add a new entry per release; it shows once on the next launch.
const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.9.2",
    date: "2026-07-22",
    title: "Smarter updates on apt",
    changes: [
      "If you installed from the apt repository, the update banner now points you to a normal system update (with a one-click copy of the exact command) instead of downloading a .deb — with a “download the .deb instead” fallback just in case.",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-07-22",
    title: "Paint your off days",
    changes: [
      "Off days moved to the dashboard, where you now paint them straight on the calendar: press a day and drag to mark a stretch off — drag over existing off days to clear them, or click a single day to toggle it. The old range dialog is gone.",
      "New “Off days ↓” button next to Add shift jumps you to the calendar.",
      "On Debian/Ubuntu you can now install from an apt repository and get updates with a normal apt upgrade — see the download page.",
      "Fixed off-day cells that could be unreadable on some colour themes.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-07-22",
    title: "Reports, billing & a smarter timeline",
    changes: [
      "New Simple/Full mode toggle (Settings → Mode). Simple keeps the clean tracker; Full unlocks billing, the letterhead profile and Reports.",
      "Reports tab: generate a Client report (hours × rate, per-project totals) or a Timesheet (worked vs. your schedule), then print to PDF or export CSV. Set an hourly rate and currency per project, and a reusable letterhead in your profile.",
      "Shift notes everywhere: jot what you worked on. On a multi-project day, use the 🖌 note brush to paint one note across several timeline blocks, or press Enter/↓ to carry a note down the sessions list.",
      "The timeline now shows your running shift as a live block that grows in real time, instead of appearing only after you clock out.",
      "Backfill older days: click any bar in the Statistics trend chart to open that day's editor — week and month bars zoom in first, with a breadcrumb to step back out. No more being stuck on the current week.",
      "Your weekly work schedule now syncs across devices, so hours targets and overtime match everywhere (and survive a browser reset).",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-07-14",
    title: "Smoother updates on Linux packages",
    changes: [
      "Fixed the in-app update on Debian/Ubuntu (.deb) and Fedora (.rpm) installs, which could hang on “Downloading…”. These now download the new package and open it in your system installer instead of trying (and failing) to self-update.",
      "AppImage, macOS and Windows continue to update automatically, and now fall back to the releases page if an automatic update can't complete.",
    ],
  },
  {
    version: "0.8.3",
    date: "2026-07-14",
    title: "No more runaway shifts",
    changes: [
      "Fixed shifts ballooning into huge durations when the app couldn't clock you out cleanly (laptop closed, crash, or power loss). A running shift is now checked with a background heartbeat and, if the app is killed without a clean clock-out, it's recovered on next launch and closed to when you were last active.",
      "Auto-closed shifts are flagged for review so you can quickly set the correct end time if needed.",
      "The server now guarantees a single active shift, so shifts can no longer pile up unnoticed across your devices.",
    ],
  },
  {
    version: "0.8.2",
    date: "2026-07-12",
    title: "Projects, reliable sync & auto-updates",
    changes: [
      "Projects — tag your time to projects, switch projects mid-shift (the running session splits automatically), and jump between projects with the number keys 0–9.",
      "Day timeline editor — click a day in the weekly chart and drag across it to reassign past time to a project.",
      "Statistics now break your hours down by project, with stacked weekly and trend charts and a per-project totals summary.",
      "Reworked device sync — changes and deletions now sync reliably between the desktop and web apps. Deleted entries stay deleted, and you can start a shift on one device and finish it on another.",
      "The web app gained the same projects and timeline tools as the desktop app, and can now export your log to CSV.",
      "CSV export now includes the project for each shift.",
      "Automatic updates — the app now notifies you when a new version is available and can update itself.",
      "Many stability and data-safety fixes.",
    ],
  },
];

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function renderWhatsNew(entries: ChangelogEntry[]) {
  const dlg = document.getElementById("dlg-whats-new") as HTMLDialogElement;
  const body = document.getElementById("whats-new-body")!;
  body.innerHTML = entries
    .map((e) => `
      <div class="whats-new-entry">
        <div class="whats-new-version">v${e.version}${e.title ? ` — ${escapeHtml(e.title)}` : ""}</div>
        <ul>${e.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
      </div>`)
    .join("");
  dlg.showModal();
}

async function maybeShowWhatsNew() {
  let current: string;
  try { current = await getVersion(); } catch { return; }

  const seen = await invoke<string | null>("get_config", { key: "whats_new_seen_version" });
  const onboardingDone = await invoke<string | null>("get_config", { key: "onboarding_complete" });

  // Fresh installs get onboarding, not a changelog. Record the version so the
  // changelog never pops after they finish onboarding.
  if (!onboardingDone) {
    await invoke("set_config", { key: "whats_new_seen_version", value: current });
    return;
  }
  if (seen === current) return;

  // Existing user who updated: show every entry newer than what they last saw.
  // If they came from a version predating this feature (no stored version),
  // show the latest entry, which summarizes the whole jump.
  const entries = seen
    ? CHANGELOG.filter((e) => compareVersions(e.version, seen) > 0)
    : CHANGELOG.slice(0, 1);
  await invoke("set_config", { key: "whats_new_seen_version", value: current });
  if (entries.length > 0) renderWhatsNew(entries);
}

function scheduleRefresh() {
  void refresh();
}

// ── Boot ────────────────────────────────────────────────────────────

// Keep the visible UI in sync when tray actions update the local database.
listen("tray-data-changed", () => scheduleRefresh());

// On focus, pull remote changes (e.g. a shift closed on the web app) as well
// as refresh. performSync refreshes on success; scheduleRefresh covers the
// not-configured / offline case.
window.addEventListener("focus", () => {
  scheduleRefresh();
  void checkStaleAndRecover();
  void performSync();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    scheduleRefresh();
    void checkStaleAndRecover();
    void performSync();
  }
});

// System suspend or resume handling.
listen("system-suspend", () => {
  void handleSystemSuspend();
});

listen("system-resume", () => {
  void handleSystemResume();
  // Backstop for when suspend didn't fire cleanly: close a stale open shift.
  void checkStaleAndRecover();
});

const RELEASES_URL = "https://github.com/julianquandt/TrackSuite.work/releases/latest";

async function checkForUpdates() {
  try {
    const update = await check();
    if (!update) return;
    const bar = document.getElementById("update-bar")!;
    const msg = document.getElementById("update-msg")!;
    const installBtn = document.getElementById("btn-update") as HTMLButtonElement;
    const altHint = document.getElementById("update-alt-hint")!;
    const altBtn = document.getElementById("btn-update-alt") as HTMLButtonElement;
    const dismissBtn = document.getElementById("btn-dismiss-update")!;
    bar.style.display = "";
    installBtn.disabled = false;
    altHint.style.display = "none";
    altBtn.style.display = "none";
    dismissBtn.onclick = () => { bar.style.display = "none"; };

    // The "download the package + open the system installer" flow, reused by the
    // plain .deb/.rpm branch and the apt fallback button.
    const wireDownloadDeb = (btn: HTMLButtonElement, label: string) => {
      btn.textContent = label;
      btn.onclick = async () => {
        btn.disabled = true;
        msg.textContent = "Downloading…";
        try {
          const path = await invoke<string>("download_update_package");
          msg.textContent = "Downloaded — opening installer…";
          await invoke("open_url", { url: path });
          btn.textContent = "Open installer";
          btn.disabled = false;
          btn.onclick = () => void invoke("open_url", { url: path });
        } catch {
          msg.textContent = `Couldn't download automatically — get v${update.version} from the releases page.`;
          btn.textContent = "Open Releases";
          btn.disabled = false;
          btn.onclick = () => void invoke("open_url", { url: RELEASES_URL });
        }
      };
    };

    // Tauri can self-update an AppImage/.dmg/Windows installer, but not a
    // package-managed .deb/.rpm. apt-managed installs update via `apt upgrade`,
    // so we point there (with a .deb fallback) rather than fetching a package.
    const selfUpdatable = await invoke<boolean>("is_self_updatable").catch(() => true);
    const aptManaged = !selfUpdatable && await invoke<boolean>("is_apt_managed").catch(() => false);

    if (selfUpdatable) {
      msg.textContent = `Update available: v${update.version}`;
      installBtn.textContent = "Install & Restart";
      installBtn.onclick = async () => {
        installBtn.disabled = true;
        msg.textContent = "Downloading…";
        try {
          await update.downloadAndInstall();
          await relaunch();
        } catch {
          msg.textContent = `Couldn't install automatically — download v${update.version}.`;
          installBtn.textContent = "Open Releases";
          installBtn.disabled = false;
          installBtn.onclick = () => void invoke("open_url", { url: RELEASES_URL });
        }
      };
    } else if (aptManaged) {
      const cmd = "sudo apt update && sudo apt install --only-upgrade track-suite-work";
      msg.textContent = `v${update.version} is available — it'll arrive with your next system update, or update now manually:`;
      installBtn.textContent = "Copy command";
      installBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          installBtn.textContent = "Copied ✓";
          setTimeout(() => { installBtn.textContent = "Copy command"; }, 2000);
        } catch {
          msg.textContent = cmd; // clipboard blocked — show it to copy by hand
        }
      };
      // False-positive escape hatch: repo configured but installed some other way.
      altHint.textContent = "Not installed via apt?";
      altHint.style.display = "";
      altBtn.style.display = "";
      wireDownloadDeb(altBtn, "Download the .deb");
    } else {
      msg.textContent = `Update available: v${update.version}`;
      wireDownloadDeb(installBtn, "Download update");
    }
  } catch { /* non-critical */ }
}

document.getElementById("btn-whats-new-close")?.addEventListener("click", () => {
  (document.getElementById("dlg-whats-new") as HTMLDialogElement).close();
});

// ── Reports tab (Full mode) ─────────────────────────────────────────
let rpProfile: ReportProfile = {};
let rpShifts: ShiftRecord[] = [];
let rpOffDaySet = new Set<string>();
let rpWired = false;
let rpProfileAvailable = false;

const RP_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function rpEl<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function fmtHoursNum(h: number): string { return h.toFixed(2); }
function fmtMoney(a: number): string {
  return a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signedHoursNum(h: number): string {
  const r = Math.round(h * 100) / 100;
  return (r >= 0 ? "+" : "") + r.toFixed(2);
}
function reportCsvCell(v: string): string {
  let s = v ?? "";
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

interface RpLineItem {
  date: string; startTime: string; endTime: string | null;
  projectName: string; projectUuid: string | null; note: string;
  hours: number; rate: number | null; currency: string; amount: number | null;
}

interface RpDetailRow {
  date: string; times: string; projectName: string; note: string;
  hours: number; amount: number | null; currency: string;
}

function rpFmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function rpBuildLineItems(): RpLineItem[] {
  const fromMs = new Date(rpEl<HTMLInputElement>("rp-from").value + "T00:00:00").getTime();
  const toMs = new Date(rpEl<HTMLInputElement>("rp-to").value + "T23:59:59.999").getTime();
  const projFilter = rpEl<HTMLSelectElement>("rp-project").value || null;
  const defaultCurrency = (rpProfile.default_currency ?? "").toUpperCase();
  return rpShifts
    .filter((s) => s.endTime !== null)
    .filter((s) => { const ms = new Date(s.startTime).getTime(); return ms >= fromMs && ms <= toMs; })
    .filter((s) => (projFilter ? (s.projectUuid ?? null) === projFilter : true))
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((s) => {
      const proj = projectsCache.find((p) => p.uuid === (s.projectUuid ?? null));
      const hours = shiftDurationHours(s);
      const rateNum = proj && proj.rate != null && proj.rate !== "" ? parseFloat(proj.rate) : null;
      const currency = (proj?.currency && proj.currency !== "" ? proj.currency : defaultCurrency).toUpperCase();
      const rate = rateNum != null && !Number.isNaN(rateNum) ? rateNum : null;
      const amount = rate != null ? hours * rate : null;
      return { date: localDateKey(new Date(s.startTime)), startTime: s.startTime, endTime: s.endTime, projectName: proj?.name ?? "Unassigned", projectUuid: s.projectUuid ?? null, note: s.note ?? "", hours, rate, currency, amount };
    });
}

// One row per shift (with work times) when `withTimes`, otherwise same day +
// project pooled into a single row (hours/amount summed, distinct notes joined).
function rpBuildDetailRows(withTimes: boolean): RpDetailRow[] {
  const items = rpBuildLineItems();
  if (withTimes) {
    return items.map((it) => ({
      date: it.date,
      times: it.endTime ? `${rpFmtTime(it.startTime)}–${rpFmtTime(it.endTime)}` : rpFmtTime(it.startTime),
      projectName: it.projectName, note: it.note, hours: it.hours, amount: it.amount, currency: it.currency,
    }));
  }
  const pooled = new Map<string, RpDetailRow & { notes: Set<string> }>();
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
  return Array.from(pooled.values()).map((r) => ({
    date: r.date, times: r.times, projectName: r.projectName,
    note: Array.from(r.notes).join("; "), hours: r.hours, amount: r.amount, currency: r.currency,
  }));
}

interface RpTimesheetRow { date: string; weekday: string; worked: number; target: number; diff: number; }
function rpBuildTimesheet(): RpTimesheetRow[] {
  const fromV = rpEl<HTMLInputElement>("rp-from").value;
  const toV = rpEl<HTMLInputElement>("rp-to").value;
  const projFilter = rpEl<HTMLSelectElement>("rp-project").value || null;
  const workedByDay = new Map<string, number>();
  for (const s of rpShifts) {
    if (!s.endTime) continue;
    if (projFilter && (s.projectUuid ?? null) !== projFilter) continue;
    const key = localDateKey(new Date(s.startTime));
    workedByDay.set(key, (workedByDay.get(key) ?? 0) + shiftDurationHours(s));
  }
  const rows: RpTimesheetRow[] = [];
  const cursor = new Date(fromV + "T00:00:00");
  const end = new Date(toV + "T00:00:00");
  while (cursor.getTime() <= end.getTime()) {
    const key = localDateKey(cursor);
    const worked = workedByDay.get(key) ?? 0;
    const target = rpOffDaySet.has(key) ? 0 : getTargetHoursForDate(cursor, currentWorkSchedule);
    if (worked > 0 || target > 0) {
      rows.push({ date: key, weekday: RP_WEEKDAY[cursor.getDay()], worked, target, diff: worked - target });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return rows;
}

function rpCurrentStyle(): string { return rpEl<HTMLSelectElement>("rp-style").value; }

function rpLetterhead(from: string, to: string): string {
  const p = rpProfile;
  const custom = (p.custom_fields ?? []).filter((f) => f.label || f.value);
  return `
    <div class="report-letterhead">
      <div class="report-sender">
        ${p.name ? `<div class="report-name">${escapeHtml(p.name)}</div>` : ""}
        ${p.company ? `<div>${escapeHtml(p.company)}</div>` : ""}
        ${p.address ? `<div class="report-addr">${escapeHtml(p.address).replace(/\n/g, "<br>")}</div>` : ""}
        ${p.email ? `<div>${escapeHtml(p.email)}</div>` : ""}
        ${custom.map((f) => `<div class="report-cf"><span>${escapeHtml(f.label)}:</span> ${escapeHtml(f.value)}</div>`).join("")}
      </div>
      <div class="report-meta">
        <div class="report-title">${p.letter_header ? escapeHtml(p.letter_header) : "Time report"}</div>
        <div class="muted">${escapeHtml(from)} — ${escapeHtml(to)}</div>
        <div class="muted">Generated ${escapeHtml(localDateKey(new Date()))}</div>
      </div>
    </div>`;
}

function rpRenderReport() {
  const isClient = rpCurrentStyle() === "client";
  rpEl("rp-detailed-wrap").style.display = isClient ? "" : "none";
  rpEl("rp-times-wrap").style.display = isClient && rpEl<HTMLInputElement>("rp-detailed").checked ? "" : "none";
  if (rpCurrentStyle() === "timesheet") rpRenderTimesheet();
  else rpRenderClientReport();
}

function rpRenderClientReport() {
  const detailed = rpEl<HTMLInputElement>("rp-detailed").checked;
  const items = rpBuildLineItems();
  const out = rpEl("report-output");
  out.hidden = false;
  const fromV = rpEl<HTMLInputElement>("rp-from").value;
  const toV = rpEl<HTMLInputElement>("rp-to").value;

  const groups = new Map<string, { name: string; hours: number; rate: number | null; currency: string; amount: number | null }>();
  for (const it of items) {
    const key = (it.projectUuid ?? "unassigned") + "|" + it.currency;
    const g = groups.get(key);
    if (g) { g.hours += it.hours; if (it.amount != null) g.amount = (g.amount ?? 0) + it.amount; }
    else groups.set(key, { name: it.projectName, hours: it.hours, rate: it.rate, currency: it.currency, amount: it.amount });
  }
  const totalsByCurrency = new Map<string, number>();
  for (const it of items) if (it.amount != null) totalsByCurrency.set(it.currency, (totalsByCurrency.get(it.currency) ?? 0) + it.amount);
  const totalHours = items.reduce((s, it) => s + it.hours, 0);

  const summaryRows = Array.from(groups.values()).map((g) => `
    <tr><td>${escapeHtml(g.name)}</td><td class="num">${fmtHoursNum(g.hours)}</td>
    <td class="num">${g.rate != null ? fmtMoney(g.rate) + " " + escapeHtml(g.currency) : "—"}</td>
    <td class="num">${g.amount != null ? fmtMoney(g.amount) + " " + escapeHtml(g.currency) : "—"}</td></tr>`).join("");
  const totalsRows = Array.from(totalsByCurrency.entries()).map(([cur, amt]) => `
    <tr class="report-total-row"><td colspan="3" class="num"><strong>Total (${escapeHtml(cur || "—")})</strong></td>
    <td class="num"><strong>${fmtMoney(amt)} ${escapeHtml(cur)}</strong></td></tr>`).join("");
  const withTimes = rpEl<HTMLInputElement>("rp-times").checked;
  const detailRows = detailed ? rpBuildDetailRows(withTimes) : [];
  const detailTable = detailed ? `
    <h4 class="report-h">Itemized entries</h4>
    <table class="report-table"><thead><tr><th>Date</th>${withTimes ? "<th>Time</th>" : ""}<th>Project</th><th>Note</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead>
    <tbody>${detailRows.map((r) => `<tr><td>${escapeHtml(r.date)}</td>${withTimes ? `<td>${escapeHtml(r.times)}</td>` : ""}<td>${escapeHtml(r.projectName)}</td><td>${escapeHtml(r.note)}</td>
      <td class="num">${fmtHoursNum(r.hours)}</td><td class="num">${r.amount != null ? fmtMoney(r.amount) + " " + escapeHtml(r.currency) : "—"}</td></tr>`).join("")}</tbody></table>` : "";

  out.innerHTML = `
    ${rpLetterhead(fromV, toV)}
    ${items.length === 0 ? `<p class="muted">No completed shifts in this range.</p>` : `
    <h4 class="report-h">Summary by project</h4>
    <table class="report-table"><thead><tr><th>Project</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${summaryRows}
      <tr class="report-total-row"><td class="num"><strong>Total hours</strong></td><td class="num"><strong>${fmtHoursNum(totalHours)}</strong></td><td></td><td></td></tr>
      ${totalsRows}</tbody></table>${detailTable}`}
    ${rpProfile.footer ? `<div class="report-footer">${escapeHtml(rpProfile.footer).replace(/\n/g, "<br>")}</div>` : ""}`;
}

function rpRenderTimesheet() {
  const rows = rpBuildTimesheet();
  const out = rpEl("report-output");
  out.hidden = false;
  const fromV = rpEl<HTMLInputElement>("rp-from").value;
  const toV = rpEl<HTMLInputElement>("rp-to").value;
  const totalWorked = rows.reduce((s, r) => s + r.worked, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const body = rows.map((r) => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.weekday)}</td>
    <td class="num">${fmtHoursNum(r.worked)}</td><td class="num">${fmtHoursNum(r.target)}</td><td class="num">${signedHoursNum(r.diff)}</td></tr>`).join("");
  out.innerHTML = `
    ${rpLetterhead(fromV, toV)}
    ${rows.length === 0 ? `<p class="muted">No working days in this range.</p>` : `
    <h4 class="report-h">Timesheet</h4>
    <table class="report-table"><thead><tr><th>Date</th><th>Day</th><th class="num">Worked</th><th class="num">Target</th><th class="num">+/−</th></tr></thead>
    <tbody>${body}
      <tr class="report-total-row"><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${fmtHoursNum(totalWorked)}</strong></td>
      <td class="num"><strong>${fmtHoursNum(totalTarget)}</strong></td><td class="num"><strong>${signedHoursNum(totalWorked - totalTarget)}</strong></td></tr></tbody></table>`}
    ${rpProfile.footer ? `<div class="report-footer">${escapeHtml(rpProfile.footer).replace(/\n/g, "<br>")}</div>` : ""}`;
}

async function rpExportCsv() {
  let header: string[]; let rows: string[][]; let kind: string;
  if (rpCurrentStyle() === "timesheet") {
    const ts = rpBuildTimesheet();
    if (ts.length === 0) { alert("No working days in this range to export."); return; }
    header = ["Date", "Day", "Worked", "Target", "Difference"];
    rows = ts.map((r) => [r.date, r.weekday, fmtHoursNum(r.worked), fmtHoursNum(r.target), signedHoursNum(r.diff)]);
    kind = "timesheet";
  } else {
    const withTimes = rpEl<HTMLInputElement>("rp-times").checked;
    const detail = rpBuildDetailRows(withTimes);
    if (detail.length === 0) { alert("No completed shifts in this range to export."); return; }
    header = withTimes
      ? ["Date", "Time", "Project", "Note", "Hours", "Currency", "Amount"]
      : ["Date", "Project", "Note", "Hours", "Currency", "Amount"];
    rows = detail.map((r) => {
      const base = [r.date];
      if (withTimes) base.push(r.times);
      base.push(r.projectName, r.note, fmtHoursNum(r.hours), r.currency, r.amount != null ? r.amount.toFixed(2) : "");
      return base;
    });
    kind = "report";
  }
  const csv = [header, ...rows].map((r) => r.map((c) => reportCsvCell(String(c))).join(",")).join("\r\n");
  const name = `${kind}_${rpEl<HTMLInputElement>("rp-from").value}_${rpEl<HTMLInputElement>("rp-to").value}.csv`;
  try {
    const path = await invoke<string>("save_download_file", { name, contents: csv });
    alert("Saved to: " + path);
  } catch (err) {
    alert("Failed to save CSV: " + err);
  }
}

// ── Profile editor (Full mode) ──────────────────────────────────────
function rpRenderCustomFields(fields: { label: string; value: string }[]) {
  const el = rpEl("pf-custom-list");
  el.innerHTML = fields.map((f) => `
    <div class="pf-custom-row">
      <input type="text" class="pf-cf-label" value="${escapeHtml(f.label)}" placeholder="Label (e.g. VAT ID)" maxlength="60">
      <input type="text" class="pf-cf-value" value="${escapeHtml(f.value)}" placeholder="Value" maxlength="120">
      <button class="btn-icon pf-cf-remove" type="button" title="Remove">&times;</button>
    </div>`).join("");
  el.querySelectorAll<HTMLButtonElement>(".pf-cf-remove").forEach((b) => b.addEventListener("click", () => b.closest(".pf-custom-row")?.remove()));
}
function rpCollectCustomFields(): { label: string; value: string }[] {
  return Array.from(rpEl("pf-custom-list").querySelectorAll<HTMLElement>(".pf-custom-row"))
    .map((row) => ({ label: (row.querySelector(".pf-cf-label") as HTMLInputElement).value.trim(), value: (row.querySelector(".pf-cf-value") as HTMLInputElement).value.trim() }))
    .filter((f) => f.label !== "" || f.value !== "");
}
function rpFillProfileForm() {
  rpEl<HTMLInputElement>("pf-name").value = rpProfile.name ?? "";
  rpEl<HTMLInputElement>("pf-company").value = rpProfile.company ?? "";
  rpEl<HTMLInputElement>("pf-email").value = rpProfile.email ?? "";
  rpEl<HTMLInputElement>("pf-currency").value = rpProfile.default_currency ?? "";
  rpEl<HTMLTextAreaElement>("pf-address").value = rpProfile.address ?? "";
  rpEl<HTMLTextAreaElement>("pf-header").value = rpProfile.letter_header ?? "";
  rpEl<HTMLTextAreaElement>("pf-footer").value = rpProfile.footer ?? "";
  rpRenderCustomFields(rpProfile.custom_fields ?? []);
}
function rpReadProfileForm(): ReportProfile {
  return {
    name: rpEl<HTMLInputElement>("pf-name").value.trim(),
    company: rpEl<HTMLInputElement>("pf-company").value.trim(),
    email: rpEl<HTMLInputElement>("pf-email").value.trim(),
    default_currency: rpEl<HTMLInputElement>("pf-currency").value.trim().toUpperCase(),
    address: rpEl<HTMLTextAreaElement>("pf-address").value.trim(),
    letter_header: rpEl<HTMLTextAreaElement>("pf-header").value.trim(),
    footer: rpEl<HTMLTextAreaElement>("pf-footer").value.trim(),
    custom_fields: rpCollectCustomFields(),
  };
}

function rpWireHandlers() {
  if (rpWired) return;
  rpWired = true;
  rpEl("rp-generate").addEventListener("click", rpRenderReport);
  rpEl("rp-style").addEventListener("change", rpRenderReport);
  rpEl("rp-detailed").addEventListener("change", rpRenderReport);
  rpEl("rp-times").addEventListener("change", rpRenderReport);
  rpEl("rp-csv").addEventListener("click", () => void rpExportCsv());
  rpEl("rp-print").addEventListener("click", () => { if (rpEl("report-output").hidden) rpRenderReport(); window.print(); });
  rpEl("pf-add-field").addEventListener("click", () => { const f = rpCollectCustomFields(); f.push({ label: "", value: "" }); rpRenderCustomFields(f); });
  rpEl("pf-save").addEventListener("click", async () => {
    const status = rpEl("pf-status");
    const sync = await settings.getSyncConfig();
    if (!sync) { status.textContent = "Configure sync first."; return; }
    const btn = rpEl<HTMLButtonElement>("pf-save");
    btn.disabled = true; status.textContent = "Saving…";
    rpProfile = rpReadProfileForm();
    const res = await saveRemoteProfile(sync.serverUrl, sync.apiKey, rpProfile);
    btn.disabled = false;
    if (res.ok) { status.textContent = "Saved."; setTimeout(() => (status.textContent = ""), 2500); }
    else { status.textContent = "Failed to save: " + (res.message ?? "server error"); }
  });
}

async function renderReportsTab() {
  rpWireHandlers();

  // Default the date range to the current month on first open.
  const fromEl = rpEl<HTMLInputElement>("rp-from");
  const toEl = rpEl<HTMLInputElement>("rp-to");
  if (!fromEl.value) {
    const now = new Date();
    fromEl.value = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
    toEl.value = localDateKey(now);
  }

  // Load the shared report profile from the server (Full mode needs sync).
  const sync = await settings.getSyncConfig();
  rpProfileAvailable = !!sync;
  rpEl("rp-profile-unavailable").hidden = rpProfileAvailable;
  rpEl("rp-profile-body").hidden = !rpProfileAvailable;
  if (sync) {
    try {
      const res = await getRemoteProfile(sync.serverUrl, sync.apiKey);
      if (res.ok && res.data?.profile) rpProfile = res.data.profile; else rpProfile = {};
    } catch { rpProfile = {}; }
    rpFillProfileForm();
  }

  // Load tracking data (projects are already in projectsCache).
  const [allShifts, offDayList] = await Promise.all([shifts.getAllShifts(), offDays.getOffDays()]);
  rpShifts = allShifts;
  rpOffDaySet = new Set(offDayList.map((o) => o.date));

  const sel = rpEl<HTMLSelectElement>("rp-project");
  sel.innerHTML = `<option value="">All projects</option>`;
  for (const p of projectsCache.filter((p) => !p.archived)) {
    const opt = document.createElement("option");
    opt.value = p.uuid;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }

  rpRenderReport();
}

loadMode()
  .then(() => { applyMode(); return loadSettings(); })
  .then(async () => {
    // Recover a shift the app couldn't clock out last run before the first paint.
    await checkStaleAndRecover();
    refresh();
    performSync();
    // Pull the shared work schedule (may adopt a newer server copy and re-render).
    void reconcileScheduleRemote();
    maybeShowOnboarding();
    void maybeShowWhatsNew();
    checkForUpdates();
  });