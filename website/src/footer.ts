import { REPO_ISSUES_URL, REPO_LICENSE_URL, REPO_URL } from "./config";
import { LEGAL, LEGAL_ENABLED } from "./legal-config";

/**
 * Site-wide footer, appended to every route.
 *
 * Disclosure law requires the Impressum to be reachable from any page of the
 * service (Austria § 25 MedienG, Germany § 5 DDG — conventionally within two
 * clicks), which is why this is global rather than living on the landing page
 * only. The legal links disappear on a build with no operator details
 * configured; the source and licence links stay, because they are true of every
 * build and are how someone reports a bug in it.
 */
export function renderFooter(app: HTMLElement): void {
    const legalLinks = LEGAL_ENABLED
        ? `<nav class="footer-links">
               <a href="#/legal/impressum">Impressum</a>
               <a href="#/legal/privacy">Privacy</a>
               <a href="#/legal/terms">Terms</a>
           </nav>`
        : "";

    const footer = document.createElement("footer");
    footer.className = "site-footer";
    footer.innerHTML = `
        ${legalLinks}
        <p>
            &copy; ${new Date().getFullYear()} ${LEGAL.siteName} —
            <a href="${REPO_URL}" target="_blank" rel="noopener">open source</a>
            under the <a href="${REPO_LICENSE_URL}" target="_blank" rel="noopener">MIT licence</a>.
        </p>
        <p class="footer-note">
            Found a bug, or want a feature?
            <a href="${REPO_ISSUES_URL}" target="_blank" rel="noopener">Open an issue on GitHub</a>.
        </p>
    `;
    app.appendChild(footer);
}
