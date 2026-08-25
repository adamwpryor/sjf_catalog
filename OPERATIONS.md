# St. John Fisher University Catalog Platform — Operations & Administrator Runbook

**Audience:** System Administrators, Registrar Staff, and Technical Operators at St. John Fisher University (SJFU) or successor vendors.

**Purpose:** This runbook provides non-developer instructions for operating, auditing, maintaining, and executing annual catalog updates for the SJFU Academic Catalog Platform without requiring original author intervention.

---

## 1. System Architecture & Topology Overview

The SJFU Academic Catalog Platform consists of four primary runtime components:

| Component | Technology | Hosted On | Primary Function |
| --- | --- | --- | --- |
| **Web Frontend** | Next.js 16 / React 19 / TypeScript | Vercel Team | Interactive catalog navigation, curriculum graphs, diff logs, and administrative dashboards. |
| **Swarm Microservice** | Python 3.12 / FastAPI | Google Cloud Run | Keyless AI agents running on Vertex AI (`us-east5`) for manual entry assistance, page extraction, and delta processing. |
| **Catalog Database** | Supabase PostgreSQL + pgvector | Supabase Cloud | 23 replicated relational tables storing courses, programs, requirements, link tables, vector embeddings (`vector(1536)`), and RLS security policies. |
| **Asset Storage** | Google Cloud Storage | GCS (`gs://sjfu-assets`) | Store catalog PDF source files and per-page markdown assets (`catalogs/SJFU/<version>/pages/page_NNNN.md`). |

---

## 2. Annual Catalog Update Playbook

St. John Fisher University has two fully supported operational pathways for executing annual catalog refreshes.

### Path 1: Managed Service (Hub Ingestion)
If SJFU engages Pryor Consulting or a managed ingestion vendor, the vendor extracts the new catalog year using the central ingestion hub and replicates the 7 contract tables to SJFU's Supabase instance via `deploy_client_db.py`.

### Path 2: Self-Serve Ingestion (`scripts/ingest_self_serve.py`)
SJFU can run catalog updates independently on its own cloud infrastructure and AI billing.

#### Step 2.1: Pre-Flight Environment & Budget Verification
Ensure the Conda environment and Application Default Credentials (ADC) are active:

```bash
# 1. Activate Environment
conda activate sjfu-catalog

# 2. Verify ADC Google Cloud Credentials
gcloud auth application-default login

# 3. Estimate LLM Cost Ceiling ($25 Ceiling Default)
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --tier2-estimate
```

#### Step 2.2: Execute Stage A Acquisition (Source → Markdown Pages)
Convert published catalog assets (PDF/HTML) into structured markdown pages in GCS/cache:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --stage-a --source ./catalog_source/
```

#### Step 2.3: Execute Stage B Extraction & Dry-Run Preview
Process markdown pages into chunks, extract course/program facts, link tables, and preview contract counts:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --dry-run
```

#### Step 2.4: Execute Stage B Live Database Load
Write records transactionally into Supabase Postgres in FK-safe topological order:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --apply
```

Writing requires `--apply` explicitly; every other invocation is a preview. Passing both `--apply`
and `--dry-run` performs a dry run, so the safer flag wins.

---

## 3. Interpreting the 23-Table Database Census

Every self-serve run ends by printing the row count of **every** table in the replication set, not
only the ones it populated. The point is that a partial load cannot look like a complete one.

Real output from a dry run of `2025-2026-undergraduate`, abbreviated:

```
=== 23-Table Database Census ===
  documents                      Count: 8        Status: POPULATED
  semantic_chunks                Count: 39544    Status: POPULATED
  courses                        Count: 6929     Status: POPULATED
  programs                       Count: 592      Status: POPULATED
  program_requirements           Count: 702      Status: POPULATED
  program_requirement_courses    Count: 3371     Status: POPULATED
  course_prerequisite_links      Count: 3527     Status: POPULATED
  faculty                        Count: 104      Status: POPULATED
  course_prereq_blocks           Count: 0        Status: UNPOPULATED (OUT OF SCOPE)
  requirement_blocks             Count: 0        Status: UNPOPULATED (OUT OF SCOPE)
