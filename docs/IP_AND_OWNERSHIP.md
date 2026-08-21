# Intellectual property and ownership

> [!IMPORTANT]
> **Position recorded `2026-08-19`; not legal advice.** Copyright is held by Pryor Consulting, on two
> independent grounds: the agreement's deliverables are a set of AI bots, which is narrower than the
> platform in this repository; and its assignment clause is conditioned on final payment, which has
> not been made. St. John Fisher University receives the surrounding platform as a grant beyond
> scope. The boundary between commissioned bot work and the surrounding platform should be stated
> explicitly in the finalized Statement of Work — see §3.

## 1. The governing document

The only agreement available when this note was written is the **Project Charter for the Academic
Catalog AI Ecosystem, dated 2025-11-19**, between St. John Fisher University and Pryor Consulting.
Its intellectual-property section is three sentences long. In full, it provides that:

- work product becomes client property upon final payment;
- both parties agree to maintain confidentiality;
- Pryor Consulting may reference the client name with permission.

That is the entire IP provision.

## 2. What that means, and what it does not

**It is an assignment, not a shared-use arrangement.** On final payment, the work product becomes
the client's property. The document contains **no** retained licence, licence-back, reuse right,
joint-ownership, perpetual-use, or non-exclusive-rights clause of any kind — verified by searching
the full text for each of those terms and finding zero occurrences.

The clause is both scope-limited and conditional, which is why §3 turns on two separate questions —
*what* the agreement covers, and *whether* its condition has been met:

| | Commissioned bot deliverables | The surrounding platform |
| --- | --- | --- |
| Listed in the agreement's Deliverables section | Yes — nine bots, plus RFP bot and strategy support | No |
| Reached by the assignment clause | Yes, on final payment | No |
| Owner today | Pryor Consulting (payment outstanding) | Pryor Consulting (never in scope) |
| SJFU's position | Becomes client property on final payment | Granted use beyond scope |

**The practical consequence worth surfacing now:** `docs/history/BUILD_PLAN.md` describes extracting a reusable
"spoke generator" from this work so that future institutions can be stood up from the same
machinery, and `scripts/spoke/` exists for that purpose. Under an assignment clause with no retained
licence, reusing SJFU-funded work product for a different client is not something this document
authorises. If that reuse is intended — and the repository's own structure says it is — it needs an
explicit retained-licence term, which is an amendment, not an interpretation.

## 3. Current position

### Scope: the agreement is narrower than this repository

This is the primary ground, and it is visible in the document itself. The charter's **Deliverables**
section enumerates **nine modular AI bots** — catalog restructuring, ETL data hygiene, change
request and revision, scheduling, faculty load planning, course rotation tracking, prerequisite and
dependency checking, compliance checking, and sustainability tracking — plus an RFP Review Bot and
AI strategic-planning support. It states these will be delivered as *"digital assets (e.g., bot
scripts, documentation, training materials) and/or consulting reports."*

The platform in this repository is a different and much larger thing: a Next.js catalog management
application, a multi-tier verification harness, an ingestion pipeline, a spoke generator, and a
Postgres schema with row-level security. **None of that appears among the enumerated deliverables.**
It was not commissioned under this agreement. It is Pryor Consulting's own work, provided to
St. John Fisher University for its institutional use as a grant beyond the agreed scope.

The assignment clause therefore reaches the commissioned bot work product, not the surrounding
platform — so the retained rights in `LICENSE` follow from ownership that was never in scope to
transfer, rather than from an exception carved out of a transfer.

### Payment: the condition is unsatisfied in any case

Independently of scope, the assignment is conditioned on final payment for the final submission of
the work, and that payment has not been made. Even on the broadest reading of scope, no transfer has
occurred.

### The term that should still be written down

Two grounds are stronger than one, but only the second is unambiguous on the face of the document.
The scope argument depends on reading the enumerated deliverables as the limit of the work product,
and a few AI features here do correspond loosely to enumerated bots — the correction assistant
resembles the change-request bot, and the verification harness overlaps the prerequisite-and-
dependency and compliance checkers. The correspondence is partial, but it is the seam where a
disagreement would start.

**Recommendation: state the boundary explicitly in the finalized Statement of Work** — which
components are delivered bot work product, which constitute the platform provided as a grant, and
that Pryor Consulting retains the platform and may reuse it de-identified. Writing it down converts
a sound reading into a settled term, and costs nothing now.

**[AI_PROMPT_INVENTORY.md](AI_PROMPT_INVENTORY.md) exists to make that a list rather than an
argument.** It inventories every prompt and model call in the software and marks each as
commissioned, arguable, or platform. Its findings: five prompts implementing the catalog correction
pipeline are unambiguously the commissioned bot work; two verification-harness prompts are the
genuine seam and should be named explicitly either way; twelve implement features no enumerated
deliverable describes. Separately, six of the enumerated bots were built as **separate applications
handed over through their own routes**, so this codebase carries only part of the commissioned bot
work — relevant when scoping what this repository's transfer does and does not settle.

One lesser point remains open and does not affect `LICENSE`: the charter's client signature and date
lines are blank as filed.

## 4. Why this section exists at all

Two facts from this project make ownership more than a formality.

**Another institution's code was in this repository.** Until Phase 7, part of the backend and forty
frontend files were byte-pinned copies of a different client's codebase, and a fallback in
`src/lib/llm.ts` pointed model calls at that client's cloud project. If that engagement carried an
IP clause resembling this one, those files were that client's property and were sitting in SJFU's
repository. They have been removed in full — see `docs/history/PHASE7_OWNERSHIP_TRANSFER.md` §2.1 — and
`CLAUDE.md` §5 now forbids reintroducing any identifier belonging to another institution. This is
the strongest practical argument for settling ownership terms explicitly per engagement.

**The repository is being transferred.** `TRANSFER_RUNBOOK.md` moves the accounts, credentials, and
billing to the client. Ownership of the code should be settled in the same pass, not left implied by
possession of a GitHub repository.

## 5. Recommended next steps

1. **State the scope boundary in the finalized Statement of Work** (§3): which components are
   commissioned bot work product, which constitute the platform provided as a grant, and that Pryor
   Consulting retains the platform with a de-identified reuse right. Best settled before final
   payment, while terms are still open.
2. Confirm whether a finalized SOW supersedes the charter, and work from that if so.
3. Note that the charter's client signature and date lines are blank as filed; confirm execution.
4. Consider whether third-party dependency licences need an accompanying notice file. Nothing in
   this repository vendors third-party source today; dependencies are installed from `package.json`
   and `environment.yml`, so a NOTICE file is likely unnecessary — but it is worth one deliberate
   look rather than an assumption.
