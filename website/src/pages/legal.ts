/**
 * Legal pages: the imprint (Offenlegung § 25 MedienG / § 5 ECG in Austria,
 * Impressum § 5 DDG in Germany), the Privacy Policy (Art. 13/14 GDPR) and the
 * Terms of Service.
 *
 * Content is generated from `legal-config.ts` so a self-hosted instance
 * publishes its own operator's details under its own jurisdiction's rules, and
 * the descriptions of *what is processed* track what the code actually does — if
 * you add a data category, a processor, or change a retention window, update the
 * privacy policy in the same commit.
 */

import { LEGAL, missingLegalFields } from "../legal-config";

function esc(value: string): string {
    const el = document.createElement("span");
    el.textContent = value;
    return el.innerHTML;
}

/** Loud, in-page warning when a legally mandatory field was never configured. */
function configWarning(): string {
    const missing = missingLegalFields();
    if (!missing.length) return "";
    return `
        <div class="legal-warning">
            <strong>This page is incomplete.</strong> The following are legally required and
            are not configured for this deployment. Set them in <code>website/.env.local</code>
            and rebuild:
            <ul>${missing.map((m) => `<li><code>${esc(m)}</code></li>`).join("")}</ul>
        </div>`;
}

/** Postal block. At Austria's reduced disclosure the street is omitted entirely. */
function addressBlock(): string {
    const parts = LEGAL.disclosure === "small"
        ? [LEGAL.operatorName, LEGAL.city, LEGAL.country]
        : [LEGAL.operatorName, LEGAL.street, LEGAL.city, LEGAL.country];
    const lines = parts.filter(Boolean).map(esc);
    return lines.length ? lines.join("<br />") : "<em>— not configured —</em>";
}

function contactLink(): string {
    return LEGAL.contactEmail
        ? `<a href="mailto:${esc(LEGAL.contactEmail)}">${esc(LEGAL.contactEmail)}</a>`
        : "<em>— not configured —</em>";
}

function layout(title: string, body: string): string {
    return `
        <div class="docs-content legal-content">
            <h1>${esc(title)}</h1>
            ${configWarning()}
            ${body}
            <p class="legal-updated">Last updated: ${esc(LEGAL.effectiveDate)}</p>
            <p class="legal-nav">
                <a href="#/legal/impressum">Impressum</a> ·
                <a href="#/legal/privacy">Privacy Policy</a> ·
                <a href="#/legal/terms">Terms of Service</a>
            </p>
        </div>`;
}

// ── Imprint ──────────────────────────────────────────────────────────

