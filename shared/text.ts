// Text helpers shared by the desktop and web apps.

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for use inside HTML, including attribute values. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * One CSV cell: quoted when it holds a separator, quote or newline, and
 * prefixed with ' when it starts like a spreadsheet formula (=, +, -, @), so
 * a note such as "=HYPERLINK(...)" can't run in Excel.
 */
export function csvCell(value: string): string {
    let s = value ?? "";
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
}
