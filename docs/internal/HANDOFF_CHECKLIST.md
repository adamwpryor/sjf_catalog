# Handoff execution checklist — internal

**Audience: Pryor Consulting.** This is the execution plan, not a client deliverable. It contains
commercial items and decommissioning steps that do not belong in the client's repository, so
`docs/internal/` is marked `export-ignore` in `.gitattributes` and is excluded from the handoff
repository built by `git archive`.

The client-facing sequence is `TRANSFER_RUNBOOK.md`, which remains the master ordering. The
playbooks in §D are the depth behind its steps, not a second description of them — see the note in
§D about why that distinction matters here.

**The ordering property, restated because everything below depends on it:** the outgoing
infrastructure stays live and untouched until the client's replacement is proven end to end.
Nothing is revoked before §F.

---

## A. Commercial and decision items — before or alongside the technical work

| # | Item | Notes |
| --- | --- | --- |
| A1 | **Write the scope boundary into the finalized Statement of Work** | The one item with a real deadline: it must be agreed **before final payment**, because payment is what triggers the assignment clause. `docs/AI_PROMPT_INVENTORY.md` now names the components, so this is a drafting task rather than an analysis one. See `docs/IP_AND_OWNERSHIP.md` §3. |
| A2 | Confirm whether a finalized SOW supersedes the 2025-11-19 Project Charter | If one exists it governs, and the ownership note should be re-read against it. |
| A3 | Confirm charter execution status | The client signature and date lines are blank as filed. |
| A4 | Stand up the client-facing contact address | Belongs in `OPERATIONS.md` §6 beside the named escalation contact, which currently has a name and no contact method. |
| A5 | Advise on the permanent repository name | Theirs to choose, but a name containing "handoff" names a moment they will live with for years. |

---

## B. Repository and access

**Chosen model:** the delivery repository is a staging artifact. The client creates their own
repository in their organisation and takes a copy from it; they never work from ours. This settles
the ownership question by severance rather than by transfer — once they have their copy, ours can be
archived without affecting them. `docs/REPOSITORY_SETUP.md` walks their team through it and is
linked from the README as the first step on handover.

| # | Item | Notes |
| --- | --- | --- |
| B1 | Push the prepared tree to the private delivery repository | It is at `sjf_catalog_handoff/`: one commit, no history, deliberately no remote. `git remote add origin <url> && git push -u origin main`. |
| B2 | Share it read-only with the client team | Read access is sufficient — they are copying, not contributing. |
| B3 | Walk them through `docs/REPOSITORY_SETUP.md` | Creating their own repository, moving the code without forking, cloning their working copy. |
| B4 | **Confirm they did not fork** | A fork stays attached to our account permanently and defeats the severance. The document says so; verify it once rather than assume. |
| B5 | Archive the delivery repository | After their copy is verified and cutover is complete — `TRANSFER_RUNBOOK.md` §3.7. |

---

## C. Client account provisioning — prerequisite for everything in §D

Nothing in §D can be executed until these exist. The playbooks can be *written* first; they cannot
be *run* first.

- [ ] GCP project, with `aiplatform`, `run`, `iamcredentials`, `sts`, `storage`, `artifactregistry` enabled
- [ ] Supabase organisation and project
- [ ] Vercel team
- [ ] GitHub organisation (§B)

---

## D. Migration workstreams — one playbook each

> **Why these are separate documents when `TRANSFER_RUNBOOK.md` already exists.** The runbook is the
> ordered checklist; these are the procedures. The risk of having both is that they drift and a
> reader follows the stale one — this project has already hit exactly that with two guidelines
> documents asserting the same rules. Mitigation: the runbook keeps the sequence and links out;
> each playbook owns its commands, verification, and rollback, and those appear nowhere else.

| # | Playbook | Covers | The failure it must prevent |
| --- | --- | --- | --- |
| D1 | **Catalog data migration** | Moving ~39.5k chunks, ~6.9k courses, programs, requirements and the prerequisite graph from the outgoing Supabase project to the client's | A partial restore that looks healthy. Must end by checking `docs/DATA_CONTRACT.md` counts and the non-zero link-table invariant. |
| D2 | **GCS assets** | Copying `gs://sjfu-assets` — the per-page catalog markdown the harness treats as ground truth | Silent partial copy. Object counts must match per catalog version, and stored `markdown_url` values must resolve after the move. |
| D3 | **Workload Identity Federation** | A new pool and provider in the client's GCP project, trusting the client's Vercel team | **Cannot be copied — the provider is scoped to a Vercel team's OIDC issuer.** Getting the issuer mode wrong fails only in deployment, never locally. |
| D4 | **Supabase Auth** | Redirect allowlist, and the `user_roles` seed | Dashboard and table state that exists in no migration file. Without the seed, RLS locks everyone out of a technically-working deployment. |
| D5 | **Cloud Run swarm service** — *added to your four* | Building `services/swarm/Dockerfile` into the client's Artifact Registry and deploying it, with `SWARM_API_TOKEN` set | If the token is unset the service refuses every request with 401 by design, and five of the seven AI features fail with no obvious cause. |

Vercel project setup — all 30 variables from `.env.example` plus the cron schedule in `vercel.json` —
is covered by `TRANSFER_RUNBOOK.md` §3.5 and does not need its own playbook.

---

## E. Verification while both systems are live

Run against the client's stack with the outgoing one still serving.

- [ ] App loads; login works through the client's Supabase Auth
- [ ] An assistant query returns a real answer — proves Vercel OIDC → GCP STS → Vertex end to end
- [ ] `python -m verification_harness --version <v> --tier2 estimate` prices a run against the client's database
- [ ] A Tier 1 harness run completes and writes findings
- [ ] Swarm reachable and authenticated: `/health` answers; an agent route returns 401 without a token
- [ ] CI green on the client's repository — its first real execution
- [ ] Row counts match `docs/DATA_CONTRACT.md` within tolerance

---

## F. Cutover, then revocation — in this order

- [ ] DNS to the client's deployment
- [ ] Rotate the Supabase service-role key and database password
- [ ] Revoke outgoing service-account keys; delete the old WIF provider
- [ ] Remove Pryor Consulting access from the client's GCP, Vercel and Supabase
- [ ] Archive or transfer the originating GitHub repository (B5)
- [ ] Decommission the original Vercel project and Supabase project
- [ ] **One full billing cycle later:** confirm $0.00 recurring against Pryor Consulting accounts. Until a cycle closes at zero, the transfer is not complete.

---

## G. Known gaps to carry forward — flagged, not blocking

| Gap | Status |
| --- | --- |
| `--apply` has never run against a database | The loader's SQL was proven against the live schema inside a rolled-back transaction, but no real write has happened. **The first load must target a scratch catalog version, not a live one.** |
| `program_requirement_courses` is not derived by self-serve ingestion | `scripts/backfill_program_requirements.mjs` must run after any self-serve load, or the contract invariant is unsatisfied. The CLI says so on every run. |
| Stage A — published catalog to markdown pages — is not built | Until it is, producing a new academic year's page set needs whoever operates the ingestion pipeline. |
| CI has never executed | The conda environment has only ever been built on Windows and `weasyprint` pulls a native stack; the first run may need packaging iteration. |
| `getSession()` used for authorization across 12+ routes | Systemic and pre-existing; recorded in `SECURITY_HARDENING.md` under "Known, Not Fixed". |
