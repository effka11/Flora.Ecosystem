# Patch operations (code)

Closed table for `/flora-code-reviser`. One operational row per `hole_id` in [`../flora-code-reviewer/taxonomy.md`](../flora-code-reviewer/taxonomy.md). If taxonomy grows, a matching row is required or this skill is incomplete.

Minors: apply only if surgical (one scar, one revert hunk). Do not drive-by refactor.

**Hard forbid (all ops):** never weaken, skip, delete, or regenerate tests/snapshots to go green; never `git commit` / `git push`; never lift a freeze without an explicit user decision already in the thread; never add features the finding did not authorize; never implement a subsystem from a one-line `goal_*` delta.

**Concrete delta (predicate used below):** names ≤3 existing or new paths and a one-hunk edit (one call site, one revert, one test file). Must **not** start with `AskQuestion:`. Anything wider or AskQuestion-shaped → treat as vague → AskQuestion.

Format: **operation + forbid**. `do-not-patch (AskQuestion)` = do not edit for that finding.

## Operations

- `goal_unstated` — do-not-patch (AskQuestion): ask for the goal once; do not invent criteria.
- `goal_uncovered` — patch ONLY if the delta is concrete (predicate) and does **not** start with AskQuestion; wire/test/revert those paths only. Else do-not-patch (AskQuestion). Do not add new goal criteria. Do not implement a missing subsystem.
- `goal_insufficient` — same predicate as `goal_uncovered`; do not expand the goal.
- `scope_creep` — patch ONLY if the review **Range kind** is `since` or `zone`: revert unrelated hunks/files in that range. Range kind `thread-files` / `working-tree` / missing → do-not-patch (AskQuestion). Do not revert mixed WIP.
- `proxy_goal` — do-not-patch (AskQuestion): do not switch product problem; ask which goal is canonical.
- `dod_human_only` — remove agent-`done` claims for device/perf/visual; list them as needs-human; do not mark them implemented.
- `assert_fitted` — restore the original assertions/cases; fix **implementation** to the contract; never loosen expectations. If the review skipped this id because the goal changed the contract, do not apply.
- `test_deleted` — (a) goal does **not** drop the behavior → restore deleted cases; do not delete production code in this op. (b) goal **does** drop the behavior → do-not-patch (AskQuestion); do not touch tests in this pass.
- `stub_left` — patch ONLY if the delta is concrete: implement or revert that surface; else do-not-patch (AskQuestion). Do not leave `unimplemented!`.
- `zone_escape` — revert paths outside the stated zone; do not expand the zone.
- `flora_boundary` — revert the illegal import/hunk in the cited files. Do not create `*-contracts`, do not relocate modules. Broader cut → do-not-patch (AskQuestion).
- `flora_frozen` — patch ONLY if (1) the thread already has an explicit user decision **and** the delta cites those frozen paths, apply that delta only; or (2) the delta explicitly lists frozen paths to **revert**, revert those only. Else do-not-patch (AskQuestion). Never lift freeze. Never guess revert vs keep.
- `dead_path` — patch ONLY if the delta picks one side and is concrete: wire a live consumer **or** revert the dead surface. Vague → do-not-patch (AskQuestion). Skip if the review already marked contracts/later-wave (no op).
- `plan_drift` — do-not-patch (AskQuestion): finding must already be in Unknowns; ask whether the plan or the code is canonical. Do not rewrite either.
- `skill_scar` — apply the scar fix named in the delta / zone skill / `Apps/Mobile/AGENTS.md`; do not invent a new perf architecture.
- `new_dep` — revert the dependency unless the thread already has explicit permission to add it; do not swap in a different crate.
- `test_gap` — add tests **only** for the cited production paths in the delta (concrete predicate); never fit expectations to a buggy impl; do not add an unrelated suite.
- `gate_red` — fix production code in zone until the scoped gate is green; **forbidden:** deleting/skipping/fitting tests to go green. Do not “fix” pre-existing red outside the range.
- `rollback_missing` — add rollback/verify for the migration; if the schema change was unauthorized, revert instead.
- `risk_unaddressed` — patch ONLY if the delta is a concrete safe edit (e.g. stop logging a secret); otherwise do-not-patch (AskQuestion).
- `contradiction` — patch ONLY if the delta unambiguously picks a side; two valid sides → do-not-patch (AskQuestion).
- `missing_decision` — do-not-patch (AskQuestion): do not guess the choice.
