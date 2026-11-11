# The design document

- **One document, `design.md` at the repo root** (2026-11-11: "merge the plans/dissertation.md to the root design.md and have only single file design.md"). It opens with the author's brief word for word, then what the game is, how the brief became it, the decisions (with the user's words and what was measured), how it is built, and what is left to build. No `plans/` folder and no other plan files.
- **Committed alongside the implementation it describes**: never in a separate change that lingers without code, never only in a harness-local location like `.claude/plans/`.
- **Edited in place when a decision changes**; its git history is the design's evolution. The brief stays as the author wrote it.
- **The current position, not an archive**: when open work is built, move it from "Left to build" into the decisions, keeping what lives only there (rejected alternatives, measured numbers, invariants, why something was not done), and delete what no longer holds.
- **Referred to, not restated**: rules in `.cursor/rules/`, the README and code comments point to `design.md`. If a rule diverges from a recent decision there, the rule is updated.
