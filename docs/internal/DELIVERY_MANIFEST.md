# Delivery manifest — what the client receives

**Audience: Pryor Consulting.** A record of exactly what the handover repository contains, so the
delivered scope is knowable without opening the client's copy. In `docs/internal/`, therefore
excluded from that copy.

Generated `2026-08-24` from the tracked tree. Regenerate after any change with the command in §5.

---

## 1. The two trees

| | Your repository | Delivered repository |
| --- | ---: | ---: |
| Tracked files | 208 | 207 |
| Commits | full history | 1 |
| Location | `sjf_catalog/` | `sjf_catalog_handoff/` |

**They differ by exactly one file:** `docs/internal/`, which `.gitattributes` marks `export-ignore`
so `git archive` omits it. That directory holds this manifest and the execution checklist — the
commercial items, decommissioning steps, and delivery record that are ours rather than theirs.

Everything else is identical, byte for byte. The delivered repository is not a curated subset; it
is the same tree with one internal directory withheld.

---

## 2. What ships, by volume

| Files | Area |
| ---: | --- |
| 57 | Verification harness — checks, extraction, LLM client, tests, its own specification |
| 53 | Web application (`src/`) — dashboard, API routes, components, libraries |
| 26 | Database migrations (25 SQL + config) |
| 14 | Root configuration — `package.json`, `environment.yml`, `tsconfig`, `vercel.json`, `.env.example` |
| 12 | Root documentation |
| 11 | Reference documentation (`docs/`) |
| 10 | Swarm and ingestion services (`services/`) |
| 9 | Historical record (`docs/history/`) |
| 9 | Operational scripts |
| 5 | Migration playbooks |
| 1 | CI workflow |
| **207** | **total** |

---

## 3. The documentation set, and what each is for

**Entry points**

| Document | Purpose |
| --- | --- |
| `docs/REPOSITORY_SETUP.md` | First thing their team reads: creating their own repository, not forking, cloning a working copy |
| `README.md` | Orientation, environment setup, annual update playbook |
| `HANDOFF.md` | Architecture, ownership model, auditability |
| `OPERATIONS.md` | Administrator runbook and the named escalation contact |

**Transfer**

| Document | Purpose |
| --- | --- |
| `TRANSFER_RUNBOOK.md` | Ordered account and billing separation, with the ordering property that nothing is revoked until the replacement is proven |
| `docs/playbooks/D1_CATALOG_DATA.md` | Database migration, with baseline comparison and the link-table invariant |
| `docs/playbooks/D2_GCS_ASSETS.md` | 3,954 pages across 8 versions, plus the `markdown_url` rewrite that is easy to miss |
| `docs/playbooks/D3_WORKLOAD_IDENTITY.md` | Federation — the one thing that cannot be copied |
| `docs/playbooks/D4_SUPABASE_AUTH.md` | Redirect allowlist and the `user_roles` seed that no migration creates |
| `docs/playbooks/D5_CLOUD_RUN_SWARM.md` | Swarm deployment; unset token means 401 everywhere by design |

**Engineering**

| Document | Purpose |
| --- | --- |
| `CLAUDE.md` | Rules for AI assistants working in the repository, written from what has actually gone wrong here |
| `MAINTENANCE_GUIDELINES.md` | Engineering standards and verification discipline |
| `DEVELOPER_GUIDELINES.md` | Pointer to the above; kept so older references resolve |
| `SECURITY_HARDENING.md` | What was fixed, and a "Known, Not Fixed" section |
| `DOUBLE_CHECK.md`, `DOUBLE_CHECK_IMPLEMENTATION.md` | The verification harness's specification |
| `docs/DATA_CONTRACT.md` | Expected row counts and the non-zero link-table invariant |
| `docs/SELF_SERVE_INGESTION.md` | Client-run ingestion design and its limits |
| `docs/HUB_SPOKE_CONTRACT.md` | The hub/spoke boundary |

**Commercial**

| Document | Purpose |
| --- | --- |
| `LICENSE` | Proprietary; copyright Pryor Consulting; use granted; de-identified reuse retained |
| `docs/IP_AND_OWNERSHIP.md` | Ownership position on two grounds, and the term still to be written into the SOW |
| `docs/AI_PROMPT_INVENTORY.md` | Every prompt, marked commissioned / arguable / platform |

**History** — `docs/history/` carries nine planning and phase records, including the full Phase 7
work log. They are marked historical and describe superseded designs, but they are the record of
how the codebase reached its current state.

---

## 4. What is deliberately absent

| Not delivered | Why |
| --- | --- |
| `.env.local` and any credential | Gitignored; every value is theirs to provision. `.env.example` documents all 30 variables. |
| `.vercel/project.json` | Bound this working copy to our Vercel team. |
| `.claude/` | Per-developer tool permissions with local paths; untracked as of the handover. |
| Catalog data | ~39.5k chunks, ~6.9k courses. Lives in Postgres, moves via playbook D1. |
| GCS assets | The page markdown. Moves via playbook D2. |
| `docs/internal/` | This manifest and the execution checklist. |
| Development history | The delivered repository is one commit. Ours retains the full sequence. |

---

## 5. Regenerating

The delivered repository is rebuilt from the tracked tree, so it cannot drift from what is
committed here:

```bash
cd c:/Users/adamw/coding_workspaces
rm -rf sjf_catalog_handoff && mkdir -p sjf_catalog_handoff
cd sjf_catalog && git archive HEAD | tar -x -C ../sjf_catalog_handoff
cd ../sjf_catalog_handoff && git init -q -b main && git add -A && git commit -q -F <message>
```

Gates worth re-running after any regeneration:

```bash
git grep -i -l "ccsj\|calumet" -- ':!package-lock.json'          # expect no output
git ls-files | grep -E "^\.env\.local|^\.vercel|^\.claude"        # expect no output
git ls-files | grep docs/internal                                 # expect no output
python -m pytest verification_harness/tests                       # 92 passed, 16 skipped
```

The skips are expected on a clean checkout: those checks need a database or the artifacts of a
completed audit sweep, and they skip with a message saying which.
