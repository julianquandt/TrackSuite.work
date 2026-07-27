import { confirmPasswordReset, requestPasswordReset } from "../api";
import { navigate } from "../router";

/**
 * Password reset. Two modes on one route:
 *  - no token → request a reset link by email.
 *  - #/reset-password?token=… → set a new password (with a 2FA code or recovery
 *    code as a second factor, so a stolen inbox alone can't take over).
 */
export function renderResetPassword(app: HTMLElement): void {
    const raw = window.location.hash || "";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const token = new URLSearchParams(query).get("token") ?? "";

    if (token) {
        renderConfirm(app, token);
    } else {
        renderRequest(app);
    }
}

function renderRequest(app: HTMLElement): void {
    app.innerHTML = `
        <div class="auth-page">
            <div class="auth-header">
                <h2>Reset your password.</h2>
                <p>Enter your email and we'll send you a reset link. You'll still need your authenticator or a recovery code to finish.</p>
            </div>
            <div class="auth-form-wrapper">
                <div class="form-error" id="rp-error"></div>
                <div class="form-success" id="rp-success"></div>
                <form id="rp-form">
                    <div class="form-group">
                        <label for="rp-email">Email Address</label>
                        <input type="email" id="rp-email" required placeholder="name@domain.com" autocomplete="email" />
                    </div>
                    <button type="submit" class="btn btn-primary">Send reset link</button>
                </form>
                <div class="form-footer"><a href="#/login">Back to sign in</a></div>
            </div>
        </div>
    `;
    const form = document.getElementById("rp-form") as HTMLFormElement;
    const errorEl = document.getElementById("rp-error")!;
    const successEl = document.getElementById("rp-success")!;
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.classList.remove("visible");
        successEl.classList.remove("visible");
        const email = (document.getElementById("rp-email") as HTMLInputElement).value.trim();
        const btn = form.querySelector("button")!;
        btn.disabled = true;
        btn.textContent = "Sending…";
        try {
            const res = await requestPasswordReset(email);
            successEl.textContent = res.data?.detail
                ?? "If that email has an account, a reset link is on its way.";
            successEl.classList.add("visible");
            form.style.display = "none";
        } catch {
            errorEl.textContent = "Network error. Please try again.";
            errorEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = "Send reset link";
        }
    });
}

function renderConfirm(app: HTMLElement, token: string): void {
    app.innerHTML = `
        <div class="auth-page auth-page-wide">
            <div class="auth-header">
                <h2>Choose a new password.</h2>
                <p>Enter a new password and confirm with your authenticator code (or a recovery code).</p>
            </div>
            <div class="auth-form-wrapper">
                <div class="form-error" id="rp-error"></div>
                <div class="form-success" id="rp-success"></div>
                <form id="rp-confirm-form">
                    <div class="form-group">
                        <label for="rp-new">New Password</label>
                        <input type="password" id="rp-new" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters" />
                    </div>
                    <div class="form-group">
                        <label for="rp-otp">Authenticator Code</label>
                        <input type="text" id="rp-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                    </div>
                    <div class="form-group">
                        <label for="rp-recovery">…or a Recovery Code</label>
                        <input type="text" id="rp-recovery" placeholder="ABCDE-12345" autocomplete="off" maxlength="11" />
                    </div>
                    <button type="submit" class="btn btn-primary">Set new password</button>
                </form>
                <div class="form-footer"><a href="#/login">Back to sign in</a></div>
            </div>
        </div>
    `;
    const form = document.getElementById("rp-confirm-form") as HTMLFormElement;
    const errorEl = document.getElementById("rp-error")!;
    const successEl = document.getElementById("rp-success")!;
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.classList.remove("visible");
        successEl.classList.remove("visible");
        const newPassword = (document.getElementById("rp-new") as HTMLInputElement).value;
        const otp = (document.getElementById("rp-otp") as HTMLInputElement).value.trim();
        const recoveryCode = (document.getElementById("rp-recovery") as HTMLInputElement).value.trim();
        if (newPassword.length < 8) {
            errorEl.textContent = "Password must be at least 8 characters.";
            errorEl.classList.add("visible");
            return;
        }
        if (!/^\d{6}$/.test(otp) && !recoveryCode) {
            errorEl.textContent = "Enter your authenticator code or a recovery code.";
            errorEl.classList.add("visible");
            return;
        }
        const btn = form.querySelector("button")!;
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
            const res = await confirmPasswordReset(token, newPassword, {
                otp: /^\d{6}$/.test(otp) ? otp : undefined,
                recoveryCode: recoveryCode || undefined,
            });
            if (res.ok || res.status === 204) {
                successEl.textContent = "Password updated. You've been signed out everywhere — sign in with your new password.";
                successEl.classList.add("visible");
                form.style.display = "none";
                setTimeout(() => navigate("#/login"), 2500);
            } else {
                const detail = (res.data as unknown as { detail?: string })?.detail ?? "Could not reset password.";
                errorEl.textContent = detail;
                errorEl.classList.add("visible");
            }
        } catch {
            errorEl.textContent = "Network error. Please try again.";
            errorEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = "Set new password";
        }
    });
}
