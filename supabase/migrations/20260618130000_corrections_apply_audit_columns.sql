-- Audit columns for the "Apply Delta Corrections" production step.
--
-- corrections are tenant-scoped, not document-scoped, so applied_to_document_id
-- records which draft catalog an approved correction was actually written into.
-- applied_patch stores the structured old->new diff that was applied, for audit
-- and rollback.
ALTER TABLE corrections ADD COLUMN IF NOT EXISTS applied_to_document_id uuid;
ALTER TABLE corrections ADD COLUMN IF NOT EXISTS applied_patch jsonb;