```

**The census reports the state of the database, not the size of the run.** After a dry run these
are your existing rows. Compare them before and after an `--apply` to see what a load actually did.

> [!IMPORTANT]
> **The contract invariant, and the one thing the self-serve path does not do.**
> `docs/DATA_CONTRACT.md` requires `program_requirement_courses` and `course_prerequisite_links` to
> both be non-zero; both being empty was the original silent-degradation failure.
>
> `scripts/ingest_self_serve.py` produces prerequisite edges but **does not derive program
> requirements**, and it says so at the end of every run. To satisfy the invariant you must run the
> requirement backfill after loading:
>
> ```bash
> node scripts/backfill_program_requirements.mjs
> ```
>
> Until it runs, programs will exist with no requirement rows attached, and the catalog is
> incomplete even though every other count looks healthy. This is stated rather than hidden because
> a plausible-looking count is exactly how the original failure went unnoticed.

## 4. Triage and Quality Assurance (`verification_harness`)

Audit the catalog database after ingestion using the independent verification harness:

```bash
# Tier 0 & 1 Hermetic Audit (Zero Cost, No Network)
python -m verification_harness --version 2025-2026-undergraduate

# Tier 2 Semantic Audit Cost Estimate
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 estimate

# Tier 2 Live Semantic Audit
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 live
```

---

## 5. Automated Catalog Remediation (`remediate.py`)

The remediation tool applies the narrow class of findings a deterministic single-column write can
repair. It is **dry-run by default**, backs up every affected cell in the same transaction, and acts
only on `CONFIRMED` findings. It takes a findings file and check ids — **not** a catalog version.

```bash
# Preview: plans and prints, writes nothing. Reviewing one check class at a time is recommended.
python -m verification_harness.remediate --checks B1

# Apply, backing up every affected cell first
python -m verification_harness.remediate --checks B1 --apply

# Reverse the most recent apply (or name one with --run-id)
python -m verification_harness.remediate --restore
```

## 6. User Access Administration

Accounts are created by invitation. There is no sign-up page, and no shared password — a route that
worked that way was removed during security hardening.

Adding someone takes one command, and it does **two** things that both have to happen: it creates
the account, and it writes the row that says what they are allowed to see. A user with an account
but no role signs in successfully and finds an empty application. That looks like a broken database
and is not one, so the tooling never does one half without the other.

### 6.1 Who has access

```bash
npm run user:list
```

Anything reading `NO ROLE` is the failure described above. `PENDING INVITE` means the account exists
but the person has not yet followed their link.

### 6.2 The roles

| Role | Can read the catalog | Can edit the catalog |
| --- | :---: | :---: |
| `viewer` | yes | no |
| `admin` | yes | no |
| `registrar` | yes | **yes** |
| `owner` | yes | **yes** |

`registrar` is the working role for staff who maintain catalog content. Grant `owner` sparingly.
One role per person: promoting someone is an update, not a second row.

### 6.3 Adding a user

**If email is configured** (§6.5), send an invitation. Leave off `--send` first — it dry-runs and
shows you exactly what it will do:

```bash
npm run user:invite -- --email someone@sjf.edu --role registrar          # preview
npm run user:invite -- --email someone@sjf.edu --role registrar --send   # send
```

**If email is not configured, or a message is not arriving,** mint the sign-in link and deliver it
yourself. This does not involve email at all and always works:

```bash
npm run user:link -- --email someone@sjf.edu --role registrar
```

The link is written to `artifacts/scratch/invite_links.txt`, which is excluded from version control.
**Each link is a credential**: whoever opens it becomes that user. Send one link to one person over a
channel you trust, then delete the file. Links are single-use and expire.

Either way the recipient chooses their own password, and nobody — including you — ever knows it.

To add several people at once, put one `email,role` per line in a file:

```text
bsosa@sjf.edu,owner
cbiehn@sjfc.edu,viewer
```

```bash
npm run user:invite -- --file invites.txt --send     # or: npm run user:link -- --file invites.txt
```

Staff addresses exist on **both** `sjf.edu` and `sjfc.edu` — the institution was a College before it
was a University and the older domain is still issued. Both are accepted. Anything else is refused
as a likely typo, because a mistyped address costs a wasted invitation and a support call;
`--allow-external` overrides that for deliberate exceptions, and names every address it admitted.

### 6.4 Removing a user

Delete the account in the Supabase dashboard under **Authentication → Users**. The role row is
removed automatically. To remove someone's access without deleting their account, drop their role —
see `docs/playbooks/D4_SUPABASE_AUTH.md` §4.

### 6.5 Two settings that make all of this work, and fail silently when wrong

Both live in the Supabase dashboard, not in this repository, so neither is covered by any test here.
Both were misconfigured at handover and are worth checking first whenever sign-in misbehaves.

**Email delivery.** Supabase's built-in mail service refuses to deliver to anyone who is not a member
of the Supabase project team, and refuses *after* reporting success. Invitations and "Forgot
password?" both appear to work and silently reach nobody. Configure custom SMTP under
**Authentication → Emails → SMTP Settings** — your own Microsoft 365 or Google Workspace mailbox is
the natural choice, since mail then arrives from a real institutional address. Test with an address
that is **not** on the project team; a team address would have worked anyway and proves nothing.

**The redirect allowlist.** Under **Authentication → URL Configuration**, the Site URL and Redirect
URLs must include the deployed application's address. When they do not, Supabase quietly rewrites
every invitation and password-reset link to point at whatever the Site URL says, and recipients land
somewhere that cannot sign them in. `npm run user:link` prints a warning when it detects this.

Keep `NEXT_PUBLIC_SITE_URL` in your environment matching that same address.

**Check both with one command:**

```bash
npm run user:check
```

It asks Supabase for a real sign-in link and inspects where that link points, which is the only way
to observe the allowlist from outside the dashboard. It creates nothing, changes nothing, sends
nothing, and exits non-zero when the redirect is wrong — so it can gate a migration checklist. Run
it after any change to the dashboard settings, and whenever someone reports that a link did not work.

A failure prints the exact values to enter:

```text
  FAIL  sign-in links return to http://localhost:3000, not https://catalog.example.edu
        Supabase substitutes its Site URL when the origin is not allowlisted.
