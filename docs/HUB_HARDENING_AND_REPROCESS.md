# Hub Hardening + SJFU Reprocess — Root Cause & Patches

**Scope:** the CDI Factory hub on Spark (`spark-6284.local:~/projects/cdi-factory`, branch `feature/campus-swarm`). These are *drafted* here for review; nothing has been applied to the hub. Apply with confirmation.

---

## 1. Confirmed root cause

`program_requirement_courses = 0` for SJFU is the visible symptom of a **CUDA OOM during an in-process vLLM text-model reload**, hidden by a 6-layer graceful-degradation chain.

**Sequence (config has `vision_model == text_model`, both Gemma-26B):**
1. Vision phase loads Gemma as `_vision_model`.
2. Enrichment reuses it as `_text_model` (same-path branch in `_init_text_model`) — fine.
3. Orchestrator calls `free_text_model()` *before embedding* → clears **both** refs and `del`s the engine.
4. Embedding phase loads Qwen3-8B (resident, `gpu_memory_utilization=0.20`).
5. `populate_tables()` runs **after** embedding → `generate_text()` → `_init_text_model()`: `_vision_model` is `None`, so it tries to **load Gemma-26B fresh in-process** (`gpu_memory_utilization=0.85`) while Qwen3 is resident → **`torch.AcceleratorError: CUDA error: out of memory`** at `gpu_worker.init_device` → `_text_model_failed = True`.
6. Circuit-breaker then raises `"text model initialization previously failed and is disabled for this run"` for all 817 requirements (1,491 logged failures across SJFU catalogs).

**Downstream (the silent chain):** AST extractor swallows the exception → returns `None` → populator stores **raw markdown** in `logic_tree` → `RelationLinker` only falls back to regex on `JSONDecodeError`, scans breadcrumb text with no course codes → inserts 0 → orchestrator's `try/except` never fires (no hard exception) → run reports success + exports a pond.

**Ruled out:** `course_code` format is clean (`"ACCT 420"`); program↔course `document_id` overlap is total (4,501/4,501). The only defect is the missing ASTs.

**Blast radius is wider than one table.** The same circuit-breaker also disabled `_extract_program_metadata_via_llm` (degree types/credits) and `_extract_course_credits_via_llm`. **Treat all SJFU text-LLM enrichment as untrustworthy** — the reprocess must be a full re-enrich, not just a re-link.

---

## 2. The root fix (pick one) — eliminate the in-process reload

The hardening patches in §3 make failures loud; this section makes them *not happen*.

- **Option A — Server-backed provider (recommended).** The ingestion config already defines `base_url: http://127.0.0.1:8000/v1`. Run vLLM as a standalone OpenAI-compatible server and route the pipeline through the `SparkProvider` (HTTP) instead of the native in-process loader. A long-lived server manages its own VRAM; the pipeline never loads/frees/reloads engines, so the reload-OOM cannot occur. Cleanest, and it also unblocks the spoke's runtime Qwen3 query-embedding (same server).
- **Option B — Reorder so AST extraction happens while the text model is loaded.** Do logic-tree AST extraction during the *enrichment* phase (text model resident) and persist the AST onto the chunk/requirement, so `populate_tables` only *reads* ASTs and needs no LLM. Bigger refactor.
- **Option C — Separate-process populate (pragmatic, good enough for the SJFU reprocess now).** Run `populate_tables` in a **fresh process** with only the text model loaded (no embedder resident → clean VRAM → no OOM). See §4.

---

## 3. Hardening patches (fail-loud + warnings + data-quality gate)

> Drafted as edits to `~/projects/cdi-factory`. Line numbers approximate (branch `feature/campus-swarm`).

### Patch 1 — `src/export/table_populator.py` · `ProgramExtractor`: count AST outcomes, fail loud
Track whether the LLM AST step was attempted and how often it succeeded; expose it so the orchestrator can assert.

```diff
 class ProgramExtractor:
     def __init__(self, cur, provider=None):
         ...
+        self.ast_attempted = 0
+        self.ast_succeeded = 0
```
```diff
                         if degree_name not in existing_degrees:
                             logic_tree_content = content.strip()
                             if self.provider:
+                                self.ast_attempted += 1
                                 ast_json = self._extract_logic_tree_ast_via_llm(degree_name, logic_tree_content)
                                 if ast_json:
                                     logic_tree_content = ast_json
+                                    self.ast_succeeded += 1
```

### Patch 2 — `_extract_logic_tree_ast_via_llm`: distinguish "model disabled" from "bad output"
Re-raise the circuit-breaker so it is not silently swallowed as a per-degree miss.

