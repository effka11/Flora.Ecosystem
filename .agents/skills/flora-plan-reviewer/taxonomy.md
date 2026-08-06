# Plan review — hole taxonomy

Closed set. Do **not** invent `hole_id`s. If nothing fits: nearest id + note in why, or `missing_decision`.

Severity tokens: `blocker` | `major` | `minor` | `unknown`.
Axis: `G` = Goal closure, `M` = Mechanics (+ Flora).

Findings with severity `unknown` go only under `### Unknowns` in the report (never under Blockers/Majors/Minors). Non-empty Unknowns ⇒ Verdict `blocked`.

## Hole ids

| id | axis | default severity | meaning |
|----|------|------------------|---------|
| `goal_unstated` | G | unknown | no explicit goal in plan or user message |
| `goal_uncovered` | G | blocker | success criterion with no plan step (Goal map `no`) |
| `goal_insufficient` | G | blocker | all steps done still would not close the goal |
| `scope_creep` | G | major | step unrelated to the goal |
| `proxy_goal` | G | blocker | plan solves a different problem than the stated goal |
| `dod_missing` | M | major | no verifiable definition of done |
| `dod_human_only` | M | major | DoD only checkable by a human/device, presented as agent-closable |
| `ownership_unclear` | M | major | module/crate/workspace owner unclear |
| `dep_hidden` | M | major | wrong order, hidden dependency, or false parallelism |
| `contract_uncut` | M | major | cross-module work without contracts → modules → wiring cut |
| `zone_overlap` | M | major | parallel parts would share files / lockfiles |
| `step_too_large` | M | major | step has no single verifiable exit |
| `contradiction` | M | blocker | plan items conflict with each other |
| `stub_shaped` | M | major | defers real work (“wire later”, “TODO tests”) |
| `flora_boundary` | M | blocker | violates AGENTS dependency/ownership rules |
| `flora_frozen` | M | blocker | touches a frozen surface without an explicit user decision |
| `flora_gate_missing` | M | major | risky change with no named gate command |
| `flora_skill_gap` | M | major | touches Web/Mobile/FSCP/migration zone without naming required skill/AGENTS |
| `risk_unaddressed` | M | major | auth/crypto/payments/PII change without risk/review step (blocker if frozen/auth contract change) |
| `rollback_missing` | M | major | migration/data change without rollback/verify |
| `test_strategy_missing` | M | major | non-trivial logic with no test/gate step |
| `missing_decision` | G or M | unknown | cannot finish the review without a human choice |

## Severity overrides

- Goal map row `partial` → at least `major` (usually `goal_insufficient` or `goal_uncovered`).
- Goal map row `no` → `goal_uncovered` / `blocker`.
- Escalate `risk_unaddressed` / `flora_skill_gap` to `blocker` when the change hits frozen HTTP/auth contracts or DB schema.
- De-escalate to `minor` only for wording/order nits that do not affect DoD, goal closure, or boundaries — never for boundary/frozen/uncovered-goal holes.
