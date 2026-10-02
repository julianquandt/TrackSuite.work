// A small toast at the bottom of the window, optionally with one action
// ("Undo"). One toast at a time: a new one replaces the old.

export type ToastAction = { label: string; run: () => void | Promise<void> };

let host: HTMLDivElement | null = null;
let hideTimer: number | null = null;

function ensureHost(): HTMLDivElement {
    if (host && document.body.contains(host)) return host;
    host = document.createElement("div");
    host.className = "ui-toast";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.hidden = true;
    document.body.appendChild(host);
    return host;
}

export function hideToast(): void {
    if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    if (host) host.hidden = true;
}

/** Show `message` for `timeoutMs` (default 6 s); `action` adds a button. */
export function showToast(message: string, opts: { action?: ToastAction; timeoutMs?: number; tone?: "info" | "error" } = {}): void {
    const el = ensureHost();
    el.innerHTML = "";
    el.dataset.tone = opts.tone ?? "info";
    const text = document.createElement("span");
    text.className = "ui-toast-text";
    text.textContent = message;
    el.appendChild(text);
    if (opts.action) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-toast-action";
        btn.textContent = opts.action.label;
        const action = opts.action;
        btn.addEventListener("click", () => {
            hideToast();
            void action.run();
        });
        el.appendChild(btn);
    }
    el.hidden = false;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hideToast, opts.timeoutMs ?? 6000);
}
