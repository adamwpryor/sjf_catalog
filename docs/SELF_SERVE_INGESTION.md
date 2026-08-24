# Self-serve ingestion — design note

**Status:** **Stage B is built** (`scripts/ingest_self_serve.py`, `services/ingestion/`). Stage A —
producing the markdown page set from a published catalog — is still a design. Program requirements
are deliberately not derived; see §4 and run `scripts/backfill_program_requirements.mjs` after a
load. Measured output against the hub for the same catalog version is recorded in the project's
transfer history, retained by Pryor Consulting.

**Goal.** Let St. John Fisher produce a new catalog year themselves, on their own cloud and their
own model billing, without the ingestion hub. The hub-spoke contract stays live and unchanged — the
point is that using it becomes a choice rather than a dependency.

---

## 1. The constraint that shapes everything

**Both paths must write the same tables, in the same schema, to the same database.** The self-serve
path is an alternative *producer*, never a second format. If a hub-produced catalog and a
self-serve catalog differ in shape, every downstream consumer — the app, the verification harness,
the remediation tool, the PDF renderer — has to learn about two worlds, and the project has
acquired a permanent tax.

This is non-negotiable, and it is also what makes the work tractable: the target is already
specified by `docs/DATA_CONTRACT.md` and already checkable by the verification harness.

## 2. The seam: the markdown page set in GCS

The single most useful fact about the existing architecture is that the hub and the harness already
agree on an intermediate representation:

```
gs://sjfu-assets/catalogs/SJFU/<version>/pages/page_NNNN.md
```

`verification_harness/fetch.py` materializes that page set into a local cache, and Tier 0
(`extract/ast_extractor.py`) reads it as ground truth. The hub's job ends by producing those pages;
everything downstream consumes them.

**So the self-serve path splits at exactly that seam.** It needs two independent stages, and they
should be built and shipped separately:

| Stage | Input | Output | Notes |
| --- | --- | --- | --- |
| **A. Acquisition** | The published catalog (PDF or website) | The markdown page set in GCS | This is the part the hub does today and the only genuinely new capability. |
| **B. Extraction & load** | The markdown page set in GCS | The catalog tables in Supabase | Substantially assembled from parts that already exist in this repo. |

Splitting here has a concrete payoff: **Stage B is independently useful before Stage A exists.** If
SJF obtains markdown by any means — including Adam running the hub — Stage B lets them rebuild the
database themselves. And Stage A's output is verifiable on its own terms (a page set either exists
and parses or it does not) without waiting on the database work.

## 3. What already exists

Stage B is not a green-field build. The harness was written to independently re-derive the hub's
output in order to audit it, which means much of the extraction logic is already here:

| Capability | Where it already lives | Reuse |
| --- | --- | --- |
| Page fetch from GCS, incremental, never silently partial | `verification_harness/fetch.py` | Direct |
| Markdown → structured course/heading facts | `verification_harness/extract/ast_extractor.py` → `PageFacts` | Direct |
| Page-role classification (content / toc / index / …) | `extract/page_role.py` | Direct |
| Chunks → `program_requirement_courses` link rows | `scripts/backfill_program_requirements.mjs` | Port the matching logic |
| Chunk → recover/insert courses lost to code collisions | `scripts/backfill_course_codes.mjs` | Port the recovery logic |
| `markdown_url` provenance mapping | `scripts/backfill_source_pages.mjs` | Port |
| Embeddings, idempotent, `gemini-embedding-001` @ 1536 | `scripts/reembed.mjs` | Direct |
| Budgeted, cached, deterministic LLM calls | `verification_harness/llm/client.py` | Direct — see §5 |

**What is genuinely missing** is narrower than "build ingestion":

1. Stage A entirely (source → markdown pages).
2. Primary chunking — producing `semantic_chunks` with the `[Header 1: … > Header N: …]` breadcrumb
   form that the requirement-matching logic depends on.
3. An extraction layer that fills the fields the AST extractor does not produce. `ExtractedCourse`
   yields `code`, `title`, `credits`, `credits_raw`, `heading_line`, `ancestor_path` — but the
   `courses` table also has `description` and `prerequisites`, and `programs` /
   `program_requirements` have no deterministic extractor at all. This is where the model calls go.
4. A loader that writes the tables transactionally, in FK-safe order.

## 4. Scope staging — and the failure mode to design against

`deploy_client_db.py`'s `TABLE_ORDER` replicates 26 tables. They are not equally in scope:

- **Six global lookup registries** (`institutions`, `chunk_types`, `toulmin_roles`,
  `deontic_modalities`, `quinean_web_classifications`, `degree_classifications`) are static
  reference data, already present in the spoke, and upserted rather than purged. Out of scope.
