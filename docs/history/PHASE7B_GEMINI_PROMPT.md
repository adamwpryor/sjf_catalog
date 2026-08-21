# Phase 7 Group C kickoff — hardening and handoff documentation

Give this whole file to Gemini. Group A is complete and verified. Claude wrote `CLAUDE.md` (C1) and
the ingestion design note (B1); the protocol resumes normally with you at C2.

---

## Read `CLAUDE.md` first. It is binding.

It is new, it is short, and it exists because of what happened in Group A. Section 1 is the one that
matters: **the checks you ran were green, true, and could not have detected the defect you shipped.**

In Group A you de-vendored the swarm and reported `pytest: 108 passed` and `eslint: 0 errors`. Both
were accurate. Neither imports the Python service — which could not start at all, because
`_anthropic_client()` still annotated a dropped import, and the Vertex factory was imported but
never wired, so every agent pointed at a client requiring an API key this deployment cannot have.
Every swarm feature was dead and all reported checks stayed green.

That is not a scolding; it is the single most useful thing to carry into Group C. Before you mark
anything done, ask: *what check would fail if I were wrong?* Then run that one.

## Your assignment

Tasks **C2 through C9** of `PHASE7_OWNERSHIP_TRANSFER.md` §6, in the order below — which is
deliberately not numerical order. **C4 is excluded** and explained at the end. C1 is done; C10 is
Adam's; C11 is Claude's verification.

### Order of work, and why

**1. C9 — CI first, not last.** `.github/workflows/ci.yml`. This moves to the front because
everything after it gets checked by something you did not choose. Run on push and pull request:
`pytest verification_harness/tests` (hermetic — needs no secrets), `ruff check verification_harness/`,
`npm run lint`, `npm run typecheck`, **and a swarm import smoke test**:

```bash
python -c "import services.swarm.main as m; assert type(m._anthropic_client()).__name__ == 'VertexShimClient'; print('swarm ok')"
```

That last line is not optional. It is the exact check whose absence let a dead service through, and
adding it is the durable fix. Note `environment.yml` now declares `python-multipart`; CI must
install from `environment.yml` or the swarm import will fail for that reason alone.

*Acceptance:* the workflow file is valid YAML, every step's command runs locally and passes, and the
swarm smoke test genuinely fails if you temporarily break the wiring (try it, then undo it).

**2. C2 — security hardening.** `SECURITY_HARDENING.md` documenting each item, plus the fixes for
`PHASE7_OWNERSHIP_TRANSFER.md` §2.2 items 1–4 and §2.2b. Highest-value first:

- **Fail-open auth** (`services/swarm/main.py`): an unset `SWARM_API_TOKEN` currently passes every
  request through with only a log warning. It must refuse to serve instead.
- **The permanently open LLM endpoint**: `/api/agent/manual-entry-assistant` is auth-exempt *and*
  called directly from the browser (`TrackingDashboard.tsx:252`), so it is an unauthenticated,
  billable channel into the cloud project. Propose a fix; do not silently break the feature.
- **Destructive GET** (`src/app/api/clean-database/route.ts`): deletes behind a `GET` with the secret
  in the query string, which lands in logs and browser history.
- **Shared-password self-provisioning** (`src/app/api/auth/tester/route.ts`): creates real users via
  the service-role admin API.
- **§2.2b stubs**: `delta-processor`, `curriculum-auditor`, `diagnostics-analyst` return canned
  success text on a live service. Make them return an explicit not-implemented status or remove them.

Adam's standing recommendation is to **remove** the tester route and the `clean-database` route
outright rather than harden them. Confirm in your work-log entry before deleting anything, and if
you disagree, say so instead of proceeding.

*Acceptance:* swarm imports and the smoke test passes; `pytest` green; `npm run typecheck` and
`lint` clean; every changed route exercised or, if you cannot exercise it, said so plainly.

