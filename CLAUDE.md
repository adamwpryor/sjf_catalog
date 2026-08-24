# CLAUDE.md — working rules for AI assistants in this repository

Read this before changing anything. It is not a style guide; it records the specific ways work in
this repository has actually gone wrong, and the checks that would have caught each one.

If you follow one thing here, follow §1.

---

## 1. Green checks are not evidence

Every incorrect change shipped in this project passed the checks its author ran. The checks were
green and true and did not touch the broken thing.

- A backend service was rewritten and reported `pytest: 108 passed` and `eslint: 0 errors`. Both
  were accurate. Neither imports the Python service, which could not start at all.
- Handoff documentation was written describing two modules that do not exist and CLI flags the tool
  has never had. It read plausibly because nobody executed it.
- A mass find-and-replace was validated by a repo-wide search returning zero — after the same script
  had rewritten the search's own target string.

**The rule: choose a check that would fail if you were wrong, then run it.**

| If you changed… | The check that can actually fail |
| --- | --- |
| Anything under `services/swarm/` | `python -c "import services.swarm.main as m; print(m.app.title, type(m._anthropic_client()).__name__)"` — must import and print `VertexShimClient` |
| `verification_harness/checks/` | Registry must be unchanged: `python -c "from verification_harness import cli; from verification_harness.checks import registry; print(sorted(registry.REGISTRY))"` |
| Any documentation containing commands | Run every command in it, once |
| Anything via scripted search-and-replace | Re-derive the search pattern from a source the script could not edit |
| `src/` TypeScript | `npm run typecheck && npm run lint` |
| Python anywhere | `python -m pytest verification_harness/tests` — 92 pass from a clean checkout with no credentials; 108 where artifacts and a database are present |

Most of the suite is hermetic and needs no credentials, which is a feature — and exactly why it
cannot tell you whether anything involving the database, the cloud, or the swarm still works.

**Do not test that hermeticity by unsetting environment variables.** `db.py` falls back to reading
`DATABASE_URL` out of `.env.local`, so an `env -u DATABASE_URL` run still finds credentials on a
developer machine and proves nothing. That check was run, believed, and wrong: two tests were
hitting the live catalog, and only building a fresh tree from `git archive` exposed it. To test a
clean checkout, extract one and run there.

## 2. Verify claims against the source, including claims in planning documents

Line numbers in this repo's planning documents were accurate when written and drift constantly.
Re-locate by content, never by line number. If a document tells you a file contains something,
open the file. Documents in this repository have been wrong about the codebase more than once —
including documents written by a previous assistant with high confidence.

When you find a document is wrong, say so and correct it. Do not build on it.

## 3. Never write a fallback for missing configuration

`MAINTENANCE_GUIDELINES.md` §3 states this, and violating it caused the most serious defect found in
this project: a missing `GCP_PROJECT_ID` silently fell back to a hardcoded cloud project belonging
to a *different client*, so every model call would have been billed and attributed to them.

```typescript
// Never
const projectId = process.env.GCP_PROJECT_ID || 'some-project';
// Always
const projectId = process.env.GCP_PROJECT_ID;
if (!projectId) throw new Error('GCP_PROJECT_ID environment variable is missing');
```

Missing configuration must fail loudly at startup. A default that "works" is a defect that hides
until it reaches production, and by then it is silently doing the wrong thing correctly.

## 4. Secrets

- No secret in source, config, scratch files, commit messages, or terminal output. Report variable
  *names* and file locations, never values.
- Real values live only in untracked `.env.local` or Conda env vars; `.env.example` is the tracked
  template and must stay in sync when you add a variable.
- Never print a connection string, key, or token — including when debugging. Parse and use it
  without echoing it.
- No PII in logs or outputs.

## 5. This codebase is owned outright

There is no vendored directory, no upstream mirror, no sync step. Edit any file directly.

This is stated because it was not always true, and stale documentation may still imply otherwise.
Earlier revisions maintained part of the backend and a set of frontend files as pinned mirrors of
another institution's repository. That relationship has been removed in full. If you encounter a
document describing `services/swarm/vendor/`, `UPSTREAM.lock`, `UPSTREAM_FRONTEND.lock`, or
`scripts/sync_upstream.py`, it is describing a system that no longer exists — see `HANDOFF.md` §2.

