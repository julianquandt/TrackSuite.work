import QRCode from "qrcode";

import {
    confirmEnrollment,
    register,
    setSessionFromAuthResponse,
    type RegisterResponse,
} from "../api";
import { navigate } from "../router";

export function renderRegister(app: HTMLElement): void {
    app.innerHTML = `
        <div class="auth-page auth-page-wide">
            <div class="auth-header">
                <h2>Create Account.</h2>
                <p>Create your account, scan the authenticator QR code, then verify the first code before the account becomes active.</p>
            </div>
            <div class="auth-form-wrapper">
                <div class="form-error" id="reg-error"></div>
                <div class="form-success" id="reg-success"></div>
                <form id="register-form">
                    <div class="form-group">
                        <label for="reg-email">Email Address</label>
                        <input type="email" id="reg-email" required placeholder="name@domain.com" autocomplete="email" />
                    </div>
                    <div class="form-group">
                        <label for="reg-password">Password</label>
                        <input type="password" id="reg-password" required minlength="8" placeholder="At least 8 characters" autocomplete="new-password" />
                    </div>
                    <button type="submit" class="btn btn-primary">Provision Account</button>
                </form>

                <div class="key-reveal" id="reg-totp-setup">
                    <div class="warning-text">
                        Scan this QR code with your authenticator app now. The account cannot be used until you verify the first 6-digit code.
                    </div>
                    <div class="totp-setup-grid">
                        <div class="totp-qr-panel">
                            <img id="reg-totp-qr" class="totp-qr-image" alt="Authenticator QR code for TrackSuite.work" />
                            <p class="totp-qr-caption" id="reg-totp-qr-caption">
                                Scan with Google Authenticator, 1Password, Aegis, Authy, or another TOTP app.
                            </p>
                        </div>
                        <div class="totp-secret-panel">
                            <div class="form-group">
                                <label>Manual TOTP Secret</label>
                                <div class="secret-container">
                                    <code id="reg-totp-secret" class="mono"></code>
                                    <button class="btn btn-outline" id="reg-copy-secret" type="button">Copy Secret</button>
                                </div>
                            </div>
                            <div class="form-group">
                                <label for="reg-confirm-otp">Verify First Authenticator Code</label>
                                <input type="text" id="reg-confirm-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                            </div>
                            <p class="totp-setup-copy">
                                If your authenticator app cannot scan a QR code, create a new time-based one-time password entry manually using your email address and the copied secret.
                            </p>
                            <div class="btn-row auth-action-row">
                                <button class="btn btn-primary" id="reg-confirm-setup" type="button">Verify and Finish Setup</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="key-reveal" id="reg-recovery-setup">
                    <div class="warning-text">
                        Save these recovery codes offline. Each code can be used once if you lose access to your authenticator app.
                    </div>
                    <div class="recovery-code-grid" id="reg-recovery-codes"></div>
                    <div class="btn-row auth-action-row">
                        <button class="btn btn-outline" id="reg-copy-recovery" type="button">Copy Recovery Codes</button>
                        <button class="btn btn-primary" id="reg-go-dashboard" type="button">Continue to Dashboard</button>
                    </div>
                </div>

                <div class="form-footer">
                    Already registered? <a href="#/login">Sign in</a>
                </div>
            </div>
        </div>
    `;

    const form = document.getElementById("register-form") as HTMLFormElement;
    const errorEl = document.getElementById("reg-error")!;
    const successEl = document.getElementById("reg-success")!;
    const setupEl = document.getElementById("reg-totp-setup")!;
    const recoveryEl = document.getElementById("reg-recovery-setup")!;
    const qrEl = document.getElementById("reg-totp-qr") as HTMLImageElement;
    const qrCaptionEl = document.getElementById("reg-totp-qr-caption")!;
    const secretEl = document.getElementById("reg-totp-secret")!;
    const confirmOtpEl = document.getElementById("reg-confirm-otp") as HTMLInputElement;
    const copySecretBtn = document.getElementById("reg-copy-secret") as HTMLButtonElement;
    const confirmSetupBtn = document.getElementById("reg-confirm-setup") as HTMLButtonElement;
    const recoveryCodesEl = document.getElementById("reg-recovery-codes")!;
    const copyRecoveryBtn = document.getElementById("reg-copy-recovery") as HTMLButtonElement;
    const goDashboardBtn = document.getElementById("reg-go-dashboard") as HTMLButtonElement;

    let pendingCredentials: { email: string; password: string } | null = null;
    let latestRecoveryCodes: string[] = [];

    copySecretBtn.addEventListener("click", async () => {
        const secret = secretEl.textContent ?? "";
        if (!secret) return;
        await navigator.clipboard.writeText(secret);
        copySecretBtn.textContent = "Copied!";
        setTimeout(() => {
            copySecretBtn.textContent = "Copy Secret";
        }, 2000);
    });

    copyRecoveryBtn.addEventListener("click", async () => {
        if (latestRecoveryCodes.length === 0) return;
        await navigator.clipboard.writeText(latestRecoveryCodes.join("\n"));
        copyRecoveryBtn.textContent = "Copied!";
        setTimeout(() => {
            copyRecoveryBtn.textContent = "Copy Recovery Codes";
        }, 2000);
    });

    goDashboardBtn.addEventListener("click", () => {
        navigate("#/dashboard");
    });

    function resetMessages() {
        errorEl.classList.remove("visible");
        successEl.classList.remove("visible");
    }

    function renderRecoveryCodes(codes: string[]) {
        latestRecoveryCodes = codes;
        recoveryCodesEl.innerHTML = codes
            .map((code) => `<code class="recovery-code-item mono">${escapeHtml(code)}</code>`)
            .join("");
        recoveryEl.classList.add("visible");
        setupEl.classList.remove("visible");
        successEl.textContent = "Authenticator verified. Save your recovery codes before you continue.";
        successEl.classList.add("visible");
    }

    async function showTotpSetup(data: RegisterResponse, email: string, password: string) {
        pendingCredentials = { email, password };
        secretEl.textContent = data.totp_secret;
        confirmOtpEl.value = "";
        recoveryEl.classList.remove("visible");
        try {
            qrEl.src = await QRCode.toDataURL(data.totp_uri, {
                width: 220,
                margin: 1,
                errorCorrectionLevel: "M",
                color: {
                    dark: "#111111",
                    light: "#ffffff",
                },
            });
            qrEl.style.display = "block";
            qrCaptionEl.textContent = "Scan with Google Authenticator, 1Password, Aegis, Authy, or another TOTP app.";
        } catch {
            qrEl.removeAttribute("src");
            qrEl.style.display = "none";
            qrCaptionEl.textContent = "QR generation failed in this browser. Use the manual TOTP secret instead.";
        }

        setupEl.classList.add("visible");
        successEl.textContent = "Account provisioned. Scan the QR code, then enter the first authenticator code to activate the account.";
        successEl.classList.add("visible");
    }

    confirmSetupBtn.addEventListener("click", async () => {
        resetMessages();
        const otp = confirmOtpEl.value.trim();
        if (!pendingCredentials) {
            errorEl.textContent = "Start by creating the account first.";
            errorEl.classList.add("visible");
            return;
        }
        if (!/^\d{6}$/.test(otp)) {
            errorEl.textContent = "Enter the 6-digit code from your authenticator app.";
            errorEl.classList.add("visible");
            return;
        }

        confirmSetupBtn.disabled = true;
        confirmSetupBtn.textContent = "Verifying…";
        try {
            const res = await confirmEnrollment(
                pendingCredentials.email,
                pendingCredentials.password,
                otp,
                "TrackSuite.work Web",
            );
            if (res.ok) {
                setSessionFromAuthResponse(res.data);
                renderRecoveryCodes(res.data.recovery_codes);
            } else {
                const detail = (res.data as { detail?: string })?.detail ?? "Authenticator verification failed.";
                errorEl.textContent = detail;
                errorEl.classList.add("visible");
            }
        } catch {
            errorEl.textContent = "Network error. Please verify your connection.";
            errorEl.classList.add("visible");
        } finally {
            confirmSetupBtn.disabled = false;
            confirmSetupBtn.textContent = "Verify and Finish Setup";
        }
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        resetMessages();
        setupEl.classList.remove("visible");
        recoveryEl.classList.remove("visible");
        qrEl.removeAttribute("src");
        qrEl.style.display = "none";
        qrCaptionEl.textContent = "Scan with Google Authenticator, 1Password, Aegis, Authy, or another TOTP app.";
        latestRecoveryCodes = [];
        pendingCredentials = null;

        const email = (document.getElementById("reg-email") as HTMLInputElement).value.trim();
        const password = (document.getElementById("reg-password") as HTMLInputElement).value;

        if (password.length < 8) {
            errorEl.textContent = "Password must be at least 8 characters.";
            errorEl.classList.add("visible");
            return;
        }

        const btn = form.querySelector("button")!;
        btn.disabled = true;
        btn.textContent = "Provisioning…";

        try {
            const res = await register(email, password);
            if (res.ok) {
                await showTotpSetup(res.data, email, password);
            } else {
                const detail = (res.data as { detail?: string })?.detail ?? "Provisioning failed.";
                errorEl.textContent = detail;
                errorEl.classList.add("visible");
            }
        } catch {
            errorEl.textContent = "Network error. Please verify your connection.";
            errorEl.classList.add("visible");
        } finally {
            btn.disabled = false;
            btn.textContent = "Provision Account";
        }
    });
}


function escapeHtml(value: string): string {
    const el = document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
}