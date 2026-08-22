# Playbook D2 — GCS asset migration

Copies the per-page catalog markdown from the outgoing bucket into yours.

`TRANSFER_RUNBOOK.md` §3.2 is where this sits in the sequence. This document owns the commands,
the verification, and the rollback.

**Why this matters more than "some files in a bucket."** These pages are the ground truth the
verification harness audits the database against. Tier 0 reads them and every finding cites one. If
the copy is short by a few hundred pages, the harness does not error — it reports that those pages
contain no courses, which reads as a coverage defect in the catalog rather than a missing file.
A partial copy therefore produces confident, wrong findings.

---

## 1. Layout

```
gs://<bucket>/catalogs/SJFU/<version>/pages/page_NNNN.md
```

Eight catalog versions, **3,954 pages** in total:

| Version | Pages |
| --- | ---: |
| 2022-2023-graduate | 249 |
| 2022-2023-undergraduate | 646 |
| 2023-2024-graduate | 227 |
| 2023-2024-undergraduate | 629 |
| 2024-2025-graduate | 295 |
| 2024-2025-undergraduate | 784 |
| 2025-2026-graduate | 353 |
| 2025-2026-undergraduate | 771 |
| **Total** | **3,954** |

Counts observed 2026-08. Treat them as the expected shape, and re-measure the source before copying
rather than trusting this table — it is a snapshot, and drift is exactly what you are checking for.

---

## 2. Before you start

- Your GCP project exists with `storage.googleapis.com` enabled.
- You can read the source bucket and write to yours.
- `gcloud` is authenticated as an identity holding both permissions.

```bash
export SRC_BUCKET='gs://sjfu-assets'
export DST_BUCKET='gs://<your-bucket>'
```

---

## 3. Procedure

### 3.1 Measure the source first

```bash
for v in 2022-2023-graduate 2022-2023-undergraduate \
         2023-2024-graduate 2023-2024-undergraduate \
         2024-2025-graduate 2024-2025-undergraduate \
         2025-2026-graduate 2025-2026-undergraduate; do
  n=$(gcloud storage ls "$SRC_BUCKET/catalogs/SJFU/$v/pages/**" | wc -l)
  echo "$v,$n"
done | tee source_page_counts.csv
```

### 3.2 Create the destination bucket

Match the source's region if you can — the harness fetches every page on a `--sync`, and
cross-region reads are slower and billed differently.

```bash
gcloud storage buckets create "$DST_BUCKET" \
  --project=<your-project> \
  --location=<region> \
  --uniform-bucket-level-access
```

### 3.3 Copy

```bash
gcloud storage rsync --recursive --checksums-only \
  "$SRC_BUCKET/catalogs" "$DST_BUCKET/catalogs"
```

`rsync` rather than `cp` so the operation is resumable and re-runnable: interrupt it, run it again,
and it transfers only what is missing. `--checksums-only` compares content rather than timestamps,
which is what you want when the question is "did every byte arrive."

---

## 4. Verification

### 4.1 Per-version counts match

```bash
for v in $(cut -d, -f1 source_page_counts.csv); do
  src=$(grep "^$v," source_page_counts.csv | cut -d, -f2)
  dst=$(gcloud storage ls "$DST_BUCKET/catalogs/SJFU/$v/pages/**" | wc -l)
  [ "$src" = "$dst" ] && echo "ok   $v ($dst)" || echo "MISMATCH $v: source $src, dest $dst"
done
```

Every line must read `ok`. A short version is the failure mode described at the top of this
document, and it does not announce itself later.

### 4.2 Content survived, not just the file count

```bash
gcloud storage cat "$DST_BUCKET/catalogs/SJFU/2025-2026-undergraduate/pages/page_0174.md" | head -5
```

Expect readable catalog markdown — a `##` course heading with a code, title and credit count. If
you see empty output or a truncated file, the copy moved names without contents.

### 4.3 The database's stored URLs resolve against the new bucket

This is the step people skip. Every `courses`, `programs`, and `semantic_chunks` row carries a
`markdown_url`, and those still point at the **old** bucket after a copy.

```bash
psql "$TARGET_DB" -At -c \
  "SELECT DISTINCT split_part(markdown_url, '/', 3) FROM semantic_chunks WHERE markdown_url IS NOT NULL;"
```

If that returns the old bucket name, rewrite the column before going live:

```sql
BEGIN;
UPDATE semantic_chunks SET markdown_url = replace(markdown_url, 'sjfu-assets', '<your-bucket>')
  WHERE markdown_url LIKE '%sjfu-assets%';
UPDATE courses          SET markdown_url = replace(markdown_url, 'sjfu-assets', '<your-bucket>')
  WHERE markdown_url LIKE '%sjfu-assets%';
UPDATE programs         SET markdown_url = replace(markdown_url, 'sjfu-assets', '<your-bucket>')
  WHERE markdown_url LIKE '%sjfu-assets%';
COMMIT;
```

Set `GCS_BUCKET` and `GCP_BUCKET_NAME` to the new name in the same pass — the code reads both, and
they must agree.

### 4.4 The end-to-end check

```bash
python -m verification_harness --version 2025-2026-undergraduate --sync
```

`--sync` pulls every page from the bucket into the local cache and refuses to proceed on a partial
fetch. Check `C1` and `C5` in the findings: they exist to catch rows pointing at a bucket other than
the configured one, which is precisely the mistake §4.3 prevents.

---

## 5. Rollback

Copying is additive and the source is untouched, so rollback is deleting the destination:

```bash
gcloud storage rm --recursive "$DST_BUCKET/catalogs"
```

If §4.3 was applied and you need to reverse it, run the same `UPDATE` statements with the bucket
names swapped. Do that **before** deleting the destination, or the application will point at a
bucket that no longer exists.
