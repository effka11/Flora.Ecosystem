# Patch operations

Closed table for `/flora-plan-reviser`. One operational row per `hole_id` in [`../flora-plan-reviewer/taxonomy.md`](../flora-plan-reviewer/taxonomy.md); do not invent ids. If taxonomy later grows, a matching row is required or this skill is incomplete.

Minors: apply only if the edit is surgical (wording, skill name, one gate). Do not bloat the plan while at it.

Format: **operation + forbid** on one line. `do-not-patch (AskQuestion)` means do not edit the plan for that finding. Conditional rows patch only under the stated predicate; otherwise AskQuestion.

Gates/skills: [`../flora-plan-reviewer/flora-lenses.md`](../flora-plan-reviewer/flora-lenses.md) §5 / §4.

## Operations

- `goal_unstated` — do-not-patch (AskQuestion): ask for the goal once; do not invent criteria.
- `goal_uncovered` — add a step with verifiable DoD from the delta and the Goal map row; do not add new criteria.
- `goal_insufficient` — expand/add steps so all steps ⇒ goal closed; do not expand the goal.
- `scope_creep` — move the step to Out of scope, not silent drop.
- `proxy_goal` — do-not-patch (AskQuestion): do not rewrite the problem; ask which goal is canonical.
- `dod_missing` — write a verifiable DoD into the cited item.
- `dod_human_only` — split: agent-DoD vs «needs a human» list; do not make the human check a `done` condition.
- `ownership_unclear` — patch ONLY if suggested delta names module/crate/workspace; otherwise do-not-patch (AskQuestion).
- `dep_hidden` — order / depends-on / drop false parallelism; no new features.
- `contract_uncut` — cut contracts → per-module → wiring; keep the meaning.
- `zone_overlap` — separate file zones or make steps sequential.
- `step_too_large` — split into substeps with one verifiable exit each.
- `contradiction` — patch ONLY if the delta unambiguously picks a side; two valid sides → do-not-patch (AskQuestion).
- `stub_shaped` — replace deferred work with real work or explicit Out of scope; do not leave «wire later».
- `flora_boundary` — rewrite to the allowed direction / `*-contracts`; do not bypass boundaries.
- `flora_frozen` — patch ONLY if the plan/thread already has an explicit user decision to change that frozen surface (apply the delta to that surface only); otherwise do-not-patch (AskQuestion). Never lift freeze unilaterally.
- `flora_gate_missing` — add a named gate from [`../flora-plan-reviewer/flora-lenses.md`](../flora-plan-reviewer/flora-lenses.md) §5; do not change the step’s work.
- `flora_skill_gap` — name the required skill/AGENTS from [`../flora-plan-reviewer/flora-lenses.md`](../flora-plan-reviewer/flora-lenses.md) §4 in the step.
- `risk_unaddressed` — add a risk/review step (or an explicit residual-risk note if that is what the delta says).
- `rollback_missing` — add rollback/verify for migration/data.
- `test_strategy_missing` — add a test/gate step to non-trivial logic.
- `approach_unjustified` — write why vs the alternative OR switch per the delta; do not invent a new algorithm.
- `approach_mismatch` — replace the method with the named alternative from the review; do not change the goal.
- `approach_inferior` — same: switch to the alternative from «Better alternative» / the delta.
- `missing_decision` — do-not-patch (AskQuestion): do not guess the choice.
