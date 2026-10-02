// App-styled dropdowns. The native <select> stays in the page (hidden), so
// all existing code keeps reading .value and listening for "change"; a button
// shows the current choice and opens the app's own menu (shared/ui/menu.ts).

import { showMenu, type MenuItem } from "./menu.ts";

const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;

export function enhanceSelect(select: HTMLSelectElement): void {
    if (select.dataset.uiSelect) return;
    select.dataset.uiSelect = "1";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-select";
    btn.setAttribute("aria-haspopup", "listbox");
    const text = document.createElement("span");
    text.className = "ui-select-text";
    btn.appendChild(text);
    select.after(btn);
    select.classList.add("ui-select-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const sync = () => {
        text.textContent = select.selectedOptions[0]?.textContent ?? "";
        btn.disabled = select.disabled;
    };

    // Code that sets select.value directly fires no event: keep the button
    // label in step anyway.
    Object.defineProperty(select, "value", {
        configurable: true,
        get() { return valueDesc.get!.call(this); },
        set(v: string) { valueDesc.set!.call(this, v); sync(); },
    });
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    select.addEventListener("change", sync);
    // A <label> click focuses the hidden select: pass that on to the button.
    select.addEventListener("focus", () => btn.focus());

    const openMenu = () => {
        const items: MenuItem[] = [];
        for (const child of [...select.children]) {
            if (child instanceof HTMLOptGroupElement) {
                items.push({ kind: "header", label: child.label });
                for (const opt of [...child.querySelectorAll("option")]) items.push(itemFor(opt));
            } else if (child instanceof HTMLOptionElement) {
                items.push(itemFor(child));
            }
        }
        btn.classList.add("ui-open");
        showMenu(items, btn, { minWidth: btn.offsetWidth, focusChecked: true, onClose: () => { btn.classList.remove("ui-open"); btn.focus({ preventScroll: true }); } });
    };
    const itemFor = (opt: HTMLOptionElement): MenuItem => ({
        label: opt.textContent ?? opt.value,
        checked: opt.value === select.value,
        run: () => {
            if (select.value === opt.value) return;
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
        },
    });

    btn.addEventListener("click", openMenu);
    btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu();
        }
    });
    sync();
}

/** Enhance every <select> under `root` (already enhanced ones are skipped). */
export function enhanceSelects(root: ParentNode): void {
    root.querySelectorAll("select").forEach((s) => enhanceSelect(s));
}
