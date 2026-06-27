# Developer Guidelines — The "Adam Pryor Standard" (SJF Spoke)

All work on this repo follows these non-negotiables. They mirror the CCSJ standard and the
global engineering standard.

## 1. Conda-First
- All local Python runs in the `sjfu-catalog` Conda env (`environment.yml`). Never `pip install`
  into `base`. New Python deps go into `environment.yml`, not a stray `requirements.txt`.
- Node is pinned via `.nvmrc` (20).

## 2. Zero-Trust secrets
- **No hardcoded secrets, ever.** No secret in source, config, or scratch files.
- **No fallback secrets** (e.g. `process.env.X || "default"` is prohibited). If a required env var
  is missing, throw an explicit configuration error at startup.
- Real values live ONLY in an untracked `.env.local` or Conda env config vars. The committed
  template is `.env.example`. `.gitignore` ignores `.env*` except `.env.example`.
- Python: load sensitive vars via a `load_secure_key()` helper, not raw `os.getenv`.
- No PII in logs, files, or outputs.

## 3. Row-Level Security (single-tenant spoke)
- The spoke DB holds one tenant (`SJFU`); RLS uses the `auth.uid()` + `user_roles` model
  (NOT the hub's `app.current_tenant`). See `BUILD_PLAN.md` §3 delta #3.
- Tenant/role-scoped queries go through `queryWithAuth(text, params, userId)`; a missing/invalid
  `userId` must abort, never fall through to an owner connection. Roles come from `user_roles`,
  never hardcoded.

## 4. SOLID & clean routes
- API routes handle HTTP only; business logic lives in dedicated modules/services (SRP).
- No multi-thousand-line endpoint files.
- Never return raw DB errors / stack traces to clients — generic message + correlation id.

## 5. Structured logging
- No bare `print()` / `console.log` in production paths. Use JSON structured logging
  (`pino` in JS, `python-json-logger` in Python). Include Git commit hash + branch
  (via `gitpython`) where practical.

## 6. Code quality
- Python: PEP 8, type hints on all signatures, Google-style docstrings, Black + Ruff + MyPy.
- TS/JS: ESLint clean, `tsc --noEmit` clean, Prettier formatting.

## 7. Git
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:` …).
- Never force-push `main` or skip hooks without explicit confirmation.

## 8. Hand-off note
This repo is built to be handed off. Anyone cloning it should reach a running app from
`README.md` alone, supplying their own `.env.local`. Keep that true.
