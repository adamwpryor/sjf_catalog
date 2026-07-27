from typing import Literal

from pydantic import BaseModel, Field


class Refuters(BaseModel):
    n: int = 0
    refuted: int = 0

class Finding(BaseModel):
    id: str
    check: str
    severity: Literal["critical", "high", "medium", "low", "info"]
    tier: int
    catalog_version: str
    page: int
    entity_type: str
    entity_id: str | None = None
    entity_key: str
    ancestor_path: list[str] | None = None
    claim: str
    evidence_page: str
    evidence_db: str | None = None
    confidence: float
    verdict: Literal["CONFIRMED", "PLAUSIBLE", "AMBIGUOUS", "REFUTED"]
    refuters: Refuters = Field(default_factory=Refuters)
    suggested_fix: str | None = None
    auto_fixable: bool

class ExtractedHeading(BaseModel):
    level: int
    line: int
    text: str
    ancestor_path: list[str] = Field(default_factory=list)

class ExtractedCourse(BaseModel):
    code: str
    title: str
    credits: int | None = None
    credits_raw: str | None = None
    heading_line: int
    ancestor_path: list[str] = Field(default_factory=list)

class PageFacts(BaseModel):
    catalog_version: str
    page: int
    page_role: Literal["content", "toc", "index", "title", "faculty_directory", "requirements_list", "blank", "unknown"]
    leading_orphan_text: bool
    headings: list[ExtractedHeading] = Field(default_factory=list)
    courses: list[ExtractedCourse] = Field(default_factory=list)
    malformed_headings: list[str] = Field(default_factory=list)
