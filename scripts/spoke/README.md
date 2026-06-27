# Scripted Spoke Generator (Decision G2)

`create-spoke` — config-driven generator that stands up a new institutional spoke from a single
`institution.config.yaml`: validate → provision Supabase → run the allow-listed schema migrations
→ `deploy_client_db.py` data load → apply branding/config. Harvested while building SJFU; the
durable factory artifact. See `BUILD_PLAN.md` §4 + P10.

Planned files: `create-spoke.mjs`, `institution.schema.json` (validates the config), `sync_upstream.py`
(vendor drift report, `BUILD_PLAN.md` §4A).

> To be implemented incrementally; finalized in P10.
