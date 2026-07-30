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
    python -m verification_harness --all --sync                    # full sweep, pages fetched first
    python -m verification_harness --version 2025-2026-undergraduate
    python -m verification_harness --all --checks A4,E4            # one class, iterating

``--sync`` populates the page cache from GCS through :mod:`verification_harness.fetch` before the
run. It is incremental (already-cached pages are skipped), so it is cheap to leave on. Without it,
the cache must already exist or the run raises rather than auditing nothing.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Importing the check modules registers their checks as a side effect.
from . import config, db, fetch
from .checks import (  # noqa: F401
    coverage,
    fidelity,
    headings,
    integrity,
    provenance,
    registry,
)
from .extract.ast_extractor import extract_facts
from .models import Finding, PageFacts
from .report import run_history, sqlite_loader

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


@dataclass(frozen=True)
class VersionRun:
    """One catalog version's sweep result.

    Attributes:
        version: The catalog key that was run.
        findings: Every finding the selected checks produced.
        corpus: Input counts (``pages``/``courses``/``programs``/``chunks``) for the ``X5``
            run-over-run diff — an unexplained change in these is itself a finding (§3).
    """

    version: str
    findings: list[Finding]
    corpus: dict[str, int]


def run_version(
    version: str,
    pages_dir: Path,
    checks: list[str] | None = None,
) -> VersionRun:
    """Run the selected checks for one catalog version.

    Each stage is timed and logged, so "the sweep is slow" is always answerable with a number
    rather than a guess.

    Args:
        version: Full catalog key.
        pages_dir: Root of the page cache.
        checks: Restrict to these check ids; ``None`` runs every registered check.

    Returns:
        The version's findings alongside the corpus counts they were derived from.
    """
    started = time.time()
    pages, page_texts = load_pages(version, pages_dir)
    t_extract = time.time() - started

    mark = time.time()
    db_facts = db.db_facts_for_version(version)
    t_db = time.time() - mark

    mark = time.time()
    ctx = registry.CheckContext(
        version=version, db=db_facts, pages=pages, page_texts=page_texts
    )
    findings = list(registry.run(ctx, checks))
    t_checks = time.time() - mark

    logger.info(
        "%s: %d pages, %d chunks, %d findings (extract %.1fs, db %.1fs, checks %.1fs)",
        version,
        len(pages),
        len(db_facts.chunks),
        len(findings),
        t_extract,
        t_db,
        t_checks,
    )
    return VersionRun(
        version=version,
        findings=findings,
        corpus={
            "pages": len(pages),
            "courses": len(db_facts.courses),
            "programs": len(db_facts.programs),
            "chunks": len(db_facts.chunks),
        },
    )


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
    parser.add_argument(
        "--sync",
        action="store_true",
        help="fetch the source pages from GCS into the page cache first (incremental)",
    )
    parser.add_argument(
        "--checks",
        help="comma-separated check ids to run (default: all), e.g. --checks A4,E4",
    )
    parser.add_argument("--pages-dir", type=Path, default=config.PAGE_CACHE_DIR)
    parser.add_argument("--out", type=Path, default=config.FINDINGS_JSONL)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    _load_env_local()

    checks: list[str] | None = None
    if args.checks:
        checks = [c.strip() for c in args.checks.split(",") if c.strip()]
        unknown = [c for c in checks if c not in registry.REGISTRY]
        if unknown:
            parser.error(
                f"unknown check id(s): {', '.join(unknown)}. "
                f"Registered: {', '.join(sorted(registry.REGISTRY))}"
            )

    versions = db.list_versions() if args.all else args.version
    if args.sync:
        fetch.sync_versions(versions, args.pages_dir)

    started = time.time()
    runs = [run_version(version, args.pages_dir, checks) for version in versions]
    all_findings: list[Finding] = [f for run in runs for f in run.findings]

    written = registry.write_findings(all_findings, args.out)
    loaded = sqlite_loader.load(args.out, config.FINDINGS_SQLITE)
    summary = sqlite_loader.summarize(config.FINDINGS_SQLITE)

    print(f"\nran {len(versions)} catalog(s) in {time.time() - started:.1f}s")
    for run in runs:
        print(f"  {run.version:28} {len(run.findings):>6} findings")
    print(f"\nwrote {written} findings -> {args.out}")
    print(f"loaded {loaded} into {config.FINDINGS_SQLITE.name}")
    print("by severity:", summary["by_severity"])
    print("by check:", summary["by_check"])

    _report_x5(runs, summary, partial=bool(checks) or not args.all)
    return 0


def _report_x5(
    runs: list[VersionRun],
    summary: dict[str, dict[str, int]],
    *,
    partial: bool,
) -> None:
    """Record this sweep and print the ``X5`` diff against the previous comparable one.

    Args:
        runs: This sweep's per-version results.
        summary: The triage-index summary.
        partial: True when the run was restricted (``--checks`` or a version subset), in which case
            it is *not* recorded — diffing a partial run against a full sweep would manufacture a
            spurious X5 on every check that simply did not run.
    """
    if partial:
        print("\nX5: partial run (subset of versions or checks) — not recorded in run history")
        return

    _, changes = run_history.record_and_diff(
        corpus={run.version: run.corpus for run in runs},
        findings_by_version={run.version: len(run.findings) for run in runs},
        summary=summary,
    )
    if not changes:
        print("\nX5: no change vs the previous run (or this is the first recorded run)")
        return
    print(f"\nX5: {len(changes)} count(s) changed vs the previous run — explain each or treat as a finding:")
    for line in changes:
        print(line)


if __name__ == "__main__":
    sys.exit(main())
