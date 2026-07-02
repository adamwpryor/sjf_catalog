---
version: "1.0"
name: "St. John Fisher University — Catalog Platform Design System"
description: >-
  Machine- and human-readable brand + UI style spec for the SJF Catalog spoke.
  Coding agents and humans both consume this: change design decisions HERE and in
  institution.config.yaml, never as ad-hoc literals in components.
institution:
  legal_name: "St. John Fisher University"
  short_name: "Fisher"
  tenant_id: "SJFU"
sources:
  official_brand: "https://www.sjf.edu/services/style-guide/colors-and-typography/"
  tone_reference: "academic-intelligence-platform (AIP) web/src/app/globals.css"
  implemented_tokens: "institution.config.yaml → src/lib/brand.ts → src/app/globals.css"

# --- Canonical brand colors (OFFICIAL SJF palette — both are PRIMARY) ---
colors:
  brand:
    cardinal:      "#993333"   # Cardinal Red — PMS 201 C · RGB 153,51,51 · CMYK 27,90,81,22
    cardinal_dark: "#7a2929"   # derived depth (hovers, gradient mid)
    gold:          "#FFCC33"   # Gold — PMS 116 C · RGB 255,204,51 · CMYK 0,19,89,0
    gold_dark:     "#E6B800"   # derived depth
  # Approved warm-editorial alternates (from AIP; use for large fills / gradients where the
  # bright official hues are too light on dark surfaces — NOT as replacements for the brand hex).
  alternates:
    cardinal_saturated: "#9F1B22"  # AIP sjf-red
    cardinal_deepest:   "#5A0F13"  # AIP gradient end (dark cardinal well)
    gold_amber:         "#F2A900"  # AIP university gold (richer amber)
  neutrals:
    ink:      "#1A1A1A"   # body text on light
    gray:     "#808285"   # secondary text / borders (UI neutral, NOT brand)
    gray_dark:"#4f5154"
    slate:    "#B6CFD6"   # cool accent (UI neutral, legacy)
    surface_warm: "#F7F5F2"  # light editorial panel
    off_white:    "#FAF3F3"  # warm cardinal-tinted paper (print/PDF)
  themes:
    operator_dark:      # the in-app "glass" console (browse / audit / correct)
      background: "#090d16"
      foreground: "#f1f5f9"
    editorial_light:    # catalog PDF + print output (Fisher house style)
      background: "#FFFFFF"
      foreground: "#1A1A1A"
      surface:    "#F7F5F2"
  semantic:
    success: "#10b981"
    warning: "#F2A900"
    danger:  "#dc2626"
    info:    "#B6CFD6"

typography:
  # Official SJF print faces: Book Antiqua, Franklin Gothic Suite, Libre Gothic,
  # Distinct Style Sans, Libre Franklin → mapped to web-available equivalents below.
  display:  # headings / catalog titles
    family: "'Book Antiqua', 'Palatino Linotype', Palatino, Georgia, serif"
    weight: 700
    tracking: "-0.02em"
  body:
    family: "'Libre Franklin', 'Franklin Gothic', Arial, sans-serif"  # Libre Franklin = Google Font
    weight: 400
  mono:
    family: "ui-monospace, 'Cascadia Code', Menlo, monospace"
  scale:   # rem
    h1: 3.0
    h2: 2.25
    h3: 1.5
    body: 1.0
    small: 0.8125
    label_caps: 0.75   # letterSpacing 0.15em, uppercase

radius:   { sm: "6px", md: "10px", lg: "16px", xl: "24px", full: "9999px" }
spacing:  { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "40px", "2xl": "64px" }
elevation:
  glass: "backdrop-blur(12px); background: rgba(15,23,42,0.55); border: 1px solid rgba(182,207,214,0.12)"
  card:  "0 1px 3px rgba(0,0,0,0.4)"

components:
  button_primary:
    background: "{colors.brand.cardinal}"
    hover:      "{colors.brand.cardinal_dark}"
    text:       "#FFFFFF"
    radius:     "{radius.md}"
  button_accent:
    background: "{colors.brand.gold}"
    text:       "{colors.neutrals.ink}"
  panel:
    style: "{elevation.glass}"
    radius: "{radius.lg}"
  badge_brand:
    background: "rgba(153,51,51,0.12)"
    border:     "rgba(153,51,51,0.35)"
    text:       "{colors.brand.gold}"
---

# St. John Fisher University — Catalog Platform Design System

> **This is the design harness.** It is the single source of style truth for the SJF Catalog
> spoke, for both humans and coding agents. The YAML frontmatter above is the machine-readable
> spec; the sections below are the rationale and rules. **To change a design decision, edit this
> file and `institution.config.yaml` — then run `python scripts/apply_brand.py`. Never hand-paint
> hex literals into components.**

