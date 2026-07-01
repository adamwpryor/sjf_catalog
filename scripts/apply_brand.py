"""Apply institution.config.yaml brand tokens to the web theme (BUILD_PLAN §P9).

Idempotent generator: reads the brand block from `institution.config.yaml` and rewrites the
stable, named CSS custom properties in `src/app/globals.css` (the crimson/gold brand colors and
the sans/serif font stacks) plus the Fisher-typography line in `src/lib/brand.ts`. It edits
*values* on known token lines rather than blindly overwriting the file, so hand-authored CSS
(glass panels, animations, the dark shell) is preserved and re-running is safe.

Run:  python scripts/apply_brand.py
This is the P9 "apply institution.config.brand tokens" step; `create-spoke --phase app` calls it.

Note: the Google-Fonts @import URL (tagged `@brand-font-import` in globals.css) is NOT auto-
rewritten — swapping font *families* means picking a matching Google-Fonts query, which is a
human choice per institution. Update that line by hand when the sans font changes.
"""

import re
import sys
from pathlib import Path

import yaml

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent


def _sub_css_var(css: str, name: str, value: str) -> str:
    """Replace the value of a single `--name: <value>;` CSS custom property, preserving comments."""
    pattern = rf'(--{re.escape(name)}:\s*)[^;]+;'
    replacement = rf'\g<1>{value};'
    new_css, n = re.subn(pattern, replacement, css)
    if n == 0:
        print(f"  WARNING: --{name} not found in globals.css (skipped).", file=sys.stderr)
    return new_css


def apply_brand() -> None:
    """Write brand color + font tokens from institution.config.yaml into the web theme."""
    config_path = WORKSPACE_ROOT / "institution.config.yaml"
    css_path = WORKSPACE_ROOT / "src" / "app" / "globals.css"

    if not css_path.exists():
        print("globals.css not found — run sync_upstream.py first.", file=sys.stderr)
        return

    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    brand = config["brand"]
    colors = brand["colors"]
    typography = brand.get("typography", {})

    primary = colors["primary"]
    primary_dark = colors.get("primaryDark", "#7a2929")
    secondary = colors["secondary"]
    secondary_dark = colors.get("secondaryDark", "#E6B800")

    css = css_path.read_text(encoding="utf-8")
    css = _sub_css_var(css, "color-brand-crimson", primary)
    css = _sub_css_var(css, "color-brand-crimson-dark", primary_dark)
    css = _sub_css_var(css, "color-brand-gold", secondary)
    css = _sub_css_var(css, "color-brand-gold-dark", secondary_dark)
    if typography.get("sans"):
        css = _sub_css_var(css, "font-sans", typography["sans"])
    if typography.get("serif"):
        css = _sub_css_var(css, "font-serif", typography["serif"])
    css_path.write_text(css, encoding="utf-8")

    print(f"Brand applied to {css_path} (crimson={primary}, gold={secondary}).")


if __name__ == "__main__":
    apply_brand()
