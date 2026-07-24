"""Load the append-only ``findings.jsonl`` into a queryable ``findings.sqlite`` triage index.

`findings.jsonl` is the interchange format — append-only, git-diffable, and written concurrently by
Tier 1 (Python) and Tier 2/3 (agents). This module rebuilds a **derived** SQLite index from it so a
human (or a remediation script) can group, sort by severity, and pull "all CONFIRMED ``B1``
findings" without parsing JSON by hand (blocking issue / Risk D resolution).

The index is *always rebuilt from scratch* — it holds no state the JSONL doesn't — so re-running is
idempotent and the SQLite file is a disposable artifact. Neither this module nor anything in the
harness writes to the *catalog* database.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .. import config

#: Columns mirrored from the findings schema (``DOUBLE_CHECK.md`` §9). Nested/enumerable fields
#: (``refuters``) are stored as JSON text; ``id`` is the primary key so a rebuild is deterministic.
_COLUMNS: tuple[str, ...] = (
    "id",
    "check",
    "severity",
    "tier",
    "catalog_version",
    "page",
    "entity_type",
    "entity_id",
    "entity_key",
    "ancestor_path",
    "claim",
    "evidence_page",
    "evidence_db",
    "confidence",
    "verdict",
    "refuters",
    "suggested_fix",
    "auto_fixable",
)

#: Fields serialized to JSON text on the way in (and back to objects on the way out).
_JSON_FIELDS: frozenset[str] = frozenset({"ancestor_path", "refuters"})


class MalformedFinding(ValueError):
    """Raised when a ``findings.jsonl`` line is not valid JSON or lacks a stable ``id``.

    Surfaced rather than skipped: silently dropping a finding would make the harness
    under-report, which is its worst failure mode (spec P5 / blocking issue B5).
    """


def _row_values(finding: dict[str, Any]) -> list[Any]:
    """Project one finding dict onto :data:`_COLUMNS`, JSON-encoding nested fields.

    Args:
        finding: A parsed finding object from ``findings.jsonl``.

    Returns:
        Column values in :data:`_COLUMNS` order, with missing keys as ``None``.
    """
    out: list[Any] = []
    for col in _COLUMNS:
        value = finding.get(col)
        if col in _JSON_FIELDS and value is not None:
            value = json.dumps(value, ensure_ascii=False)
        out.append(value)
    return out


def load(
    jsonl_path: Path | None = None,
    sqlite_path: Path | None = None,
) -> int:
    """Rebuild the SQLite triage index from ``findings.jsonl``.

    Args:
        jsonl_path: Source findings file. Defaults to :data:`config.FINDINGS_JSONL`.
        sqlite_path: Destination index. Defaults to :data:`config.FINDINGS_SQLITE`.

    Returns:
        The number of findings loaded.

    Raises:
        FileNotFoundError: If the source JSONL does not exist.
        MalformedFinding: If any non-blank line is not valid JSON or has no ``id`` (never skipped).
    """
    jsonl_path = jsonl_path or config.FINDINGS_JSONL
    sqlite_path = sqlite_path or config.FINDINGS_SQLITE

    if not jsonl_path.exists():
        raise FileNotFoundError(f"findings file not found: {jsonl_path}")

    rows: list[list[Any]] = []
    for lineno, raw in enumerate(jsonl_path.read_text(encoding="utf-8").splitlines(), start=1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            finding = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise MalformedFinding(f"{jsonl_path}:{lineno}: invalid JSON ({exc})") from exc
        if not finding.get("id"):
            raise MalformedFinding(f"{jsonl_path}:{lineno}: finding has no stable 'id'")
        rows.append(_row_values(finding))

    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    if sqlite_path.exists():
        sqlite_path.unlink()  # index is fully derived; rebuild clean for a deterministic result

    col_defs = ", ".join(f'"{c}"' for c in _COLUMNS)
    placeholders = ", ".join("?" for _ in _COLUMNS)
    conn = sqlite3.connect(sqlite_path)
    try:
        conn.execute(f'CREATE TABLE findings ({col_defs}, PRIMARY KEY ("id"))')
        conn.execute("CREATE INDEX idx_sev ON findings(severity)")
        conn.execute("CREATE INDEX idx_check ON findings(\"check\")")
        conn.execute("CREATE INDEX idx_verdict ON findings(verdict)")
        conn.executemany(f'INSERT INTO findings VALUES ({placeholders})', rows)
        conn.commit()
    finally:
        conn.close()

    return len(rows)


def summarize(sqlite_path: Path | None = None) -> dict[str, dict[str, int]]:
    """Return counts grouped by severity and by check, for a quick triage overview.

    Args:
        sqlite_path: The index to read. Defaults to :data:`config.FINDINGS_SQLITE`.

    Returns:
        ``{"by_severity": {sev: n}, "by_check": {check: n}, "by_verdict": {verdict: n}}``.
    """
    sqlite_path = sqlite_path or config.FINDINGS_SQLITE
    conn = sqlite3.connect(sqlite_path)
    try:
        def group(column: str) -> dict[str, int]:
            cur = conn.execute(f'SELECT "{column}", COUNT(*) FROM findings GROUP BY "{column}"')
            return {str(k): n for k, n in cur.fetchall()}

        return {
            "by_severity": group("severity"),
            "by_check": group("check"),
            "by_verdict": group("verdict"),
        }
    finally:
        conn.close()