function impressumAustria(): string {
    const small = LEGAL.disclosure === "small";
    return `
        <p class="legal-lede">
            Offenlegung gemäß § 25 Mediengesetz${small ? " (kleine Website, § 25 Abs 5 MedienG)" : " und Informationen gemäß § 5 E-Commerce-Gesetz"} —
            information required under Austrian law.
        </p>

        <h2>Medieninhaber und Diensteanbieter / Media owner and service provider</h2>
        <p class="legal-address">${addressBlock()}</p>
        ${small ? `
        <p>
            Angegeben ist der Wohnort des Medieninhabers, wie es § 25 Abs 5 MedienG für eine
            kleine Website vorsieht.
            <span class="legal-en">Under the reduced disclosure Austrian media law provides for a
            "small website", the media owner's place of residence is stated rather than a full
            street address.</span>
        </p>` : ""}

        <h2>Unternehmensgegenstand / Business purpose</h2>
        <p>${esc(LEGAL.businessPurpose) || "<em>— not configured —</em>"}</p>

        <h2>Kontakt / Contact</h2>
        <table class="legal-table">
            <tr><th>E-Mail</th><td>${contactLink()}</td></tr>
            ${LEGAL.phone ? `<tr><th>Telefon</th><td>${esc(LEGAL.phone)}</td></tr>` : ""}
            <tr><th>Website</th><td>${esc(LEGAL.siteDomain)}</td></tr>
        </table>
        <p>
            E-Mail ermöglicht eine schnelle elektronische Kontaktaufnahme und unmittelbare
            Kommunikation und wird regelmäßig gelesen.
            <span class="legal-en">Email is the primary contact channel and is monitored
            regularly.</span>
        </p>

        ${LEGAL.vatId ? `
        <h2>UID-Nummer / VAT identification number</h2>
        <p><span class="mono">${esc(LEGAL.vatId)}</span></p>` : ""}

        <h2>Verbraucherstreitbeilegung / Consumer dispute resolution</h2>
        <p>
            ${esc(LEGAL.operatorName)} ist nicht verpflichtet und nicht bereit, an einem
            Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle im Sinne des
            Alternative-Streitbeilegung-Gesetzes (AStG) teilzunehmen.
            <span class="legal-en">We are neither obliged nor willing to participate in dispute
            resolution proceedings before a consumer arbitration board.</span>
        </p>

        <h2>Haftung für Inhalte und Links / Liability for content and links</h2>
        <p>
            Für eigene Inhalte auf diesen Seiten sind wir nach den allgemeinen Gesetzen
            verantwortlich. Nach §§ 13 ff E-Commerce-Gesetz besteht jedoch keine allgemeine
            Verpflichtung, übermittelte oder gespeicherte fremde Informationen zu überwachen
            oder aktiv nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit
            hinweisen. Verpflichtungen zur Entfernung oder Sperrung nach den allgemeinen
            Gesetzen bleiben davon unberührt; eine Haftung ist erst ab Kenntnis einer konkreten
            Rechtsverletzung möglich. Bei Bekanntwerden entsprechender Rechtsverletzungen
            entfernen wir die betreffenden Inhalte oder Links umgehend.
        </p>
        <p>
            Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir
            keinen Einfluss haben. Für diese fremden Inhalte ist stets der jeweilige Anbieter
            oder Betreiber verantwortlich.
        </p>

        <h2>Urheberrecht / Copyright</h2>
        <p>
            Die Software hinter ${esc(LEGAL.siteName)} ist quelloffen und steht unter der
            MIT-Lizenz; es gelten die Bedingungen dieser Lizenz. Die auf diesen Seiten
            veröffentlichten Texte und Grafiken unterliegen dem österreichischen
            Urheberrechtsgesetz, soweit sie nicht ausdrücklich anders lizenziert sind.
            <span class="legal-en">The software behind ${esc(LEGAL.siteName)} is open source under
            the MIT licence; the website's texts and graphics are protected by copyright unless
            explicitly licensed otherwise.</span>
        </p>`;
}

function impressumGermany(): string {
    return `
        <p class="legal-lede">
            Angaben gemäß § 5 Digitale-Dienste-Gesetz (DDG) —
            information required under German law.
        </p>

        <h2>Diensteanbieter / Service provider</h2>
        <p class="legal-address">${addressBlock()}</p>

        <h2>Kontakt / Contact</h2>
        <table class="legal-table">
            <tr><th>E-Mail</th><td>${contactLink()}</td></tr>
            ${LEGAL.phone ? `<tr><th>Telefon</th><td>${esc(LEGAL.phone)}</td></tr>` : ""}
            <tr><th>Website</th><td>${esc(LEGAL.siteDomain)}</td></tr>
        </table>
        <p>
            E-Mail ist der schnellste Weg zur unmittelbaren Kommunikation und wird
            regelmäßig gelesen. <span class="legal-en">Email is the primary contact channel
            and is monitored regularly.</span>
        </p>

        ${LEGAL.vatId ? `
        <h2>Umsatzsteuer-Identifikationsnummer</h2>
        <p>Gemäß § 27a Umsatzsteuergesetz: <span class="mono">${esc(LEGAL.vatId)}</span></p>` : ""}

        <h2>Verantwortlich für den Inhalt / Responsible for content</h2>
        <p>
            Verantwortlich nach § 18 Abs. 2 Medienstaatsvertrag (MStV):<br />
            ${addressBlock()}
        </p>

        <h2>Verbraucherstreitbeilegung / Consumer dispute resolution</h2>
        <p>
            ${esc(LEGAL.operatorName)} ist nicht bereit und nicht verpflichtet, an
            Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
            teilzunehmen (§ 36 VSBG).
            <span class="legal-en">We are neither willing nor obliged to participate in
            dispute resolution proceedings before a consumer arbitration board.</span>
        </p>

        <h2>Haftung für Inhalte und Links / Liability for content and links</h2>
        <p>
            Als Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für eigene Inhalte auf diesen
            Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG sind wir
            jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu
            überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit
            hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von
            Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine
            diesbezügliche Haftung ist erst ab dem Zeitpunkt der Kenntnis einer konkreten
            Rechtsverletzung möglich. Bei Bekanntwerden entsprechender Rechtsverletzungen werden
            wir diese Inhalte umgehend entfernen.
        </p>
        <p>
            Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir
            keinen Einfluss haben. Für die Inhalte der verlinkten Seiten ist stets der jeweilige
            Anbieter oder Betreiber verantwortlich.
        </p>

        <h2>Urheberrecht / Copyright</h2>
        <p>
            Die Software hinter ${esc(LEGAL.siteName)} ist quelloffen und steht unter der
            MIT-Lizenz; es gelten die Bedingungen dieser Lizenz. Die auf diesen Seiten
            veröffentlichten Texte und Grafiken unterliegen dem deutschen Urheberrecht,
            soweit sie nicht ausdrücklich anders lizenziert sind.
            <span class="legal-en">The software behind ${esc(LEGAL.siteName)} is open source under
            the MIT licence; the website's texts and graphics are protected by copyright unless
            explicitly licensed otherwise.</span>
        </p>`;
}

