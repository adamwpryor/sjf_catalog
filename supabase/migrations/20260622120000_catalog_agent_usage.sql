-- Usage log for the in-PDF correction agent: powers the per-user daily rate limit and an audit
-- trail of what was asked/applied. Written only by the server (pooled service connection); RLS is
-- enabled with no policies so it is inaccessible to client/authenticated roles.
CREATE TABLE IF NOT EXISTS catalog_agent_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  tenant_id text NOT NULL DEFAULT 'SJFU',
  document_id uuid,
  kind text NOT NULL,                 -- 'propose' | 'apply'
  vision_pages int NOT NULL DEFAULT 0,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalog_agent_usage_user_day ON catalog_agent_usage (user_id, created_at);
ALTER TABLE catalog_agent_usage ENABLE ROW LEVEL SECURITY;