**No identifier belonging to another institution may re-enter this repository.** If you are porting
code, a prompt, or a document from elsewhere, strip institution names, project refs, bucket names,
brand colors, and deployment URLs before it lands.

## 6. Formatting: match the file, do not reformat it

This project has **no Black configuration** and is hand-wrapped at roughly 100–110 columns. Running
`black` at its 88-column default reformats essentially every Python file, and doing so once already
buried a mechanical refactor in fourteen unrelated rewrapped functions.

- Match the conventions of the file you are editing.
- If you must format, `black --line-length 110`.
- `ruff` is the linter; some files carry pre-existing debt. Do not fix unrelated lint in a change
  that is about something else — a small diff that a human can review beats a tidy one they cannot.
- Never let a formatter turn a two-line fix into a two-hundred-line diff.

## 7. Scope discipline

Do the task. Do not do the adjacent task you noticed on the way.

A previous pass, asked to remove one client's identifiers, also changed an unrelated configuration
value from correct-but-unused to wrong-but-unused. It was well-intentioned and it cost a review
cycle. If you spot something worth fixing outside your scope, write it down and say so — that is
valuable. Fixing it silently is not.

## 8. Environment

- **`conda` may not be on PATH.** If `conda activate` is unavailable, invoke the environment's
  interpreter directly rather than the system Python — on Windows that is
  `<conda-root>\envs\sjfu-catalog\python.exe`, with `pytest`, `ruff`, and `black` in the same
  environment's `Scripts\`; on macOS or Linux, `<conda-root>/envs/sjfu-catalog/bin/python`. Locate
  the root with `conda info --base`. Run everything from the repo root.
- Python dependencies go in `environment.yml` (conda-first, `conda install -c conda-forge` before
  pip), never a stray `requirements.txt`.
- Google Cloud auth is Application Default Credentials. If Vertex or GCS calls start failing while
  Supabase keeps working, ADC has expired: the fix is `gcloud auth application-default login`, not
  `gcloud auth login`, which refreshes a different credential store and looks like a fix but is not.
  Only the account owner can re-authenticate, interactively.

## 9. Writing to the database

Most of this codebase is read-only by construction and should stay that way.

- `verification_harness/db.py` opens a read-only session. A check *records a finding*; it never
  writes and never asserts.
- `verification_harness/remediate.py` is the only harness code that writes to the catalog. It is
  dry-run by default, backs up every affected cell in the same transaction, supports `--restore`,
  and acts only on `CONFIRMED` findings. Preserve all four properties.
- Several app routes write (catalog corrections, delta application, chunk re-sync). They are
  role-gated and rate-limited. If you touch one, the gate and the limit are part of the feature.

## 10. Git

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`). Mark breaking changes.
- Never force-push `main`; never `--no-verify` without explicit instruction.
- Commit messages should explain *why*, and should state plainly what was verified and what was not.
- Do not commit unless asked.

## 11. Where things are

| Document | What it is |
| --- | --- |
| `HANDOFF.md` | Architecture, auditability, ownership model. Start here. |
| `README.md` | Setup and the annual catalog update playbook. |
| `docs/DATA_CONTRACT.md` | Expected row counts. The non-zero link-table invariant lives here. |
| `docs/SELF_SERVE_INGESTION.md` | Design for client-run ingestion. |
| `MAINTENANCE_GUIDELINES.md` | Coding and engineering standards (`DEVELOPER_GUIDELINES.md` reframed). |
| `DOUBLE_CHECK.md` / `DOUBLE_CHECK_IMPLEMENTATION.md` | The verification harness's own specification. |
| `TRANSFER_RUNBOOK.md` + `docs/playbooks/` | Moving accounts, billing, and data to institutional ownership. |

`STATUS.md` used to sit in this list. It was deleted in Phase 7 because it described a months-old
scaffold state and would have misled a new team. If you find a document referring to it, that
reference is stale.
