"""Database loader and 23-table census reporter for self-serve ingestion.

Performs FK-safe transactional inserts into Supabase PostgreSQL for contract tables:
    documents -> semantic_chunks -> courses -> programs -> program_requirements
    -> program_requirement_courses -> course_prerequisite_links

Emits a complete census report of ALL tables in TABLE_ORDER, explicitly naming
populated vs unpopulated tables per docs/SELF_SERVE_INGESTION.md §4.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
from typing import Any

import psycopg2
from psycopg2 import extras

# Topological order of tables from deploy_client_db.py
TABLE_ORDER = [
    "institutions",
    "chunk_types",
    "toulmin_roles",
    "deontic_modalities",
    "quinean_web_classifications",
    "degree_classifications",
    "subjects",
    "documents",
    "semantic_chunks",
    "courses",
    "programs",
    "program_requirements",
    "program_requirement_courses",
    "course_prerequisite_links",
    "course_prereq_blocks",
    "course_prereq_edges",
    "requirement_blocks",
    "block_courses",
    "ghost_log",
    "faculty",
    "program_faculty",
    "policy_mentions_courses",
    "policy_mentions_programs",
]
from .chunker import SemanticChunk
from .extractor import ExtractedCatalogData


def get_db_url() -> str:
    """Load DATABASE_URL from environment or local dotenv file."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    
    dotenv_local = pathlib.Path(__file__).parent.parent.parent / ".env.local"
    dotenv_main = pathlib.Path(__file__).parent.parent.parent / ".env"
    
    for path in (dotenv_local, dotenv_main):
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("DATABASE_URL="):
                        val = line.split("=", 1)[1].strip()
                        if "#" in val:
                            val = val.split("#", 1)[0].strip()
                        return val.strip('"').strip("'")
                        
    raise RuntimeError("DATABASE_URL environment variable is missing and could not be loaded from .env.local")


