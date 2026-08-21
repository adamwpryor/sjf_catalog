# Developer Guidelines — moved

The engineering standards that lived here are now maintained in
**[MAINTENANCE_GUIDELINES.md](MAINTENANCE_GUIDELINES.md)**, which is the single authoritative
version. This file is a pointer so that older references keep resolving.

Nothing was dropped in the move. `MAINTENANCE_GUIDELINES.md` carries the same non-negotiables —
Conda-first environments, zero-trust secrets with no configuration fallbacks, single-tenant RLS and
`queryWithAuth`, SOLID route separation, structured logging, formatting that matches the file rather
than reformatting it, scope discipline, and Conventional Commits — and adds the verification
discipline that earlier revisions lacked.

Two related documents:

- **[CLAUDE.md](CLAUDE.md)** — the same ground rules written for AI coding assistants, organised
  around the specific ways work in this repository has gone wrong.
- **[HANDOFF.md](HANDOFF.md)** — architecture, ownership model, and how the auditability mechanisms
  fit together.

> Why this file is a stub rather than a deletion: several planning documents and prompts cite
> `DEVELOPER_GUIDELINES.md` by name, and a few cite it by line number. A pointer keeps those
> references meaningful. Maintaining two copies of the standards would not — that is how the two
> versions drift apart and a reader ends up following the stale one.