function impressumGeneric(): string {
    return `
        <p class="legal-lede">
            Who operates ${esc(LEGAL.siteName)}, and how to reach us.
        </p>

        <h2>Service provider</h2>
        <p class="legal-address">${addressBlock()}</p>

        <h2>Contact</h2>
        <table class="legal-table">
            <tr><th>Email</th><td>${contactLink()}</td></tr>
            ${LEGAL.phone ? `<tr><th>Phone</th><td>${esc(LEGAL.phone)}</td></tr>` : ""}
            <tr><th>Website</th><td>${esc(LEGAL.siteDomain)}</td></tr>
        </table>
        ${LEGAL.vatId ? `<h2>VAT identification number</h2>
        <p><span class="mono">${esc(LEGAL.vatId)}</span></p>` : ""}

        <h2>Copyright</h2>
        <p>
            The software behind ${esc(LEGAL.siteName)} is open source under the MIT licence.
            This site's texts and graphics are protected by copyright unless explicitly
            licensed otherwise.
        </p>`;
}

export function renderImpressum(app: HTMLElement): void {
    const body = LEGAL.jurisdiction === "at" ? impressumAustria()
        : LEGAL.jurisdiction === "de" ? impressumGermany()
        : impressumGeneric();
    const title = LEGAL.jurisdiction === "at"
        ? "Offenlegung / Legal Notice"
        : "Impressum / Legal Notice";
    app.innerHTML = layout(title, body);
}

// ── Privacy policy ───────────────────────────────────────────────────

/** The national statute implementing Art. 5(3) ePrivacy for terminal storage. */
function terminalStorageStatute(): string {
    if (LEGAL.jurisdiction === "at") return "§ 165 Abs 3 TKG 2021";
    if (LEGAL.jurisdiction === "de") return "§ 25(2) no. 2 TDDDG";
    return "the national law implementing Art. 5(3) of the ePrivacy Directive";
}

/** Where the "we have no DPO" statement points for the national derogation. */
function dpoStatute(): string {
    if (LEGAL.jurisdiction === "at") return "Art. 37 GDPR / § 5 DSG";
    if (LEGAL.jurisdiction === "de") return "Art. 37 GDPR / § 38 BDSG";
    return "Art. 37 GDPR";
}

function supervisoryAuthority(): string {
    if (LEGAL.jurisdiction === "at") {
        return `
        <p>
            The competent authority for us is the Austrian Data Protection Authority
            (Österreichische Datenschutzbehörde), Barichgasse 40–42, 1030 Vienna,
            <a href="mailto:dsb@dsb.gv.at">dsb@dsb.gv.at</a>.
        </p>`;
    }
    return "";
}

