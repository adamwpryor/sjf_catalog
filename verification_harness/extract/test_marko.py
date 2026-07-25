import marko

def test():
    md = """# Hello
    
This is a test.

## Heading 2
"""
    doc = marko.parse(md)
    for child in doc.children:
        print(type(child), getattr(child, "line_number", None), getattr(child, "start_line", None), getattr(child, "sourcepos", None))

if __name__ == "__main__":
    test()
