import { login, loginWithRecoveryCode, resendVerification, setSessionFromAuthResponse } from "../api";
import { instanceConfig } from "../config";
import { navigate } from "../router";
import { checkTermsAcceptance } from "../tos";

type LoginMode = "otp" | "recovery";

export function renderLogin(app: HTMLElement): void {
    const config = instanceConfig();
    // Only offer what this instance can actually deliver: no signup link on a
    // closed instance, and no password-reset link where no mailer is configured
    // to send the link (the administrator resets it from the terminal instead).
    const signUpLink = config.signup_open
        ? `No account? <a href="#/register">Create one</a>`
        : "";
    const resetLink = config.email_enabled
        ? `<a href="#/reset-password">Forgot password?</a>`
        : "";
    const footerLinks = [signUpLink, resetLink].filter(Boolean).join("&nbsp;·&nbsp;")
        || "Contact your administrator if you can't sign in.";

    app.innerHTML = `
        <div class="auth-page auth-page-wide">
            <div class="auth-header">
                <h2>Welcome back.</h2>
                <p>Sign in with your password and authenticator app, or use a saved recovery code.</p>
            </div>
            <div class="auth-form-wrapper">
                <div class="form-error" id="login-error"></div>
                <div class="auth-mode-toggle" role="tablist" aria-label="Sign-in method">
                    <button class="btn btn-outline auth-mode-btn is-active" id="mode-otp" type="button">Authenticator App</button>
                    <button class="btn btn-outline auth-mode-btn" id="mode-recovery" type="button">Recovery Code</button>
                </div>
                <form id="login-form">
                    <div class="form-group">
                        <label for="login-email">Email Address</label>
                        <input type="email" id="login-email" required placeholder="name@domain.com" autocomplete="email" />
                    </div>
                    <div class="form-group">
                        <label for="login-password">Password</label>
                        <input type="password" id="login-password" required placeholder="••••••••" autocomplete="current-password" />
                    </div>
                    <div class="form-group" id="otp-group">
                        <label for="login-otp">Authenticator Code</label>
                        <input type="text" id="login-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                    </div>
                    <div class="form-group" id="recovery-group" style="display:none;">
                        <label for="login-recovery">Recovery Code</label>
                        <input type="text" id="login-recovery" placeholder="ABCDE-12345" autocomplete="off" maxlength="11" />
                    </div>
                    <button type="submit" class="btn btn-primary">Sign in</button>
                </form>
                <div class="form-footer">${footerLinks}</div>
            </div>
        </div>
    `;

    const form = document.getElementById("login-form") as HTMLFormElement;
    const errorEl = document.getElementById("login-error")!;
    const otpGroup = document.getElementById("otp-group")!;
    const recoveryGroup = document.getElementById("recovery-group")!;
    const otpBtn = document.getElementById("mode-otp") as HTMLButtonElement;
    const recoveryBtn = document.getElementById("mode-recovery") as HTMLButtonElement;
    const otpInput = document.getElementById("login-otp") as HTMLInputElement;
    const recoveryInput = document.getElementById("login-recovery") as HTMLInputElement;

    let mode: LoginMode = "otp";

    function renderMode(nextMode: LoginMode) {
        mode = nextMode;
        const usingOtp = mode === "otp";
        otpGroup.style.display = usingOtp ? "block" : "none";
        recoveryGroup.style.display = usingOtp ? "none" : "block";
        otpBtn.classList.toggle("is-active", usingOtp);
        recoveryBtn.classList.toggle("is-active", !usingOtp);
        otpInput.required = usingOtp;
        recoveryInput.required = !usingOtp;
    }

    otpBtn.addEventListener("click", () => renderMode("otp"));
    recoveryBtn.addEventListener("click", () => renderMode("recovery"));

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.classList.remove("visible");

        const email = (document.getElementById("login-email") as HTMLInputElement).value.trim();
        const password = (document.getElementById("login-password") as HTMLInputElement).value;
        const btn = form.querySelector("button")!;

        btn.disabled = true;
        btn.textContent = mode === "otp" ? "Authenticating…" : "Checking Recovery Code…";

        try {
            const res = mode === "otp"
                ? await login(email, password, otpInput.value.trim(), "TrackSuite.work Web")
                : await loginWithRecoveryCode(email, password, recoveryInput.value.trim(), "TrackSuite.work Web");

            if (res.ok) {
                setSessionFromAuthResponse(res.data);
                navigate("#/tracker");
                // Startup ran this before there was a session to check.
                void checkTermsAcceptance();
            } else if (res.status === 403 && /verify your email/i.test((res.data as { detail?: string })?.detail ?? "")) {
                errorEl.innerHTML = 'Verify your email address first — check your inbox. '
                    + '<a href="#" id="login-resend">Resend the link</a>.';
                errorEl.classList.add("visible");
                document.getElementById("login-resend")?.addEventListener("click", async (ev) => {
                    ev.preventDefault();
                    await resendVerification(email);
                    errorEl.textContent = "Verification email sent — check your inbox, then sign in.";
                    errorEl.classList.add("visible");
                });
            } else {
                const detail = (res.data as { detail?: string })?.detail ?? "Authentication failed.";
                errorEl.textContent = detail;
                errorEl.classList.add("visible");
            }
        } catch {
            errorEl.textContent = "Network error. Please verify your connection.";
            errorEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = "Sign in";
        }
    });
}