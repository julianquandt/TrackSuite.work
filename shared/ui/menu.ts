// One floating menu at a time: right-click menus and custom dropdown lists.
// Keyboard: ↑/↓ move, Enter/Space choose, Esc closes. A click outside or a
// resize closes it; on scroll a dropdown follows its button and a right-click
// menu closes.

import { OFF_DAY_REASONS, type OffDayReason } from "../offdays.ts";

export type MenuItem =
    | { kind?: "item"; label: string; run: () => void | Promise<void>; color?: string; danger?: boolean; checked?: boolean; hint?: string }
    | { kind: "header"; label: string }
    | { kind: "separator" };

let open: { el: HTMLDivElement; onClose?: () => void; anchor: HTMLElement | null; openedAt: number } | null = null;

export function closeMenu(): void {
    if (!open) return;
    const { el, onClose } = open;
    open = null;
    el.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", closeMenu);
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
}

// A dropdown follows its button when the page scrolls; a right-click menu
// closes (after a short grace period: opening can itself cause a scroll).
function onScroll(e: Event) {
    if (!open || (e.target instanceof Node && open.el.contains(e.target))) return;
    if (open.anchor) place(open.el, open.anchor);
    else if (Date.now() - open.openedAt > 250) closeMenu();
}

function place(el: HTMLDivElement, at: { x: number; y: number } | HTMLElement) {
    const w = el.offsetWidth, h = el.offsetHeight;
    let x: number, y: number;
    if (at instanceof HTMLElement) {
        const r = at.getBoundingClientRect();
        x = r.left;
        y = r.bottom + 4;
        if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - 4 - h);
    } else {
        x = at.x;
        y = at.y;
        if (y + h > window.innerHeight - 8) y = Math.max(8, y - h);
    }
    x = Math.max(8, Math.min(window.innerWidth - 8 - w, x));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
}

function onOutside(e: PointerEvent) {
    if (open && !e.composedPath().includes(open.el)) closeMenu();
}

function buttons(): HTMLButtonElement[] {
    return open ? [...open.el.querySelectorAll<HTMLButtonElement>(".ui-menu-item")] : [];
}

function onKey(e: KeyboardEvent) {
    if (!open) return;
    const items = buttons();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next]?.focus();
    }
    if (e.key === "Tab") closeMenu();
}

/**
 * Show a menu at a viewport point (right-click) or under an anchor element
 * (dropdown). Returns nothing; the chosen item's `run` is called.
 */
export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, opts: { onClose?: () => void; minWidth?: number; focusChecked?: boolean } = {}): void {
    closeMenu();
    const el = document.createElement("div");
    el.className = "ui-menu";
    el.setAttribute("role", "menu");
    for (const item of items) {
        if (item.kind === "separator") { el.insertAdjacentHTML("beforeend", `<div class="ui-menu-sep" role="separator"></div>`); continue; }
        if (item.kind === "header") {
            const h = document.createElement("div");
            h.className = "ui-menu-header";
            h.textContent = item.label;
            el.appendChild(h);
            continue;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ui-menu-item" + (item.danger ? " ui-danger" : "") + (item.checked ? " ui-checked" : "");
        btn.setAttribute("role", "menuitem");
        if (item.color) {
            const dot = document.createElement("span");
            dot.className = "ui-menu-dot";
            dot.style.background = item.color;
            btn.appendChild(dot);
        }
        const label = document.createElement("span");
        label.className = "ui-menu-label";
        label.textContent = item.label;
        btn.appendChild(label);
        if (item.hint) {
            const hint = document.createElement("kbd");
            hint.textContent = item.hint;
            btn.appendChild(hint);
        }
        btn.addEventListener("click", () => { closeMenu(); void item.run(); });
        el.appendChild(btn);
    }
    if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
    document.body.appendChild(el);

    place(el, at);

    open = { el, onClose: opts.onClose, anchor: at instanceof HTMLElement ? at : null, openedAt: Date.now() };
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("keydown", onKey, true);
    const first = (opts.focusChecked ? el.querySelector<HTMLButtonElement>(".ui-checked") : null) ?? el.querySelector<HTMLButtonElement>(".ui-menu-item");
    first?.focus({ preventScroll: true });
}

/**
 * Right-click menu for a calendar day: mark it off with a reason, change the
 * reason, or make it a normal day again.
 */
export function showOffDayMenu(
    at: { x: number; y: number },
    day: { label: string; isOff: boolean; reason: string | null },
    actions: { setReason(reason: OffDayReason | null): void | Promise<void>; clear(): void | Promise<void> },
): void {
    const items: MenuItem[] = [{ kind: "header", label: day.label }];
    for (const r of OFF_DAY_REASONS) {
        items.push({
            label: `${r.icon ? r.icon + "  " : ""}${r.label}`,
            checked: day.isOff && (day.reason ?? null) === r.key,
            run: () => actions.setReason(r.key),
        });
    }
    if (day.isOff) items.push({ kind: "separator" }, { label: "Not an off day", run: () => actions.clear() });
    showMenu(items, at);
}
