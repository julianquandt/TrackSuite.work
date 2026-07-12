import QRCode from "qrcode";

import {
    clearSession,
    confirmMfaReset,
    createApiKey,
    deleteApiKey,
    getEmailFromToken,
    getRecoveryCodeStatus,
    getToken,
    listApiKeys,
    listSessions,
    logoutAll,
    regenerateRecoveryCodes,
    revokeSession,
    startMfaReset,
    type ApiKeyItem,
    type MfaResetStartResponse,
    type SessionInfo,
} from "../api";
import { navigate } from "../router";

export function renderDashboard(app: HTMLElement): void {
    if (!getToken()) {
        navigate("#/login");
        return;
    }

    const email = getEmailFromToken() ?? "unknown";

    app.innerHTML = `
        <div class="dashboard">
            <div class="dashboard-header">
                <h2>Account Control</h2>
                <p>Signed in as <span class="mono">${escapeHtml(email)}</span>. This is where you manage browser sessions, authenticator recovery, and sync API keys.</p>
            </div>

            <section class="dash-section">
                <div class="section-row">
                    <div>
                        <h3>Sync API Keys</h3>
                        <p>Generate API keys for desktop clients. The desktop app only needs the server URL and one sync key.</p>
                    </div>
                </div>

                <div class="table-wrapper">
                    <div id="key-list-container"><div class="key-empty">Querying keys…</div></div>
                </div>

                <div class="key-reveal" id="key-reveal">
                    <div class="warning-text">Key generated. Copy it now, as it will never be displayed again.</div>
                    <div class="secret-container">
                        <code id="key-reveal-value" class="mono"></code>
                        <button class="btn btn-outline" id="key-copy-btn" type="button">Copy Secret</button>
                    </div>
                </div>

                <div class="inline-form">
                    <div class="form-group">
                        <label for="new-key-name">Key Label</label>
                        <input type="text" id="new-key-name" placeholder="Office Desktop" maxlength="64" />
                    </div>
                    <button class="btn btn-primary" id="create-key-btn" type="button">Generate</button>
                </div>
            </section>

            <section class="dash-section">
                <div class="section-row">
                    <div>
                        <h3>Browser Sessions</h3>
                        <p>Inspect active and revoked browser sessions. Revoke any session you no longer trust.</p>
                    </div>
                    <button class="btn btn-outline" id="refresh-sessions-btn" type="button">Refresh</button>
                </div>

                <div class="table-wrapper">
                    <div id="session-list-container"><div class="key-empty">Loading sessions…</div></div>
                </div>

                <div class="btn-row">
                    <button class="btn btn-danger" id="logout-all-btn" type="button">Log Out Everywhere</button>
                </div>
            </section>

            <section class="dash-section">
                <div class="section-row">
                    <div>
                        <h3>Recovery and Authenticator</h3>
                        <p>Recovery codes remaining: <span class="mono" id="recovery-count">…</span>. Rotating recovery codes or resetting MFA should be treated like a credential event.</p>
                    </div>
                </div>

                <div class="settings-grid">
                    <div class="settings-card">
                        <h4>Regenerate Recovery Codes</h4>
                        <p class="settings-copy">Enter your password and a current authenticator code to invalidate every existing recovery code and mint a new set.</p>
                        <div class="form-error" id="recovery-error"></div>
                        <div class="form-success" id="recovery-success"></div>
                        <form id="recovery-form">
                            <div class="form-group">
                                <label for="recovery-password">Password</label>
                                <input type="password" id="recovery-password" autocomplete="current-password" />
                            </div>
                            <div class="form-group">
                                <label for="recovery-otp">Authenticator Code</label>
                                <input type="text" id="recovery-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                            </div>
                            <button class="btn btn-primary" type="submit">Regenerate Codes</button>
                        </form>
                    </div>

                    <div class="settings-card">
                        <h4>Reset Authenticator App</h4>
                        <p class="settings-copy">Prove possession of your current authenticator before provisioning a new TOTP secret. Confirming the reset will revoke other browser sessions.</p>
                        <div class="form-error" id="mfa-error"></div>
                        <div class="form-success" id="mfa-success"></div>
                        <form id="mfa-start-form">
                            <div class="form-group">
                                <label for="mfa-password">Password</label>
                                <input type="password" id="mfa-password" autocomplete="current-password" />
                            </div>
                            <div class="form-group">
                                <label for="mfa-current-otp">Current Authenticator Code</label>
                                <input type="text" id="mfa-current-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                            </div>
                            <button class="btn btn-primary" type="submit">Start Authenticator Reset</button>
                        </form>

                        <div class="key-reveal" id="mfa-reset-setup">
                            <div class="warning-text">Scan the new QR code now. The reset is not complete until you verify a code from the newly provisioned authenticator.</div>
                            <div class="totp-setup-grid">
                                <div class="totp-qr-panel">
                                    <img id="mfa-reset-qr" class="totp-qr-image" alt="New authenticator QR code for TrackSuite.work" />
                                    <p class="totp-qr-caption" id="mfa-reset-caption">Scan this with your replacement authenticator app.</p>
                                </div>
                                <div class="totp-secret-panel">
                                    <div class="form-group">
                                        <label>Manual TOTP Secret</label>
                                        <div class="secret-container">
                                            <code id="mfa-reset-secret" class="mono"></code>
                                            <button class="btn btn-outline" id="mfa-copy-secret" type="button">Copy Secret</button>
                                        </div>
                                    </div>
                                    <div class="form-group">
                                        <label for="mfa-new-otp">Code From New Authenticator</label>
                                        <input type="text" id="mfa-new-otp" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" />
                                    </div>
                                    <div class="btn-row auth-action-row">
                                        <button class="btn btn-primary" id="mfa-confirm-btn" type="button">Confirm New Authenticator</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="key-reveal" id="recovery-codes-panel">
                    <div class="warning-text" id="recovery-codes-label">Save these recovery codes offline. Each code can be used once if you lose your authenticator.</div>
                    <div class="recovery-code-grid" id="recovery-codes-grid"></div>
                    <div class="btn-row auth-action-row">
                        <button class="btn btn-outline" id="recovery-copy-btn" type="button">Copy Recovery Codes</button>
                    </div>
                </div>
            </section>
        </div>
    `;

    const listContainer = document.getElementById("key-list-container")!;
    const revealBox = document.getElementById("key-reveal")!;
    const revealValue = document.getElementById("key-reveal-value")!;
    const copyBtn = document.getElementById("key-copy-btn") as HTMLButtonElement;
    const nameInput = document.getElementById("new-key-name") as HTMLInputElement;
    const createBtn = document.getElementById("create-key-btn") as HTMLButtonElement;
    const sessionListContainer = document.getElementById("session-list-container")!;
    const refreshSessionsBtn = document.getElementById("refresh-sessions-btn") as HTMLButtonElement;
    const logoutAllBtn = document.getElementById("logout-all-btn") as HTMLButtonElement;
    const recoveryCountEl = document.getElementById("recovery-count")!;
    const recoveryForm = document.getElementById("recovery-form") as HTMLFormElement;
    const recoveryPasswordInput = document.getElementById("recovery-password") as HTMLInputElement;
    const recoveryOtpInput = document.getElementById("recovery-otp") as HTMLInputElement;
    const recoveryErrorEl = document.getElementById("recovery-error")!;
    const recoverySuccessEl = document.getElementById("recovery-success")!;
    const mfaStartForm = document.getElementById("mfa-start-form") as HTMLFormElement;
    const mfaPasswordInput = document.getElementById("mfa-password") as HTMLInputElement;
    const mfaCurrentOtpInput = document.getElementById("mfa-current-otp") as HTMLInputElement;
    const mfaErrorEl = document.getElementById("mfa-error")!;
    const mfaSuccessEl = document.getElementById("mfa-success")!;
    const mfaResetSetupEl = document.getElementById("mfa-reset-setup")!;
    const mfaResetQrEl = document.getElementById("mfa-reset-qr") as HTMLImageElement;
    const mfaResetCaptionEl = document.getElementById("mfa-reset-caption")!;
    const mfaResetSecretEl = document.getElementById("mfa-reset-secret")!;
    const mfaCopySecretBtn = document.getElementById("mfa-copy-secret") as HTMLButtonElement;
    const mfaNewOtpInput = document.getElementById("mfa-new-otp") as HTMLInputElement;
    const mfaConfirmBtn = document.getElementById("mfa-confirm-btn") as HTMLButtonElement;
    const recoveryCodesPanel = document.getElementById("recovery-codes-panel")!;
    const recoveryCodesLabel = document.getElementById("recovery-codes-label")!;
    const recoveryCodesGrid = document.getElementById("recovery-codes-grid")!;
    const recoveryCopyBtn = document.getElementById("recovery-copy-btn") as HTMLButtonElement;

    let latestRecoveryCodes: string[] = [];

    function resetMessages(): void {
        recoveryErrorEl.classList.remove("visible");
        recoverySuccessEl.classList.remove("visible");
        mfaErrorEl.classList.remove("visible");
        mfaSuccessEl.classList.remove("visible");
    }

    function showMessage(element: HTMLElement, message: string): void {
        element.textContent = message;
        element.classList.add("visible");
    }

    function renderRecoveryCodes(codes: string[], message: string): void {
        latestRecoveryCodes = codes;
        recoveryCodesLabel.textContent = message;
        recoveryCodesGrid.innerHTML = codes
            .map((code) => `<code class="recovery-code-item mono">${escapeHtml(code)}</code>`)
            .join("");
        recoveryCodesPanel.classList.add("visible");
        recoveryCountEl.textContent = String(codes.length);
    }

    function renderKeyList(keys: ApiKeyItem[]): void {
        if (keys.length === 0) {
            listContainer.innerHTML = `<div class="key-empty">No active keys created yet.</div>`;
            return;
        }

        listContainer.innerHTML = `<ul class="key-list">${keys.map((key) => `
            <li class="key-item" data-id="${key.id}">
                <div>
                    <div class="key-name">${escapeHtml(key.name)}</div>
                    <div class="key-date">Generated ${escapeHtml(formatTimestamp(key.created_at))}</div>
                </div>
                <button class="btn btn-danger key-delete-btn" type="button">Revoke</button>
            </li>
        `).join("")}</ul>`;

        listContainer.querySelectorAll(".key-delete-btn").forEach((button) => {
            button.addEventListener("click", async () => {
                const row = button.closest(".key-item") as HTMLElement | null;
                const id = Number(row?.dataset.id ?? "0");
                if (!id) {
                    return;
                }
                if (!window.confirm("Revoke this API key? Associated clients will immediately lose sync access.")) {
                    return;
                }
                const response = await deleteApiKey(id);
                if (response.ok || response.status === 204) {
                    await loadKeys();
                }
            });
        });
    }

    function getSessionState(session: SessionInfo): { label: string; className: string } {
        if (session.revoked_at) {
            return { label: "Revoked", className: "is-revoked" };
        }
        if (Date.parse(session.expires_at) <= Date.now()) {
            return { label: "Expired", className: "is-expired" };
        }
        return { label: "Active", className: "is-active" };
    }

    function renderSessionList(sessions: SessionInfo[]): void {
        if (sessions.length === 0) {
            sessionListContainer.innerHTML = `<div class="key-empty">No browser sessions found.</div>`;
            return;
        }

        sessionListContainer.innerHTML = `<ul class="session-list">${sessions.map((session) => {
            const state = getSessionState(session);
            const details = [session.label, session.ip_address, session.user_agent].filter(Boolean).join(" · ");
            return `
                <li class="session-item ${state.className}" data-id="${escapeHtml(session.id)}">
                    <div class="session-main">
                        <div class="session-head">
                            <div class="key-name">${escapeHtml(session.label ?? "Browser session")}</div>
                            <div class="session-badges">
                                ${session.current ? '<span class="session-badge current">Current</span>' : ""}
                                <span class="session-badge ${state.className}">${state.label}</span>
                            </div>
                        </div>
                        <div class="session-meta">${escapeHtml(details || "No client metadata")}</div>
                        <div class="session-dates mono">Created ${escapeHtml(formatTimestamp(session.created_at))} · Last used ${escapeHtml(formatTimestamp(session.last_used_at))} · Expires ${escapeHtml(formatTimestamp(session.expires_at))}</div>
                    </div>
                    ${session.current || state.label !== "Active" ? "" : '<button class="btn btn-outline session-revoke-btn" type="button">Revoke</button>'}
                </li>
            `;
        }).join("")}</ul>`;

        sessionListContainer.querySelectorAll(".session-revoke-btn").forEach((button) => {
            button.addEventListener("click", async () => {
                const row = button.closest(".session-item") as HTMLElement | null;
                const sessionId = row?.dataset.id;
                if (!sessionId) {
                    return;
                }
                if (!window.confirm("Revoke this browser session?")) {
                    return;
                }
                const response = await revokeSession(sessionId);
                if (response.ok || response.status === 204) {
                    await loadSessions();
                }
            });
        });
    }

    async function loadKeys(): Promise<void> {
        const response = await listApiKeys();
        if (!response.ok) {
            listContainer.innerHTML = `<div class="key-empty">Failed to load API keys.</div>`;
            return;
        }
        renderKeyList(response.data);
    }

    async function loadSessions(): Promise<void> {
        const response = await listSessions();
        if (!response.ok) {
            if (response.status === 401) {
                clearSession();
                navigate("#/login");
                return;
            }
            sessionListContainer.innerHTML = `<div class="key-empty">Failed to load sessions.</div>`;
            return;
        }
        renderSessionList(response.data);
    }

    async function loadRecoveryStatus(): Promise<void> {
        const response = await getRecoveryCodeStatus();
        if (!response.ok) {
            recoveryCountEl.textContent = "unavailable";
            return;
        }
        recoveryCountEl.textContent = String(response.data.remaining_count);
    }

    async function renderResetSetup(data: MfaResetStartResponse): Promise<void> {
        mfaResetSecretEl.textContent = data.totp_secret;
        mfaNewOtpInput.value = "";
        try {
            mfaResetQrEl.src = await QRCode.toDataURL(data.totp_uri, {
                width: 220,
                margin: 1,
                errorCorrectionLevel: "M",
                color: {
                    dark: "#111111",
                    light: "#ffffff",
                },
            });
            mfaResetQrEl.style.display = "block";
            mfaResetCaptionEl.textContent = "Scan this with your replacement authenticator app.";
        } catch {
            mfaResetQrEl.removeAttribute("src");
            mfaResetQrEl.style.display = "none";
            mfaResetCaptionEl.textContent = "QR generation failed in this browser. Use the manual TOTP secret instead.";
        }
        mfaResetSetupEl.classList.add("visible");
    }

    createBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) {
            nameInput.focus();
            return;
        }

        createBtn.disabled = true;
        createBtn.textContent = "Generating…";
        try {
            const response = await createApiKey(name);
            if (response.ok) {
                revealValue.textContent = response.data.key;
                revealBox.classList.add("visible");
                nameInput.value = "";
                await loadKeys();
            }
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = "Generate";
        }
    });

    copyBtn.addEventListener("click", async () => {
        const key = revealValue.textContent ?? "";
        if (!key) {
            return;
        }
        await navigator.clipboard.writeText(key);
        copyBtn.textContent = "Copied!";
        window.setTimeout(() => {
            copyBtn.textContent = "Copy Secret";
        }, 2000);
    });

    refreshSessionsBtn.addEventListener("click", async () => {
        refreshSessionsBtn.disabled = true;
        refreshSessionsBtn.textContent = "Refreshing…";
        try {
            await loadSessions();
        } finally {
            refreshSessionsBtn.disabled = false;
            refreshSessionsBtn.textContent = "Refresh";
        }
    });

    logoutAllBtn.addEventListener("click", async () => {
        if (!window.confirm("Log out every browser session, including this one?")) {
            return;
        }

        logoutAllBtn.disabled = true;
        logoutAllBtn.textContent = "Revoking…";
        try {
            const response = await logoutAll();
            if (response.ok) {
                clearSession();
                navigate("#/login");
            }
        } finally {
            logoutAllBtn.disabled = false;
            logoutAllBtn.textContent = "Log Out Everywhere";
        }
    });

    recoveryForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        resetMessages();

        const password = recoveryPasswordInput.value;
        const otp = recoveryOtpInput.value.trim();
        if (!password || !/^\d{6}$/.test(otp)) {
            showMessage(recoveryErrorEl, "Enter your password and a valid 6-digit authenticator code.");
            return;
        }

        const submitButton = recoveryForm.querySelector('button[type="submit"]') as HTMLButtonElement;
        submitButton.disabled = true;
        submitButton.textContent = "Regenerating…";
        try {
            const response = await regenerateRecoveryCodes(password, otp);
            if (response.ok) {
                renderRecoveryCodes(
                    response.data.recovery_codes,
                    "Fresh recovery codes generated. Save them offline now. The previous set is no longer valid.",
                );
                recoveryPasswordInput.value = "";
                recoveryOtpInput.value = "";
                showMessage(recoverySuccessEl, "Recovery codes rotated successfully.");
                await loadRecoveryStatus();
            } else {
                const detail = (response.data as { detail?: string })?.detail ?? "Recovery code rotation failed.";
                showMessage(recoveryErrorEl, detail);
            }
        } catch {
            showMessage(recoveryErrorEl, "Network error. Please verify your connection.");
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = "Regenerate Codes";
        }
    });

    mfaStartForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        resetMessages();

        const password = mfaPasswordInput.value;
        const otp = mfaCurrentOtpInput.value.trim();
        if (!password || !/^\d{6}$/.test(otp)) {
            showMessage(mfaErrorEl, "Enter your password and a valid current authenticator code.");
            return;
        }

        const submitButton = mfaStartForm.querySelector('button[type="submit"]') as HTMLButtonElement;
        submitButton.disabled = true;
        submitButton.textContent = "Provisioning…";
        try {
            const response = await startMfaReset(password, otp);
            if (response.ok) {
                await renderResetSetup(response.data);
                showMessage(mfaSuccessEl, "New authenticator secret provisioned. Confirm a code from the new app to finish the reset.");
            } else {
                const detail = (response.data as { detail?: string })?.detail ?? "Authenticator reset could not be started.";
                showMessage(mfaErrorEl, detail);
            }
        } catch {
            showMessage(mfaErrorEl, "Network error. Please verify your connection.");
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = "Start Authenticator Reset";
        }
    });

    mfaCopySecretBtn.addEventListener("click", async () => {
        const secret = mfaResetSecretEl.textContent ?? "";
        if (!secret) {
            return;
        }
        await navigator.clipboard.writeText(secret);
        mfaCopySecretBtn.textContent = "Copied!";
        window.setTimeout(() => {
            mfaCopySecretBtn.textContent = "Copy Secret";
        }, 2000);
    });

    mfaConfirmBtn.addEventListener("click", async () => {
        resetMessages();
        const otp = mfaNewOtpInput.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            showMessage(mfaErrorEl, "Enter the 6-digit code from the newly provisioned authenticator app.");
            return;
        }

        mfaConfirmBtn.disabled = true;
        mfaConfirmBtn.textContent = "Confirming…";
        try {
            const response = await confirmMfaReset(otp);
            if (response.ok) {
                renderRecoveryCodes(
                    response.data.recovery_codes,
                    "Authenticator reset completed. Save this replacement recovery-code set offline now.",
                );
                mfaResetSetupEl.classList.remove("visible");
                mfaPasswordInput.value = "";
                mfaCurrentOtpInput.value = "";
                mfaNewOtpInput.value = "";
                showMessage(mfaSuccessEl, "Authenticator reset completed. Other browser sessions were revoked.");
                await loadRecoveryStatus();
                await loadSessions();
            } else {
                const detail = (response.data as { detail?: string })?.detail ?? "Authenticator reset confirmation failed.";
                showMessage(mfaErrorEl, detail);
            }
        } catch {
            showMessage(mfaErrorEl, "Network error. Please verify your connection.");
        } finally {
            mfaConfirmBtn.disabled = false;
            mfaConfirmBtn.textContent = "Confirm New Authenticator";
        }
    });

    recoveryCopyBtn.addEventListener("click", async () => {
        if (latestRecoveryCodes.length === 0) {
            return;
        }
        await navigator.clipboard.writeText(latestRecoveryCodes.join("\n"));
        recoveryCopyBtn.textContent = "Copied!";
        window.setTimeout(() => {
            recoveryCopyBtn.textContent = "Copy Recovery Codes";
        }, 2000);
    });

    void loadKeys();
    void loadSessions();
    void loadRecoveryStatus();
}

function formatTimestamp(value: string): string {
    return new Date(value).toLocaleString();
}

function escapeHtml(value: string): string {
    const el = document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
}
