"""Report generator: findings.sqlite / findings.jsonl -> report.md.

Transforms verified findings into an executive, actionable remediation report:
- Includes ONLY CONFIRMED and PLAUSIBLE findings (REFUTED and AMBIGUOUS remain in SQLite/JSONL for audit).
- Ordered by severity: critical -> high -> medium -> low -> info.
- Grouped by check and entity class rather than a raw dump of line items.
- Displays literal page excerpts, DB values, and source page links for every defect (P4).
- Provides a Coverage & Refutation Summary section documenting what was verified, refuted, or skipped (P5).
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from .. import config

logger = logging.getLogger(__name__)

SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]


def fetch_findings_from_sqlite(sqlite_path: Path) -> list[dict[str, Any]]:
    """Fetch all findings from findings.sqlite."""
    if not sqlite_path.exists():
        return []
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM findings")
    rows = cursor.fetchall()
    findings: list[dict[str, Any]] = []
    for r in rows:
        item = dict(r)
        if item.get("ancestor_path"):
            try:
                item["ancestor_path"] = json.loads(item["ancestor_path"])
            except (json.JSONDecodeError, TypeError, ValueError):
                item["ancestor_path"] = None
        findings.append(item)
    conn.close()
    return findings


def fetch_findings_from_jsonl(jsonl_path: Path) -> list[dict[str, Any]]:
    """Fetch all findings from findings.jsonl."""
    if not jsonl_path.exists():
        return []
    findings: list[dict[str, Any]] = []
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                findings.append(json.loads(line))
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                logger.debug("Skipping unparseable jsonl line: %s", exc)
                continue
    return findings


def load_all_findings(sqlite_path: Path, jsonl_path: Path) -> list[dict[str, Any]]:
    """Load findings from SQLite if available, falling back to JSONL."""
    if sqlite_path.exists():
        return fetch_findings_from_sqlite(sqlite_path)
    return fetch_findings_from_jsonl(jsonl_path)


def generate_report_markdown(findings: list[dict[str, Any]]) -> str:
    """Generate executive report markdown string from findings."""
    total_count = len(findings)
    refuted_count = sum(1 for f in findings if f.get("verdict") == "REFUTED")
    ambiguous_count = sum(1 for f in findings if f.get("verdict") == "AMBIGUOUS")
    confirmed_count = sum(1 for f in findings if f.get("verdict") == "CONFIRMED")
    plausible_count = sum(1 for f in findings if f.get("verdict") == "PLAUSIBLE")

    # Filter for human report
    actionable = [f for f in findings if f.get("verdict") in ("CONFIRMED", "PLAUSIBLE")]

    #: Findings omitted by the per-check rendering cap, tallied so the audit section can state the
    #: real coverage instead of implying the list is complete.
    truncated: dict[str, int] = {}

    # Group by severity then check
    by_severity: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in actionable:
        sev = f.get("severity", "info").lower()
        by_severity[sev].append(f)

    lines: list[str] = [
        "# Catalog ↔ Database Verification Harness Report",
        "",
        "## Executive Summary",
        "",
        f"- **Total Scanned Findings:** {total_count:,}",
        f"- **Actionable Findings (CONFIRMED + PLAUSIBLE):** {len(actionable):,}",
        f"- **Refuted False Positives (Tier 3):** {refuted_count:,}",
        f"- **Ambiguous / Unverified Findings:** {ambiguous_count:,}",
        "",
        "### Breakdown by Verdict",
        "",
        "| Verdict | Count | Report Status |",
        "| --- | ---: | --- |",
        f"| `CONFIRMED` | {confirmed_count:,} | Included in Remediation Queue |",
        f"| `PLAUSIBLE` | {plausible_count:,} | Included in Remediation Queue |",
        f"| `AMBIGUOUS` | {ambiguous_count:,} | Retained in Audit Log |",
        f"| `REFUTED` | {refuted_count:,} | Retained in Audit Log (False Positives Killed) |",
        "",
        "---",
        "",
        "## Remediation Queue",
        "",
    ]

    if not actionable:
        lines.append("No actionable (`CONFIRMED` or `PLAUSIBLE`) findings present.")
    else:
        for sev in SEVERITY_ORDER:
            sev_findings = by_severity.get(sev, [])
            if not sev_findings:
                continue

            lines.append(f"### Severity: `{sev.upper()}` ({len(sev_findings)} items)")
            lines.append("")

            # Group by check
            by_check: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for f in sev_findings:
                by_check[f.get("check", "UNKNOWN")].append(f)

            for check_id, check_findings in sorted(by_check.items()):
                lines.append(f"#### Check `{check_id}` ({len(check_findings)} findings)")
                lines.append("")

                # Group by entity or present concise items
                for f in check_findings[:50]:  # Cap individual entries per check section
                    page_num = f.get("page", 0)
                    version = f.get("catalog_version", "unknown")
                    claim = f.get("claim", "")
                    evidence_p = f.get("evidence_page", "").strip()
                    evidence_db = f.get("evidence_db", "").strip() if f.get("evidence_db") else ""

                    lines.append(f"- **Entity:** `{f.get('entity_type')}` `{f.get('entity_key')}` (Version: `{version}`, Page: `{page_num}`) [page_{page_num:04d}.md]")
                    lines.append(f"  - **Claim:** {claim}")
                    if evidence_p:
                        lines.append(f"  - **Page Evidence:** `{evidence_p}`")
                    if evidence_db:
                        lines.append(f"  - **DB Evidence:** `{evidence_db}`")
                    if f.get("suggested_fix"):
                        lines.append(f"  - **Suggested Fix:** `{f.get('suggested_fix')}`")
                    lines.append("")

                if len(check_findings) > 50:
                    # "grouped" would be a lie: these are OMITTED from the rendered list, not
                    # summarized into it. P5 requires that a cap say what it dropped and where the
                    # full set still lives, or the report reads as complete coverage when it is not.
                    omitted = len(check_findings) - 50
                    truncated[check_id] = truncated.get(check_id, 0) + omitted
                    lines.append(
                        f"  > **{omitted:,} further `{check_id}` findings are OMITTED from this "
                        f"list** (cap: 50 per check per severity). They are not grouped or "
                        f"summarized — query `findings.sqlite` for the full set: "
                        f"`SELECT * FROM findings WHERE \"check\"='{check_id}'`."
                    )
                    lines.append("")

    lines.extend(_audit_summary(findings, truncated))
    return "\n".join(lines)


def _audit_summary(findings: list[dict[str, Any]], truncated: dict[str, int]) -> list[str]:
    """Render the P5 coverage section from the findings themselves.

    This section is the report's own account of what it did and did not verify, so every number in
    it is **derived from the data**. It previously carried hardcoded prose — including the literal
    string "N independent skeptical refuters" and a claim that low/medium findings were excluded
    when they are in fact listed above. A coverage statement that cannot be wrong is a coverage
    statement that cannot be trusted; if the run changes and these numbers do not, that is a bug.
    """
    by_tier: dict[int, int] = defaultdict(int)
    refuted_by_tier: dict[int, int] = defaultdict(int)
    unverified = 0
    refuter_calls = 0
    for f in findings:
        tier = int(f.get("tier", 1))
        by_tier[tier] += 1
        if f.get("verdict") == "REFUTED":
            refuted_by_tier[tier] += 1
        refuters = f.get("refuters")
        if isinstance(refuters, str):
            try:
                refuters = json.loads(refuters)
            except (json.JSONDecodeError, TypeError, ValueError):
                refuters = None
        n = int((refuters or {}).get("n", 0)) if isinstance(refuters, dict) else 0
        refuter_calls += n
        if n == 0 and f.get("verdict") in ("CONFIRMED", "PLAUSIBLE"):
            unverified += 1

    harness_errors = [f for f in findings if "crashed" in str(f.get("claim", ""))]
    adjudication_failed = [f for f in findings if "adjudication-failed" in str(f.get("entity_key", ""))]

    out = [
        "---",
        "",
        "## Coverage & Audit Summary",
        "",
        "Every figure here is computed from the findings in this run, not asserted.",
        "",
        f"- **Tier 1 (deterministic):** {by_tier.get(1, 0):,} findings.",
        f"- **Tier 2 (LLM adjudication):** {by_tier.get(2, 0):,} findings.",
        (
            f"- **Tier 3 (refutation):** {refuter_calls:,} refuter votes cast; "
            f"{sum(refuted_by_tier.values()):,} findings killed as false positives."
        ),
        (
            f"- **Not adversarially verified:** {unverified:,} actionable findings carry "
            "`refuters.n = 0`. These were out of Tier 3's scope, or are pageless by construction "
            "(e.g. `A4` reports rows that link to no page, so there is no excerpt to refute "
            "against). They are reported as found, not as verified."
        ),
    ]
    if truncated:
        total_omitted = sum(truncated.values())
        detail = ", ".join(f"`{k}` {v:,}" for k, v in sorted(truncated.items(), key=lambda kv: -kv[1]))
        out.append(
            f"- **Omitted from the lists above:** {total_omitted:,} findings ({detail}). The "
            "rendering cap is 50 per check per severity. Nothing is deleted — `findings.jsonl` and "
            "`findings.sqlite` hold the complete set."
        )
    if adjudication_failed:
        out.append(
            f"- **Tier 2 calls that did not complete:** {len(adjudication_failed):,}. The pages they "
            "covered were NOT semantically adjudicated; re-run to fill the gap."
        )
    if harness_errors:
        out.append(
            f"- **Checks that crashed:** {len(harness_errors)} — "
            + ", ".join(sorted({str(f.get("check")) for f in harness_errors}))
            + ". Their coverage is missing from this report entirely."
        )
    out.append("")
    return out


def generate_report(
    sqlite_path: Path = config.FINDINGS_SQLITE,
    jsonl_path: Path = config.FINDINGS_JSONL,
    output_path: Path = config.REPORT_MD,
) -> Path:
    """Generate report.md from SQLite or JSONL findings."""
    findings = load_all_findings(sqlite_path, jsonl_path)
    md_content = generate_report_markdown(findings)
    output_path.write_text(md_content, encoding="utf-8")
    return output_path


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for report generator."""
    parser = argparse.ArgumentParser(prog="report", description="Generate report.md from findings.")
    parser.add_argument("--sqlite", type=Path, default=config.FINDINGS_SQLITE)
    parser.add_argument("--jsonl", type=Path, default=config.FINDINGS_JSONL)
    parser.add_argument("--out", type=Path, default=config.REPORT_MD)
    args = parser.parse_args(argv)

    out_file = generate_report(args.sqlite, args.jsonl, args.out)
    print(f"Report generated: {out_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
