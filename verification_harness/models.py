from pydantic import BaseModel, Field
from typing import List, Literal, Optional

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
    entity_id: Optional[str] = None
    entity_key: str
    ancestor_path: Optional[List[str]] = None
    claim: str
    evidence_page: str
    evidence_db: Optional[str] = None
    confidence: float
    verdict: Literal["CONFIRMED", "PLAUSIBLE", "AMBIGUOUS", "REFUTED"]
    refuters: Refuters = Field(default_factory=Refuters)
    suggested_fix: Optional[str] = None
    auto_fixable: bool

class ExtractedHeading(BaseModel):
    level: int
    line: int
    text: str
    ancestor_path: List[str] = Field(default_factory=list)

class ExtractedCourse(BaseModel):
    code: str
    title: str
    credits: Optional[int] = None
    credits_raw: Optional[str] = None
    heading_line: int
    ancestor_path: List[str] = Field(default_factory=list)

class PageFacts(BaseModel):
    catalog_version: str
    page: int
    page_role: Literal["content", "toc", "index", "title", "faculty_directory", "requirements_list", "blank", "unknown"]
    leading_orphan_text: bool
    headings: List[ExtractedHeading] = Field(default_factory=list)
    courses: List[ExtractedCourse] = Field(default_factory=list)
    malformed_headings: List[str] = Field(default_factory=list)
