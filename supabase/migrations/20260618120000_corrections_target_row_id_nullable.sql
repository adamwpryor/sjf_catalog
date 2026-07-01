-- Intake-extracted corrections are semantic proposals that are not yet mapped to a
-- concrete row. The registrar resolves target_row_id during review, so it must be
-- allowed to be NULL at insert time (the Intake Agent extracts changes by program/
-- subject name, which often has no single resolvable row — e.g. course-level edits).
ALTER TABLE corrections ALTER COLUMN target_row_id DROP NOT NULL;
