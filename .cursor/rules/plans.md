# Plans

- **All planning documents live in `/plans/` at the repo root**, with kebab-case filenames describing the work.
- **Plans are committed alongside (or in the same PR as) the implementation they describe** — never in a separate "design PR" that lingers without code, never only in a harness-local location like `.claude/plans/`.
- **When a plan is superseded, edit the original** rather than creating a parallel file; the file's git history *is* the design evolution. If the slug should change, use `git mv` so the rename is preserved.
- **Plans are durable while they still describe open work.** A live plan is the canonical record — refer to it from `.cursor/rules/`, docs, and code comments instead of restating the design. If a rule in `.cursor/rules/` diverges from a recent plan, the rule needs updating, not the plan.
- **A plan is retired once it has nothing left to build.** `plans/` holds forward-looking work, not a shipped-features archive; git history keeps deleted content. Retirement means two things **in the same commit**: (1) *rescue what lives only there* — rejected alternatives, measured numbers, invariants, "why we did **not** do X" — into `docs/` if it describes the shipped system, `.cursor/rules/` if it is a convention, or the owning plan if it is still open work; (2) *repoint every inbound citation*, having grepped the basename across the whole repo.
- **One plan per subsystem.** When work on one subsystem spreads across several files they drift and contradict each other; consolidate into the owning file and delete the rest.
