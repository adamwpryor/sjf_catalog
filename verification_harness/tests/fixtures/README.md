# tests/fixtures/ — frozen golden oracle

Checked-in, hand-verified JSON that the extractor's output is diffed against. This is the
**single source of truth** for Tier 0 extraction tests.

**Cross-authoring rule (Design Principle P1):** the agent who writes a module does **not**
write its fixtures. The extractor is built by Gemini, so its golden fixtures here are
authored by Claude from real cached pages (and vice versa for Claude-owned modules). This
is what stops a parser bug from being "confirmed" by a test written with the same blind spot.

Naming: `<version>__page_NNNN.json` — e.g. `2025-2026-undergraduate__page_0360.json`
(the `HIST-301` description page, a good `ancestor_path` + credits fixture).
