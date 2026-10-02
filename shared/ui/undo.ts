// Undo instead of "Are you sure?": every destructive action runs at once and
// offers a short "Undo" toast; Ctrl/Cmd+Z undoes the latest one too.

import { showToast } from "./toast.ts";

type Entry = { label: string; undo: () => Promise<void> };

const stack: Entry[] = [];
const MAX = 20;
let keyInstalled = false;
let undoing = false;

function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function installKey() {
    if (keyInstalled) return;
    keyInstalled = true;
    document.addEventListener("keydown", (e) => {
        if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
        if (isTyping(e.target)) return; // text fields keep their own undo
        if (!stack.length) return;
        e.preventDefault();
        void undoLast();
    });
}

/** Record a done action; shows "<label> · Undo". */
export function pushUndo(label: string, undo: () => Promise<void>): void {
    installKey();
    stack.push({ label, undo });
    if (stack.length > MAX) stack.shift();
    showToast(label, { action: { label: "Undo", run: () => undoLast() }, timeoutMs: 9000 });
}

export async function undoLast(): Promise<void> {
    if (undoing) return;
    const entry = stack.pop();
    if (!entry) return;
    undoing = true;
    try {
        await entry.undo();
        showToast(`Undone: ${entry.label}`, { timeoutMs: 2500 });
    } catch (err) {
        showToast(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
        undoing = false;
    }
}

/** Drop undo entries (e.g. after a sync replaced the data they refer to). */
export function clearUndo(): void {
    stack.length = 0;
}
