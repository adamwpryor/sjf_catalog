# Phase 4 handoff — Tier 3 adversarial verification (Gemini builds, Claude checks)

Give this whole file to Gemini. It is written to be self-contained.

---

## Why you and not Claude

Claude built Tier 2 (`checks/semantic.py`) — the adjudications you are about to attack. Design
Principle **P1** says a verifier must not share machinery with the thing it verifies, or it
validates its own blind spots. A refuter written by the author of the claim inherits the author's
assumptions about what counts as evidence. So: **you write Tier 3, Claude reviews it and
defect-injects your guards.** That is the same arrangement used for the Tier 0 extractor, where
Gemini wrote the parser and Claude wrote its oracle.

One consequence worth stating plainly, because it is easy to violate accidentally:

> **Do not read `checks/semantic.py`'s prompts and write refuter prompts that mirror them.**
> If your refuter is told to look for the same things the adjudicator was told to look for, it will
> agree with the adjudicator for the same wrong reasons. Read the *spec* (`DOUBLE_CHECK.md` §7 traps
> and §10 severity), the finding, and the source page. You may read `semantic.py`'s **interfaces**
> — schemas, `Finding` shape, how it calls the LLM layer — but derive your prompts from the spec
> and the evidence, not from Claude's prompt text.

---

## What Tier 3 is for

From `DOUBLE_CHECK.md` §8:

```text
Tier 3  REFUTE   N independent skeptics per finding, prompted to REFUTE;
                 kill on majority; default to refuted when unsure
```

§1 sets the strategy: *tune for recall in Tiers 1–2, then suppress noise here* — **not** by
weakening the earlier checks. So Tier 3's job is to kill false positives that survived, and it is
supposed to be aggressive about it. Q8 fixes the count: **3 refuters normally, 5 for `critical`.**

§9 fixes the outcome: `verdict ∈ CONFIRMED | PLAUSIBLE | AMBIGUOUS | REFUTED`. **Only CONFIRMED and
PLAUSIBLE reach the human report. REFUTED is retained** in `findings.jsonl` for harness auditing —
never deleted, because a Tier 3 that quietly discards findings is indistinguishable from a Tier 1
that never found them.

---

## Scope — read this before estimating anything

Do **not** refute all 5,195 findings. That is ~16,500 calls and ~$14, and it aims the most
expensive tier at the tier that needs it least. Adam approved this narrower scope on `2026-08-02`:

**In scope:**

1. **Every Tier 2 finding** (`tier == 2`). These are LLM judgments with unmeasured precision. This
   is the population Tier 3 exists for.
2. **Tier 1 findings at `critical` or `high` severity** — currently **751** (A1=536 critical,
   A5=81, B1=75, A6=30, A4=29 high). These drive remediation in Phase 5, so they must be verified.

**Out of scope, deliberately:**

- **Tier 1 `low`/`medium`/`info`** — D1 (1,911), C3 (609), D7 (548), C2 (514), D6 (36), D5, C6, E1.
  These are inventory and provenance aggregates, not defect claims. D6 is explicitly a *census*.
  A refuter has nothing to attack in "here is a list of headings that recur", and none of it enters
  the remediation queue.
- The justification is measured, not assumed: Phase 1's gate hand-triaged a 30-finding stratified
  sample at **0% false positives** (`PHASE1_TRIAGE.md`). Deterministic checks with demonstrated
  precision do not need three independent LLM skeptics each.

**If you disagree with this scope, say so before building it.** Argue it with numbers — that is how
Risk A and the Phase 2 performance premise were both settled, and both times the measurement
overturned the plan.

---

## Budget

The ceiling is **$25 for the whole one-time audit** (Adam, `2026-08-02`), raised from Q5's $10
because Tier 2 ($7.96) plus Tier 3 does not fit in $10 end-to-end. `llm/budget.py` holds both
figures; `CI_CEILING_USD` preserves the original $10 for when this becomes a CI gate (Q7).

