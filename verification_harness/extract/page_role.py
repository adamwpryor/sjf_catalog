import re
from typing import List, Literal

PageRole = Literal["content", "toc", "index", "title", "faculty_directory", "requirements_list", "blank", "unknown"]

def classify_page_role(markdown_content: str) -> PageRole:
    """Classify the structural role of a markdown page without relying on web heuristics."""
    if not markdown_content or not markdown_content.strip():
        return "blank"

    lines = markdown_content.splitlines()
    non_empty_lines = [line for line in lines if line.strip()]
    if not non_empty_lines:
        return "blank"

    # Metrics
    num_headings = sum(1 for line in non_empty_lines if re.match(r'^#{1,6}\s', line))
    short_lines = sum(1 for line in non_empty_lines if len(line.strip()) < 60)
    long_lines = len(non_empty_lines) - short_lines
    trailing_numbers = sum(1 for line in non_empty_lines if re.search(r'\d+\s*$', line))
    
    # Ratios
    short_line_ratio = short_lines / len(non_empty_lines)
    heading_ratio = num_headings / len(non_empty_lines)
    trailing_num_ratio = trailing_numbers / len(non_empty_lines)

    # Heuristics
    if short_line_ratio > 0.8 and trailing_num_ratio > 0.3:
        if heading_ratio > 0.1:
            return "toc"
        return "index"
    
    # Check for faculty directory (lots of names, degrees, no long paragraphs)
    faculty_keywords = sum(1 for line in non_empty_lines if any(kw in line.lower() for kw in ["ph.d.", "m.a.", "professor", "adjunct"]))
    if faculty_keywords > 5 and short_line_ratio > 0.7:
        return "faculty_directory"
        
    # Check for requirements list (lots of course codes)
    course_codes = sum(1 for line in non_empty_lines if re.search(r'[A-Z]{3,4}\s*\d{3}', line))
    if course_codes > 10 and heading_ratio < 0.1:
        return "requirements_list"

    # Default to content if there are significant paragraphs
    if long_lines > 3:
        return "content"

    if len(non_empty_lines) < 5 and num_headings > 0:
        return "title"

    return "unknown"
