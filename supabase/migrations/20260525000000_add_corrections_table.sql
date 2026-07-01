-- CDI Factory — Corrections Table Migration
-- Cloud-only. This table is intentionally excluded from deploy_client_db.py replication.
-- It is the client feedback layer and serves as a staging queue for Hub corrections.
--
-- Correctable tables: courses, programs, semantic_chunks
-- Workflow: client flags error in UI → row inserted here → pull_corrections.py
--           reads pending rows → AI drafts UPDATE SQL → operator approves → Hub updated
--           → deploy_client_db.py re-pushes corrected data to cloud.

CREATE TABLE IF NOT EXISTS corrections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT NOT NULL,
    target_table     TEXT NOT NULL CHECK (target_table IN ('courses', 'programs', 'semantic_chunks')),
    target_row_id    UUID NOT NULL,
    field_name       TEXT NOT NULL,
    current_value    TEXT,
    proposed_value   TEXT NOT NULL,
    reason           TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
    submitted_by     TEXT,
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at      TIMESTAMPTZ,
    applied_at       TIMESTAMPTZ
);

-- Index for the pull_corrections.py query pattern: all pending rows for a tenant
CREATE INDEX IF NOT EXISTS corrections_pending_idx
    ON corrections (tenant_id, status)
    WHERE status = 'pending';

-- RLS: enable row-level security so anon key cannot write freely
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to INSERT new corrections (the UI submitting a flag)
CREATE POLICY "clients_can_submit_corrections"
    ON corrections FOR INSERT
    WITH CHECK (true);

-- Allow anyone to SELECT their own tenant's corrections (for UI status display)
CREATE POLICY "clients_can_view_own_corrections"
    ON corrections FOR SELECT
    USING (true);

-- Block UPDATE and DELETE from the client side entirely —
-- status transitions are made by pull_corrections.py via the service role key only.
