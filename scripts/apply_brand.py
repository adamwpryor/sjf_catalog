import yaml
from pathlib import Path
import re

def apply_brand():
    workspace_root = Path(r"C:\Users\adamw\coding_workspaces\sjf_catalog\sjf_catalog")
    config_path = workspace_root / "institution.config.yaml"
    css_path = workspace_root / "src" / "app" / "globals.css"
    
    if not css_path.exists():
        print("globals.css not found. Run sync_upstream.py first.")
        return

    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)
        
    primary = config['brand']['colors']['primary']
    secondary = config['brand']['colors']['secondary']
    
    with open(css_path, 'r') as f:
        css = f.read()
        
    # Override CCSJ Crimson with SJFU Primary (Cardinal Red)
    css = re.sub(r'(--color-ccsj-crimson:\s*)[#a-fA-F0-9]+;', rf'\g<1>{primary};', css)
    # Give the dark variant a slightly darker shade of primary (or just use primary for now)
    css = re.sub(r'(--color-ccsj-crimson-dark:\s*)[#a-fA-F0-9]+;', rf'\g<1>#7a2929;', css)
    
    # Override scrollbar and glass panel hover
    # Primary rgb for #993333 is 153, 51, 51
    css = re.sub(r'rgba\(140,\s*34,\s*50,', r'rgba(153, 51, 51,', css)
    
    with open(css_path, 'w') as f:
        f.write(css)
        
    print(f"Brand applied to {css_path}")

if __name__ == "__main__":
    apply_brand()
