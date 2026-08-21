"""Primary markdown chunker for self-serve ingestion.

Produces semantic_chunks with breadcrumb contexts formatted as:
    [Header 1: ... > Header 2: ... > Header N: ...]

This breadcrumb structure is load-bearing; downstream requirement-linking
logic (backfill_program_requirements) relies on this exact breadcrumb format.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass


@dataclass
class SemanticChunk:
    id: str
    document_id: str
    chunk_index: int
    heading_context: str
    content: str
    markdown_url: str
    page_number: int
    char_count: int
    token_count: int
    chunk_type_id: int = 1  # 1: Content, default


def build_breadcrumb(ancestors: list[str]) -> str:
    """Format ancestor headings into the canonical breadcrumb string."""
    if not ancestors:
        return ""
    parts = [f"Header {i + 1}: {h}" for i, h in enumerate(ancestors)]
    return f"[{' > '.join(parts)}]"


def chunk_markdown_page(
    markdown_text: str,
    document_id: str,
    markdown_url: str,
    page_number: int,
    start_chunk_index: int = 0,
    max_chunk_chars: int = 1500,
) -> list[SemanticChunk]:
    """Chunk a single markdown page into breadcrumb-annotated semantic chunks.

    Args:
        markdown_text: Content of the markdown page.
        document_id: Foreign key ID of the parent document.
        markdown_url: Provenance URL for the source page.
        page_number: Source page number (1-based).
        start_chunk_index: Starting index offset for chunk sequence.
        max_chunk_chars: Soft maximum character target for chunk splitting.

    Returns:
        List of SemanticChunk objects ready for DB insertion.
    """
    lines = markdown_text.splitlines()
    chunks: list[SemanticChunk] = []
    
    current_headers: list[tuple[int, str]] = []  # (level, text)
    current_block: list[str] = []
    current_index = start_chunk_index

    def flush_chunk() -> None:
        nonlocal current_index, current_block
        if not current_block:
            return
        content_text = "\n".join(current_block).strip()
        if not content_text:
            current_block = []
            return
        
        ancestors = [h[1] for h in current_headers]
        breadcrumb = build_breadcrumb(ancestors)
        
        char_count = len(content_text)
        token_count = max(1, char_count // 4)
        
        chunk_id = str(uuid.uuid4())
        chunks.append(
            SemanticChunk(
                id=chunk_id,
                document_id=document_id,
                chunk_index=current_index,
                heading_context=breadcrumb,
                content=content_text,
                markdown_url=markdown_url,
                page_number=page_number,
                char_count=char_count,
                token_count=token_count,
            )
        )
        current_index += 1
        current_block = []

    for line in lines:
        match = re.match(r"^(#{1,6})\s+(.*)$", line)
        if match:
            # Flush previous text before changing heading level
            flush_chunk()
            level = len(match.group(1))
            heading_text = match.group(2).strip()
            
            # Pop deeper or equal headers from stack
            while current_headers and current_headers[-1][0] >= level:
                current_headers.pop()
            current_headers.append((level, heading_text))
            current_block.append(line)
        else:
            current_block.append(line)
            # Soft flush if chunk size exceeds target limit
            if sum(len(l) for l in current_block) >= max_chunk_chars:
                flush_chunk()

    flush_chunk()
    return chunks