export function renderPrivacy(app: HTMLElement): void {
    const contact = contactLink();
    const hosting = LEGAL.hostingProvider
        ? esc(LEGAL.hostingProvider)
        : "our hosting provider (server infrastructure)";

    app.innerHTML = layout("Privacy Policy", `
        <p class="legal-lede">
            How ${esc(LEGAL.siteName)} handles your personal data, as required by Articles 13
            and 14 of the General Data Protection Regulation (GDPR). In short: we collect the
            minimum needed to run the service, we do not track you, we do not use advertising
            or analytics, and we never sell or share your data.
        </p>

        <h2>1. Who is responsible</h2>
        <p>The controller within the meaning of Art. 4(7) GDPR is:</p>
        <p class="legal-address">${addressBlock()}</p>
        <p>Email: ${contact}</p>
        <p>
            We have not appointed a Data Protection Officer, as we are not required to under
            ${dpoStatute()}. Please direct all privacy enquiries to the address above.
        </p>

        <h2>2. What we process, why, and on what legal basis</h2>

        <h3>2.1 Account data</h3>
        <p>
            Your email address, a cryptographic hash of your password, your two-factor
            authentication secret, hashes of your recovery codes, the date the account was
            created, and the date and version of the Terms you accepted.
        </p>
        <p>
            <strong>Purpose:</strong> to create and secure your account and to prove which
            version of the Terms applies to it.
            <strong>Legal basis:</strong> Art. 6(1)(b) GDPR (performance of a contract) and,
            for the acceptance record, Art. 6(1)(f) (our legitimate interest in being able to
            demonstrate compliance).
        </p>

        <h3>2.2 The content you create</h3>
        <p>
            Work shifts (start and end times), shift notes, projects and their hourly rates or
            billing settings, off-days and holidays, your weekly target schedule, and your
            reporting profile (such as the name, company details and letterhead you put on
            generated reports).
        </p>
        <p>
            <strong>Purpose:</strong> to provide the tracking, reporting and cross-device sync
            you signed up for. <strong>Legal basis:</strong> Art. 6(1)(b) GDPR.
            We do not read, analyse, profile or monetise this content.
        </p>

        <h3>2.3 Session and security data</h3>
        <p>
            For each signed-in device: a session identifier, a hash of the session's refresh
            token, the IP address and browser user-agent recorded when the session was created
            or last used, a device label, and the relevant timestamps. Also failed
            authentication counters keyed to an email address or IP address, used for rate
            limiting.
        </p>
        <p>
            <strong>Purpose:</strong> to keep you signed in, to let you see and revoke your own
            active sessions, and to detect and block credential-stuffing and brute-force
            attacks. <strong>Legal basis:</strong> Art. 6(1)(f) GDPR — our legitimate interest,
            and yours, in the security of the service (see recital 49).
        </p>

        <h3>2.4 Server and security logs</h3>
        <p>
            Security-relevant events (sign-in, sign-in failure, password change, account
            deletion and similar) are logged with an account identifier, an IP address, an event
            name and a timestamp. These logs deliberately contain no passwords, tokens,
            one-time codes, or the content of your notes.
        </p>
        <p>
            <strong>Purpose:</strong> operating the service securely and being able to
            investigate and report a personal data breach (Art. 33/34 GDPR).
            <strong>Legal basis:</strong> Art. 6(1)(f) GDPR.
        </p>

        <h3>2.5 Email</h3>
        <p>
            We send email only in response to something that happened on your account: address
            verification, password reset, security notices, and — if enabled on this instance —
            a warning before a long-inactive account is deleted. There is no newsletter and no
            marketing email.
        </p>
        <p><strong>Legal basis:</strong> Art. 6(1)(b) and Art. 6(1)(f) GDPR.</p>

        <h2>3. What we do <em>not</em> do</h2>
        <ul>
            <li>No advertising, no advertising identifiers, no ad networks.</li>
            <li>No analytics, no tracking pixels, no fingerprinting, no third-party scripts.</li>
            <li>No sale of personal data, and no sharing with third parties for their own purposes.</li>
            <li>No automated decision-making or profiling within the meaning of Art. 22 GDPR.</li>
            <li>
                No third-party content is loaded when you visit the site. Fonts and all other
                assets are served from our own server, so no request and no IP address of yours
                is passed to a content-delivery network.
            </li>
        </ul>

        <h2>4. Cookies and local storage</h2>
        <p>
            We set <strong>no cookies</strong>. The web app stores a small number of items in
            your browser's local storage: your access and refresh tokens (so you stay signed
            in), your light/dark theme choice, your simple/full interface preference and a
            cached copy of your work schedule so the app works offline.
        </p>
        <p>
            These are strictly necessary to deliver the service you explicitly requested, so
            under ${terminalStorageStatute()} they require no consent banner. They stay on your
            device, are never transmitted to third parties, and are cleared when you sign out or
            clear your browser data.
        </p>

        <h2>5. Where your data is stored, and who else sees it</h2>
        <p>
            The service runs on a server operated on our behalf by ${hosting}. Data is
            transmitted over TLS and the sensitive fields — your email address, two-factor
            secret, device labels, reporting profile and schedule — are additionally encrypted
            at rest, so a stolen disk image does not yield readable data.
        </p>
        ${LEGAL.emailProvider ? `
        <p>
            Transactional email is delivered by <strong>${esc(LEGAL.emailProvider)}</strong>,
            acting as our processor under Art. 28 GDPR. To send you an email we necessarily
            pass them your email address and the message. As this provider processes data in
            the United States, the transfer takes place on the basis of the EU–U.S. Data
            Privacy Framework and/or the European Commission's Standard Contractual Clauses
            together with supplementary measures pursuant to Art. 46 GDPR.
        </p>` : ""}
        <p>
            Beyond these processors, your data is disclosed to no one — except where we are
            legally obliged to do so, for example in response to a binding order from a
            competent authority.
        </p>

        <h2>6. How long we keep it</h2>
        <table class="legal-table legal-table-wide">
            <tr><th>Account and content</th><td>Until you delete your account. Deletion is immediate and irreversible.</td></tr>
            <tr><th>Deleted items (shifts, projects, off-days)</th><td>A deletion marker is retained for 180 days so the deletion propagates to your other devices, then purged.</td></tr>
            <tr><th>Sessions (incl. IP and user-agent)</th><td>Purged 30 days after the session expires or is revoked. Sessions expire after 90 days at the latest.</td></tr>
            <tr><th>Rate-limiting counters</th><td>Purged after 24 hours.</td></tr>
            <tr><th>Accounts that never completed setup</th><td>Deleted automatically after 48 hours.</td></tr>
            <tr><th>Security logs</th><td>Kept for the retention period configured on the server's system journal, then rotated out.</td></tr>
        </table>
        <p>
            If an inactivity policy is enabled on this instance, we email you a warning before a
            long-dormant account is removed, and delete it only after a grace period.
        </p>

        <h2>7. Your rights</h2>
        <p>Under the GDPR you have the right to:</p>
        <ul>
            <li><strong>Access</strong> (Art. 15) — a copy of your data. The dashboard has a one-click export in machine-readable JSON.</li>
            <li><strong>Rectification</strong> (Art. 16) — correct inaccurate data; most of it you can edit yourself in the app.</li>
            <li><strong>Erasure</strong> (Art. 17) — delete your account and all its data, self-service from the dashboard.</li>
            <li><strong>Restriction</strong> of processing (Art. 18).</li>
            <li><strong>Data portability</strong> (Art. 20) — the JSON export is provided for exactly this.</li>
            <li><strong>Object</strong> (Art. 21) to processing based on our legitimate interests, on grounds relating to your particular situation.</li>
            <li><strong>Withdraw consent</strong> at any time, where processing is based on consent, without affecting the lawfulness of processing before withdrawal.</li>
        </ul>
        <p>
            To exercise any of these, write to ${contact}. We answer within one month
            (Art. 12(3) GDPR).
        </p>
        <p>
            You also have the right to <strong>lodge a complaint with a supervisory authority</strong>
            (Art. 77 GDPR) — in particular in the EU or EEA member state of your habitual
            residence, your place of work, or the place of the alleged infringement.
        </p>
        ${supervisoryAuthority()}

        <h2>8. Do you have to provide this data?</h2>
        <p>
            Providing an email address and a password is necessary to create an account; without
            them we cannot provide the service. Everything else you enter — notes, projects,
            rates, letterhead details — is entirely optional and up to you. There is no
            statutory obligation on you to provide any of it.
        </p>

        <h2>9. Security</h2>
        <p>
            Passwords are stored using the Argon2 key-derivation function and are never
            recoverable in plaintext. Two-factor authentication is mandatory. Sensitive database
            columns are encrypted at rest. All traffic is served over HTTPS. Sessions can be
            listed and revoked individually, and reuse of a rotated session token is treated as
            theft and terminates the session.
        </p>
        <p>
            No system is perfectly secure. Should a personal data breach occur that is likely to
            result in a risk to your rights and freedoms, we will notify the competent
            supervisory authority within 72 hours and, where the risk is high, inform you
            directly (Art. 33/34 GDPR).
        </p>

        <h2>10. Self-hosted installations</h2>
        <p>
            ${esc(LEGAL.siteName)} is open-source software that anyone may run on their own
            server. This policy covers only the instance at ${esc(LEGAL.siteDomain)}. If you use
            an installation operated by someone else — your employer, for instance — that
            operator is the controller for your data and their own privacy notice applies.
        </p>

        <h2>11. Changes to this policy</h2>
        <p>
            We may update this policy as the service changes or the law does. The date at the
            bottom of this page always reflects the current version, and we will notify
            registered users by email before any change that materially affects them.
        </p>
    `);
}