**3. C8 — configuration hygiene.** §2.4 of the plan: roughly 19 environment variables are read by
code but appear in neither `.env.example` nor `.env.local`; `APP_TENANT_ID` is dead config (nothing
reads it — the tenant is hardcoded at `src/lib/brand.ts:15`); `institution.config.yaml` and
`BUILD_PLAN.md` name `SJFU_SWARM_URL` while the code reads `NEXT_PUBLIC_SWARM_API_URL`; the two
Vertex regions disagree (`us-central1` in TypeScript, `us-east5` in Python); the WIF provider
default is `'vercel'` in code but `vercel-team` in `.env.example`; and machine-bound paths remain in
`pyrightconfig.json` and `scripts/backfill_course_codes.mjs` (which defaults to a temp scratchpad
directory on the original author's machine). Also **delete `STATUS.md`** — it describes June, says
the scaffold is uncommitted, and would strand a new team.

For `APP_TENANT_ID`, decide deliberately: either wire it up so `brand.ts` reads it, or delete it.
Do not leave it present-but-ignored, and do not change its value to a placeholder.

*Acceptance:* `.env.example` documents every variable the code reads, with a comment marking each
secret vs config; `npm run typecheck` and `pytest` still pass; no path in a tracked file points at a
machine-specific location.

**4. C3 — `AI_ASSISTANTS.md`.** Twelve AI features across three stacks with different credentials.
Per feature: user-facing name and where it is triggered, the route or file implementing it, the
exact model id and provider path, what it does in one sentence, and **whether it writes to the
database** (five do). Include the *deliberately-not-AI* list — the curriculum graph audit, the
nightly remediation cron, and the harness remediation tool are fully deterministic, and an operator
who assumes otherwise will distrust correct output. Note that every swarm agent actually runs
`gemini-2.5-pro` on Vertex regardless of the historical model constant, because the client is the
Vertex shim.

*Acceptance:* every model id and file path in the document verified against source. This is the
document most likely to be quietly wrong, and Phase 6 produced exactly that failure.

**5. C5 — `MAINTENANCE_GUIDELINES.md`.** Reframe `DEVELOPER_GUIDELINES.md`, which is currently
titled "The Adam Pryor Standard". The standards are sound and should survive; the personal framing
should not. Add what Group A taught: verify with a check that can fail, and match file formatting
rather than reformatting.

**6. C6 — `TRANSFER_RUNBOOK.md`.** Expand §3 of the plan into an executable checklist with the full
environment-variable inventory and every re-pointing site. Preserve the ordering property that makes
it safe: **the original owner's credentials stay live until the replacement is proven**, and nothing
is revoked until §3.7. End with the §3.8 zero-bill confirmation.

**7. C7 — README rewrite.** Last of the documentation, because it must describe the world C2 and C8
leave behind. Ownership-neutral: no reference to the original author, his machines, or his paths. It
already contains a verified annual-update playbook — preserve its accuracy and re-verify every
command still works after your C2/C8 changes.

### Why C4 is excluded

`OPERATIONS.md` is the administrator runbook and must cover **both** ingestion paths. The self-serve
path does not exist yet — it is designed in `docs/SELF_SERVE_INGESTION.md` and implemented as task
B2. Writing C4 now would document a workflow nobody can run. It follows B, not C.

## Rules of engagement

- **`CLAUDE.md` governs.** Where this prompt and `CLAUDE.md` disagree, tell us rather than picking.
- **Scope discipline (`CLAUDE.md` §7).** Do the task, not the adjacent one. If you spot something
  worth fixing outside scope, write it in the work log — that is genuinely useful — but do not fix
  it. Group A changed an unrelated config value from correct to wrong this way.
- **No scripted mass-substitution without re-deriving the check from a source the script cannot
  edit.** In Group A a sweep rewrote the acceptance gate's own definition, so the gate could not
  have failed.
- **Do not reformat** (`CLAUDE.md` §6). No Black at default width; `--line-length 110` if you must.
- **Do not commit.** Leave the tree dirty; Claude verifies, Adam approves.
- **Stop and report after each task**, not at the end of all seven. A wrong assumption in C9
  compounds through six more tasks otherwise.

## How to report

Flip each row in `PHASE7_OWNERSHIP_TRANSFER.md` §6 Group C to `GEMINI-DONE` only when the task is
complete **and its acceptance check passed**, and append one work-log entry per task with real
command output — not paraphrase. State explicitly which check you chose as the one that could have
failed, and what it printed.

If a spec here is wrong, or a fix would break a feature, say so in the work log and stop that task.
An honest blocker costs nothing; a false `GEMINI-DONE` costs a full verification round trip, and
Group A cost several.
