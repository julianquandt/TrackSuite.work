import QRCode from "qrcode";

import { confirmEnrollment, resendVerification, setSession } from "../api";
import { navigate } from "../router";

export interface EnrollTarget {
    email: string;
    password: string;
    secret: string;
    uri: string;
}

/**
 * Renders the "set up two-factor authentication" step into `container`, given an
 * account's email/password and its pending TOTP secret (from the register
 * response). Shows the QR + manual secret, confirms the first code, reveals
 * recovery codes, and then either activates the session (no-email deployments)
 * or tells the user to verify their email (verify-last).
 */
export async function mount2faSetup(container: HTMLElement, target: EnrollTarget): Promise<void> {
    const { email, password, secret, uri } = target;
    let qrDataUrl = "";
    try {
        qrDataUrl = await QRCode.toDataURL(uri, {
            width: 220, margin: 1, errorCorrectionLevel: "M",
            color: { dark: "#111111", light: "#ffffff" },
        });
    } catch {
        qrDataUrl = "";
    }

    container.innerHTML = `
        <div id="enroll-setup">
            <p class="settings-copy" style="margin-bottom:16px">
                Scan this QR code with your authenticator app (Google Authenticator, 1Password,
                Aegis, Authy…), then enter the 6-digit code to set up two-factor authentication.
            </p>
            <div class="totp-setup-grid">
                <div class="totp-qr-panel">
                    ${qrDataUrl
                        ? `<img class="totp-qr-image" src="${qrDataUrl}" alt="Authenticator QR code" />`
                        : `<p class="totp-qr-caption">QR code unavailable — use the manual secret.</p>`}
                </div>
                <div class="totp-secret-panel">
                    <div class="form-group">
                        <label>Manual secret</label>
                        <div class="secret-container">
                            <code class="mono" id="enroll-secret">${escapeHtml(secret)}</code>
                            <button class="btn btn-outline" id="enroll-copy" type="button">Copy</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="enroll-otp">6-digit code</label>
                        <input type="text" id="enroll-otp" placeholder="123456" inputmode="numeric"
                               autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                    </div>
                    <div class="form-error" id="enroll-error"></div>
                    <button class="btn btn-primary" id="enroll-confirm" type="button">Verify &amp; Continue</button>
                </div>
            </div>
        </div>
        <div class="key-reveal" id="enroll-recovery">
            <div class="warning-text">Save these recovery codes offline. Each can be used once if you lose your authenticator.</div>
            <div class="recovery-code-grid" id="enroll-recovery-grid"></div>
            <div class="btn-row auth-action-row">
                <button class="btn btn-outline" id="enroll-recovery-copy" type="button">Copy Recovery Codes</button>
            </div>
            <div id="enroll-next"></div>
        </div>
    `;

    const setupEl = container.querySelector("#enroll-setup") as HTMLElement;
    const otpInput = container.querySelector("#enroll-otp") as HTMLInputElement;
    const errorEl = container.querySelector("#enroll-error") as HTMLElement;
    const confirmBtn = container.querySelector("#enroll-confirm") as HTMLButtonElement;
    const copyBtn = container.querySelector("#enroll-copy") as HTMLButtonElement;
    const recoveryEl = container.querySelector("#enroll-recovery") as HTMLElement;
    const recoveryGrid = container.querySelector("#enroll-recovery-grid") as HTMLElement;
    const recoveryCopyBtn = container.querySelector("#enroll-recovery-copy") as HTMLButtonElement;
    const nextEl = container.querySelector("#enroll-next") as HTMLElement;

    let latestRecoveryCodes: string[] = [];

    copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(secret);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    });
    recoveryCopyBtn.addEventListener("click", async () => {
        if (!latestRecoveryCodes.length) return;
        await navigator.clipboard.writeText(latestRecoveryCodes.join("\n"));
        recoveryCopyBtn.textContent = "Copied!";
        setTimeout(() => { recoveryCopyBtn.textContent = "Copy Recovery Codes"; }, 2000);
    });

    confirmBtn.addEventListener("click", async () => {
        errorEl.classList.remove("visible");
        const otp = otpInput.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            errorEl.textContent = "Enter the 6-digit code from your authenticator app.";
            errorEl.classList.add("visible");
            return;
        }
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Verifying…";
        try {
            const res = await confirmEnrollment(email, password, otp, "TrackSuite.work Web");
            if (!res.ok) {
                const detail = (res.data as unknown as { detail?: string })?.detail
                    ?? "That code wasn't accepted. Try the next one.";
                errorEl.textContent = detail;
                errorEl.classList.add("visible");
                return;
            }
            latestRecoveryCodes = res.data.recovery_codes;
            recoveryGrid.innerHTML = latestRecoveryCodes
                .map((c) => `<code class="recovery-code-item mono">${escapeHtml(c)}</code>`)
                .join("");
            setupEl.style.display = "none";
            recoveryEl.classList.add("visible");

            // Update the page header so it no longer says "set up 2FA".
            const headerH2 = document.querySelector(".auth-header h2") as HTMLElement | null;
            const headerP = document.querySelector(".auth-header p") as HTMLElement | null;
            if (res.data.verification_pending) {
                if (headerH2) headerH2.textContent = "Almost done!";
                if (headerP) headerP.textContent = "Save your recovery codes, then verify your email to activate your account.";
            } else {
                if (headerH2) headerH2.textContent = "You're all set!";
                if (headerP) headerP.textContent = "Save your recovery codes below.";
            }

            if (res.data.verification_pending) {
                // Verify-last: account not active until the email is confirmed.
                nextEl.innerHTML = `
                    <div class="warning-text" style="margin-top:14px">
                        📧 Almost done — we've emailed a verification link to
                        <span class="mono">${escapeHtml(email)}</span>. Click it to activate your
                        account, then sign in. Didn't get it?
                        <a href="#" id="enroll-resend">Resend it</a>.
                        <span id="enroll-resend-status" style="margin-left:6px;color:var(--success)"></span>
                    </div>
                    <div class="btn-row auth-action-row"><a class="btn btn-outline" href="#/login">Go to sign in</a></div>`;
                nextEl.querySelector("#enroll-resend")?.addEventListener("click", async (ev) => {
                    ev.preventDefault();
                    const s = nextEl.querySelector("#enroll-resend-status") as HTMLElement;
                    s.textContent = "Sending…";
                    try { await resendVerification(email); s.textContent = "Sent ✓"; }
                    catch { s.textContent = "Couldn't resend."; }
                });
            } else if (res.data.access_token && res.data.refresh_token) {
                // No-email deployment: logged in immediately.
                setSession({ accessToken: res.data.access_token, refreshToken: res.data.refresh_token });
                nextEl.innerHTML = `<div class="btn-row auth-action-row">
                    <button class="btn btn-primary" id="enroll-go" type="button">Continue to Dashboard</button></div>`;
                nextEl.querySelector("#enroll-go")?.addEventListener("click", () => navigate("#/dashboard"));
            }
        } catch {
            errorEl.textContent = "Network error. Please try again.";
            errorEl.classList.add("visible");
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Verify & Continue";
        }
    });
}

function escapeHtml(value: string): string {
    const el = document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
}