```

It cannot check email delivery — nothing outside Supabase can observe a message that was accepted
and then discarded. Test that by inviting one address that is not on the project team.

Playbook `docs/playbooks/D4_SUPABASE_AUTH.md` covers both in full, with verification steps.

---

## 7. Escalation and Ownership

### Who to contact

**On handoff to St. John Fisher University, the escalation point is Bethsaida Sosa.**

Route to that contact anything this runbook does not resolve: a failed catalog load, an audit
finding nobody can interpret, a credential that has expired, or a decision about whether to engage a
managed ingestion vendor for the annual refresh (§2, Path 1).

Two limits worth stating plainly rather than discovering during an incident:

- **The original developer is not an on-call escalation path.** Pryor Consulting may be engaged for
  managed ingestion as a commercial arrangement (§2, Path 1), which is a service, not support.
- **Some credentials can only be renewed by their holder.** Google Application Default Credentials
  expire on an organisational session policy and must be refreshed interactively by the account
  owner — nobody else can do it on their behalf. See §4 troubleshooting.

### Reference documentation

- **Repository overview:** [README.md](README.md)
- **Architecture and ownership model:** [HANDOFF.md](HANDOFF.md)
- **Engineering standards:** [MAINTENANCE_GUIDELINES.md](MAINTENANCE_GUIDELINES.md)
- **Account and billing transfer:** [TRANSFER_RUNBOOK.md](TRANSFER_RUNBOOK.md)
- **AI features and costs:** [AI_ASSISTANTS.md](AI_ASSISTANTS.md)
- **Security posture and known gaps:** [SECURITY_HARDENING.md](SECURITY_HARDENING.md)
- **Expected row counts:** [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md)
- **Client-run ingestion design:** [docs/SELF_SERVE_INGESTION.md](docs/SELF_SERVE_INGESTION.md)
- **Prompt inventory and IP boundary:** [docs/AI_PROMPT_INVENTORY.md](docs/AI_PROMPT_INVENTORY.md) ·
  [docs/IP_AND_OWNERSHIP.md](docs/IP_AND_OWNERSHIP.md)