Tier 2 has already spent its share. **Budget roughly $6–8 for Tier 3.** Sketch:

| population | count | refuters | model | ~cost |
| --- | ---: | ---: | --- | ---: |
| Tier 1 `critical` | 536 | 5 | flash ×3, escalate to pro ×2 | ~$3.8 |
| Tier 1 `high` | 215 | 3 | flash | ~$0.6 |
| Tier 2 findings | TBD | 3 | flash | ~$1.3–3.9 |

Q5 says pro is for `critical` only. Consider running 3 flash refuters first and escalating to pro
**only when they disagree** — a unanimous flash verdict does not need an expensive tiebreaker. That
is your call; measure it with `--tier3 estimate` before spending.

---

## The infrastructure already exists — use it, do not rebuild it

`verification_harness/llm/` is the only path to a model. Read these three files first:

| file | what it gives you |
| --- | --- |
| `llm/client.py` | `Adjudicator` with `live` / `replay` / `estimate` / `fake` modes, `Request`, `Response`, `.map()` for concurrent fan-out, retry, refusal handling |
| `llm/cache.py` | content-addressed response cache — **this is what makes findings reproducible (P3)** |
| `llm/budget.py` | token accounting and the hard ceiling that stops the run |

Three things follow:

- **Never call `google.genai` directly.** Go through `Adjudicator`. Everything below depends on it:
  the cache, the ceiling, refusal handling, and the offline test path.
- **`estimate` mode must work for Tier 3 too.** It builds every prompt, counts tokens, and spends
  nothing. That is how a cost is reported *before* asking for authorization, and it is how this
  scope was agreed.
- **`fake` mode is how your tests run offline.** Tests must not need credentials. A guard that only
  runs when someone has fresh ADC will not run.

### A determinism trap specific to Tier 3

The cache keys on `(model, system, prompt, schema, params)`. **Three refuters asking the identical
question produce the identical cache key** — so refuters 2 and 3 would replay refuter 1's answer,
and your "three independent skeptics" would be one skeptic counted three times. The suite would stay
green and the majority vote would be meaningless.

Fix it by making the refuters genuinely different, which you want anyway: give each a **distinct
lens** in its prompt. Suggested (adapt with reason):

1. *Evidence* — is the quoted page text actually there, and does it actually say what the claim says?
2. *Trap* — is this one of the §7 known-good patterns (T1–T11) misread as a defect?
3. *Scope* — is the claim about the right entity, the right page, and the right catalog version?
4. *Severity* — even if real, is it the severity claimed? (§10)
5. *Alternative reading* — is there a reading of the page under which the database is correct?

Distinct lenses give distinct prompts, distinct cache keys, and — more importantly — catch failure
modes that three identical skeptics cannot.

---

## Interface contract

Write **`verification_harness/checks/adversarial.py`**. It is a post-processing stage over findings,
not a registered check (the `@register` registry is keyed to `CheckContext`, and Tier 3 consumes
findings instead).

```python
def refute(
    findings: list[Finding],
    ctx: CheckContext,
    adjudicator: Adjudicator,
) -> list[Finding]:
    """Adversarially verify in-scope findings; return ALL findings, verdicts updated.

    Returns the same number of findings it was given. A finding out of scope is passed through
    untouched. A finding whose refuters could not run keeps its prior verdict and says why.
    """
```

- **Return every finding you were given.** Under-reporting is the harness's worst failure mode (P5).
  Filtering to the report happens in `report.py`, not here.
- Set `finding.refuters = Refuters(n=<count>, refuted=<how many voted to refute>)` — the field is
  already in `models.py`.
- **Kill on majority**: `refuted > n/2` → `verdict = "REFUTED"`.
- **Default to refuted when unsure** (§8). A refuter that cannot decide votes *to refute*. This is
  the opposite of Tier 2's posture and it is intentional: Tier 2 declines to judge, Tier 3 declines
  to let a claim through.
