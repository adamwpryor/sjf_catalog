# Taking ownership of this repository

**Read this first.** You are reading it inside the delivery repository — the copy shared with you by
Pryor Consulting. That copy is the handover artifact, not your long-term home for the code. This
document walks through creating your own repository, moving the code into it, and cloning a working
copy from your own remote.

Do this before any configuration or deployment work. Everything else in `README.md` assumes you are
working from a repository your institution controls.

---

## 1. Do not fork

GitHub's Fork button is the obvious move and the wrong one here.

A fork stays permanently attached to the account it came from. The repository page carries a
"forked from" line indefinitely, it joins that account's fork network, and some administrative
actions on the upstream repository affect it. The entire point of this handover is that your
catalog platform stops depending on an outside account, so the copy must be independent from the
first commit.

Use one of the two methods below instead. Both produce a repository with no upstream relationship.

---

## 2. Create your repository

In your institution's GitHub organisation — not a personal account — create a new **private**
repository. Leave it completely empty: no README, no `.gitignore`, no licence file. Anything
GitHub adds will collide with the first push.

Name it for what it is rather than for this moment. Something like `sjf-catalog` will read
sensibly for years; a name containing "handoff" will not.

---

## 3. Move the code across

### Option A — push from a local clone (works everywhere)

```bash
# 1. Clone the delivery repository
git clone <delivery-repo-url> sjf-catalog
cd sjf-catalog

# 2. Point it at your own repository instead
git remote remove origin
git remote add origin https://github.com/<your-org>/sjf-catalog.git

# 3. Publish
git push -u origin main
```

Your repository now holds the code with no link to where it came from. Confirm it:

```bash
git remote -v          # should show only your organisation
git log --oneline      # a single commit: the delivered tree
```

### Option B — GitHub's importer

GitHub → **New repository** → **Import a repository**, and give it the delivery repository's URL.
This copies the content without creating a fork relationship. Use this if you would rather not run
git locally for the transfer; the result is equivalent.

---

## 4. Clone your working copy

Once your repository exists, work from it — not from the delivery copy:

```bash
git clone https://github.com/<your-org>/sjf-catalog.git
cd sjf-catalog
```

Then follow `README.md` §3 for environment setup: the Conda environment, Node dependencies, the
swarm service, and your own `.env.local`. **No credentials travel with this repository.**
`.env.example` lists all thirty variables the code reads and marks each as secret, config, or
public; every value is yours to provision.

---

## 5. What you have at this point, and what you do not

Cloning gives you the **software**. It does not give you a working catalog, because the repository
contains schema and no data — by design, since catalog content and credentials should not live in
source control.

Still to be moved into your accounts, each with its own playbook:

| What | Why it cannot simply be cloned |
| --- | --- |
| Catalog data | ~39.5k chunks and ~6.9k courses live in a Postgres database, not in git |
| GCS assets | The per-page catalog markdown the verification harness audits against |
| Workload Identity Federation | The provider is scoped to a Vercel team's OIDC issuer and must be created against yours |
| Supabase Auth | Redirect allowlist and `user_roles` seed rows exist in dashboard and table state, in no migration file |
| Cloud Run service | The Python swarm is built from `services/swarm/Dockerfile` into your own registry |

`TRANSFER_RUNBOOK.md` is the ordered sequence for all of it, and it is written so that the outgoing
infrastructure stays live until yours is verified. Nothing is switched off before you have a working
system.

---

## 6. First things worth running

From your clone, before configuring anything:

```bash
# Tests. 92 pass with no credentials at all; the rest skip with a message
# explaining whether they need a database or a completed audit sweep.
python -m pytest verification_harness/tests

# TypeScript and lint
npm install && npm run typecheck && npm run lint
```

If those pass, the code arrived intact. `.github/workflows/ci.yml` runs the same checks on every
push once your repository exists — note that this will be its first real execution, so treat an
early failure there as a packaging issue to resolve rather than a sign the code is wrong.

Then read, in this order: `README.md` for orientation, `HANDOFF.md` for architecture and the
ownership model, and `OPERATIONS.md` for the administrator runbook and who to contact.