```diff
         try:
             response_text = self.provider.generate_text(prompt)
             ...
         except Exception as e:
+            # A latched model-init failure is a run-level fault, not a per-degree miss —
+            # do not let it masquerade as "this degree had no parseable requirements".
+            if "initialization previously failed" in str(e):
+                logger.critical(
+                    "Text model is disabled for this run (init failed). "
+                    "Logic-tree ASTs cannot be built; aborting enrichment.")
+                raise
             logger.error(f"LLM logic tree AST extraction failed for {degree_name}: {e}")
         return None
```

### Patch 3 — `RelationLinker.link_program_requirements`: warn on non-JSON trees and zero links
```diff
         reqs = self.cur.fetchall()
+        nonjson = 0
         ...
             try:
                 ast_data = json.loads(logic_tree)
                 ...
             except (json.JSONDecodeError, TypeError):
+                nonjson += 1
                 # Fall back gracefully to plain-text regex parsing
                 ...
+        if reqs and total_links == 0:
+            logger.error(
+                f"link_program_requirements: {len(reqs)} requirements but 0 course links "
+                f"({nonjson} had non-JSON logic_tree). Likely the AST/text-LLM step was disabled.")
+        elif nonjson:
+            logger.warning(
+                f"link_program_requirements: {nonjson}/{len(reqs)} requirements had non-JSON "
+                f"logic_tree (regex fallback used).")
         return total_links
```

### Patch 4 — `src/export/table_populator.py` · `populate_tables`: assert before declaring success
```diff
         program_extractor = ProgramExtractor(cur, provider)
         extracted_programs = program_extractor.extract_from_chunks(chunks)
         program_extractor.insert_programs(extracted_programs)
+        # Fail loud: provider was supplied but every AST attempt failed → text model was down.
+        if provider and program_extractor.ast_attempted > 0 and program_extractor.ast_succeeded == 0:
+            raise RuntimeError(
+                f"populate_tables({tenant_id}): {program_extractor.ast_attempted} AST attempts, "
+                f"0 succeeded — text-LLM enrichment is broken. Refusing to export degraded data.")
```
```diff
         linker = RelationLinker(cur)
         links = linker.link_program_requirements(tenant_id)
+        cur.execute("SELECT count(*) FROM program_requirements WHERE tenant_id=%s;", (tenant_id,))
+        n_reqs = cur.fetchone()[0]
+        if n_reqs > 0 and links == 0:
+            raise RuntimeError(
+                f"populate_tables({tenant_id}): {n_reqs} requirements but 0 requirement→course "
+                f"links. Data-quality gate failed; not a valid catalog.")
```

### Patch 5 — `src/ingestion/orchestrator.py`: don't swallow populate failures
```diff
         try:
             from src.export.table_populator import populate_tables
             populate_tables(tenant_id, provider=provider)
         except Exception as e:
-            logger.error(f"Failed to populate tables: {e}")
+            logger.critical(f"populate_tables FAILED for {tenant_id}: {e}")
+            raise   # a degraded catalog must fail the run, not pass silently
```

---

## 4. SJFU reprocess runbook (pragmatic path, Option C)

Per-catalog (8 catalogs: grad/undergrad × 2022–2026). The chunks/embeddings are fine; only text-LLM enrichment + table population must be redone with the text model up.

```bash
ssh AdamPryorSpark   # or explicit key/host
cd ~/projects/cdi-factory && conda activate cdi_factory_env

# In a FRESH process with ONLY the text model loaded (no embedder resident → no OOM):
python - <<'PY'
from src.llm.providers import get_llm_provider
from src.export.table_populator import populate_tables
import yaml
cfg = yaml.safe_load(open("ingestion_config_sjfu_undergraduate_2025_2026.yaml"))
provider = get_llm_provider(cfg["llm"])     # loads Gemma fresh, clean VRAM
populate_tables("SJFU", provider=provider)  # rebuilds logic_tree ASTs → links
PY
```

Then verify the gate that should have existed:
```bash
python -c "import psycopg2; from src.utils.security import load_secure_key as k; \
c=psycopg2.connect(k('CDI_DATABASE_URL')).cursor(); \
c.execute(\"SELECT count(*) FROM program_requirement_courses WHERE tenant_id='SJFU'\"); \
print('links:', c.fetchone()[0])"
```
Expect a non-zero count. If still 0, the text model didn't load — check `nvidia-smi` for resident processes before running, and prefer Option A (server-backed provider).

**Recommendation:** adopt **Option A** for durability + adopt **Patches 1–5** so this can never again exit as a silent success. Mirror Patch 4's gate into the spoke factory's Phase-0 acceptance check.
