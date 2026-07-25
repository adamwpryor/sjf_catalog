import re
from typing import List
from ..models import ExtractedHeading

def scan_for_malformed_headings(markdown_content: str, strict_headings: List[ExtractedHeading]) -> List[str]:
    """
    Perform a permissive line-scan for heading-like lines and diff against the strict AST headings.
    Returns a list of malformed heading lines that marko dropped.
    """
    malformed = []
    lines = markdown_content.splitlines()
    
    strict_texts = {h.text.strip() for h in strict_headings}
    
    # Permissive regex: lines starting with 1-6 hashes, even without space, 
    # or bold lines that look like headings.
    heading_like_pattern = re.compile(r'^#{1,6}\S|^#{1,6}\s+.*|^\*\*.*?\*\*$')
    
    for i, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
            
        if heading_like_pattern.match(line):
            # Clean up the line to compare with strict text
            clean_text = re.sub(r'^#{1,6}\s*', '', line)
            clean_text = re.sub(r'^\*\*(.*?)\*\*$', r'\1', clean_text).strip()
            
            if clean_text not in strict_texts and line not in strict_texts:
                # Also ensure it's not just a normal bolded phrase inside a paragraph
                # But since we matched the whole line `^\*\*.*?\*\*$`, it's a standalone bold line.
                malformed.append(line)
                
    return malformed
