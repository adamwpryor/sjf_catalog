# System Engineering & Maintenance Guidelines

This document records the non-negotiable engineering standards, operational security policies, and maintenance guidelines for the St. John Fisher University (SJFU) Catalog System codebase. It is written for the institution and any maintaining vendor or developer taking over system operations.

---

## 1. Verification Discipline — "Pick a Check That Can Fail"

The single most critical lesson from past system maintenance: **Green checks are not evidence if they could not have caught the defect.**

Every major bug or documentation error that shipped in earlier iterations passed all checks run by its author because the checks were green, true, and structurally incapable of reaching the broken code:
* A backend microservice was rewritten and passed `pytest` (108 passed) and `eslint` (0 errors). Both were true. Neither imported the Python microservice, which could not even start due to an un-wired client factory.
* Documentation was written claiming a feature was on a specific sidebar tab. A self-check verified that the tab ID existed in `page.tsx` and reported 100% pass rate — but existence checks validate *vocabulary*, not *claims*. The feature was actually wired to a different tab component.

### The Verification Rules

1. **Existence checks are not claim checks:** Checking if a string, model ID, or tab ID exists somewhere in the codebase does not verify how items are connected. To verify a claim (e.g. "Feature X is triggered from Tab Y"), you must **reconstruct the end-to-end structural relationship independently**:
   - Trace from the API route -> to the React component that fetches it -> to the sidebar tab that renders that component -> compare against the claim.
2. **Choose a check that fails when the code is wrong:**
   - For Python services: Do not rely solely on unit tests. Run an explicit import smoke test:
     ```bash
     python -c "import services.swarm.main as m; assert type(m._anthropic_client()).__name__ == 'VertexShimClient'; print('swarm ok')"
     ```
   - For TypeScript/Next.js: Run strict typechecking and linting:
     ```bash
     npm run typecheck && npm run lint
     ```
   - For documentation commands: Run every command exactly as documented.
3. **Verify claims against authoritative source code:** Never trust planning notes, historical docstrings, or previous summaries over current code. If a docstring contradicts the implementation below it, trust the implementation and update the docstring.

---

## 2. Conda-First & Fixed Environment

* **Python Environment:** All local Python execution and service runs must use the dedicated `sjfu-catalog` Conda environment defined in [`environment.yml`](environment.yml). Never `pip install` into base or global Python environments.
* **Dependencies:** New Python dependencies must be declared in [`environment.yml`](environment.yml) under the `conda-forge` channel where available (or pip section if conda-forge lacks the package). Never rely on stray `requirements.txt` files.
* **Node.js Environment:** Node runtime is pinned via [`.nvmrc`](.nvmrc) (Node 20).

---

## 3. Zero-Trust Security & Secrets Management

* **No Hardcoded Secrets:** Credentials, API keys, database connection strings, and tokens must never appear in source code, configuration files, scratch files, or commit messages.
* **No Default Fallbacks for Secrets:** Code must **never** provide fallback defaults for missing configuration (e.g. `process.env.GCP_PROJECT_ID || 'fallback-project'` is strictly prohibited). Missing environment variables must throw explicit configuration errors at startup:
  ```typescript
  // REQUIRED PATTERN
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('GCP_PROJECT_ID environment variable is missing');
  ```
  *Why this matters:* A default secret or fallback project ID causes silent billing, security leaks, or unauthorized access that goes undetected until production.
* **Environment Credentials:** Environment variables live only in untracked `.env.local` or OS environment variables. The tracked template is [`.env.example`](.env.example).
* **Python Key Loading:** Sensitive keys in Python should be resolved via secure environment helpers, never echoed or logged.
* **Privacy (Zero PII):** No Personally Identifiable Information (PII) may be written to log files, output artifacts, or tracking data.

---

## 4. Single-Tenant Database & RLS Access Patterns

* **Single-Tenant Spoke Architecture:** The database instance is single-tenant for SJFU (`tenant_id = 'SJFU'`).
* **Row-Level Security (RLS):** RLS policies enforce access using Supabase `auth.uid()` and the `user_roles` table.
* **Authenticated Queries:** Role-gated database queries in API routes must use `queryWithAuth(text, params, userId)`. If `userId` is invalid or unauthenticated, the query must abort immediately with a 401/403 status. Roles must be evaluated dynamically from `user_roles`, never hardcoded.

---

## 5. API Architecture & SOLID Principles

* **Single Responsibility Principle (SRP):** Next.js API routes (`src/app/api/`) handle HTTP request parsing, session authorization, and response formatting only. Business logic, graph algorithms, and AI orchestrations belong in dedicated helper modules (`src/lib/`, `services/swarm/`).
* **Error Hygiene:** API routes must never return raw database error messages or internal stack traces to client browsers. Return clean JSON error summaries with appropriate HTTP status codes.
* **Structured Logging:** Production code uses JSON-structured loggers (`pino` in TypeScript, `python-json-logger` in Python). Bare `print()` or `console.log()` statements should not be committed to production branches.

---

## 6. Code Quality, Formatting & Diff Hygiene

* **Match Existing File Conventions:** Follow the formatting and style of the file being modified.
* **No Blanket Automatic Formatting:** Do not run repository-wide auto-formatters (e.g. running `black` at default 88-column width across hand-wrapped 110-column Python code). A formatter must never turn a 2-line logic fix into a 200-line rewrapped diff.
* **Linting & Type Standards:**
  * **Python:** Follow PEP 8 guidelines, include type annotations on public function signatures, use Google-style docstrings, and ensure `pytest` and `ruff check` pass.
  * **TypeScript/React:** Ensure `npm run typecheck` and `npm run lint` compile cleanly without errors.

---

## 7. Scope Discipline & Git Lifecycle

* **Scope Discipline:** Focus strictly on the assigned task. If you discover unrelated technical debt or adjacent bugs during a task, log them in documentation — do not make unauthorized or out-of-scope edits to active code.
* **Conventional Commits:** Use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
* **Git Safety:** Never force-push (`git push --force`) to `main` or bypass pre-commit hooks. Commit messages should state plainly what was changed and how it was verified.

---

## 8. Maintainability & Self-Sufficiency

The codebase is owned outright by St. John Fisher University. Any developer or administrator cloning the repository must be able to spin up and maintain the application using [`README.md`](README.md) and their own environment configuration (`.env.local`). Avoid any dependency on personal developer infrastructure, private sync scripts, or third-party institutional accounts.
