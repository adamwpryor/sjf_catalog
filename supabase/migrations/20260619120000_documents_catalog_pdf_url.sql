-- Step 4 (Sign-off & Publish) generates the catalog-of-record PDF from the corrected
-- database and uploads it to GCS. Record its location and generation time on the document.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS catalog_pdf_url text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS catalog_pdf_generated_at timestamptz;
