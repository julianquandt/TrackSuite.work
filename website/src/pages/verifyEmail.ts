import { verifyEmail } from "../api";

/**
 * Landing page for the emailed verification link (#/verify-email?token=…).
 * In the verify-last flow, 2FA is already set up at registration, so this page
 * just activates the account and sends the user to sign in.
 */
export function renderVerifyEmail(app: HTMLElement): void {
    const raw = window.location.hash || "";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const token = new URLSearchParams(query).get("token") ?? "";

    app.innerHTML = `
        <div class="auth-page">
            <div class="auth-header">
                <h2>Activate your account.</h2>
                <p id="verify-subtitle">Verifying your email…</p>
            </div>
            <div class="auth-form-wrapper" id="verify-body">
                <div class="form-error" id="verify-error"></div>
            </div>
        </div>
    `;

    const subtitle = document.getElementById("verify-subtitle")!;
    const body = document.getElementById("verify-body")!;
    const errorEl = document.getElementById("verify-error")!;

    if (!token) {
        subtitle.textContent = "This verification link is missing its token.";
        errorEl.textContent = "Open the link directly from your email, or request a new one from the sign-in page.";
        errorEl.classList.add("visible");
        body.insertAdjacentHTML("beforeend", `<p style="margin-top:12px"><a href="#/login">Go to sign in</a></p>`);
        return;
    }

    void (async () => {
        const res = await verifyEmail(token);
        if (res.ok) {
            subtitle.textContent = "Your email is verified and your account is active. 🎉";
            body.insertAdjacentHTML("beforeend",
                `<p style="margin-top:12px"><a class="btn btn-primary" href="#/login">Sign in</a></p>`);
            return;
        }
        const detail = (res.data as unknown as { detail?: string })?.detail
            ?? "This verification link is invalid or has expired.";
        subtitle.textContent = "We couldn't verify this link.";
        errorEl.textContent = detail;
        errorEl.classList.add("visible");
        body.insertAdjacentHTML("beforeend", `
            <p style="margin-top:12px">
                If you already verified, just <a href="#/login">sign in</a>. Otherwise you can
                re-register (an unverified account isn't kept) or request a new link at sign-in.
            </p>`);
    })();
}
