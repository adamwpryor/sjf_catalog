# Phase 7 task C3 — `AI_ASSISTANTS.md`

Give this whole file to Gemini. Supplements the C3 section of `PHASE7B_GEMINI_PROMPT.md` with traps
found while verifying C9, C2, and C8. Where the two differ, this file wins.

C9, C2, and C8 are `CLAUDE-VERIFIED` and committed. C3 is next in the sequence.

---

## Why this task is different from the last three

C9, C2, and C8 changed code, so when they were wrong something failed. **C3 changes nothing.** Its
only failure mode is being confidently, quietly wrong — a document that reads well and describes a
system that does not exist.

That is not hypothetical here. In Phase 6 the handoff documentation named two Tier 1 modules that do
not exist (`structure.py`, `duplicates.py`), omitted one that does, and documented `--tier 1` /
`--tier 2` CLI flags the harness has never had. Every harness command in the annual playbook would
have failed on first use. It read plausibly because nobody executed it.

So the rule from `CLAUDE.md` §1 applies with a twist: **there is no test suite for prose, so you have
to build the check yourself.** See "How to verify" below — it is the most important section here.

## Your assignment

Write `AI_ASSISTANTS.md`: every AI/LLM-powered feature that ships in this product, what each is for,
and which maintenance task each fits. Two audiences — the administrator deciding whether to use a
feature, and the developer maintaining it.

Per feature, state:

1. **Name and trigger.** Where a user sets it off. Note that the app is a single-page dashboard
   (`src/app/page.tsx`) with client-side tabs, so cite the sidebar tab id and label, not a URL.
2. **Implementation.** The route or module that handles it.
3. **Model and provider path.** The exact model id *that actually runs*, and how it authenticates
   (keyless Vertex via ADC/WIF, or a provider API key).
4. **What it does**, in one sentence grounded in its system prompt.
5. **Whether it writes to the database.** Five features do. This is the single most useful column
   for an operator deciding what is safe to try.
6. **Cost shape.** Per-call, per-page, or per-catalog — this surface is the main recurring cost
   after transfer.

## Traps — all six verified against current source today

**1. The model constant in the swarm is a lie, and it is the trap most likely to catch you.**
`services/swarm/main.py:26` reads
`LLM_MODEL = os.environ.get("EXTRACT_MINUTES_MODEL", "claude-opus-4-8")`, and every swarm agent
passes `model=LLM_MODEL` to its client. **That value is never used.** `_anthropic_client()` returns
the Vertex shim, and `services/swarm/overrides/vertex.py:117` discards the model argument entirely:
`vertex_model = DEFAULT_VERTEX_MODEL`, which is `VERTEX_GEMINI_MODEL` defaulting to
`gemini-2.5-pro`. So **all five swarm agents run `gemini-2.5-pro` on Vertex, keyless, in `us-east5`**
— not Claude, and there is no Anthropic key path in this deployment. Document what runs, and say
plainly that the constant is historical, or the next maintainer will "fix" a model id that does
nothing.

**2. The codebase moved under you. Do not trust the survey text in the plan.**
`PHASE7_OWNERSHIP_TRANSFER.md` describes a twelve-feature surface, but that was written before
Groups A and C landed. Since then: the three stub endpoints (`delta-processor`,
`curriculum-auditor`, `diagnostics-analyst`) were **removed** — do not document them;
`manual-entry-assistant` is **no longer called from the browser**, it now goes through
`src/app/api/swarm/manual-entry-assistant/route.ts`, which checks the session server-side; and the
`clean-database` and tester routes are gone. Seven `@app` routes remain in the swarm. **Verify every
feature against current source, not against the plan.**

**3. Two Vertex regions, deliberately — do not present this as drift.** `src/lib/llm.ts` uses
`us-central1` because that value feeds the `gemini-embedding-001` call producing RAG query vectors,
and that region is verified to serve the model. The Python services use `us-east5` and only ever
call generation models. A comment at the call site explains it. C8 tried to unify them and had to be
reverted.

**4. Which model answers can depend on which secret is set.** `callLLM` in `src/lib/llm.ts` tries
providers in a fixed order and uses the first configured one, so the Diff Log's editorial review may
be answered by different models in different deployments. Document the order and state what a stock
deployment resolves to. Related: the assistant's model picker
(`src/components/CatalogAssistantChat.tsx:172-182`) offers eleven models including Claude and GPT
options labelled "(needs API key)" — say which work out of the box.

**5. Two models run inside a single assistant request.** The Strict RAG path makes a cheap intent
parse *and* an embedding call before the main answer. An operator reading "one question, one call"
will mis-model the cost.

**6. Say clearly what is NOT AI.** The curriculum graph audit, the nightly remediation cron, and the
harness's `remediate.py` are fully deterministic — no model involved. Two of them write to the
database. An operator who assumes those are AI will distrust correct output, which is its own
failure. `verification_harness/db.py` is read-only by construction; `remediate.py` is the only
harness code that writes.

## How to verify — build the check, then run it

A document has no test suite, so make one. After writing, **mechanically confirm every factual claim
against source**: for each model id and each `file:line` you cite, grep that file and confirm the
string is actually there. A short script that walks your own claims and reports any that do not
resolve is a check that can genuinely fail — which is the standard in `CLAUDE.md` §1.

Report in your work-log entry: how many claims you checked, how many failed on the first pass, and
what you did about them. "I verified it" without a count is not evidence.

Do not cite line numbers for anything volatile. Prefer a symbol or function name that survives
edits; where you must give a line, re-locate it by content immediately before writing it down.

## Rules of engagement

- `CLAUDE.md` governs. Scope discipline (§7): C3 is a documentation task — **do not change code**.
  If you find a bug while surveying, write it in the work log; that is genuinely valuable. Fixing it
  here is not.
- Do not commit. Leave the tree dirty; Claude verifies, Adam approves.
- Stop and report when C3 is done. C5 is next, but it is a separate turn.
- ADC may be unavailable — you do not need it for this task. Nothing here requires calling a model.

## How to report

Flip C3 to `GEMINI-DONE` in `PHASE7_OWNERSHIP_TRANSFER.md` §6 only when the document is complete and
your claim check passes, and append one work-log entry with the counts described above.

Append to the work log with a **targeted edit**, not by rewriting the file. It previously grew to
927 lines holding three copies of the task ledger and two of the work log, with the copies
disagreeing about task status; it had to be rebuilt by hand.

If a spec here is wrong, say so and stop rather than guessing.