// ── Terms of service ─────────────────────────────────────────────────

/**
 * The liability clause, which is the one part of the Terms that genuinely turns
 * on national law. Both Austria and Germany forbid excluding liability for
 * personal injury and for intent/gross negligence towards consumers; both allow
 * excluding slight negligence, Austria under § 6 Abs 1 Z 9 KSchG and Germany via
 * the reduced standard § 521 BGB sets for gratuitous provision.
 */
function liabilityClause(): string {
    const mandatory = LEGAL.jurisdiction === "at"
        ? `<li>
               We are liable <strong>without limitation</strong> for damages arising from injury
               to life, body or health, and for damage caused intentionally or by gross
               negligence. Any attempt to exclude these towards a consumer would be void under
               § 6 Abs 1 Z 9 of the Austrian Consumer Protection Act (KSchG), and nothing below
               is intended to. Liability under the Austrian Product Liability Act
               (Produkthaftungsgesetz) is likewise unaffected.
           </li>`
        : LEGAL.jurisdiction === "de"
        ? `<li>
               We are liable <strong>without limitation</strong> for damages arising from injury
               to life, body or health; for damage caused intentionally or by gross negligence;
               for fraudulently concealed defects; and under the German Product Liability Act
               (Produkthaftungsgesetz). None of this is excluded or limited by anything below.
           </li>`
        : `<li>
               We are liable <strong>without limitation</strong> for damages arising from injury
               to life, body or health and for damage caused intentionally or by gross
               negligence, and for anything else that mandatory law does not permit us to
               exclude. Nothing below limits that.
           </li>`;

    const basis = LEGAL.jurisdiction === "at"
        ? `Because ${esc(LEGAL.siteName)} is supplied to you at no charge, and in line with the
           reduced standard Austrian law applies to gratuitous performance, our liability is
           limited as follows:`
        : LEGAL.jurisdiction === "de"
        ? `Because ${esc(LEGAL.siteName)} is supplied to you at no charge, our liability is
           limited in accordance with the principles of § 521 of the German Civil Code (BGB),
           applied to the gratuitous provision of this service. Specifically:`
        : `Because ${esc(LEGAL.siteName)} is supplied to you at no charge, our liability is
           limited as far as applicable law permits for a service provided free of charge:`;

    return `
        <h2>7. Liability</h2>
        <p>${basis}</p>
        <ul>
            ${mandatory}
            <li>
                Beyond those cases, we are <strong>liable only for intent and gross
                negligence</strong>. Liability for slight negligence is excluded.
            </li>
            <li>
                Where we are liable, liability for loss of data is limited to the effort that
                would have been required to restore that data had you kept backups in a manner
                appropriate to its importance (see section 4).
            </li>
        </ul>
        <p>
            Any statutory liability under data protection law, in particular Art. 82 GDPR,
            remains unaffected by this section.
        </p>`;
}

