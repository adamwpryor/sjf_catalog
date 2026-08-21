#!/usr/bin/env python
"""
Self-Serve Ingestion CLI Utility for St. John Fisher University Catalog Platform.

Runs Stage A (acquisition: source -> markdown pages) and Stage B (extraction & load:
markdown -> 7 contract tables + 23-table census report).

Usage:
    python scripts/ingest_self_serve.py --version 2025-2026-undergraduate --dry-run
    python scripts/ingest_self_serve.py --version 2025-2026-undergraduate --tier2-estimate
    python scripts/ingest_self_serve.py --version 2025-2026-undergraduate --apply
    python scripts/ingest_self_serve.py --census
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys
import uuid

# Ensure root path is accessible for imports
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.resolve()))

import re

from services.ingestion.chunker import chunk_markdown_page
from services.ingestion.extractor import extract_catalog_from_pages
from services.ingestion.loader import SelfServeLoader
from services.ingestion.provider import SelfServeInferenceProvider
from services.ingestion.stage_a_acquisition import acquire_catalog_pages
from verification_harness import config
from verification_harness.fetch import sync_version


def main() -> None:
    parser = argparse.ArgumentParser(description="St. John Fisher University Self-Serve Catalog Ingestion")
    parser.add_argument("--version", default="2025-2026-undergraduate", help="Catalog version key")
    parser.add_argument("--source", help="Source directory or file for Stage A acquisition")
    parser.add_argument("--stage-a", action="store_true", help="Run Stage A source acquisition")
    parser.add_argument("--stage-b", action="store_true", help="Run Stage B extraction and load")
    # A dry run is the default. --dry-run is kept as an explicit no-op so the documented
    # command reads clearly; it must NOT default to True, or --apply can never take effect.
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing (the default)")
    parser.add_argument("--apply", action="store_true", help="Execute live database writes")
    parser.add_argument("--tier2-estimate", action="store_true", help="Estimate LLM costs before execution")
    parser.add_argument("--census", action="store_true", help="Print complete 23-table database census")

    args = parser.parse_args()

    loader = SelfServeLoader()

    if args.census:
        print("=== Full 23-Table Database Census Report ===")
        census = loader.generate_full_census_report()
        for table, info in census.items():
            print(f"  {table:<30} Count: {info['count']:<8} Status: {info['status']}")
        return

    apply_db = args.apply and not args.dry_run  # explicit --dry-run still wins over --apply
    mode = "estimate" if args.tier2_estimate else "live"

    provider = SelfServeInferenceProvider(mode=mode, budget_usd=25.0)

    print(f"--- Starting Self-Serve Ingestion Pipeline [Version: {args.version}] ---")
    print(f"Mode: {'APPLY (Live DB)' if apply_db else 'DRY RUN (Preview)'}")

    # Stage A
    pages_data: list[tuple[int, str, str]] = []
    if args.stage_a and args.source:
        out_dir = pathlib.Path("artifacts/scratch/catalogs") / args.version / "pages"
        pages_data = acquire_catalog_pages(args.version, args.source, out_dir)
        print(f"Stage A Complete: Acquired {len(pages_data)} markdown pages.")
    else:
        # Load from harness fetch cache if present
        page_dir = config.PAGE_CACHE_DIR / args.version / "pages"
        if not page_dir.exists() or not list(page_dir.glob("page_*.md")):
            try:
                sync_version(args.version)
            except Exception as e:  # noqa: BLE001 - any fetch failure falls back to the cache
                print(f"Notice: Harness page fetch unavailable ({e}). Using sample synthetic page set.")

        if page_dir.exists() and list(page_dir.glob("page_*.md")):
            md_files = sorted(page_dir.glob("page_*.md"))
            for file_path in md_files:
                match = re.search(r"page_(\d+)\.md", file_path.name)
                p_num = int(match.group(1)) if match else 1
                content = file_path.read_text(encoding="utf-8")
                p_url = f"gs://sjfu-assets/catalogs/SJFU/{args.version}/pages/{file_path.name}"
                pages_data.append((p_num, content, p_url))
            print(f"Loaded {len(pages_data)} pages from page cache ({page_dir}).")
        else:
            sample_md = """# Department of Physics

