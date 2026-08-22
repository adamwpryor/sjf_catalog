# Playbook D1 — Catalog data migration

Moves the catalog itself — courses, programs, requirements, the prerequisite graph, and the
embedded chunks — from the outgoing Supabase project into yours.

`TRANSFER_RUNBOOK.md` §3.2 is the ordered place this step sits. This document owns the commands,
the verification, and the rollback; they are not repeated there.

**The failure this is written against:** a restore that completes without error and leaves a
catalog that is quietly incomplete. Row counts are the only thing that catches it, which is why
§4 is not optional.

---

## 1. Before you start

- The 25 migrations in `supabase/migrations/` have been applied to the target, so the schema and
  the `pgvector` extension already exist. **This is a data-only migration.** If the schema is not
  there yet, stop and apply migrations first — restoring data into a missing schema produces a
  confusing partial failure.
- You have the direct Postgres connection string for both projects. Supabase exposes it under
  Project Settings → Database. Use the **direct** connection, not the pooled one, for dump and
  restore.
- `pg_dump` and `psql` are available and their major version is **at least** the server's.

Never place either connection string in a file that gets committed. Export them for the session:

```bash
export SOURCE_DB='postgresql://...'   # outgoing project
export TARGET_DB='postgresql://...'   # yours
```

---

## 2. What moves, and the one table that does not behave like the others

Twenty-three tables replicate. They fall into three groups:

| Group | Tables | Note |
| --- | --- | --- |
| Reference registries | `institutions`, `chunk_types`, `toulmin_roles`, `deontic_modalities`, `quinean_web_classifications`, `degree_classifications`, `subjects` | Small, static. Restore first — everything else references them. |
| Catalog content | `documents`, `semantic_chunks`, `courses`, `programs`, `program_requirements`, `program_requirement_courses`, `course_prerequisite_links` | The seven tables `docs/DATA_CONTRACT.md` measures. |
| Derived and adjacent | `course_prereq_blocks`, `course_prereq_edges`, `requirement_blocks`, `block_courses`, `ghost_log`, `faculty`, `program_faculty`, `policy_mentions_courses`, `policy_mentions_programs` | Move them too. They are populated in the source and their absence degrades the app quietly. |

**`corrections` is different.** It is the client feedback layer and the source of truth for pending
corrections — `deploy_client_db.py` marks it cloud-only and never wipes it. If the outgoing project
holds pending corrections that matter to you, migrate it deliberately and last. If you are starting
your review queue fresh, leave it empty and say so, rather than discovering later that submitted
corrections were dropped.

---

## 3. Procedure

### 3.1 Capture a baseline you can compare against

Do this **before** dumping. It is the number you will check the restore against.

```bash
psql "$SOURCE_DB" -At -F',' -c "
  SELECT 'courses', count(*) FROM courses UNION ALL
  SELECT 'programs', count(*) FROM programs UNION ALL
  SELECT 'program_requirements', count(*) FROM program_requirements UNION ALL
  SELECT 'program_requirement_courses', count(*) FROM program_requirement_courses UNION ALL
  SELECT 'course_prerequisite_links', count(*) FROM course_prerequisite_links UNION ALL
  SELECT 'semantic_chunks', count(*) FROM semantic_chunks UNION ALL
  SELECT 'documents', count(*) FROM documents
  ORDER BY 1;" | tee baseline_source.csv
```

### 3.2 Dump data only

```bash
pg_dump "$SOURCE_DB" \
  --data-only \
  --no-owner --no-privileges \
  --schema=public \
  --exclude-table-data='public.corrections' \
  -Fc -f catalog_data.dump
```

`--data-only` because the schema is already in place. `--no-owner --no-privileges` because
Supabase manages roles differently between projects and carrying them across causes permission
errors on restore. `corrections` is excluded here and handled separately per §2.

### 3.3 Restore

