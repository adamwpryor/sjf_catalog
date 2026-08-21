# AI prompt inventory — the commissioned bot work product

**Purpose.** The engagement's deliverables were a set of modular AI bots, delivered as bot scripts,
documentation, and training materials. The platform around them — the web application, the
verification harness, the ingestion pipeline, the spoke generator, the database schema — was not
commissioned under that agreement. This document lists **every prompt and model call written into
this software**, so the boundary between the two is a list rather than an argument.

Read alongside `IP_AND_OWNERSHIP.md`, which sets out the ownership position, and `AI_ASSISTANTS.md`,
which describes the same features from an operator's point of view.

> [!NOTE]
> This is an engineering inventory prepared to inform a commercial discussion; it is not a legal
> determination and does not assign anything. Where a mapping is arguable it is marked arguable,
> because a boundary document that quietly resolves its own hard cases is not useful to either party.

---

## 1. How to read this

Each entry gives the prompt's identifier, where it lives, what it instructs the model to do, and how
it maps to the enumerated deliverables. Three mapping verdicts are used:

| Verdict | Meaning |
| --- | --- |
| **Commissioned** | Implements an enumerated bot deliverable. Squarely the paid work product. |
| **Arguable** | Serves a purpose an enumerated bot names, but is built as platform instrumentation rather than as that bot. The seam where a disagreement would start. |
| **Platform** | Not among the enumerated deliverables. Infrastructure the platform needs to function. |

Prompts are quoted only in fragments sufficient to identify them. The full text lives in the cited
source files, which are the authoritative copy.

---

## 2. Catalog correction pipeline — five prompts

The clearest match to an enumerated deliverable. Together these implement the **Change Request &
Revision Bot** ("processes stakeholder feedback and tracks catalog change requests"), and the
restructuring operations overlap the **Catalog Restructuring Bot**.

All five live in `services/swarm/main.py` and run on Vertex Gemini.

| Prompt | Location | Function | Verdict |
| --- | --- | --- | --- |
| `EXTRACT_SYSTEM_PROMPT` | `services/swarm/main.py` | Pulls approved curricular changes out of committee minutes — *"only motions that actually passed, not discussion, deferrals, or items tabled"* | **Commissioned** |
| `MANUAL_ENTRY_SYSTEM_PROMPT` | same | Conversationally shapes a registrar's edit into a structured correction, asking clarifying questions where a change *"might require updating course prefixes or prerequisites"* | **Commissioned** |
| `RESOLVE_SYSTEM_PROMPT` | same | Maps one approved plain-English correction onto concrete code-keyed edits; *"NEVER copy or infer a prerequisite (or any value) from a DIFFERENT candidate row"* | **Commissioned** |
| `REWRITE_CHUNK_SYSTEM_PROMPT` | same | Rewrites a narrative chunk only where it genuinely covers the affected item — *"If the chunk does not genuinely cover the affected item, make NO change"* | **Commissioned** |
| `CORRECTION_SYSTEM_PROMPT` | same | Classifies an in-PDF correction as rendering or data change and emits a structured plan; carries the promote/merge/rename/hide operation vocabulary | **Commissioned** (restructuring operations also serve the Catalog Restructuring Bot) |

The institution name is injected into `CORRECTION_SYSTEM_PROMPT` from `INSTITUTION_LEGAL_NAME`
rather than hardcoded, so these prompts carry no institution-specific content of their own.

---

## 3. Catalog assistant — three prompts

Natural-language question answering over the catalog. **No enumerated deliverable describes a
catalog Q&A assistant.** The nine bots concern restructuring, ETL hygiene, change requests,
scheduling, faculty load, rotation, prerequisite checking, compliance, and sustainability — none is
a retrieval chat interface.

| Prompt | Location | Function | Verdict |
| --- | --- | --- | --- |
| Strict RAG system prompt | `src/app/api/assistant/route.ts` | Answers *"STRICTLY on the official academic policies, course details, and program requirements provided in the Grounded Catalog Chunks"*, with a bracketed citation rule | **Platform** |
| General Reasoning system prompt | same | Drives a tool-calling loop over three read-only catalog tools | **Platform** |
| Intent parser prompt | same | Cheap pre-pass extracting structured intent as JSON before retrieval | **Platform** |

