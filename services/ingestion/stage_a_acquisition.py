"""Stage A Acquisition module for self-serve ingestion.

Fetches raw catalog assets (PDF/HTML) or structures per-page markdown files into
the standard GCS/cache hierarchy:
    catalogs/SJFU/<version>/pages/page_NNNN.md

Adheres to docs/SELF_SERVE_INGESTION.md §2.
"""

from __future__ import annotations

import pathlib


def acquire_catalog_pages(
    version: str,
    source_dir_or_file: str | pathlib.Path,
    output_dir: str | pathlib.Path,
) -> list[tuple[int, str, str]]:
    """Acquire and structure catalog source content into per-page markdown files.

    Args:
        version: Catalog version string (e.g., '2025-2026-undergraduate').
        source_dir_or_file: Path to source PDF, markdown file, or directory of pages.
        output_dir: Destination directory for page_NNNN.md files.

    Returns:
        List of (page_number, page_markdown_text, page_url) tuples.
    """
    src_path = pathlib.Path(source_dir_or_file)
    out_path = pathlib.Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    pages: list[tuple[int, str, str]] = []

    if src_path.is_dir():
        md_files = sorted(src_path.glob("page_*.md"))
        if not md_files:
            md_files = sorted(src_path.glob("*.md"))

        for idx, file_path in enumerate(md_files, start=1):
            content = file_path.read_text(encoding="utf-8")
            page_filename = f"page_{idx:04d}.md"
            dest_file = out_path / page_filename
            dest_file.write_text(content, encoding="utf-8")
            
            page_url = f"gs://sjfu-assets/catalogs/SJFU/{version}/pages/{page_filename}"
            pages.append((idx, content, page_url))
    elif src_path.is_file():
        # Single text/markdown file — partition into 100-line virtual pages
        content = src_path.read_text(encoding="utf-8")
        lines = content.splitlines()
        chunk_size = 100
        
        for idx, start in enumerate(range(0, len(lines), chunk_size), start=1):
            page_text = "\n".join(lines[start : start + chunk_size])
            page_filename = f"page_{idx:04d}.md"
            dest_file = out_path / page_filename
            dest_file.write_text(page_text, encoding="utf-8")
            
            page_url = f"gs://sjfu-assets/catalogs/SJFU/{version}/pages/{page_filename}"
            pages.append((idx, page_text, page_url))

    return pages