```bash
pg_restore \
  --data-only \
  --no-owner --no-privileges \
  --disable-triggers \
  --single-transaction \
  -d "$TARGET_DB" catalog_data.dump
```

`--single-transaction` is the important flag: either the whole catalog lands or none of it does,
and a failure halfway leaves nothing to clean up. `--disable-triggers` defers foreign-key checks so
table order does not matter; if your role cannot disable triggers, drop that flag and restore in
the group order in §2 instead.

### 3.4 Re-check the sequences

If any table uses a serial or identity column, restoring rows does not advance its sequence, and
the next insert collides. Most keys here are UUIDs, but verify rather than assume:

```bash
psql "$TARGET_DB" -c "
  SELECT sequence_schema, sequence_name FROM information_schema.sequences
  WHERE sequence_schema = 'public';"
```

If any are listed, reset each with `setval` against the maximum value of its owning column.

---

## 4. Verification — the part that can actually fail

### 4.1 Counts must match the source and the contract

```bash
psql "$TARGET_DB" -At -F',' -c "
  SELECT 'courses', count(*) FROM courses UNION ALL
  SELECT 'programs', count(*) FROM programs UNION ALL
  SELECT 'program_requirements', count(*) FROM program_requirements UNION ALL
  SELECT 'program_requirement_courses', count(*) FROM program_requirement_courses UNION ALL
  SELECT 'course_prerequisite_links', count(*) FROM course_prerequisite_links UNION ALL
  SELECT 'semantic_chunks', count(*) FROM semantic_chunks UNION ALL
  SELECT 'documents', count(*) FROM documents
  ORDER BY 1;" | diff - baseline_source.csv && echo "counts match source"
```

Then compare against `docs/DATA_CONTRACT.md`. A difference between the source and the contract is
not automatically an error — the contract is re-baselined periodically — but it must be explained,
not waved through.

### 4.2 The link-table invariant

```bash
psql "$TARGET_DB" -At -c "
  SELECT
    (SELECT count(*) FROM program_requirement_courses) AS prc,
    (SELECT count(*) FROM course_prerequisite_links)   AS cpl;"
```

**Both must be non-zero.** Both coming back empty was the original silent-degradation failure this
system was built to detect: every page still renders, and the curriculum graph is simply gone.

### 4.3 Embeddings survived as vectors, not text

```bash
psql "$TARGET_DB" -At -c "
  SELECT count(*) FILTER (WHERE embedding IS NOT NULL),
         count(*),
         vector_dims((SELECT embedding FROM semantic_chunks WHERE embedding IS NOT NULL LIMIT 1))
  FROM semantic_chunks;"
```

Expect the third value to be **1536**. If embeddings are null across the board, retrieval silently
degrades to full-text search and nobody notices until answers get worse — repair with
`npm run reembed`, which only touches null rows.

### 4.4 The independent check

Point `DATABASE_URL` at the target and run the audit that was built for exactly this question:

```bash
python -m verification_harness --version 2025-2026-undergraduate
```

Tier 1 is deterministic and costs nothing. A clean run against a freshly restored database is
stronger evidence than any count comparison, because it re-derives the catalog from the source
pages rather than trusting the rows.

---

## 5. Rollback

The target is a new project, so rollback is truncation rather than restoration. In reverse
dependency order, inside one transaction:

```sql
BEGIN;
TRUNCATE policy_mentions_programs, policy_mentions_courses, program_faculty, faculty,
         ghost_log, block_courses, requirement_blocks, course_prereq_edges, course_prereq_blocks,
         course_prerequisite_links, program_requirement_courses, program_requirements,
         programs, courses, semantic_chunks, documents
  RESTART IDENTITY CASCADE;
COMMIT;
```

Reference registries are left in place — they are static and re-restoring them is harmless.
`corrections` is deliberately absent from that list; truncating it would destroy client feedback
that exists nowhere else.

If `--single-transaction` was used in §3.3 and the restore failed, nothing was committed and no
rollback is required.