- **The seven contract tables** — `documents`, `semantic_chunks`, `courses`, `programs`,
  `program_requirements`, `program_requirement_courses`, `course_prerequisite_links` — are the
  catalog itself and are exactly what `docs/DATA_CONTRACT.md` measures. **This is the B2 scope.**
- **Derived and adjacent layers** — the AIP-parity block/edge model (`course_prereq_blocks`,
  `course_prereq_edges`, `requirement_blocks`, `block_courses`), `ghost_log`, `faculty`,
  `program_faculty`, and the policy-mention tables — are out of scope for B2.

> [!WARNING]
> **A self-serve run must not silently produce a degraded catalog.** If the block/edge, faculty, and
> policy tables come back empty while the seven contract tables look healthy, the app will render a
> catalog whose prerequisite graph and faculty listings have quietly disappeared. This is the same
> shape as the original silent-degradation failure that `DATA_CONTRACT.md`'s "both link tables must
> be non-zero" invariant exists to catch.
>
> **Requirement:** a self-serve run must end by reporting the row count of *every* table in
> `TABLE_ORDER`, explicitly naming the ones it did not populate, and the operator documentation must
> state plainly which catalog features a Stage-B-only run does not deliver. Out of scope is
> acceptable; out of scope and unannounced is not.

## 5. The model provider seam

**Decision: build against Gemini only, behind a thin interface.** Gemini is the cost-appropriate
choice for structured extraction, it is what every other model path in this project already uses,
and it is the only provider whose credentials work here without an API key
(`verification_harness/llm/client.py` is keyless by design — Vertex ADC).

"An AI system they choose" is satisfied by putting the choice at a seam rather than shipping three
integrations nobody has asked to exercise. Concretely:

- Extraction calls go through **one module** with a narrow interface — roughly
  `extract(prompt, schema, *, key) -> dict`. No provider SDK types cross that boundary.
- The model id and region stay environment-configurable, as they already are elsewhere
  (`VERTEX_TIER2_MODEL`, `GOOGLE_CLOUD_LOCATION`).
- Adding a second provider later means writing one adapter, not refactoring the pipeline.

**Reuse `verification_harness/llm/client.py` rather than writing a second client.** It already
provides the three properties an ingestion run needs and that are tedious to rebuild: a hard USD
budget ceiling, a response cache (so a failed run resumes without re-paying), and deterministic
decoding (`temperature: 0.0`). It also already has the `estimate` mode, which gives the operator a
cost preview before committing — the same affordance the harness exposes as `--tier2 estimate`.

## 6. Acceptance — the test already exists

This is the strongest part of the design and the reason to prefer it over a bespoke validator.

1. **Row counts.** Hit `docs/DATA_CONTRACT.md` within tolerance, with the standing invariant that
   `program_requirement_courses` and `course_prerequisite_links` are both non-zero.
2. **The verification harness passes on the output.** The harness audits catalog rows against the
   source pages. It was built to check the hub's work; it checks a self-serve run *identically and
   without modification*. Tier 1 must be clean of new critical findings, and a Tier 2 run should not
   surface a new defect class.
3. **Provenance is real.** Every row carries a `markdown_url` pointing at a page that exists, and
   `page_number` is not uniformly 1 — the two defects `backfill_source_pages.mjs` was written to
   repair. Checks `C1`/`C5` already guard this.
4. **Full-table census** per §4, naming unpopulated tables.

Point 2 is what makes this genuinely trustworthy: the acceptance test was written by a different
process, for a different purpose, before this pipeline existed. It cannot have been tuned to pass
the thing it is checking.

## 7. Risks

- **Stage A is a research problem, not an engineering one.** PDF/web → clean per-page markdown is
  where quality is won or lost, and its output quality caps everything downstream. Do not scope
  Stage A by analogy to Stage B; build a small page sample end-to-end first and measure against the
  existing page set for a catalog the hub already produced. That comparison is free and decisive.
- **Cost is unbounded until measured.** Per-page extraction across ~3,954 pages is the largest model
  spend this project would incur. The budget ceiling and `estimate` mode are not optional.
- **Chunk breadcrumb format is load-bearing.** `backfill_program_requirements.mjs` matches programs
  to requirement rows through the `[Header 1: … > Header N: …]` breadcrumb. If self-serve chunking
  emits a different breadcrumb shape, the requirement link table silently comes back empty — the
  exact failure the contract invariant exists to catch. Treat the breadcrumb format as a contract
  and test it directly.
- **A partial run must not leave a half-written catalog.** The loader writes in FK-safe order and
  should be transactional per catalog version, with the existing replication ordering
  (`deploy_client_db.py TABLE_ORDER`) as the reference for both insert and reverse-order purge.
