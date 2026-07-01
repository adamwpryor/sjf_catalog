-- Catalog-scoped PDF presentation overrides set by the in-app correction agent.
-- These are *rendering* corrections (regroup / rename / hide) that buildCatalogHtml applies
-- on top of its grouping heuristic. They are reversible and scoped to a single document.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS presentation_overrides jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN documents.presentation_overrides IS
  'Catalog-scoped PDF presentation overrides (regroup/rename/hide) applied by the renderer on top of the grouping heuristic. Set by the in-app correction agent; reversible.';
