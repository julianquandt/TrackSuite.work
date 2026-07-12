export type MigrationStrategy = "port" | "replace" | "keep";

export type MigrationEntry = {
    currentPath: string;
    targetPath: string;
    category: "shared-core" | "desktop-shell" | "backend";
    strategy: MigrationStrategy;
    summary: string;
};

export const migrationEntries: MigrationEntry[] = [
    {
        currentPath: "work_time_app/database.py",
        targetPath: "desktop/src/lib/storage.ts",
        category: "shared-core",
        strategy: "port",
        summary: "Port local shift and off-day persistence into a Tauri-friendly repository layer.",
    },
    {
        currentPath: "work_time_app/sync.py",
        targetPath: "desktop/src/lib/api.ts",
        category: "shared-core",
        strategy: "port",
        summary: "Keep the sync contract but reimplement the client with browser fetch and typed models.",
    },
    {
        currentPath: "work_time_app/ui/graphs.py",
        targetPath: "desktop/src/main.ts",
        category: "shared-core",
        strategy: "port",
        summary: "Reuse the existing Chart.js approach in the web UI instead of embedding a WebKit view.",
    },
    {
        currentPath: "work_time_app/indicator.py",
        targetPath: "desktop/src-tauri/src/main.rs",
        category: "desktop-shell",
        strategy: "replace",
        summary: "Replace Linux AppIndicator with a cross-platform tray icon and menu.",
    },
    {
        currentPath: "work_time_app/main.py",
        targetPath: "desktop/src-tauri/src/main.rs",
        category: "desktop-shell",
        strategy: "replace",
        summary: "Move process bootstrap, tray initialization, and window lifecycle into the Tauri host.",
    },
    {
        currentPath: "work_time_app/notifications.py",
        targetPath: "desktop/src/lib/platform.ts",
        category: "desktop-shell",
        strategy: "port",
        summary: "Swap GI notifications for the Tauri notification plugin or OS-native APIs.",
    },
    {
        currentPath: "work_time_app/suspend_handler.py",
        targetPath: "desktop/src/lib/platform.ts",
        category: "desktop-shell",
        strategy: "replace",
        summary: "Rebuild sleep and wake integration behind a small platform adapter.",
    },
    {
        currentPath: "work_time_app/ui/dashboard.py",
        targetPath: "desktop/src/main.ts",
        category: "desktop-shell",
        strategy: "replace",
        summary: "Rewrite the dashboard as a web UI while keeping the data model and feature set.",
    },
    {
        currentPath: "app_server/main.py",
        targetPath: "backend/app_server/main.py",
        category: "backend",
        strategy: "keep",
        summary: "Keep the current FastAPI service as the canonical backend entry point during the migration.",
    },
    {
        currentPath: "app_server/models.py",
        targetPath: "backend/app_server/models.py",
        category: "backend",
        strategy: "keep",
        summary: "Keep the current SQLAlchemy models and move future auth changes into the backend package.",
    },
];

export const migrationGroups = [
    {
        key: "shared-core",
        title: "Shared Core",
        summary: "Logic that can be ported with minimal product change.",
    },
    {
        key: "desktop-shell",
        title: "Desktop Shell",
        summary: "GTK- and Linux-specific behavior that must move to Tauri host code or web UI.",
    },
    {
        key: "backend",
        title: "Backend",
        summary: "Server code that stays Python-first while the desktop shell is replaced.",
    },
] as const;

export const nextMilestones = [
    "Port local persistence and settings into the new desktop repository layer.",
    "Recreate the tray-first shell and dashboard flows in Tauri.",
    "Upgrade backend auth and sync semantics after the shell migration is stable.",
];