class SelfServeLoader:
    """Handles transactional loads into Supabase Postgres and census reporting."""

    def __init__(self, db_url: str | None = None, tenant_id: str = "SJFU") -> None:
        """Initialise the loader.

        Args:
            db_url: Postgres connection string. Defaults to the configured ``DATABASE_URL``.
            tenant_id: Tenant code stamped on every row; the catalog tables declare it NOT NULL.
        """
        self.db_url = db_url or get_db_url()
        self.tenant_id = tenant_id

    def get_connection(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(self.db_url)

    def load_catalog_data(
        self,
        document_row: dict[str, Any],
        chunks: list[SemanticChunk],
        extracted: ExtractedCatalogData,
        apply: bool = False,
    ) -> dict[str, int]:
        """Insert catalog records in FK-safe topological order.

        Args:
            document_row: Document metadata dict.
            chunks: List of SemanticChunk objects.
            extracted: ExtractedCatalogData containing 5 contract tables.
            apply: If True, commit changes to DB; if False, perform dry run.

        Returns:
            Dict mapping table names to inserted row counts.
        """
        counts: dict[str, int] = {}
        if not apply:
            counts["documents"] = 1
            counts["semantic_chunks"] = len(chunks)
            counts["courses"] = len(extracted.courses)
            counts["programs"] = len(extracted.programs)
            counts["program_requirements"] = len(extracted.program_requirements)
            counts["program_requirement_courses"] = len(extracted.program_requirement_courses)
            counts["course_prerequisite_links"] = len(extracted.course_prerequisite_links)
            return counts

        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                # Column lists below are taken from the live schema, not from the migration
                # files: several later migrations add and rename columns, and an earlier revision
                # of this loader inserted `code`, `credits_raw`, `department`, `page_number`,
                # `overview`, `expression` and `prerequisite_course_id` — none of which exist — and
                # omitted `tenant_id`, which every catalog table declares NOT NULL. None of that
                # surfaced because a dry run returns before reaching any SQL.

                # 1. Document
                cur.execute(
                    """
                    INSERT INTO documents (id, domain_id, version, file_hash)
                    VALUES (%(id)s, %(domain_id)s, %(version)s, %(file_hash)s)
                    ON CONFLICT (id) DO UPDATE SET file_hash = EXCLUDED.file_hash;
                    """,
                    document_row,
                )
                counts["documents"] = 1

                # 2. Semantic chunks. content_hash is NOT NULL and is the column check C7 audits.
                chunk_dicts = [
                    {
                        "id": c.id,
                        "tenant_id": self.tenant_id,
                        "document_id": c.document_id,
                        "sequence_order": c.chunk_index,
                        "section_header": c.heading_context,
                        "content": c.content,
                        "content_hash": hashlib.sha256(c.content.encode("utf-8")).hexdigest(),
                        "page_number": c.page_number,
                        "markdown_url": c.markdown_url,
                    }
                    for c in chunks
                ]
                extras.execute_batch(
                    cur,
                    """
                    INSERT INTO semantic_chunks (
                        id, tenant_id, document_id, sequence_order, section_header,
                        content, content_hash, page_number, markdown_url
                    ) VALUES (
                        %(id)s, %(tenant_id)s, %(document_id)s, %(sequence_order)s, %(section_header)s,
                        %(content)s, %(content_hash)s, %(page_number)s, %(markdown_url)s
                    ) ON CONFLICT (id) DO NOTHING;
                    """,
                    chunk_dicts,
                )
                counts["semantic_chunks"] = len(chunk_dicts)

                # 3. Courses
                extras.execute_batch(
                    cur,
                    """
                    INSERT INTO courses (
                        id, tenant_id, document_id, course_code, title, credits,
                        description, prerequisites, markdown_url, is_ghost
                    ) VALUES (
                        %(id)s, %(tenant_id)s, %(document_id)s, %(course_code)s, %(title)s, %(credits)s,
                        %(description)s, %(prerequisites)s, %(markdown_url)s, %(is_ghost)s
                    ) ON CONFLICT (id) DO NOTHING;
                    """,
                    extracted.courses,
                )
                counts["courses"] = len(extracted.courses)

                # 4. Programs
                extras.execute_batch(
                    cur,
                    """
                    INSERT INTO programs (
                        id, tenant_id, document_id, name, degree_type, total_credits, markdown_url
                    ) VALUES (
                        %(id)s, %(tenant_id)s, %(document_id)s, %(name)s, %(degree_type)s,
                        %(total_credits)s, %(markdown_url)s
                    ) ON CONFLICT (id) DO NOTHING;
                    """,
                    extracted.programs,
                )
                counts["programs"] = len(extracted.programs)

                # 5/6. program_requirements and program_requirement_courses are not produced by
                # this pipeline — see the note at the end of extractor.py. They are reported as
                # unpopulated by the census rather than filled with plausible rows.
                counts["program_requirements"] = 0
                counts["program_requirement_courses"] = 0

                # 7. Prerequisite edges
                extras.execute_batch(
                    cur,
                    """
                    INSERT INTO course_prerequisite_links (
                        id, tenant_id, course_id, prereq_course_id
                    ) VALUES (
                        %(id)s, %(tenant_id)s, %(course_id)s, %(prereq_course_id)s
                    ) ON CONFLICT (id) DO NOTHING;
                    """,
                    extracted.course_prerequisite_links,
                )
                counts["course_prerequisite_links"] = len(extracted.course_prerequisite_links)

            conn.commit()
        except Exception as err:
            conn.rollback()
            raise RuntimeError(f"Database transaction failed: {err}") from err
        finally:
            conn.close()

        return counts

    def generate_full_census_report(self) -> dict[str, dict[str, Any]]:
        """Query row count across ALL tables in TABLE_ORDER and report populated state."""
        census: dict[str, dict[str, Any]] = {}
        conn = self.get_connection()
        try:
            with conn.cursor() as cur:
                for table in TABLE_ORDER:
                    try:
                        cur.execute(f"SELECT COUNT(*) FROM {table};")
                        cnt = cur.fetchone()[0]
                        census[table] = {"count": cnt, "status": "POPULATED" if cnt > 0 else "UNPOPULATED (OUT OF SCOPE)"}
                    except Exception:  # noqa: BLE001 - a missing table is a census result
                        conn.rollback()
                        census[table] = {"count": 0, "status": "TABLE MISSING / NOT ACCESSIBLE"}
        finally:
            conn.close()
        return census
