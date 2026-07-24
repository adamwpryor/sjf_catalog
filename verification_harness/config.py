"""Shared configuration for the catalog verification harness.

Paths, catalog-version reference data, and run gates. Contains **no secrets** — the
database URL is read from the environment at runtime (see :mod:`verification_harness.db`),
never stored here (``DEVELOPER_GUIDELINES.md`` §2, Zero-Trust).

All derived outputs live under :data:`ARTIFACTS_DIR`, which is git-ignored; nothing this
module points at (other than the checked-in fixtures) should ever be committed.
"""

from __future__ import annotations

from pathlib import Path

# --- Package + artifact locations -------------------------------------------------

PACKAGE_ROOT: Path = Path(__file__).resolve().parent
REPO_ROOT: Path = PACKAGE_ROOT.parent

#: All derived outputs (git-ignored). See ``artifacts/.gitignore``.
ARTIFACTS_DIR: Path = PACKAGE_ROOT / "artifacts"

#: gcloud-synced source ``.md`` pages: ``page-cache/<version>/pages/page_NNNN.md``.
PAGE_CACHE_DIR: Path = ARTIFACTS_DIR / "page-cache"

#: Tier 0 output, one JSON file per page: ``extracted_facts/<version>/page_NNNN.json``.
EXTRACTED_FACTS_DIR: Path = ARTIFACTS_DIR / "extracted_facts"

#: Append-only interchange format written by every tier.
FINDINGS_JSONL: Path = ARTIFACTS_DIR / "findings.jsonl"

#: Derived triage index rebuilt from :data:`FINDINGS_JSONL`.
FINDINGS_SQLITE: Path = ARTIFACTS_DIR / "findings.sqlite"

#: Human-readable report.
REPORT_MD: Path = ARTIFACTS_DIR / "report.md"

#: Checked-in golden oracle for the extractor (cross-authored per Design Principle P1).
FIXTURES_DIR: Path = PACKAGE_ROOT / "tests" / "fixtures"

# --- Source-of-truth locations ----------------------------------------------------

#: Bucket holding the ground-truth pages. Full path:
#: ``gs://{GCS_BUCKET}/{GCS_PAGES_PREFIX}/<version>/pages/page_NNNN.md``.
GCS_BUCKET: str = "sjfu-assets"
GCS_PAGES_PREFIX: str = "catalogs/SJFU"

#: Name of the environment variable holding the read-only Postgres URL. The *value*
#: is never stored in source — it is read at runtime from the process environment.
DB_URL_ENV_VAR: str = "DATABASE_URL"

# --- Catalog reference data -------------------------------------------------------

#: Reference expectation only. Runtime truth is ``SELECT DISTINCT version FROM documents``
#: (``DOUBLE_CHECK.md`` §3); a mismatch between this list and the DB is itself finding ``X5``.
EXPECTED_VERSIONS: tuple[str, ...] = (
    "2022-2023-undergraduate",
    "2022-2023-graduate",
    "2023-2024-undergraduate",
    "2023-2024-graduate",
    "2024-2025-undergraduate",
    "2024-2025-graduate",
    "2025-2026-undergraduate",
    "2025-2026-graduate",
)

# --- Run gates --------------------------------------------------------------------

#: Phase 1 gate (``DOUBLE_CHECK.md`` §12): hand-triaged false-positive rate must be below
#: this before the deterministic sweep is scaled to all eight catalogs.
FALSE_POSITIVE_GATE: float = 0.20


def version_pages_dir(version: str) -> Path:
    """Return the local page-cache directory for a catalog version.

    Args:
        version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.

    Returns:
        Path to ``artifacts/page-cache/<version>/pages``.
    """
    return PAGE_CACHE_DIR / version / "pages"


def version_facts_dir(version: str) -> Path:
    """Return the Tier 0 extracted-facts directory for a catalog version.

    Args:
        version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.

    Returns:
        Path to ``artifacts/extracted_facts/<version>``.
    """
    return EXTRACTED_FACTS_DIR / version