---

## 4. Editorial review — one prompt

| Prompt | Location | Function | Verdict |
| --- | --- | --- | --- |
| `EDITORIAL_SYSTEM_PROMPT` | `src/app/api/diff-summary/route.ts` | Plain-language review of version-to-version differences for a non-technical editor, in fixed sections | **Platform** — no enumerated deliverable describes a diff-review assistant |

---

## 5. Verification harness — five adjudication prompts plus refuter lenses

**This is the arguable set, and the most valuable to settle explicitly.**

The harness audits the catalog against its source pages. Two enumerated deliverables name functions
it performs: the **Prerequisite & Dependency Checker Bot** (*"flags inconsistencies and logic errors
in course prerequisites and dependencies"*) and the **Catalog Compliance Checker Bot** (*"checks
catalog entries for compliance with policies"*).

The harness does those things. It was not, however, built as those bots: it is a multi-tier
verification system with its own specification (`DOUBLE_CHECK.md`), a deterministic Tier 1 that uses
no model at all, a budgeted Tier 2, and an adversarial Tier 3. Most of its checks are deterministic
code, and the prompts below cover only the questions no string comparison can decide.

| Prompt | Location | Function | Verdict |
| --- | --- | --- | --- |
| `_COURSE_SYSTEM` | `verification_harness/checks/semantic/courses.py` | Adjudicates course fidelity against the page — *"The PAGE is ground truth: where the page and the database disagree, the page is right"* | **Arguable** (prerequisite/dependency checking) |
| `_PROGRAM_SYSTEM` | `.../programs.py` | Judges whether a linked page is genuinely *about* a program or merely mentions it | **Arguable** (compliance checking) |
| `_CHUNK_SYSTEM` | `.../chunks.py` | Verifies chunk content matches its section-header breadcrumb | **Platform** — instrumentation for the retrieval layer |
| `_TITLE_SYSTEM` | `.../residue.py` | Adjudicates titles a deterministic abbreviation check could not reconcile | **Platform** |
| `_DISCOVERY_SYSTEM` | `.../discovery.py` | Bounded open-ended search for *"error CLASSES nobody has anticipated yet"* | **Platform** |
| Refuter lenses (5) | `verification_harness/checks/adversarial.py` | Independent skeptics attempting to disprove findings; *"vote to REFUTE whenever there is reasonable doubt"* | **Platform** |

**Suggested resolution.** The two arguable prompts are worth naming explicitly in the finalized
Statement of Work — either as delivered bot work product, or as platform that happens to satisfy a
bot's description. Either is defensible. Leaving it unstated is the only option that is not.

---

## 6. Enumerated deliverables delivered outside this repository

Verified by search: six of the enumerated bots appear nowhere in this codebase. No source file
references scheduling, faculty load, course rotation, sustainability, accountability, or RFP review.

- Scheduling Bot
- Faculty Load Cycle Planner Bot
- Course Rotation Tracker Bot
- Sustainability & Accountability Bot
- RFP Review Bot
- AI Strategic Planning Support

**These were built as separate applications and are being handed over through their own routes.**
Their absence here is a delivery boundary, not a gap.

The consequence for this document is that **the catalog platform is not the whole engagement, and
this inventory is not the whole bot work product.** Anyone reasoning about what was delivered under
the agreement needs the other applications alongside this one; anyone reasoning about *this
repository* should read the inventory above as covering only the portion of the commissioned work
that happens to live here.

---

## 7. Summary

| Category | Prompts | Verdict |
| --- | ---: | --- |
| Catalog correction pipeline | 5 | Commissioned |
| Verification harness adjudication | 2 | Arguable |
| Verification harness, remaining | 3 + 5 lenses | Platform |
| Catalog assistant | 3 | Platform |
| Editorial review | 1 | Platform |

Five prompts are unambiguously the commissioned bot work product. Two are arguable and should be
named in the finalized Statement of Work. The remaining twelve implement features no enumerated
deliverable describes.

Separately, and independent of any of the above: the application, harness, ingestion pipeline, spoke
generator, and schema are platform. Six enumerated bots live in other applications handed over
separately, so this repository carries only part of the commissioned bot work — see §6.
