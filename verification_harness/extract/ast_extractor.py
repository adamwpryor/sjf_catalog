import re

import marko

from ..models import ExtractedCourse, ExtractedHeading, PageFacts
from .page_role import classify_page_role
from .permissive_scan import scan_for_malformed_headings


def extract_facts(markdown_content: str, version: str, page_num: int) -> PageFacts:
    doc = marko.parse(markdown_content)
    
    headings = []
    courses = []
    stack = []
    
    lines = markdown_content.splitlines()
    line_index = 0
    
    leading_orphan_text = False
    first_non_blank = next((child for child in doc.children if not isinstance(child, marko.block.BlankLine)), None)
    if first_non_blank and not isinstance(first_non_blank, marko.block.Heading):
        leading_orphan_text = True
        
    def find_heading_line(text_to_find, start_line):
        for i in range(start_line, len(lines)):
            if lines[i].startswith('#') and text_to_find in lines[i]:
                return i + 1
        return -1

    for child in doc.children:
        if isinstance(child, marko.block.Heading):
            text_parts = []
            def walk_text(node, parts):
                if hasattr(node, "children"):
                    if isinstance(node.children, list):
                        for c in node.children:
                            walk_text(c, parts)
                    elif isinstance(node.children, str):
                        parts.append(node.children)
            walk_text(child, text_parts)
            heading_text = "".join(text_parts).strip()
            
            line_num = find_heading_line(heading_text, line_index)
            if line_num != -1:
                line_index = line_num
            else:
                line_num = 0
            
            level = child.level
            while stack and stack[-1].level >= level:
                stack.pop()
                
            ancestor_path = [h.text for h in stack]
            
            extracted = ExtractedHeading(
                level=level,
                line=line_num,
                text=heading_text,
                ancestor_path=ancestor_path
            )
            headings.append(extracted)
            stack.append(extracted)
            
            course_match = re.match(r'^([A-Z]{3,4})[- ](\d{3,4}[A-Z]*)\s*(.*)', heading_text)
            if course_match:
                prefix = course_match.group(1)
                num = course_match.group(2)
                code = f"{prefix} {num}"
                rest = course_match.group(3)
                
                credits_val = None
                credits_raw = None
                
                credits_match = re.search(r'\(([^)]+)\)$', rest)
                if credits_match:
                    c_raw = credits_match.group(1).strip()
                    rest = rest[:credits_match.start()].strip()
                    
                    if c_raw.isdigit():
                        credits_val = int(c_raw)
                    else:
                        credits_raw = f"({c_raw})"
                
                title = rest.strip()
                
                courses.append(ExtractedCourse(
                    code=code,
                    title=title,
                    credits=credits_val,
                    credits_raw=credits_raw,
                    heading_line=line_num,
                    ancestor_path=ancestor_path
                ))

    role = classify_page_role(markdown_content)
    malformed = scan_for_malformed_headings(markdown_content, headings)
    
    return PageFacts(
        catalog_version=version,
        page=page_num,
        page_role=role,
        leading_orphan_text=leading_orphan_text,
        headings=headings,
        courses=courses,
        malformed_headings=malformed
    )
