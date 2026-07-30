from collections.abc import Iterator

from ..models import Finding
from .coverage import courses_by_code
from .registry import CheckContext, make_finding, register


@register("B1", tier=1, needs_pages=True, title="Fidelity: Credits mismatch")
def check_b1(ctx: CheckContext) -> Iterator[Finding]:
    db_courses = {c["course_code"].strip(): c for c in ctx.db.courses if c.get("course_code")}

    for page_num, page_facts in ctx.pages.items():
        # Grouped by code: a code repeated on one page is one entity, so one finding — see
        # `courses_by_code`. Differing credits between the occurrences are named in the claim.
        for code, occurrences in courses_by_code(page_facts).items():
            db_c = db_courses.get(code)
            if not db_c:
                continue

            db_credits_str = str(db_c.get("credits")).strip() if db_c.get("credits") is not None else None

            if db_credits_str and db_credits_str.isdigit():
                db_credits = int(db_credits_str)
                page_credits = [c.credits for c in occurrences if c.credits is not None]
                mismatched = sorted({c for c in page_credits if c != db_credits})
                if mismatched:
                    page_says = " or ".join(str(c) for c in mismatched)
                    yield make_finding(
                        ctx,
                        check="B1",
                        severity="high",
                        entity_type="course",
                        entity_key=code,
                        entity_id=db_c["id"],
                        claim=f"Credits mismatch for {code}: page says {page_says}, DB says {db_credits}",
                        page=page_num,
                        evidence_db=str(db_credits),
                        ancestor_path=occurrences[0].ancestor_path
                    )

@register("B5", tier=1, needs_pages=True, title="Fidelity: Course suffix/prefix anomaly")
def check_b5(ctx: CheckContext) -> Iterator[Finding]:
    db_codes = {c["course_code"].strip() for c in ctx.db.courses if c.get("course_code")}
    db_codes_stripped = {c.replace(" ", ""): c for c in db_codes}

    for page_num, page_facts in ctx.pages.items():
        for code, occurrences in courses_by_code(page_facts).items():
            if code not in db_codes:
                stripped_code = code.replace(" ", "")
                if stripped_code in db_codes_stripped:
                    db_code = db_codes_stripped[stripped_code]
                    yield make_finding(
                        ctx,
                        check="B5",
                        severity="medium",
                        entity_type="course",
                        entity_key=code,
                        claim=f"Course code suffix/prefix anomaly: page says '{code}', DB says '{db_code}'",
                        page=page_num,
                        ancestor_path=occurrences[0].ancestor_path
                    )