## Physics B.S.
The Bachelor of Science in Physics provides rigorous foundation in classical and quantum physics.

### Requirements
- PHYS 101 General Physics I (4)
- PHYS 102 General Physics II (4)

## PHYS 101 General Physics I (4)
Prerequisites: None. Fundamental kinematics, dynamics, and energy principles.

## PHYS 102 General Physics II (4)
Prerequisites: PHYS 101. Electricity, magnetism, and wave optics.
"""
            pages_data = [(1, sample_md, f"gs://sjfu-assets/catalogs/SJFU/{args.version}/pages/page_0001.md")]

    # Stage B
    document_id = str(uuid.uuid4())
    # documents columns are (id, domain_id, version, file_hash, ...) — there is no name,
    # tenant_id, file_path or page_count column on this table.
    corpus_hash = hashlib.sha256(
        "\n".join(content for _, content, _ in pages_data).encode("utf-8")
    ).hexdigest()
    document_row = {
        "id": document_id,
        "domain_id": "academic_catalog",
        "version": args.version,
        "file_hash": corpus_hash,
    }

    all_chunks = []
    chunk_idx = 0
    for p_num, content, p_url in pages_data:
        chunks = chunk_markdown_page(
            markdown_text=content,
            document_id=document_id,
            markdown_url=p_url,
            page_number=p_num,
            start_chunk_index=chunk_idx,
        )
        all_chunks.extend(chunks)
        chunk_idx += len(chunks)

    extracted = extract_catalog_from_pages(
        pages=pages_data,
        document_id=document_id,
        catalog_version=args.version,
        provider=provider,
    )

    # Load / Dry Run
    counts = loader.load_catalog_data(
        document_row=document_row,
        chunks=all_chunks,
        extracted=extracted,
        apply=apply_db,
    )

    print("\n=== Contract Table Row Counts ===")
    print(f"  documents                    : {counts.get('documents', 0)}")
    print(f"  semantic_chunks              : {counts.get('semantic_chunks', 0)}")
    print(f"  courses                      : {counts.get('courses', 0)}")
    print(f"  programs                     : {counts.get('programs', 0)}")
    print(f"  program_requirements         : {counts.get('program_requirements', 0)}")
    print(f"  program_requirement_courses  : {counts.get('program_requirement_courses', 0)} (LINK TABLE)")
    print(f"  course_prerequisite_links    : {counts.get('course_prerequisite_links', 0)} (LINK TABLE)")

    # Validate Link Table Non-Zero Invariant
    prc_count = counts.get("program_requirement_courses", 0)
    cpl_count = counts.get("course_prerequisite_links", 0)

    if cpl_count > 0:
        print(f"\n[PASS] course_prerequisite_links is non-zero ({cpl_count} edges parsed from "
              "'Pre-requisites:' lines on the source pages).")
    else:
        print("\n[FAIL] course_prerequisite_links is empty — the prerequisite graph would be lost.")

    if prc_count == 0:
        print("[NOT PRODUCED] program_requirement_courses is empty by design: this pipeline does "
              "not derive program requirements. Run scripts/backfill_program_requirements.mjs "
              "after loading to populate it from chunk breadcrumbs. Until that runs, the contract "
              "invariant in docs/DATA_CONTRACT.md is NOT satisfied and the catalog is incomplete.")

    if args.tier2_estimate:
        total_cost = provider.client.estimates.total_usd()
        print(f"\nEstimated LLM Spend: ${total_cost:.4f} USD")

    print("\n=== 23-Table Database Census ===")
    census = loader.generate_full_census_report()
    for table, info in census.items():
        print(f"  {table:<30} Count: {info['count']:<8} Status: {info['status']}")


if __name__ == "__main__":
    main()