- Preserve the finding `id` exactly. Ids are deterministic (`{version}:{page}:{check}:{entity_key}`)
  so runs diff cleanly (P3), and `sqlite_loader` **raises** on duplicates — it will catch you.

Wire it into `cli.py` `run_version()` after the Tier 2 block, behind a `--tier3` flag mirroring
`--tier2` (`off` / `live` / `replay` / `estimate`, defaulting to **off** — a tier that costs money
must never run because someone forgot a flag).

---

## Also in Phase 4: `report/report.py`

`findings.sqlite` → `report.md`. It does not exist yet; the README already references it.

- Only `CONFIRMED` and `PLAUSIBLE` appear. `REFUTED` and `AMBIGUOUS` stay in the JSONL for audit.
- Order by severity: 536 critical and 215 high are what a human acts on.
- **Group, do not dump.** Risk D was raised precisely against "a dump of 1,000 JSON errors". D1
  alone is 1,911 findings; if it reaches the report at all it is one grouped section with counts,
  not 1,911 bullets.
- Every entry carries its page excerpt and DB value (P4) and links to its source page.
- State what was refuted and what was skipped. A report that silently omits its own coverage gaps
  is the failure mode P5 exists to prevent.

---

## Acceptance criteria — Claude will check these

1. `refute()` returns exactly as many findings as it received, ids unchanged.
2. Three refuters on one finding produce **three distinct cache keys**. (The trap above. Claude will
   test this specifically by asserting the fake adjudicator was called three times, not once.)
3. Majority kill works at 3 and at 5; ties do not resolve to CONFIRMED.
4. An unsure refuter votes to refute.
5. A refuter that errors or is refused does **not** silently reduce `n` — either it counts as a
   refusal to clear, or the finding is left with its prior verdict and a stated reason.
6. `--tier3 estimate` reports a cost without making a call.
7. Out-of-scope findings pass through byte-identical.
8. Tests run with **no database, no credentials, no model** (`fake` / `replay` modes).
9. `ruff check verification_harness/` clean; type hints and Google-style docstrings per
   `DEVELOPER_GUIDELINES.md`.
10. **Defect injection.** For each guard above, break exactly that mechanism and show the suite goes
    red. A test that passes with the defect present is worse than no test — it reports confidence it
    has not earned. This is not a formality: the Phase 0 drift guard passed its first review, and
    then passed again with the historical §11.5 defect injected, because both fixtures happened to
    lack 4-digit course codes. Claude will re-run your injections independently.

---

## Files to read first

| file | why |
| --- | --- |
| `DOUBLE_CHECK.md` | the spec — §7 traps and §10 severity are what your refuters reason with |
| `verification_harness/SIGNOFF.md` | Phase 3 section: what Tier 2 does, what it costs, what is unresolved |
| `verification_harness/llm/*.py` | the infrastructure you must use rather than rebuild |
| `verification_harness/models.py` | `Finding`, `Refuters` |
| `verification_harness/checks/registry.py` | `CheckContext`, `make_finding`, `write_findings` |
| `verification_harness/tests/test_tier2.py` | the testing posture expected of you (offline, injected) |
| `PHASE1_TRIAGE.md` | why Tier 1 low/medium is out of scope — the 0% FP measurement |

Do **not** import from `../scripts/` or `../src/` (P1). Do not modify `db.py`, `llm/`, or any
existing check without saying why first.

---

## Open question for you, answer with a number

Tier 2 has never been FP-gated. Claude is hand-triaging a 30-finding Tier 2 sample against the same
**FP < 20%** bar Phase 1 used. **If Tier 2's false-positive rate comes back high, Tier 3's job
changes** — from trimming a mostly-good queue to being the thing that makes Tier 2 usable at all,
which may justify 5 refuters on every Tier 2 finding rather than 3.

Wait for that number before finalizing your refuter counts, or build the count as a parameter you
can turn. Do not hard-code 3.
