# Approach / algorithm fitness

Mandatory **Axis B** probe. Answers: *is the plan’s method a sound way to solve this task?* — not “the globally best algorithm”.

Load with [taxonomy.md](taxonomy.md). Parent writes the report **Approach** header; dual-pass Mechanics subagent returns `approach_*` findings only.

## When this probe applies

**Algorithm-shaped** (must judge) if the plan or user chooses a method for any of:

- ranking, search, recommend, matching
- sync, replication, consistency, conflict resolution
- encoding, compression, crypto, codecs
- scheduling, batching, backpressure, caches
- migration / backfill strategy
- a new protocol, product, or module “from scratch”
- scale/complexity claims (N users, hot path, latency)
- explicit words: algorithm, approach, способ, подход, архитектура решения

**Not algorithm-shaped** → **Fit:** `n/a`. One line why (e.g. mechanical UI/API wiring, spec-prescribed single path). Do **not** demand a bake-off. Do **not** emit `approach_*` holes.

User question like “лучший ли это способ / is this the best algorithm” **does not** add a Goal-map criterion. It **does** require a filled Approach header even if Fit is `n/a`.

## What “better” means here (relative, not global)

Judge **only** against, in order:

1. Stated goal + explicit constraints in the plan/user text (scale, freeze, latency, correctness).
2. Flora primitives the domain already owns — reuse beats a new Social/App-owned copy: FSA (search), FIRA (affinity; formulas frozen), FSCP (E2E), FRC (codecs), FEP/LIV, FGP, FPP, existing `*-contracts`.
3. Flora mechanics: fewer cross-module deps, contracts-cut, no Functional→Social, no new protocol when an existing one fits.
4. A **standard simpler method for the same problem class** (one-line why). Example: last-write-wins vs an unjustified custom CRDT when the plan states no concurrent-edit requirement.

Do **not**: claim global optimality; invent a novel/research algorithm; fish the uncited codebase for a cleverer idea; score novelty/fashion; require listing N alternatives when the spec already prescribes one method.

## How to judge (walk once)

1. **Name the chosen method.** Quote the plan (data structure, protocol, product, formula, “from scratch”). If algorithm-shaped and unnamed → `approach_unjustified`.
2. **Can it close the goal under stated constraints?** No → `approach_mismatch` (blocker). Overlaps `goal_insufficient` / `proxy_goal`: one finding; prefer `approach_mismatch` when a method is named; mention the other axis in why. Frozen-formula edits → prefer `flora_frozen` (dedupe); mention mismatch in why.
3. **Is there an evidence-backed better alternative?** Existing named Flora primitive, a method the plan itself rejected without a reason, or a standard simpler method for the same class. Yes, and the plan ignores it → `approach_inferior` (major). If that alternative would also violate AGENTS direction, prefer `flora_boundary` and mention inferior in why.
4. **Rationale present?** Algorithm-shaped with no why and no constraints that make the choice forced → `approach_unjustified` (major). De-escalate to `minor` only when a single spec-prescribed path is obvious and only the one-line why is missing.
5. **Cannot judge** (missing constraint: scale, consistency model, freeze exception) → `missing_decision` under Unknowns; **Fit:** `unknown`. Do not invent the constraint.

## Fit tokens (header)

| Fit | When |
|-----|------|
| `n/a` | not algorithm-shaped |
| `adequate` | method can close the goal; no evidence-backed better alternative; rationale present or spec-prescribed |
| `inferior` | works or might work, but a better evidenced alternative exists |
| `mismatch` | cannot satisfy the stated goal/constraints |
| `unjustified` | algorithm-shaped, method or why missing |
| `unknown` | need a human constraint/decision |

**Never** write “this is the best algorithm”. `adequate` is the pass token.

Fit `mismatch` / `inferior` / `unjustified` **must** have a matching `M#` (or deduped `G#`) finding. Fit `unknown` **must** appear under Unknowns (`missing_decision` or `goal_unstated` if the goal itself is missing). `adequate` / `n/a` need no approach finding.

## Suggested-delta style

One line, actionable: switch to the named primitive / simpler method; add a why vs that alternative; or record the constraint that forces the heavier method. Do not attach a new design essay.
