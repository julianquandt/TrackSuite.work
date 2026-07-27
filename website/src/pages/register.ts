import { register } from "../api";
import { instanceConfig } from "../config";
import { LEGAL_ENABLED } from "../legal-config";
import { mount2faSetup } from "./enroll";

export function renderRegister(app: HTMLElement): void {
    const config = instanceConfig();

    // A closed instance (typically a single-user self-hosted deployment) has no
    // signup flow at all — the account is created from the server's terminal.
    if (!config.signup_open) {
        app.innerHTML = `
            <div class="auth-page">
                <div class="auth-header">
                    <h2>Registration is closed.</h2>
                    <p>This instance doesn't accept new sign-ups. Ask the administrator to create an account for you.</p>
                </div>
                <div class="auth-form-wrapper">
                    <div class="form-footer">Already have an account? <a href="#/login">Sign in</a></div>
                </div>
            </div>`;
        return;
    }

    const domainHint = config.allowed_email_domains.length
        ? `<p class="form-hint">This instance accepts addresses at
           ${config.allowed_email_domains.map((d) => `<strong>@${escapeHtml(d)}</strong>`).join(", ")}.</p>`
        : "";

    const inviteField = config.invite_required
        ? `<div class="form-group">
               <label for="reg-invite">Invite Code</label>
               <input type="text" id="reg-invite" required placeholder="Provided by your administrator" autocomplete="off" />
           </div>`
        : "";

    const consent = LEGAL_ENABLED
        ? `<p class="form-consent">
               By creating an account you agree to our
               <a href="#/legal/terms">Terms of Service</a> and confirm you have read the
               <a href="#/legal/privacy">Privacy Policy</a>.
           </p>`
        : "";

    const nextStep = config.email_enabled
        ? "Next you'll set up two-factor authentication, then verify your email to activate the account."
        : "Next you'll set up two-factor authentication.";

    app.innerHTML = `
        <div class="auth-page auth-page-wide">
            <div class="auth-header">
                <h2>Create Account.</h2>
                <p id="reg-subtitle">Enter your email and a password. ${nextStep}</p>
            </div>
            <div class="auth-form-wrapper">
                <div class="form-error" id="reg-error"></div>
                <form id="register-form">
                    <div class="form-group">
                        <label for="reg-email">Email Address</label>
                        <input type="email" id="reg-email" required placeholder="name@domain.com" autocomplete="email" />
                        ${domainHint}
                    </div>
                    <div class="form-group">
                        <label for="reg-password">Password</label>
                        <input type="password" id="reg-password" required minlength="8" placeholder="At least 8 characters" autocomplete="new-password" />
                    </div>
                    ${inviteField}
                    ${consent}
                    <button type="submit" class="btn btn-primary">Create Account</button>
                </form>

                <div id="reg-2fa"></div>

                <div class="form-footer" id="reg-footer">
                    Already registered? <a href="#/login">Sign in</a>
                </div>
            </div>
        </div>
    `;

    const form = document.getElementById("register-form") as HTMLFormElement;
    const errorEl = document.getElementById("reg-error")!;
    const subtitle = document.getElementById("reg-subtitle")!;
    const twofaSlot = document.getElementById("reg-2fa") as HTMLElement;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.classList.remove("visible");

        const email = (document.getElementById("reg-email") as HTMLInputElement).value.trim();
        const password = (document.getElementById("reg-password") as HTMLInputElement).value;
        const inviteCode = (document.getElementById("reg-invite") as HTMLInputElement | null)?.value.trim();
        if (password.length < 8) {
            errorEl.textContent = "Password must be at least 8 characters.";
            errorEl.classList.add("visible");
            return;
        }

        const btn = form.querySelector("button")!;
        btn.disabled = true;
        btn.textContent = "Creating account…";
        try {
            const res = await register(email, password, inviteCode);
            if (res.ok) {
                // Step 2: set up 2FA right here (email verification comes after).
                form.style.display = "none";
                subtitle.textContent = "Set up two-factor authentication to continue.";
                await mount2faSetup(twofaSlot, {
                    email, password,
                    secret: res.data.totp_secret,
                    uri: res.data.totp_uri,
                });
            } else {
                const detail = (res.data as { detail?: string })?.detail ?? "Could not create account.";
                errorEl.innerHTML = escapeHtml(detail);
                // If they already have an account, nudge to sign in / reset.
                if (res.status === 409) {
                    errorEl.innerHTML = escapeHtml(detail)
                        + ' <a href="#/login">Sign in</a> or <a href="#/reset-password">reset your password</a>.';
                }
                errorEl.classList.add("visible");
            }
        } catch {
            errorEl.textContent = "Network error. Please verify your connection.";
            errorEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = "Create Account";
        }
    });
}

function escapeHtml(value: string): string {
    const el = document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
}
