"""Reporting — turn findings into something a human can triage.

``sqlite_loader`` rebuilds a queryable ``findings.sqlite`` triage index from the append-only
``findings.jsonl``; ``report`` renders ``report.md`` from it. Neither writes to the catalog
database — remediation is a separate, reviewed, backed-up step.
"""