## 1. Brand foundation

St. John Fisher University's identity is **two primary colors — Cardinal Red and Gold** — over a
warm, collegiate, editorial character. The catalog platform must read unmistakably as *Fisher*, not
as generic SaaS and never as its CCSJ ancestor. Everything here derives from the
[official SJF style guide](https://www.sjf.edu/services/style-guide/colors-and-typography/).

| Role | Name | HEX | RGB | CMYK | Pantone |
|---|---|---|---|---|---|
| **Primary** | Cardinal Red | `#993333` | 153, 51, 51 | 27, 90, 81, 22 | PMS 201 C |
| **Primary** | Gold | `#FFCC33` | 255, 204, 51 | 0, 19, 89, 0 | PMS 116 C |

Both are *primary* — Fisher uses them as an equal pair (cardinal as the dominant field, gold as the
signal/accent), not primary-plus-secondary. These two hex values are **canonical and non-negotiable**
for brand surfaces (logos, headers, primary actions, print).

## 2. Color system

### 2.1 Canonical tokens
The brand colors live as tokens, wired config → theme → CSS:

- `institution.config.yaml → brand.colors` (source of truth)
- [src/lib/brand.ts](src/lib/brand.ts) `BRAND.colors` (importable by server + client)
- [src/app/globals.css](src/app/globals.css) `@theme` → `--color-brand-crimson`, `--color-brand-gold`, …

| Token | Value | Use |
|---|---|---|
| `--color-brand-crimson` | `#993333` | primary brand field, primary buttons, header rules |
| `--color-brand-crimson-dark` | `#7a2929` | hover/pressed, gradient mid |
| `--color-brand-gold` | `#FFCC33` | accent, highlights, active/selected, badge text |
| `--color-brand-gold-dark` | `#E6B800` | gold hover/depth |
| `--color-brand-gray` / `-dark` | `#808285` / `#4f5154` | **neutral** UI text/borders (not brand) |
| `--color-brand-slate` | `#B6CFD6` | cool neutral accent (legacy; prefer gold for brand accent) |

### 2.2 Two themes, one brand
The platform is deliberately bi-modal:

1. **Operator console (dark "glass").** The working app — browse, inspect, audit, correct — ships a
   dark glassmorphism shell (`--background: #090d16`, `--foreground: #f1f5f9`) with cardinal and gold
   as luminous accents on deep field. This is the product's design language; keep it.
2. **Editorial / print (light).** Generated **catalog PDFs and any print-facing output** use the
   light Fisher house style: white/`#F7F5F2` paper, `#1A1A1A` ink, Book Antiqua display, cardinal
   section rules, gold dividers. This is where Fisher's collegiate editorial voice lives.

> Do **not** flip the whole operator console to a light theme casually — it inverts contrast across
> every component. A light-mode console is a scoped design project, not a token swap.

### 2.3 Approved warm-editorial alternates (from AIP)
The Academic Intelligence Platform established a slightly deeper, warmer Fisher palette. Use these
**only** for large fills and gradients where the bright official hues wash out on dark surfaces —
never in place of the canonical brand hex on logos or primary chrome:

- Saturated cardinal `#9F1B22`, deepest cardinal well `#5A0F13` → cardinal gradients
  (`linear-gradient(#9F1B22 → #5A0F13)`).
- Amber gold `#F2A900` → large gold fills that would glare at `#FFCC33`.
- Warm paper `#FAF3F3` → cardinal-tinted off-white for print backgrounds.

### 2.4 Accessibility & contrast
- Body text must meet **WCAG AA (≥ 4.5:1)**. Gold `#FFCC33` on white is **failing** for text — use
  gold only on dark fields or as a non-text accent; for gold-on-light *text*, darken to `#8a6d00`.
- Cardinal `#993333` on white passes for large/bold text; verify small text.
- Never encode meaning in color alone — pair with icon or label (registrar vs. viewer, error states).

### 2.5 Don'ts
- ❌ No CCSJ maroon/`#8C2232`, slate-only branding, or the old dark-maroon field as *the* brand.
  (Note: [login/page.tsx](src/app/login/page.tsx) still hardcodes `#8C2232`/`#B6CFD6` — migrate these
  to `--color-brand-crimson`/tokens.)
- ❌ No raw hex in components when a token exists.
- ❌ Don't pair cardinal and gold at equal area as vibrating fills; gold is the smaller signal.

## 3. Typography

Official SJF print faces (Book Antiqua, Franklin Gothic Suite, Libre Gothic, Distinct Style Sans,
Libre Franklin) mapped to web-available equivalents:

| Role | Stack | Notes |
|---|---|---|
| **Display / headings** | `'Book Antiqua', 'Palatino Linotype', Palatino, Georgia, serif` | catalog titles, section heads, `.serif-title` |
| **Body / UI** | `'Libre Franklin', 'Franklin Gothic', Arial, sans-serif` | Libre Franklin loaded via Google Fonts in globals.css |
| **Mono** | `ui-monospace, 'Cascadia Code', Menlo, monospace` | codes, IDs, diagnostics |

Wired as `--font-serif` / `--font-sans` in [globals.css](src/app/globals.css) `@theme`; Tailwind
`font-serif` / `font-sans` utilities resolve to these. Scale: h1 3rem / h2 2.25 / h3 1.5 / body 1rem;
uppercase label-caps at 0.75rem, `letter-spacing: 0.15em`.

## 4. Logo & iconography
**Status: PENDING.** SJF logos are not directly downloadable; they require the official
**Logo Request form (Asana)**. On receipt, drop files at the paths already declared in
`institution.config.yaml → brand.logo`:
- `public/brand/fisher-logo-color.svg` (light backgrounds)
- `public/brand/fisher-logo-white.svg` (dark backgrounds — the operator console)
- `public/brand/favicon.ico`

Until then, use the wordmark treatment: **"Fisher"** in Book Antiqua + `INSTITUTION.appTitle`
("Fisher Catalog") from [brand.ts](src/lib/brand.ts). Never recreate or distort the seal.

## 5. Layout, spacing, elevation
- **Radius:** sm 6 / md 10 / lg 16 / xl 24 / full. Panels use `lg`; buttons/inputs `md`.
- **Spacing scale:** 4 / 8 / 16 / 24 / 40 / 64.
- **Glass system:** `.glass-panel` = `rgba(15,23,42,0.55)` + `blur(12px)` + hairline
  `rgba(182,207,214,0.12)`; `.glass-panel-hover` warms the border to cardinal `rgba(153,51,51,0.35)`
  with a soft cardinal glow. This is the console's signature — reuse it, don't reinvent per view.

## 6. Components
| Component | Spec |
|---|---|
| **Primary button** | cardinal `#993333` bg → hover `#7a2929`, white text, radius md |
| **Accent button** | gold `#FFCC33` bg, ink text — reserve for the single highest-signal action |
| **Panel / card** | glass system, radius lg, cardinal-on-hover |
| **Brand badge / chip** | bg `rgba(153,51,51,0.12)`, border `rgba(153,51,51,0.35)`, gold text, uppercase label-caps |
| **Input** | dark field `#0a0f1d`, `white/10` border, focus ring cardinal |
| **Data table** | zebra on `white/[0.02]`, gold left-rule on the active row, mono for codes/IDs |
| **Status** | success `#10b981` · warning `#F2A900` · danger `#dc2626` · info `#B6CFD6` — always with an icon |

## 7. Voice & tone
Fisher is **collegiate, precise, and warm** — a university registrar's voice, not a startup's.
- Plain, authoritative, no hype. "Apply approved corrections," not "✨ Supercharge your catalog."
- Academic register: catalog, program, prerequisite, requirement, remediation — used correctly.
- Errors are respectful and actionable: what happened + what to do, with a correlation ID.
- Cardinal for authority, gold for a moment of pride/emphasis — mirror that restraint in copy.

## 8. Implementation map (how style flows)
```
institution.config.yaml  (brand tokens — SOURCE OF TRUTH; Adam edits)
        │  python scripts/apply_brand.py   (idempotent generator)
        ▼
src/lib/brand.ts          (typed tokens; imported by server + client)
src/app/globals.css       (@theme CSS vars + font imports; Tailwind v4 utilities)
        ▼
components consume tokens  (font-serif/font-sans, brand-crimson/brand-gold, .glass-panel)
```
**Rule:** change brand values in the config and re-run `apply_brand.py`; do not diverge literals into
components. Presentation/brand files are the *divergent* bucket per `BUILD_PLAN.md §4A` and are not
tracked against CCSJ upstream — style them freely here.

## 9. Sources & provenance
- **Official brand (authoritative):** SJF style guide — colors & typography (Cardinal `#993333`/PMS 201 C, Gold `#FFCC33`/PMS 116 C; Book Antiqua / Libre Franklin family).
- **Warm-editorial tone reference:** AIP `web/src/app/globals.css` — `sjf-red #9F1B22`, `sjf-red-dark #7d1218`, `sjf-gold #F2A900`, gradient `#9F1B22 → #5A0F13`.
- **Implemented tokens:** `institution.config.yaml`, [src/lib/brand.ts](src/lib/brand.ts), [src/app/globals.css](src/app/globals.css).
- **Note:** the Spark `agentswarm/.gemini/skills/engineering/style-enforcer` harness enforces *code* style (Ruff/Black/MyPy), not visual design; this document is the visual-design counterpart.
