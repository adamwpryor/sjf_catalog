"""``X5`` — snapshot each sweep and diff it against the previous one.

``DOUBLE_CHECK.md`` §3 makes this a finding class, not a convenience: *"An unexplained count change
between runs is itself a finding (``X5``)."* A catalog that quietly loses 40 courses, or a check
whose output halves after a refactor, is exactly the kind of silent regression a verifier exists to
catch — and the harness must not be blind to it in its own output.

Each run appends one snapshot to ``artifacts/run_history.jsonl`` (git-ignored), carrying the corpus
counts, the findings breakdown, and the git commit/branch the run was produced from, so a diff can
always be attributed to a code change or flagged as unexplained.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .. import config

logger = logging.getLogger(__name__)

#: Append-only run log. Derived artifact; safe to delete (the next run simply has no baseline).
RUN_HISTORY: Path = config.ARTIFACTS_DIR / "run_history.jsonl"


def _git_context() -> dict[str, str]:
    """Return the commit and branch the run was produced from.

    Required by ``DEVELOPER_GUIDELINES.md`` so a count change can be attributed to a code change.

    Returns:
        ``{"commit": ..., "branch": ..., "dirty": ...}``; values are ``"unknown"`` if the repo
        cannot be read (the harness must never fail a run over provenance metadata).
    """
    try:
        import git

        repo = git.Repo(config.REPO_ROOT, search_parent_directories=True)
        return {
            "commit": repo.head.commit.hexsha[:12],
            "branch": repo.active_branch.name if not repo.head.is_detached else "DETACHED",
            "dirty": str(repo.is_dirty()),
        }
    except Exception as exc:  # noqa: BLE001 — provenance is best-effort, never fatal
        logger.debug("git context unavailable: %s", exc)
        return {"commit": "unknown", "branch": "unknown", "dirty": "unknown"}


def snapshot(
    corpus: dict[str, dict[str, int]],
    findings_by_version: dict[str, int],
    summary: dict[str, dict[str, int]],
) -> dict[str, Any]:
    """Build a snapshot of one sweep.

    Args:
        corpus: Per-version input counts, e.g. ``{"2025-2026-undergraduate": {"pages": 771, ...}}``.
        findings_by_version: Finding count per catalog version.
        summary: The ``sqlite_loader.summarize`` output (by severity / check / verdict).

    Returns:
        The snapshot record.
    """
    return {
        "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git": _git_context(),
        "corpus": corpus,
        "findings_by_version": findings_by_version,
        "findings_total": sum(findings_by_version.values()),
        "by_check": summary.get("by_check", {}),
        "by_severity": summary.get("by_severity", {}),
    }


def load_history(path: Path | None = None) -> list[dict[str, Any]]:
    """Read every recorded run, oldest first.

    Args:
        path: History file; defaults to :data:`RUN_HISTORY`.

    Returns:
        The recorded snapshots (empty if the file does not exist).
    """
    path = path or RUN_HISTORY
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def record(record_: dict[str, Any], path: Path | None = None) -> None:
    """Append a snapshot to the run history.

    Args:
        record_: The snapshot from :func:`snapshot`.
        path: History file; defaults to :data:`RUN_HISTORY`.
    """
    path = path or RUN_HISTORY
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record_, ensure_ascii=False) + "\n")


def _diff_counts(label: str, before: dict[str, int], after: dict[str, int]) -> list[str]:
    """Return one human-readable line per changed key between two count maps."""
    lines: list[str] = []
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key, 0), after.get(key, 0)
        if old != new:
            lines.append(f"  {label} {key}: {old} -> {new} ({new - old:+d})")
    return lines


def diff(previous: dict[str, Any], current: dict[str, Any]) -> list[str]:
    """Compare two snapshots and describe every count that moved.

    Args:
        previous: The prior run's snapshot.
        current: This run's snapshot.

    Returns:
        Human-readable change lines; empty when the two runs agree exactly.
    """
    lines: list[str] = []
    for field in ("pages", "courses", "programs", "chunks"):
        before = {v: counts.get(field, 0) for v, counts in previous.get("corpus", {}).items()}
        after = {v: counts.get(field, 0) for v, counts in current.get("corpus", {}).items()}
        lines += _diff_counts(f"{field:9}", before, after)
    lines += _diff_counts("findings ", previous.get("findings_by_version", {}), current.get("findings_by_version", {}))
    lines += _diff_counts("check    ", previous.get("by_check", {}), current.get("by_check", {}))
    return lines


def record_and_diff(
    corpus: dict[str, dict[str, int]],
    findings_by_version: dict[str, int],
    summary: dict[str, dict[str, int]],
    path: Path | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Snapshot this run, diff it against the previous one, and append it to the history.

    Args:
        corpus: Per-version input counts.
        findings_by_version: Finding count per catalog version.
        summary: The ``sqlite_loader.summarize`` output.
        path: History file; defaults to :data:`RUN_HISTORY`.

    Returns:
        ``(snapshot, change_lines)``. ``change_lines`` is empty on the first-ever run *and* when
        nothing moved — the caller distinguishes the two by whether a prior snapshot existed.
    """
    history = load_history(path)
    current = snapshot(corpus, findings_by_version, summary)
    changes = diff(history[-1], current) if history else []
    record(current, path)
    return current, changes
