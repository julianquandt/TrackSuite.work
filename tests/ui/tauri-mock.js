// In-memory stand-in for the Rust side of the desktop app, for browser tests.
// Injected before the page's own scripts. It answers the commands the
// interface calls, so layout and wiring can be tested in plain Chrome.
// It does NOT test the Rust code (cargo test does that).
//
// A test can set window.__TAURI_SEED__ = { config, projects, shifts, offDays,
// syncResult } in an earlier init script to change the starting state.
(() => {
    const seed = window.__TAURI_SEED__ || {};
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return iso(d); };

    const state = {
        // Full mode, and the first-run welcome and "What's new" dialogs already seen
        // (they would cover the page).
        config: { app_mode: "full", onboarding_complete: "1", whats_new_seen_version: "0.0.0-test", ...(seed.config || {}) },
        projects: seed.projects || [
            { uuid: "p-client", name: "Client A", color: "#3b82f6", archived: false, rate: null, currency: null },
            { uuid: "p-internal", name: "Internal", color: "#10b981", archived: false, rate: null, currency: null },
        ],
        shifts: seed.shifts || [
            { id: 1, uuid: "s1", start_time: at(9), end_time: at(11), project_uuid: "p-client", note: "planning", auto_closed_at: null },
            { id: 2, uuid: "s2", start_time: at(11), end_time: at(12, 30), project_uuid: "p-internal", note: null, auto_closed_at: null },
        ],
        offDays: seed.offDays || [],
        currentProject: null,
        nextId: 100,
        calls: [],
    };
    const open = () => state.shifts.find((s) => !s.end_time) || null;

    const commands = {
        get_config: ({ key }) => state.config[key] ?? null,
        set_config: ({ key, value }) => { state.config[key] = value; },
        get_all_shifts: () => state.shifts.map((s) => ({ ...s })),
        get_active_shift: () => { const s = open(); return s ? { ...s } : null; },
        start_shift: () => {
            if (open()) return false;
            const id = state.nextId++;
            state.shifts.push({ id, uuid: `s${id}`, start_time: iso(new Date()), end_time: null, project_uuid: state.currentProject, note: null, auto_closed_at: null });
            return true;
        },
        end_shift: () => { const s = open(); if (!s) return false; s.end_time = iso(new Date()); return true; },
        end_local_shift: () => commands.end_shift(),
        delete_shift: ({ shiftId }) => { state.shifts = state.shifts.filter((s) => s.id !== shiftId); },
        set_shift_note: ({ shiftId, note }) => { const s = state.shifts.find((x) => x.id === shiftId); if (s) s.note = note; },
        set_shift_project: ({ shiftId, projectUuid }) => { const s = state.shifts.find((x) => x.id === shiftId); if (s) s.project_uuid = projectUuid; },
        get_projects: () => state.projects.map((p) => ({ ...p })),
        create_project: ({ name, color }) => { const p = { uuid: `p${state.nextId++}`, name, color, archived: false, rate: null, currency: null }; state.projects.push(p); return { ...p }; },
        get_current_project: () => state.currentProject,
        set_current_project: ({ projectUuid }) => { state.currentProject = projectUuid; const s = open(); if (s) s.project_uuid = projectUuid; return true; },
        get_off_days: () => state.offDays.map((d) => ({ ...d })),
        add_off_day: ({ date }) => { if (!state.offDays.some((d) => d.date === date)) state.offDays.push({ date, reason: null }); },
        remove_off_day: ({ date }) => { state.offDays = state.offDays.filter((d) => d.date !== date); },
        sync_now: () => seed.syncResult ?? "not_configured",
        take_auto_closed_shift: () => null,
        fill_range: () => [],
        assign_project_to_range: () => 0,
        is_self_updatable: () => false,
        is_apt_managed: () => false,
        autostart_is_enabled: () => false,
        // Tauri's own plugins
        "plugin:app|version": () => "0.0.0-test",
        "plugin:event|listen": () => state.nextId++,
        "plugin:event|unlisten": () => null,
        "plugin:notification|is_permission_granted": () => true,
        "plugin:updater|check": () => null,
    };

    window.__TAURI_TEST__ = state;
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => state.nextId++,
        convertFileSrc: (path) => path,
        invoke: async (cmd, args) => {
            state.calls.push(cmd);
            const handler = commands[cmd];
            // Unknown commands answer "nothing", like a command with no result.
            return handler ? handler(args || {}) : null;
        },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
