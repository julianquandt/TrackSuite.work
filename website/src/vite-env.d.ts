/// <reference types="vite/client" />

/**
 * Build-time configuration read via `import.meta.env`. See `config.ts` (which
 * surfaces exist) and `legal-config.ts` (whose operator details are published),
 * and `website/.env.example` for the values a self-hoster sets.
 */
interface ImportMetaEnv {
    readonly VITE_SITE_PROFILE?: string;
    readonly VITE_REPO_SLUG?: string;
    readonly VITE_LEGAL_NAME?: string;
    readonly VITE_LEGAL_STREET?: string;
    readonly VITE_LEGAL_CITY?: string;
    readonly VITE_LEGAL_COUNTRY?: string;
    readonly VITE_LEGAL_EMAIL?: string;
    readonly VITE_LEGAL_PHONE?: string;
    readonly VITE_LEGAL_VAT_ID?: string;
    readonly VITE_LEGAL_HOSTING?: string;
    readonly VITE_LEGAL_EMAIL_PROVIDER?: string;
    readonly VITE_LEGAL_EFFECTIVE_DATE?: string;
    readonly VITE_LEGAL_SITE_NAME?: string;
    readonly VITE_LEGAL_SITE_DOMAIN?: string;
    readonly VITE_LEGAL_JURISDICTION?: string;
    readonly VITE_LEGAL_JURISDICTION_NAME?: string;
    readonly VITE_LEGAL_BUSINESS_PURPOSE?: string;
    readonly VITE_LEGAL_SMALL_WEBSITE?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