function governingLaw(): string {
    const country = esc(LEGAL.jurisdictionName || LEGAL.country);
    return `
        <h2>10. Final provisions</h2>
        <p>
            These terms are governed by the law of ${country}, excluding its conflict-of-law
            rules and the UN Convention on Contracts for the International Sale of Goods. If you
            are a consumer habitually resident in the EU or EEA, this choice of law does not
            deprive you of the protection of mandatory provisions of the law of your country of
            residence, and you may bring proceedings in the courts of that country.
        </p>
        <p>
            Should any provision of these terms be or become invalid, the validity of the
            remaining provisions is unaffected.
        </p>`;
}

export function renderTerms(app: HTMLElement): void {
    const contact = contactLink();

    app.innerHTML = layout("Terms of Service", `
        <p class="legal-lede">
            These terms govern your use of the ${esc(LEGAL.siteName)} service at
            ${esc(LEGAL.siteDomain)}, operated by ${esc(LEGAL.operatorName)}. By creating an
            account you agree to them.
        </p>

        <h2>1. What this service is</h2>
        <p>
            ${esc(LEGAL.siteName)} is a work-time tracking application with an optional
            server component that syncs your data between your devices. It is provided
            <strong>free of charge</strong>, as a personal, non-commercial project. There is no
            fee, no subscription, and correspondingly no paid support and no service level
            agreement.
        </p>
        <p>
            The underlying software is open source under the MIT licence. These terms govern the
            <em>hosted service</em> only; your use of the source code is governed by that licence.
        </p>

        <h2>2. Your account</h2>
        <ul>
            <li>You must be at least 16 years old, or have the consent of a parent or guardian.</li>
            <li>Provide an email address you actually control, and keep it current — it is how we reach you about security matters.</li>
            <li>
                You are responsible for your password, your two-factor device and your recovery
                codes. We cannot recover an account for which both the authenticator and every
                recovery code have been lost; this is a consequence of the encryption that
                protects your data, not an oversight.
            </li>
            <li>Do not share your account, and tell us promptly if you believe it has been compromised.</li>
        </ul>

        <h2>3. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
            <li>break the law, or infringe anyone's rights, using the service;</li>
            <li>attempt to gain unauthorised access to the service, other accounts, or the underlying infrastructure;</li>
            <li>disrupt or overload the service, including by automated request volumes beyond ordinary use of the app and its API;</li>
            <li>upload malware, or use the service to store or distribute unlawful content;</li>
            <li>resell or offer the hosted service commercially to third parties. (Running your own instance from the source code is expressly welcome.)</li>
        </ul>
        <p>
            Legitimate security research is welcome — please report findings to ${contact}
            rather than exploiting them, and give us reasonable time to fix an issue before
            disclosing it.
        </p>

        <h2>4. Your data, and your backups</h2>
        <p>
            Your data remains yours. We claim no ownership of and no licence to it beyond what is
            technically necessary to store, sync and display it back to you.
        </p>
        <p>
            <strong>Keep your own backups.</strong> The dashboard provides a full export at any
            time, and the desktop application keeps a local copy of your data. Because the
            service is free, we do not warrant that data will never be lost, and you should not
            rely on it as your only copy of records you cannot afford to lose — for example
            records you need for invoicing, payroll or a tax authority.
        </p>

        <h2>5. Availability and changes</h2>
        <p>
            We aim to keep the service running and will give reasonable notice of planned
            downtime where we can, but the service is provided on an "as available" basis and may
            be interrupted for maintenance, technical failure or reasons outside our control.
        </p>
        <p>
            We may change, restrict or discontinue features, or discontinue the hosted service
            entirely. If we discontinue it, we will give registered users at least 30 days'
            notice by email so you can export your data — and the software will remain available
            for you to self-host.
        </p>

        <h2>6. Warranty</h2>
        <p>
            The service is provided free of charge and without warranty as to quality, fitness
            for a particular purpose, uninterrupted availability, or freedom from defects, to
            the extent permitted by law. Statutory rights that cannot be excluded — in
            particular in cases of fraudulent concealment of a defect — remain unaffected.
        </p>

        ${liabilityClause()}

        <h2>8. Ending the agreement</h2>
        <p>
            You may stop using the service and delete your account at any time, from the
            dashboard, without giving reasons. Deletion is immediate and irreversible — export
            your data first if you want to keep it.
        </p>
        <p>
            We may suspend or terminate an account that materially breaches these terms, that is
            used unlawfully, or that endangers the service or other users. Except where a
            serious breach makes it unreasonable, we will warn you first and give you an
            opportunity to remedy the problem. Your right to export your data before deletion
            remains, unless a legal obligation prevents it.
        </p>

        <h2>9. Changes to these terms</h2>
        <p>
            We may amend these terms where necessary — for legal reasons, or to reflect changes
            to the service. Amended terms are published on this page, and registered users are
            shown a notice in the app itself.
        </p>
        <p>
            A material change takes effect for you the next time you use the service after that
            notice has been shown to you. It is never applied retroactively, and until you have
            been notified the version you accepted continues to govern your use. If you do not
            agree, do not continue: you can export your data and delete your account at any
            time, from the dashboard, without giving reasons.
        </p>

        ${governingLaw()}
        <p>Questions about these terms: ${contact}.</p>
    `);
}
