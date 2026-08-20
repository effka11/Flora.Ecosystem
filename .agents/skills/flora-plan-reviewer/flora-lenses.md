# Flora lenses — plan-text checklists

Load always (Flora-first). Check whether the **plan** acknowledges these rules; read cited paths (shared ≤10 budget with Goal axis). Do not fish the uncited codebase.

Source of truth for live policy: repo root [`AGENTS.md`](../../../AGENTS.md). This file is a compact review checklist, not a replacement.

## 1) Dependency direction

Allowed: **Apps → Packages → API/host → App-product → modules / Functional kernels**.

Flag `flora_boundary` if the plan implies:

- Functional → Social / `modules/flora-*`
- Products → Apps
- Modules → Apps; Infrastructure → Modules (except interfaces)
- direct dependencies between App-products
- functional kernel → sqlx / axum / flora-shared

## 2) Ownership and logic placement

Flag `flora_boundary` / `ownership_unclear` if the plan:

- mixes business logic across modules
- reads/writes another module’s DB
- shares DB models across modules
- puts business logic in `flora-shared`, `flora-api`, Products composition, or Infrastructure
- imports another module’s internal types/services (bypass `*-contracts`)

Cross-module work must be cut: **contracts/DTO → per-module implementation → integration/wiring**. Missing cut → `contract_uncut`.

## 3) Frozen surfaces

Flag `flora_frozen` unless the plan explicitly records a user decision to change:

- public HTTP contract
- DB schema (evolution only via `flora-migrate` / `Backend/crates/flora-migrate`)
- FIRA formulas (and similar frozen formulas)
- hand-edits to `Documents/test-vectors/**`
- hand-edits to `Artifacts/contract-fixtures/**`

Migration without rollback/verify step → `rollback_missing`.

## 4) Zone → skill / AGENTS map

If the plan touches a zone but does not name the required skill/doc → `flora_skill_gap`:

| Zone | Required before implementation |
|------|--------------------------------|
| `Apps/Web` positioning (`top` / margin / absolute / fixed) | `/apps-web-grid-placement` |
| `Apps/Web` messages chat | `/apps-web-messages-chat` |
| Messaging / FSCP E2E | `/flora-fscp-e2e` |
| `Apps/Mobile` | `Apps/Mobile/AGENTS.md` (+ Expo v56 docs) |
| C#→Rust migration / `Backend/` host cutover context | `/rust-migration` |

## 5) Gates by stack

Risky or non-trivial steps should name a gate; else `flora_gate_missing` / `test_strategy_missing`:

| Stack | Typical gates |
|-------|----------------|
| Rust crate | `cargo fmt --all --check`; `cargo clippy -p <crate> --all-targets -- -D warnings`; `cargo test -p <crate>` |
| Rust workspace / boundaries | `cargo test --workspace`; `cargo deny check`; `pwsh ./Tools/validate-architecture-rust.ps1` |
| JS/TS | `npm run typecheck`; workspace `lint` / `test`; `npm run ci` when broad |

## 6) Risk surfaces

Auth, crypto, payments, PII, session/JWT, witness co-signing (LIV/FEP): plan should name a risk/review step (or explicit acceptance of residual risk). Missing → `risk_unaddressed`. Prefer escalating when contracts or frozen surfaces are involved.

## 7) Approach / algorithm (see [approach.md](approach.md))

Always run the approach probe (Axis B). Flag:

- `approach_unjustified` — algorithm-shaped, method or why missing
- `approach_mismatch` — named method cannot close the goal under stated constraints
- `approach_inferior` — ignores an evidence-backed better alternative (existing Functional primitive, contracts-cut, or a standard simpler method for the same class)

“Better” is relative to the goal, stated constraints, and Flora primitives — not global optimality. Mechanical / spec-prescribed work → Fit `n/a`, no `approach_*` hole.

## 8) Ignore for scoring (unless contradictory)

- `## Model routing` / `## Маршрутизация по моделям` — do not score routing quality
- `## Execution log` / `## Журнал исполнения` — do not score execution history

If those sections contradict plan items → `contradiction`.
