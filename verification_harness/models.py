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
    text: str
    ancestor_path: List[str] = Field(default_factory=list)

class PageFacts(BaseModel):
    page: int
    catalog_version: str
    headings: List[ExtractedHeading] = Field(default_factory=list)
