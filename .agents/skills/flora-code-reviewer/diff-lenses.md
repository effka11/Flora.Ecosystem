# Diff lenses — code-text checklists

Load always with the taxonomy. Source of policy: repo root [`AGENTS.md`](../../../AGENTS.md). Flora dependency/ownership/freeze/gates: [`../flora-plan-reviewer/flora-lenses.md`](../flora-plan-reviewer/flora-lenses.md) — apply those checks to the **diff**, not to plan wording. Do not copy that file here.

This loop adds probes the plan loop cannot see. Skip a probe when it does not apply (no stated zone → skip `zone_escape`; no plan → skip `plan_drift`).

## 0) Diff object (required)

Evidence is the change, not intent. Pick **exactly one** range, in order:

1. User passed `since=<ref>` or a PR/branch → `<base>...HEAD` **only**. Working tree: include a dirty file **only if it already appears in that commit range**. Extra dirty files → ask once; unanswered → `missing_decision`. Do not silently merge unrelated WIP into the PR range.
2. User / plan part / orchestrator brief stated a **file zone** → `git diff HEAD -- <zone>` plus untracked under that zone. If that diff is **>15** non-generated files and the user did not explicitly name that wide zone, ask to narrow. If they did name it and the diff is ≥30 files / ≥~800 lines → dual-pass (SKILL.md).
3. The **last implementation report** in this thread listed changed files (or that turn’s `git diff --stat`) → those files only. Not every path ever mentioned in the chat.
4. Working tree vs `HEAD` is non-empty, **≤15** non-generated files, and a goal is stated → working tree vs `HEAD`.
5. Else → **one** ask for goal (if missing) **and** range/zone together. Unanswered → `goal_unstated` and/or `missing_decision`. Do **not** review the whole dirty monorepo. Empty working tree is **not** `ready`: ask for `since=` (merge-base with `main` / the branch). Do not rubber-stamp an empty diff.

Record **Range kind** in the report: `since` | `zone` | `thread-files` | `working-tree` (needed for `scope_creep` ops).

Then:

1. Read `git status --short` and `git diff` for that range, plus untracked source in range.
2. Ignore generated noise unless it is the change: `node_modules`, `target`, `.expo`, `android/**/build`, `*.lock` except when the finding is `new_dep`.
3. Every finding quotes a diff hunk or a concrete new-file snippet. No quote → not a finding.
4. Do not fish the uncited repo. Extra reads: `AGENTS.md`; **mandatory** zone skill / `Apps/Mobile/AGENTS.md` when that zone is in the range (counts toward the budget); call sites of **new** exports (few targeted greps). Shared cited-path budget with Goal axis: **≤15** file reads besides the diff itself.

## 1) Tests are a contract

Flag `assert_fitted` / `test_deleted` (never minor):

- Deleted test files or cases without the goal saying the behavior is gone
- `toBe` / `assert_eq!` / expected status **changed to match** whatever the new code returns
- `it.skip` / `#[ignore]` / commented assertions added to go green
- Snapshot/fixture regenerated to hide a behavior change (unless the goal is the new snapshot)

**Skip `assert_fitted`** when the stated goal **explicitly** changes that contract (the new expectation *is* the goal). Then a matching assert change is not fitting.

A green gate does **not** clear `assert_fitted` / `test_deleted`. Read the **test-file diff**, not the test count.

Flag `test_gap` when non-trivial branches/invariants landed with no new or extended test **on the cited production paths**. Mechanical moves, copy, CSS-only, or spec-prescribed one-liners → no `test_gap`. Do not demand a new test suite beyond those paths.

Flag `stub_left` for `unimplemented!`, `todo!`, empty `TODO` bodies, `throw new Error('not implemented')`. Skip/ignore to go green is `assert_fitted`, not `stub_left`.

## 2) Live path

Flag `dead_path` when a new export, screen, flag, or branch has no reachable in-repo consumer, or the consumer’s entry condition can never be true (prefetch that never mounts, param nobody passes). Search call sites; do not trust comments.

**Skip** `dead_path` when the new symbols live in a `*-contracts` crate (or contracts-only zone) **and** the cited plan/brief has a later wiring/consumer part — unless *this* range’s goal was to wire that consumer.

## 3) Zone scars (only if the diff touches the zone)

If the range touches a row below, **load the Required read before Axis B**. Do not invent scars absent from that skill/AGENTS. Do not skip the read.

| Zone in the diff | Required read | Typical `skill_scar` |
|------------------|---------------|----------------------|
| `Apps/Web` `top` / margin / absolute / fixed | `/apps-web-grid-placement` | pixel placement, missing grid coordinates |
| `Apps/Web` messages chat | `/apps-web-messages-chat` | compose / stickers / voice player off the skill |
| `Apps/Web` UI copy / titles | `.cursor/rules/flora-ui-dash-separator.mdc` | em-dash `—` instead of `FLORA_TITLE_SEPARATOR` |
| `Apps/Mobile` | `Apps/Mobile/AGENTS.md` | per-frame text `color`; RN `ScrollView`/`TextInput` inside a pager (must be RNGH); `removeClippedSubviews` on a `translateX` container |
| Messaging / FSCP E2E | `/flora-fscp-e2e` | wire/security improvisation |
| `package.json` / `Cargo.toml` deps | thread permission | `new_dep` |

## 4) Gates (required)

Run the scoped gate from [`flora-lenses.md`](../flora-plan-reviewer/flora-lenses.md) §5 for every touched Rust crate / TS workspace in the range. Not optional. Not “when cheap”. **Do not** run root `npm run ci`, `cargo test --workspace`, or `cargo clippy --workspace` for a narrow range — narrow to the touched package/crate.

Attribute by **diagnostic path**:

- Error points at a file **in this range** → `gate_red`.
- Error points only at files **outside** the range (or matches a stated orchestrator/user baseline) → not a finding; note under Out of scope as `pre-existing red`. Do **not** put that on Unknowns. Do **not** fail the review because orchestrator §6 did or did not run.
- Fail with **no** path and no baseline → one `missing_decision` for that gate only.

This loop does not replace wave acceptance.

## 5) Plan drift

If a work plan is in the thread or attached: method/scope divergence → `plan_drift` under **Unknowns** (human picks canonical side). Do not put it in Majors. Do not write a patchable delta. Do not re-run the approach bake-off; do not invent a better algorithm; do not assume the plan wins. No plan → skip.

## 6) Ignore unless contradictory

- `## Model routing` / `## Execution log` in a plan file
- Unrelated dirty files the user said to ignore
- Comment-only or docs-only nits (not blockers)
- Asking for more comments or “cleanliness”
- Pre-existing gate red outside the range (see §4)
