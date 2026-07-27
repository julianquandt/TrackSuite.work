// Self-hosted Inter (latin subset). Bundled into dist/ by Vite so no request
// ever leaves for a third-party font CDN — see the note at the top of styles.css.
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";

import "./styles.css";
import { getToken } from "./api";
import { APP_ONLY, loadInstanceConfig } from "./config";
import { LEGAL_ENABLED } from "./legal-config";
import { route, startRouter } from "./router";
import { renderNav } from "./nav";
import { renderFooter } from "./footer";
import { checkTermsAcceptance } from "./tos";
import { renderLanding } from "./pages/landing";
import { renderRegister } from "./pages/register";
import { renderLogin } from "./pages/login";
import { renderVerifyEmail } from "./pages/verifyEmail";
import { renderResetPassword } from "./pages/resetPassword";
import { renderDashboard } from "./pages/dashboard";
import { renderDocs } from "./pages/docs";
import { renderTracker } from "./pages/tracker";
import { renderReports } from "./pages/reports";
import { renderImpressum, renderPrivacy, renderTerms } from "./pages/legal";

const app = document.getElementById("app")!;

function render(page: (el: HTMLElement) => void): void {
    app.innerHTML = "";
    page(app);
    renderNav(app);
    renderFooter(app);
}

/**
 * The landing page is marketing for the public service, so an app-only build
 * doesn't ship it: "/" goes straight to the app (or to sign-in). Same for the
 * self-hosting guide, which documents deploying the project, not using it.
 */
function renderHome(): void {
    if (APP_ONLY) {
        window.location.replace(getToken() ? "#/tracker" : "#/login");
        return;
    }
    render(renderLanding);
}

route("#/", renderHome);
route("#/register", () => render(renderRegister));
route("#/login", () => render(renderLogin));
route("#/verify-email", () => render(renderVerifyEmail));
route("#/reset-password", () => render(renderResetPassword));
route("#/dashboard", () => render(renderDashboard));
route("#/tracker", () => render(renderTracker));
route("#/reports", () => render(renderReports));

if (!APP_ONLY) {
    route("#/docs", () => render(renderDocs));
}

if (LEGAL_ENABLED) {
    route("#/legal/impressum", () => render(renderImpressum));
    route("#/legal/privacy", () => render(renderPrivacy));
    route("#/legal/terms", () => render(renderTerms));
}

// Learn what this deployment allows (open signup? invite code? single user?)
// before the first render, so the UI never offers something the server refuses.
void loadInstanceConfig().finally(() => {
    startRouter();
    // After the first paint, not before it: the Terms prompt is notice, and
    // notice must never be what stands between someone and their own data.
    void checkTermsAcceptance();
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js")
            .then(reg => console.log("Service Worker registered!", reg.scope))
            .catch(err => console.warn("Service Worker registration failed", err));
    });
}
