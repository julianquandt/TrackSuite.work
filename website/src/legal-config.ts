/**
 * Operator details behind the Impressum / Privacy Policy / Terms pages.
 *
 * Everything is overridable at build time so a self-hosted instance publishes
 * *its own* operator's details, never tracksuite.work's. The defaults below
 * apply only to tracksuite.work's own build; anywhere else, no `VITE_LEGAL_NAME`
 * means no legal pages and no footer links at all — the right answer for an
 * internal company instance covered by the company's existing privacy notice.
 *
 * Set them in `website/.env.local` (untracked, survives `git checkout` during a
 * deploy) or export them before `npm run build`. See `website/.env.example`.
 */

import { APP_ONLY } from "./config";

function env(key: string): string {
    return (import.meta.env[key] as string | undefined)?.trim() ?? "";
}

/** Fall back to the tracksuite.work value only on the public build. */
function fallback(key: string, publicDefault: string): string {
    return env(key) || (APP_ONLY ? "" : publicDefault);
}

/** Which country's disclosure and consumer-protection rules the pages follow. */
export type Jurisdiction = "at" | "de" | "other";

/**
 * How much the imprint has to disclose.
 *
 * `small` is Austria's reduced disclosure under § 25 Abs 5 MedienG, available to
 * a "kleine Website" — one that presents only the operator's own personal or
 * business life and has no influence on public opinion. It needs the operator's
 * name, their *place of residence or seat* (city — not a street address) and the
 * business purpose. See `.env.example` for when this is and isn't defensible.
 *
 * `full` additionally publishes the geographic address § 5 ECG (AT) / § 5 DDG
 * (DE) demands of a commercial provider.
 */
export type DisclosureLevel = "small" | "full";

export interface LegalConfig {
    /** Legal name of the natural or legal person operating the service. */
    operatorName: string;
    /** Street + number. Required at `full` disclosure; a PO box never suffices. */
    street: string;
    /** Postal code + city at `full`, or just the city at `small`. */
    city: string;
    country: string;
    /** A monitored mailbox. Always required. */
    contactEmail: string;
    /** Optional; only include one you are willing to publish. */
    phone: string;
    /** UID / USt-IdNr., if you have one. Omit if not VAT-registered. */
    vatId: string;
    /** "Unternehmensgegenstand" — required for Austria's reduced disclosure. */
    businessPurpose: string;
    /** Named for transparency; "categories of recipients" would also satisfy Art. 13. */
    hostingProvider: string;
    /** Transactional email processor, empty on instances that send no email. */
    emailProvider: string;
    /** Last-updated stamp shown on the legal pages. */
    effectiveDate: string;
    siteName: string;
    siteDomain: string;
    jurisdiction: Jurisdiction;
    /** Display name of the governing-law country, e.g. "Austria". */
    jurisdictionName: string;
    disclosure: DisclosureLevel;
}

function parseJurisdiction(): Jurisdiction {
    const raw = fallback("VITE_LEGAL_JURISDICTION", "at").toLowerCase();
    if (raw === "at" || raw === "austria" || raw === "österreich") return "at";
    if (raw === "de" || raw === "germany" || raw === "deutschland") return "de";
    return "other";
}

const JURISDICTION_NAMES: Record<Jurisdiction, string> = {
    at: "Austria",
    de: "Germany",
    other: "",
};

const jurisdiction = parseJurisdiction();

export const LEGAL: LegalConfig = {
    operatorName: fallback("VITE_LEGAL_NAME", "Julian Quandt"),
    street: env("VITE_LEGAL_STREET"),
    city: env("VITE_LEGAL_CITY"),
    country: fallback("VITE_LEGAL_COUNTRY", "Austria"),
    contactEmail: fallback("VITE_LEGAL_EMAIL", "contact@tracksuite.work"),
    phone: env("VITE_LEGAL_PHONE"),
    vatId: env("VITE_LEGAL_VAT_ID"),
    businessPurpose: fallback(
        "VITE_LEGAL_BUSINESS_PURPOSE",
        "Non-commercial operation of open-source work-time tracking software",
    ),
    hostingProvider: env("VITE_LEGAL_HOSTING"),
    emailProvider: fallback("VITE_LEGAL_EMAIL_PROVIDER", "Resend, Inc. (USA)"),
    // Keep in step with WORK_TIME_TOS_VERSION on the backend, which stamps the
    // version each account accepted at registration.
    effectiveDate: fallback("VITE_LEGAL_EFFECTIVE_DATE", "2026-07-27"),
    siteName: fallback("VITE_LEGAL_SITE_NAME", "TrackSuite.work"),
    siteDomain: fallback("VITE_LEGAL_SITE_DOMAIN", "tracksuite.work"),
    jurisdiction,
    jurisdictionName:
        env("VITE_LEGAL_JURISDICTION_NAME")
        || JURISDICTION_NAMES[jurisdiction]
        || fallback("VITE_LEGAL_JURISDICTION", "Austria"),
    // The reduced disclosure only exists in Austrian media law; asking for it
    // anywhere else silently gets you the full one rather than a wrong page.
    disclosure:
        env("VITE_LEGAL_SMALL_WEBSITE") === "1" && jurisdiction === "at"
            ? "small"
            : "full",
};

/** Whether to publish legal pages and link them from the footer. */
export const LEGAL_ENABLED = Boolean(LEGAL.operatorName);

/**
 * Legally mandatory fields that are still unset. Rendered as a visible warning
 * on the page itself — an imprint missing an address is worse than obviously
 * broken, because it looks complete until someone challenges it.
 */
export function missingLegalFields(): string[] {
    const missing: string[] = [];
    if (!LEGAL.operatorName) missing.push("VITE_LEGAL_NAME (full legal name)");
    if (LEGAL.disclosure === "full" && !LEGAL.street) {
        missing.push("VITE_LEGAL_STREET (street and number)");
    }
    if (!LEGAL.city) {
        missing.push(LEGAL.disclosure === "small"
            ? "VITE_LEGAL_CITY (place of residence — the city is enough)"
            : "VITE_LEGAL_CITY (postal code and city)");
    }
    if (LEGAL.disclosure === "small" && !LEGAL.businessPurpose) {
        missing.push("VITE_LEGAL_BUSINESS_PURPOSE (Unternehmensgegenstand)");
    }
    if (!LEGAL.contactEmail) missing.push("VITE_LEGAL_EMAIL (a monitored mailbox)");
    if (LEGAL.jurisdiction === "other" && !LEGAL.jurisdictionName) {
        missing.push("VITE_LEGAL_JURISDICTION_NAME (country whose law governs)");
    }
    return missing;
}
