# Code review — hole taxonomy

Closed set. Do **not** invent `hole_id`s. If nothing fits: nearest id + note in why, or `missing_decision`.

Severity tokens: `blocker` | `major` | `minor` | `unknown`.
Axis: `G` = Goal closure on the **diff**; `C` = diff mechanics + Flora + scars.

Findings with severity `unknown` go only under `### Unknowns` (never under Blockers/Majors/Minors). Non-empty Unknowns ⇒ Verdict `blocked`.

This loop judges **code that already exists**. Do not re-score a work plan (that is `/flora-plan-reviewer`). Do not invent product success criteria.

## Hole ids

| id | axis | default severity | meaning |
|----|------|------------------|---------|
| `goal_unstated` | G | unknown | no explicit goal in user text, plan, or part DoD |
| `goal_uncovered` | G | blocker | success criterion with no delivering change in the diff |
| `goal_insufficient` | G | blocker | the whole diff still would not close the stated goal |
| `scope_creep` | G | major | hunks/files unrelated to the goal (revert only if the range was explicit `since=` / stated zone — see patch-ops) |
| `proxy_goal` | G | blocker | the diff solves a different problem than the stated goal |
| `dod_human_only` | G | major | perf / flicker / visual / device check presented as agent-closed |
| `assert_fitted` | C | blocker | tests weakened, skipped, or expectations fitted to the implementation (skip: the stated goal explicitly changes that contract) |
| `test_deleted` | C | blocker | test cases removed without the goal authorizing it |
| `stub_left` | C | major | `unimplemented!`, empty body, `TODO` instead of code (skip/ignore to go green → `assert_fitted`) |
| `zone_escape` | C | major | edited paths outside a **stated** file zone (skip if no zone was stated) |
| `flora_boundary` | C | blocker | AGENTS direction, ownership, foreign DB/models, logic in host/shared/composition, internal imports |
| `flora_frozen` | C | blocker | frozen surface (HTTP, schema, FIRA formula, test-vectors, contract-fixtures) without an explicit user decision |
| `dead_path` | C | major | new surface/API/branch never reached from a live in-repo consumer (skip: `*-contracts` / contracts-only zone when a later wiring part is in the cited plan/brief) |
| `plan_drift` | C | unknown | method or scope differs from the cited plan (skip if no plan); which side is canonical is a human choice |
| `skill_scar` | C | major | violated a named scar in a required zone skill / `Apps/Mobile/AGENTS.md` |
| `new_dep` | C | major | new `package.json` / `Cargo.toml` dependency without explicit permission in the thread |
| `test_gap` | C | major | non-trivial new logic in the diff with no corresponding test |
| `gate_red` | C | major | scoped gate failed and the failure is in this diff’s zone |
| `rollback_missing` | C | major | migration/data change without rollback/verify |
| `risk_unaddressed` | C | major | auth/crypto/payments/PII/JWT/LIV witness in the diff without evidence of care |
| `contradiction` | C | blocker | hunks conflict with each other or with the stated goal |
| `missing_decision` | G or C | unknown | cannot finish the review without a human choice |

## Severity overrides

- Goal map row `partial` → at least `major` (`goal_insufficient` or `goal_uncovered`).
- Goal map row `no` → `goal_uncovered` / `blocker`.
- Escalate `risk_unaddressed` / `flora_frozen` / `flora_boundary` when the diff touches frozen HTTP/auth contracts or DB schema.
- Escalate `skill_scar` to `blocker` when the scar is a known ship-blocker (e.g. per-frame text `color` on Android Fabric).
- De-escalate to `minor` only for wording/comment nits that do not affect goal, tests, boundaries, or scars.
- `assert_fitted` overlapping `test_deleted`: one finding; prefer `assert_fitted`.
- `assert_fitted` overlapping `stub_left` (skipped/ignored tests): prefer `assert_fitted`.
- `dead_path` overlapping `goal_uncovered`: one finding; prefer `G#` / `goal_uncovered` if the missing consumer **is** the goal criterion; else `dead_path`.
- `plan_drift` overlapping `proxy_goal`: prefer `proxy_goal` when the product problem is wrong; else `plan_drift` (Unknowns).
- `plan_drift` overlapping `missing_decision`: one Unknown; keep `plan_drift`.
- `flora_boundary` overlapping illegal internal imports: prefer `flora_boundary`.
- Never de-escalate `assert_fitted` or `test_deleted`.
- Human-choice findings (`plan_drift`, any delta that would be `AskQuestion:`) live **only** under Unknowns. They are not Blockers/Majors and are not a patchable one-line delta.
