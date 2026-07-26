"""Pipeline entry point: source pages + database → findings.

Runs the whole deterministic pass for one or more catalog versions:

1. read each ``page_NNNN.md`` from the local page cache,
2. extract Tier 0 ``PageFacts`` (Gemini's ``ast_extractor``),
3. fetch version-scoped, read-only ``DbFacts`` (``db.py``),
4. run every registered check (A–E) with both facts + raw page text,
5. write ``findings.jsonl`` and rebuild the ``findings.sqlite`` triage index.

Usage::

    conda activate sjfu-catalog
    export DATABASE_URL=...                        # read-only creds; never stored in source
    python -m verification_harness --version 2025-2026-undergraduate
    python -m verification_harness --all --pages-dir <dir>

The page cache is populated out-of-band (local ADC tokens expire mid-run, so streaming per-check is
avoided)::

    gcloud storage cp -r "gs://sjfu-assets/catalogs/SJFU/*" verification_harness/artifacts/page-cache/
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# Importing the check modules registers their checks as a side effect.
from . import config, db
from .checks import (  # noqa: F401
    coverage,
    fidelity,
    headings,
    integrity,
    provenance,
    registry,
)
from .extract.ast_extractor import extract_facts
from .models import PageFacts
from .report import sqlite_loader

logger = logging.getLogger(__name__)


def _load_env_local() -> None:
    """Load ``.env.local`` into the environment if present (dev convenience; no secrets in source).

    Mirrors the repo's ``.env.local`` format, which allows ``KEY=value  # inline comment``. Existing
    environment variables win, so an already-exported ``DATABASE_URL`` is never overwritten.
    """
    import os

    env_path = config.REPO_ROOT / ".env.local"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        hash_at = value.find(" #")
        if hash_at != -1:
            value = value[:hash_at]
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


def load_pages(version: str, pages_dir: Path) -> tuple[dict[int, PageFacts], dict[int, str]]:
    """Read and extract every page of a catalog version from the local cache.

    Args:
        version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.
        pages_dir: Root of the page cache (contains ``<version>/pages/page_NNNN.md``).

    Returns:
        ``(pages, page_texts)`` — ``PageFacts`` and raw markdown, both keyed by page number.

    Raises:
        FileNotFoundError: If the version's page directory is absent (guards a silent empty run).
    """
    version_dir = pages_dir / version / "pages"
    if not version_dir.is_dir():
        raise FileNotFoundError(
            f"no page cache for {version} at {version_dir}. Populate it with:\n"
            f'  gcloud storage cp -r "gs://{config.GCS_BUCKET}/{config.GCS_PAGES_PREFIX}/*" {pages_dir}/'
        )
    pages: dict[int, PageFacts] = {}
    page_texts: dict[int, str] = {}
    for md_file in sorted(version_dir.glob("page_*.md")):
        digits = "".join(c for c in md_file.stem if c.isdigit())
        if not digits:
            continue
        page_num = int(digits)
        text = md_file.read_text(encoding="utf-8")
        page_texts[page_num] = text
        pages[page_num] = extract_facts(text, version, page_num)
    return pages, page_texts


def run_version(version: str, pages_dir: Path) -> list:
    """Run all registered checks for one catalog version and return its findings.

    Args:
        version: Full catalog key.
        pages_dir: Root of the page cache.

    Returns:
        The findings produced for this version.
    """
    pages, page_texts = load_pages(version, pages_dir)
    ctx = registry.CheckContext(
        version=version,
        db=db.db_facts_for_version(version),
        pages=pages,
        page_texts=page_texts,
    )
    findings = list(registry.run(ctx))
    logger.info("%s: %d pages, %d findings", version, len(pages), len(findings))
    return findings


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, run the pipeline, and write findings + triage index.

    Args:
        argv: Argument list (defaults to ``sys.argv``).

    Returns:
        Process exit code (0 on success).
    """
    parser = argparse.ArgumentParser(prog="verification_harness", description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--version", action="append", help="catalog version (repeatable)")
    group.add_argument("--all", action="store_true", help="run every version in the database")
    parser.add_argument("--pages-dir", type=Path, default=config.PAGE_CACHE_DIR)
    parser.add_argument("--out", type=Path, default=config.FINDINGS_JSONL)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    _load_env_local()

    versions = db.list_versions() if args.all else args.version
    all_findings: list = []
    for version in versions:
        all_findings.extend(run_version(version, args.pages_dir))

    written = registry.write_findings(all_findings, args.out)
    loaded = sqlite_loader.load(args.out, config.FINDINGS_SQLITE)
    summary = sqlite_loader.summarize(config.FINDINGS_SQLITE)
    print(f"\nwrote {written} findings -> {args.out}")
    print(f"loaded {loaded} into {config.FINDINGS_SQLITE.name}")
    print("by severity:", summary["by_severity"])
    print("by check:", summary["by_check"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
