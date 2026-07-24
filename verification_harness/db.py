"""Read-only, version-scoped database facts for the verification harness.

This is the *only* database entry point in the harness, and it is deliberately narrow:

- **Read-only by construction.** The connection is opened with ``readonly=True`` and every
  statement runs inside a ``READ ONLY`` transaction, so an accidental write raises rather than
  mutating the catalog. The harness never writes to the catalog DB (``DOUBLE_CHECK.md`` guardrails).
- **Version-scoped by construction.** Facts are always fetched *for one catalog version*, joined
  through ``documents.version`` — never by parsing ``markdown_url``. This closes the exact trap that
  made the original backfill one-way (blocking issue B3).
- **Independent of the backfill.** Nothing here imports from ``scripts/`` or ``src/`` (P1).

The credentials come from the ``DATABASE_URL`` environment variable
(:data:`verification_harness.config.DB_URL_ENV_VAR`); the value is never stored in source.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

import psycopg2
import psycopg2.extras

from . import config


class HarnessDBError(RuntimeError):
    """Raised when the harness database layer is misconfigured or a write is attempted."""


@dataclass(frozen=True)
class DbFacts:
    """The database's view of one catalog version — the DERIVED side under test.

    Every list is scoped to a single ``documents.version`` via a join on ``document_id``.

    Attributes:
        version: The catalog key these facts belong to, e.g. ``"2025-2026-undergraduate"``.
        courses: ``courses`` rows (dicts) for this version.
        programs: ``programs`` rows (dicts) for this version.
        chunks: ``semantic_chunks`` rows (dicts) for this version.
    """

    version: str
    courses: list[dict[str, Any]] = field(default_factory=list)
    programs: list[dict[str, Any]] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)


def _dsn() -> str:
    """Return the Postgres DSN from the environment, or raise if unset.

    Returns:
        The connection string.

    Raises:
        HarnessDBError: If :data:`config.DB_URL_ENV_VAR` is not set (no fallback — Zero-Trust).
    """
    dsn = os.environ.get(config.DB_URL_ENV_VAR)
    if not dsn:
        raise HarnessDBError(
            f"{config.DB_URL_ENV_VAR} is not set. Export it (read-only creds) before running the "
            f"harness; it is never stored in source."
        )
    return dsn


@contextmanager
def read_only_cursor() -> Iterator[psycopg2.extras.RealDictCursor]:
    """Yield a read-only ``RealDictCursor``, guaranteeing no write can reach the catalog.

    The connection is opened ``readonly=True`` (server rejects any writing statement) and rolled
    back on exit, so the harness can never mutate the database it is auditing.

    Yields:
        A dict-returning cursor bound to a ``READ ONLY`` transaction.
    """
    conn = psycopg2.connect(_dsn())
    try:
        conn.set_session(readonly=True, autocommit=False)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
        conn.rollback()  # nothing to commit; make the read-only intent explicit
    finally:
        conn.close()


def list_versions() -> list[str]:
    """Return the catalog versions actually present in the database.

    This is the runtime source of truth for the version list; a mismatch against
    :data:`config.EXPECTED_VERSIONS` is itself finding ``X5`` (``DOUBLE_CHECK.md`` §3).

    Returns:
        Sorted list of ``documents.version`` values.
    """
    with read_only_cursor() as cur:
        cur.execute("SELECT DISTINCT version FROM documents WHERE version IS NOT NULL ORDER BY 1")
        return [row["version"] for row in cur.fetchall()]


def db_facts_for_version(version: str) -> DbFacts:
    """Fetch all DERIVED rows for one catalog version, scoped through ``documents.version``.

    Args:
        version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.

    Returns:
        A :class:`DbFacts` with courses, programs, and semantic_chunks for this version only.

    Raises:
        HarnessDBError: If the version is unknown to the database (guards silent empty results).
    """
    with read_only_cursor() as cur:
        cur.execute("SELECT 1 FROM documents WHERE version = %s LIMIT 1", (version,))
        if cur.fetchone() is None:
            known = ", ".join(list_versions())
            raise HarnessDBError(f"Unknown catalog version {version!r}. Known versions: {known}")

        cur.execute(
            """
            SELECT c.id, c.course_code, c.title, c.credits, c.description,
                   c.prerequisites, c.markdown_url, c.is_ghost, c.subject_id, c.source_chunk_id
            FROM courses c
            JOIN documents d ON d.id = c.document_id
            WHERE d.version = %s
            ORDER BY c.course_code
            """,
            (version,),
        )
        courses = [dict(row) for row in cur.fetchall()]

        cur.execute(
            """
            SELECT p.id, p.name, p.degree_type, p.total_credits, p.markdown_url
            FROM programs p
            JOIN documents d ON d.id = p.document_id
            WHERE d.version = %s
            ORDER BY p.name
            """,
            (version,),
        )
        programs = [dict(row) for row in cur.fetchall()]

        cur.execute(
            """
            SELECT s.id, s.section_header, s.content, s.page_number, s.markdown_url,
                   s.sequence_order, s.content_hash
            FROM semantic_chunks s
            JOIN documents d ON d.id = s.document_id
            WHERE d.version = %s
            ORDER BY s.sequence_order
            """,
            (version,),
        )
        chunks = [dict(row) for row in cur.fetchall()]

    return DbFacts(version=version, courses=courses, programs=programs, chunks=chunks)
