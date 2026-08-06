"""Phase 5a — apply the findings a deterministic single-column write can actually repair.

**This is a separate tool. The harness never invokes it** (``DOUBLE_CHECK.md`` §5 Risk D): auditing
and mutating must not share a command, or a routine verification run can change the database it is
verifying.

Scope is deliberately tiny. Of 18,787 findings the audit produced, ~105 are repairable by writing
one column to one row, because the page states the correct value outright:

- ``B1`` — page heading says ``(3)``, ``courses.credits`` says 4. Write 3.
- ``A6`` — ``is_ghost`` set on a course a page defines with a heading. Clear the flag.
- ``C7`` — ``content_hash`` disagrees with ``content``. Recompute it.

Everything else the audit found needs the *ingest* fixed, not a row patched — re-chunking closes
``F3``'s 6,000+ findings, re-ingesting closes ``B3``'s. That is Phase 5b, and it applies nothing.

Explicitly refused here, because **the page does not say which value is right**: ``D8`` and ``D4``
(a code defined twice with conflicting titles — choosing the canonical one is a human judgment),
``B4``'s ``page_silent`` class, ``B2`` residue, and every verdict that is not ``CONFIRMED``.

Safety, in the order it matters:

1. **``--dry-run`` is the default.** Writing requires typing ``--apply``.
2. **Nothing is written before the affected rows are copied into a backup table**, in the same
   transaction, mirroring ``scripts/backfill_source_pages.mjs``. ``--restore`` reverses it.
3. **Idempotent.** A change whose current value already equals the target is dropped from the plan,
   so a second ``--apply`` is a no-op rather than a second backup generation.
4. **An unknown check id is an error, not a skip.** Silently ignoring a finding class is how a
   remediation tool quietly under-applies and nobody notices.
5. **Its own write connection.** :mod:`verification_harness.db` is read-only by construction and
   stays that way — the harness itself never gains a path that can write to the catalog.

Usage::

    python -m verification_harness.remediate                 # dry run, prints the diff
    python -m verification_harness.remediate --checks B1     # one class at a time (recommended)
    python -m verification_harness.remediate --apply         # writes, after backing up
    python -m verification_harness.remediate --restore       # undo the last apply
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras

from . import config
from .db import _dsn
from .models import Finding

logger = logging.getLogger(__name__)

#: Rows are copied here before any write. One row per changed column, with the run that produced it,
#: so ``--restore`` can reverse a specific apply rather than the whole table's history.
BACKUP_TABLE = "harness_remediation_backup"

#: Only these checks may be applied. An id outside this set raises — see the module docstring.
FIXABLE: frozenset[str] = frozenset({"B1", "A6", "C7"})

#: ``Credits mismatch for HIST 301: page says 3, DB says 4``. Only a single unambiguous page value
#: is fixable; ``page says 3 or 4`` means the page contradicts itself and a human must choose.
_B1_PAGE_CREDITS = re.compile(r"page says (\d+), DB says (\d+)")

#: The synthesized title the ingest gives a course it never found a definition for.
_GHOST_PLACEHOLDER = re.compile(r"\(\s*referenced;\s*not in catalog\s*\)\s*$", re.IGNORECASE)


class RemediationError(RuntimeError):
    """Raised when a finding cannot be turned into a safe, unambiguous write."""


@dataclass(frozen=True)
class Change:
    """One column on one row, with the value it is moving from and to.

    Attributes:
        table: Target table.
        row_id: Primary key of the row.
        column: Column being written.
        old: Current value, captured for the backup and for the dry-run diff.
        new: Value to write.
        check: The finding's check id, so a review can be filtered per class.
        finding_id: Provenance — every write traces to the finding that justified it.
    """

    table: str
    row_id: str
    column: str
    old: Any
    new: Any
    check: str
    finding_id: str

    def render(self) -> str:
        """Return a one-line human diff for the dry run."""
        return (
            f"  {self.check}  {self.table}.{self.column}  {self.old!r} -> {self.new!r}"
            f"   (row {self.row_id}, {self.finding_id})"
        )


# --- planning (pure; touches the DB only to read current values) -------------------

def _plan_b1(finding: Finding, row: dict[str, Any]) -> Change | None:
    """Plan a credits correction from a ``B1`` finding.

    Refuses when the page states more than one value for the same code — the claim renders that as
    ``page says 3 or 4``, and picking one would be the tool inventing an answer the page withholds.
    """
    match = _B1_PAGE_CREDITS.search(finding.claim)
    if not match:
        raise RemediationError(
            f"{finding.id}: cannot read an unambiguous page credit value from the claim "
            f"({finding.claim!r}). The page may state several; a human must choose."
        )
    page_credits, claimed_db = int(match.group(1)), int(match.group(2))
    current = row.get("credits")
    if current != claimed_db:
        raise RemediationError(
            f"{finding.id}: DB has moved since the audit — finding says credits={claimed_db}, "
            f"row now says {current!r}. Re-run the harness before applying."
        )
    if current == page_credits:
        return None  # already correct; idempotence
    return Change("courses", str(row["id"]), "credits", current, page_credits, "B1", finding.id)


def _plan_a6(finding: Finding, row: dict[str, Any]) -> Change | None:
    """Plan an ``is_ghost`` clear.

    Only clears the flag when the row already carries a real title. A ghost whose title is still the
    synthesized ``"BIOL 322 (referenced; not in catalog)"`` placeholder needs its content *ingested*
    — that is Phase 5b — and clearing the flag alone would leave a row that claims to be a real
    course while holding nothing.
    """
    if not row.get("is_ghost"):
        return None  # already cleared; idempotence
    title = (row.get("title") or "").strip()
    if not title or _GHOST_PLACEHOLDER.search(title):
        raise RemediationError(
            f"{finding.id}: {row.get('course_code')} is a ghost whose title is still the ingest "
            f"placeholder ({title!r}). Clearing is_ghost would leave a row asserting a course it "
            f"does not hold. Ingest the definition first (Phase 5b)."
        )
    return Change("courses", str(row["id"]), "is_ghost", True, False, "A6", finding.id)


def _plan_c7(finding: Finding, row: dict[str, Any]) -> Change | None:
    """Plan a ``content_hash`` recompute — the safest possible fix, derived wholly from the row."""
    content = row.get("content")
    if content is None:
        raise RemediationError(f"{finding.id}: chunk {row['id']} has no content to hash.")
    actual = hashlib.sha256(str(content).encode("utf-8")).hexdigest()
    current = row.get("content_hash")
    if current == actual:
        return None  # already correct; idempotence
    return Change("semantic_chunks", str(row["id"]), "content_hash", current, actual, "C7", finding.id)


_PLANNERS = {
    "B1": (_plan_b1, "courses", "id, course_code, credits, title"),
    "A6": (_plan_a6, "courses", "id, course_code, credits, title, is_ghost"),
    "C7": (_plan_c7, "semantic_chunks", "id, content, content_hash"),
}


def load_findings(path: Path, checks: Iterable[str] | None = None) -> list[Finding]:
    """Read findings, keeping only ``CONFIRMED`` ones in the fixable allow-list.

    Args:
        path: ``findings.jsonl``.
        checks: Restrict further to these ids; ``None`` means all of :data:`FIXABLE`.

    Returns:
        The findings this tool may act on.

    Raises:
        RemediationError: If ``checks`` names an id outside :data:`FIXABLE`. Refusing loudly is the
            point — a tool that silently skips a class under-applies without anyone noticing.
    """
    wanted = FIXABLE if checks is None else frozenset(checks)
    unknown = wanted - FIXABLE
    if unknown:
        raise RemediationError(
            f"not remediable: {', '.join(sorted(unknown))}. Only {', '.join(sorted(FIXABLE))} are "
            "mechanically fixable — the rest need the ingest fixed (Phase 5b), or the page does not "
            "state which value is correct."
        )
    out: list[Finding] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        finding = Finding(**json.loads(line))
        if finding.check in wanted and finding.verdict == "CONFIRMED" and finding.entity_id:
            out.append(finding)
    return out


def build_plan(findings: list[Finding], cur: Any) -> tuple[list[Change], list[str]]:
    """Turn findings into concrete column writes, reading each row's current value first.

    Returns:
        ``(changes, refusals)`` — refusals are findings this tool declined to act on, each with the
        reason. They are returned rather than logged away so the dry run shows what it will *not*
        fix as prominently as what it will.
    """
    changes: list[Change] = []
    refusals: list[str] = []
    for finding in findings:
        planner, table, columns = _PLANNERS[finding.check]
        cur.execute(f"SELECT {columns} FROM {table} WHERE id = %s", (finding.entity_id,))
        row = cur.fetchone()
        if row is None:
            refusals.append(f"{finding.id}: row {finding.entity_id} no longer exists")
            continue
        try:
            change = planner(finding, dict(row))
        except RemediationError as exc:
            refusals.append(str(exc))
            continue
        if change is not None:
            changes.append(change)
    return _collapse(changes, refusals)


def _collapse(changes: list[Change], refusals: list[str]) -> tuple[list[Change], list[str]]:
    """Reduce to one write per cell, and refuse a cell two findings disagree about.

    A course defined on several pages produces several findings about the *same row* — ``NURS 428``
    arrives three times from pages 741, 749 and 760. Left alone that writes the same cell three
    times and files three backup rows for one change.

    The dangerous case is not the duplicate, it is the *disagreement*: if two findings named
    different targets for one cell, both writes would run and the last would silently win, with the
    backup recording an "old" value that was itself written moments earlier. So a contested cell is
    refused outright — the page evidence conflicts, and that is a human's call.

    Args:
        changes: Planned writes, possibly overlapping.
        refusals: Existing refusals; contested cells are appended.

    Returns:
        ``(deduplicated changes, refusals)``.
    """
    by_cell: dict[tuple[str, str, str], list[Change]] = {}
    for change in changes:
        by_cell.setdefault((change.table, change.row_id, change.column), []).append(change)

    kept: list[Change] = []
    for (table, row_id, column), group in by_cell.items():
        targets = {c.new for c in group}
        if len(targets) > 1:
            sources = ", ".join(f"{c.finding_id} -> {c.new!r}" for c in group)
            refusals.append(
                f"{table}.{column} on row {row_id}: {len(group)} findings disagree about the "
                f"target value ({sources}). The pages contradict each other; a human must choose."
            )
            continue
        kept.append(group[0])
    return kept, refusals


# --- applying ---------------------------------------------------------------------

def _write_cursor() -> Any:
    """Open a read-write connection. Deliberately **not** ``db.py``.

    ``db.py`` opens ``readonly=True`` and every check runs through it; keeping the write path in a
    separate module is what guarantees no check can ever mutate the catalog, however it is edited.
    """
    conn = psycopg2.connect(_dsn())
    conn.set_session(readonly=False, autocommit=False)
    return conn


def apply_changes(changes: list[Change], run_id: str) -> int:
    """Back up the affected columns, then write — both in one transaction.

    If the backup fails the writes never happen, and if a write fails the backup rolls back with it.
    A backup that can outlive its transaction would let ``--restore`` reverse changes that were
    never made.

    Args:
        changes: The plan to apply.
        run_id: Groups this apply's backup rows so ``--restore`` reverses one run, not all history.

    Returns:
        Number of rows written.
    """
    if not changes:
        return 0
    conn = _write_cursor()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {BACKUP_TABLE} (
                    id           bigserial PRIMARY KEY,
                    run_id       text NOT NULL,
                    applied_at   timestamptz NOT NULL DEFAULT now(),
                    target_table text NOT NULL,
                    row_id       text NOT NULL,
                    column_name  text NOT NULL,
                    old_value    jsonb,
                    new_value    jsonb,
                    finding_id   text NOT NULL
                )
                """
            )
            psycopg2.extras.execute_batch(
                cur,
                f"""INSERT INTO {BACKUP_TABLE}
                    (run_id, target_table, row_id, column_name, old_value, new_value, finding_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [
                    (run_id, c.table, c.row_id, c.column, json.dumps(c.old), json.dumps(c.new), c.finding_id)
                    for c in changes
                ],
            )
            for change in changes:
                cur.execute(
                    f"UPDATE {change.table} SET {change.column} = %s WHERE id = %s",
                    (change.new, change.row_id),
                )
        return len(changes)
    finally:
        conn.close()


def restore(run_id: str | None = None) -> int:
    """Reverse a previous apply from the backup table.

    Args:
        run_id: The run to reverse; ``None`` reverses the most recent one.

    Returns:
        Number of rows restored.
    """
    conn = _write_cursor()
    try:
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"SELECT to_regclass('{BACKUP_TABLE}') IS NOT NULL AS present"
            )
            if not cur.fetchone()["present"]:
                raise RemediationError(f"{BACKUP_TABLE} does not exist — nothing was ever applied.")
            if run_id is None:
                cur.execute(f"SELECT run_id FROM {BACKUP_TABLE} ORDER BY id DESC LIMIT 1")
                latest = cur.fetchone()
                if latest is None:
                    return 0
                run_id = latest["run_id"]
            cur.execute(
                f"""SELECT target_table, row_id, column_name, old_value
                    FROM {BACKUP_TABLE} WHERE run_id = %s ORDER BY id DESC""",
                (run_id,),
            )
            rows = cur.fetchall()
            for row in rows:
                cur.execute(
                    f"UPDATE {row['target_table']} SET {row['column_name']} = %s WHERE id = %s",
                    (row["old_value"], row["row_id"]),
                )
            cur.execute(f"DELETE FROM {BACKUP_TABLE} WHERE run_id = %s", (run_id,))
        return len(rows)
    finally:
        conn.close()


# --- CLI --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    """Plan, and only write when ``--apply`` is given explicitly."""
    parser = argparse.ArgumentParser(prog="remediate", description=__doc__)
    parser.add_argument("--findings", type=Path, default=config.FINDINGS_JSONL)
    parser.add_argument(
        "--checks",
        help=f"comma-separated subset of {', '.join(sorted(FIXABLE))} (default: all). "
        "Reviewing one class at a time is the recommended workflow.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="write the changes (backs up first)")
    mode.add_argument("--restore", action="store_true", help="reverse the most recent apply")
    parser.add_argument("--run-id", help="with --restore, the run to reverse (default: latest)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    from .cli import _load_env_local

    _load_env_local()

    try:
        if args.restore:
            n = restore(args.run_id)
            print(f"restored {n} row(s) to their pre-apply values")
            return 0

        checks = [c.strip() for c in args.checks.split(",")] if args.checks else None
        findings = load_findings(args.findings, checks)
        conn = psycopg2.connect(_dsn())
        try:
            conn.set_session(readonly=True)
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                changes, refusals = build_plan(findings, cur)
        finally:
            conn.close()
    except RemediationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    by_check: dict[str, list[Change]] = {}
    for change in changes:
        by_check.setdefault(change.check, []).append(change)

    print(f"\n{len(findings)} CONFIRMED finding(s) in scope -> {len(changes)} row write(s)\n")
    for check, group in sorted(by_check.items()):
        print(f"{check} ({len(group)} row(s)):")
        for change in group:
            print(change.render())
        print()
    if refusals:
        print(f"REFUSED ({len(refusals)}) — these need a human or Phase 5b, and are not applied:")
        for reason in refusals[:20]:
            print(f"  - {reason}")
        if len(refusals) > 20:
            print(f"  … and {len(refusals) - 20} more")
        print()

    if not args.apply:
        print("DRY RUN — nothing was written. Re-run with --apply to write these changes.")
        return 0

    import uuid

    run_id = str(uuid.uuid4())
    written = apply_changes(changes, run_id)
    print(f"APPLIED {written} row write(s). run_id={run_id}")
    print(f"Reverse with: python -m verification_harness.remediate --restore --run-id {run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
