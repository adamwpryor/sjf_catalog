/**
 * Institution brand + identity module (the single theme layer, BUILD_PLAN §P4).
 *
 * DERIVED ARTIFACT — the source of truth is `institution.config.yaml` at the repo
 * root. `create-spoke --phase app` regenerates this file from that config when a
 * new spoke is stood up. It is committed (non-secret values only) so it can be
 * imported by both server and client components without filesystem/YAML access
 * at runtime (a client bundle cannot read the YAML directly).
 *
 * When editing branding for THIS spoke, change `institution.config.yaml` and
 * re-run the generator; do not hand-edit divergent literals back into components.
 */

/** Canonical tenant id — matches hub rows and drives every `tenant_id` filter. */
export const TENANT_ID = 'SJFU' as const;

/** Institution identity (from institution.config.yaml → institution). */
export const INSTITUTION = {
  tenantId: TENANT_ID,
  legalName: 'St. John Fisher University',
  shortName: 'Fisher',
  appTitle: 'Fisher Catalog',
  emailDomain: 'sjf.edu',
} as const;

/** Feature flags (from institution.config.yaml → institution/swarm). */
export const FEATURES = {
  /** Accreditation schema + UI are omitted for this spoke (BUILD_PLAN §3 delta #2). */
  accreditation: false,
  assistant: true,
  productionAgent: true,
  remediation: true,
} as const;

/**
 * Default GCS asset bucket (from institution.config.yaml → deploy.gcs_bucket).
 * Server code should prefer `process.env.GCP_BUCKET_NAME` and fall back to this.
 */
export const GCS_BUCKET = 'sjfu-assets' as const;

/** Brand tokens (from institution.config.yaml → brand). */
export const BRAND = {
  colors: {
    primary: '#993333', // Cardinal Red (official, PMS 201 C) → --color-brand-crimson
    primaryDark: '#7a2929', // → --color-brand-crimson-dark
    secondary: '#FFCC33', // Gold (official, PMS 116 C) → --color-brand-gold
    secondaryDark: '#E6B800', // → --color-brand-gold-dark
    accent: '#FFCC33',
    bg: '#FFFFFF',
    surface: '#F7F5F2',
    ink: '#1A1A1A',
  },
  typography: {
    serif: "'Book Antiqua', 'Palatino Linotype', Palatino, Georgia, serif",
    sans: "'Libre Franklin', 'Franklin Gothic', Arial, sans-serif",
    mono: "ui-monospace, 'Cascadia Code', Menlo, monospace",
  },
} as const;
