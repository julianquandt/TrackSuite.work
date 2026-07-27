/**
 * Re-acceptance prompt for updated Terms.
 *
 * § 9 of the Terms promises registered users notice before a material change
 * takes effect, and the backend already stamps the accepted version on each
 * account — this is the piece that closes the loop.
 *
 * Deliberately *notice*, not a gate. The Terms say continuing to use the
 * service constitutes acceptance, and someone who does not agree is entitled to
 * export their data and delete their account instead — so a dialog they cannot
 * escape would contradict the very clause it exists to honour. Dismissing it
 * simply shows it again on the next load.
 */

import { acceptTos, getToken, getTosStatus } from "./api";
import { LEGAL, LEGAL_ENABLED } from "./legal-config";

/** One prompt per page load, however many times the router re-renders. */
let promptShown = false;

function detailOf(data: unknown, fallback: string): string {
    return (data as { detail?: string })?.detail?.trim() || fallback;
}

/**
 * Ask the server whether this account is behind on the Terms, and prompt if so.
 * Never throws and never blocks startup: an instance that is offline, or a
 * session that has expired, must not stop the app from rendering.
 */
export async function checkTermsAcceptance(): Promise<void> {
    // An instance that publishes no legal pages (an internal company deployment
    // covered by its employer's own notices) has no terms to consent to, and
    // the dialog's links would go nowhere.
    if (!LEGAL_ENABLED || promptShown || !getToken()) return;

    let res;
    try {
        res = await getTosStatus();
    } catch {
        return;
    }
    if (!res.ok || !res.data?.acceptance_required) return;

    promptShown = true;
    showTermsDialog(res.data.current_version);
}

function showTermsDialog(version: string): void {
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.innerHTML = `
        <h3>We've updated our Terms</h3>
        <p class="modal-note">
            The Terms of Service and Privacy Policy for ${LEGAL.siteName} changed
            (version <strong>${version}</strong>). Please have a look — they open in a
            new tab, so you won't lose your place.
        </p>
        <p class="modal-note">
            <a href="#/legal/terms" target="_blank" rel="noopener">Terms of Service</a>
            &nbsp;·&nbsp;
            <a href="#/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>
        </p>
        <div class="modal-error" id="tos-error" style="display:none;"></div>
        <p class="modal-note">
            If you'd rather not accept, you can export your data and delete your account
            from the dashboard at any time.
        </p>
        <div class="btn-row modal-actions">
            <button type="button" class="btn btn-primary" id="tos-accept">Accept</button>
            <button type="button" class="btn btn-ghost" id="tos-later">Later</button>
        </div>
    `;
    document.body.appendChild(dialog);

    const errorEl = dialog.querySelector<HTMLDivElement>("#tos-error")!;
    const acceptBtn = dialog.querySelector<HTMLButtonElement>("#tos-accept")!;
    const laterBtn = dialog.querySelector<HTMLButtonElement>("#tos-later")!;

    const close = (): void => {
        dialog.close();
        dialog.remove();
    };

    laterBtn.addEventListener("click", close);
    dialog.addEventListener("cancel", () => {
        // Let Escape dismiss it, but tear the node down with it.
        window.setTimeout(() => dialog.remove(), 0);
    });

    acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        errorEl.style.display = "none";
        const res = await acceptTos(version);
        if (res.ok) {
            close();
            return;
        }
        acceptBtn.disabled = false;
        errorEl.textContent = detailOf(res.data, "Could not record your acceptance. Please try again.");
        errorEl.style.display = "block";
    });

    dialog.showModal();
}
