import re
from collections.abc import Iterator

from ..models import Finding
from ..normalize import page_from_url
from .registry import CheckContext, make_finding, register


@register("A1", tier=1, needs_pages=True, title="Coverage: Course on page but missing from DB")
def check_a1(ctx: CheckContext) -> Iterator[Finding]:
    db_codes = {c["course_code"].strip() for c in ctx.db.courses if c.get("course_code")}
    
    for page_num, page_facts in ctx.pages.items():
        for course in page_facts.courses:
            if course.code not in db_codes:
                yield make_finding(
                    ctx,
                    check="A1",
                    severity="critical",
                    entity_type="course",
                    entity_key=course.code,
                    claim=f"Course {course.code} found on page {page_num} but missing from DB",
                    page=page_num,
                    ancestor_path=course.ancestor_path
                )

@register("A2", tier=1, needs_pages=True, title="Coverage: DB course missing from its target page")
def check_a2(ctx: CheckContext) -> Iterator[Finding]:
    for c in ctx.db.courses:
        if not c.get("markdown_url"):
            continue
            
        m = re.search(r'page_(\d+)\.md', c["markdown_url"])
        if not m:
            continue
            
        page_num = int(m.group(1))
        page_facts = ctx.pages.get(page_num)
        
        if not page_facts:
            yield make_finding(
                ctx,
                check="A2",
                severity="critical",
                entity_type="course",
                entity_key=c["course_code"],
                entity_id=c["id"],
                claim=f"Course {c['course_code']} points to page {page_num} which was not parsed",
                page=page_num,
                evidence_db=c["markdown_url"]
            )
            continue
            
        page_codes = {course.code for course in page_facts.courses}
        if c["course_code"] not in page_codes:
            yield make_finding(
                ctx,
                check="A2",
                severity="critical",
                entity_type="course",
                entity_key=c["course_code"],
                entity_id=c["id"],
                claim=f"Course {c['course_code']} missing from its target page {page_num}",
                page=page_num,
                evidence_db=c["markdown_url"]
            )

@register("A5", tier=1, needs_pages=True, title="Coverage: Empty content page")
def check_a5(ctx: CheckContext) -> Iterator[Finding]:
    def _chunk_page(c):
        return c.get("page_number") if c.get("page_number") is not None else page_from_url(c.get("markdown_url"))
    
    chunk_pages = {_chunk_page(c) for c in ctx.db.chunks if _chunk_page(c) is not None}
    for page_num, page_facts in ctx.pages.items():
        if page_facts.page_role == "content" and not page_facts.courses and page_num not in chunk_pages:
            yield make_finding(
                ctx,
                check="A5",
                severity="high",
                entity_type="page",
                entity_key=str(page_num),
                claim=f"Page {page_num} is classified as 'content' but contains no courses or DB rows",
                page=page_num
            )
