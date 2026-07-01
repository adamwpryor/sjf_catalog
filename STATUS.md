# STATUS — pick up here

_Last updated: 2026-06-27. Short orientation note; the real detail is in `BUILD_PLAN.md` + `IMPLEMENTATION_PLAN.md`._

## Where things stand
- **Project = the first "spoke"** (St. John Fisher University, `tenant_id = SJFU`), built by lift-and-adapt of the CCSJ catalog app, plus a reusable spoke generator. Goal is a repeatable way to stand up a catalog spoke from a PDF the CDI Factory hub already ingested.
- **Scaffold is in place and builds** (P0 done): Next.js 16 + Tailwind tooling, `environment.yml` (conda `sjfu-catalog`), `.env.example`, `DEVELOPER_GUIDELINES.md`, `institution.config.yaml`, `services/swarm/`, `scripts/spoke/`. `npm install` + conda env both done.
- **Embeddings settled (important):** we use the **hosted `gemini-embedding-001` API @ 1536**, exactly like CCSJ — NO self-hosted GPU. (A Qwen3-on-Cloud-Run-GPU attempt was built and **torn down**; Cloud Run's L4 driver is too old for vLLM+Qwen3. Don't reopen that.)
- **Hub data is good:** the CDI Factory agent fixed the two extraction gaps — `program_requirement_courses` 0→2,402 and `course_prerequisite_links` 46→2,939 (live-verified). A larger "AIP-parity" hub upgrade (program de-dup, prereq/requirement *logic blocks*) is specced in `docs/HUB_UPGRADE_AIP_PARITY.md` but **not yet done**.

## Not committed yet
- The scaffold + all planning docs are **uncommitted on `main`**. Commit on a branch when ready (per the Adam Pryor Standard).

## Next steps (in order)
1. **Commit the scaffold** (branch e.g. `chore/project-scaffold`).
2. **Decide:** wait for the hub AIP-parity upgrade before loading spoke data, or load now and re-load later. (Loading good data once = wait; see `BUILD_PLAN.md` gate 0.2.)
3. **Phase 0/1 — provision the spoke DB** into Supabase project `zkoimkcctqigisfeqlpv` ("SJF-Catalog-Project", us-east-2, empty): run the allow-listed migrations (**keep the 1536 Gemini embedding migration; omit accreditation; RLS = single-tenant `auth.uid()`**), then `deploy_client_db.py --tenant-id SJFU` from the hub.
4. **Re-embed** chunks with Gemini on load (P3), then lift/adapt the CCSJ UI (P4+).

## What's needed from Adam to proceed
- **`GEMINI_API_KEY`** (or Vertex SA) — for embeddings. → secret store / `.env.local`, never committed.
- **Spoke Supabase keys + `DATABASE_URL`** for `zkoimkcctqigisfeqlpv` — secure channel.
- **SJF logo files** (request form pending) — only gates final branding (P9).
- **Deploy target** for the frontend (Vercel vs Cloud Run).

## Key facts to not re-derive
- **Supabase projects (names nearly identical — use refs):** spoke = `zkoimkcctqigisfeqlpv` (build here). AIP benchmark = `thsrwztyvqjkhcfzapnl` (READ-ONLY, never touch). CCSJ = `hbqjlqphevhuargxkisv`.
- **Hub access:** `ssh -i "…/NVIDIA Corporation/Sync/config/nvsync.key" adamwpryor@spark-6284.local` (the `AdamPryorSpark` alias doesn't resolve in Git Bash).
- **Brand:** Cardinal Red `#993333`, Gold `#FFCC33`; Book Antiqua (serif) + Libre Franklin (sans).
- **Docs:** `BUILD_PLAN.md` = the execution runbook (P0–P10, gates). `IMPLEMENTATION_PLAN.md` = strategy/decisions/root-causes. `docs/` = hub contract, AIP benchmark, hub-upgrade spec.
