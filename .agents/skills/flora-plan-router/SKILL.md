---
name: flora-plan-router
description: Splits a work plan into parts for subagents and assigns each part an optimal agent model (fable, opus, sonnet, haiku, gpt sol, terra, luna, grok, codex, gemini) with a thinking level and rationale, balancing quality and cost. The first row picks the orchestrator model. Writes the routing table into the attached plan file. Use when the user asks to distribute a plan across models/subagents, assign models to tasks, or asks which model should do what. Do not route when a ## Plan review in the thread is not ready (revise/blocked) — send the user to /flora-plan-reviser first.
---

# Flora Plan Router — route a plan across models

Input: a work plan (text, document, TODO, PRD). Output: a table of plan parts with assigned model, thinking level, and rationale — **written into the plan file itself** when the plan is attached as a file. The first row is the orchestrator model that, on a separate request, will drive the subagents.

## Workflow

```
- [ ] 0. Reconcile available models and thinking levels
- [ ] 1. Analyze the plan (scope, modules, risks, dependencies)
- [ ] 2. Split into parts per the rules below
- [ ] 3. Assign a model and thinking level to each part
- [ ] 4. Choose the orchestrator
- [ ] 5. Build the table and a short budget summary
- [ ] 6. Write the table into the plan file (if the plan is attached as a file)
```

If the thread or plan already has `## Plan review` whose verdict is not `ready` (`revise` or `blocked`), do **not** emit a routing table — tell the user to run `/flora-plan-reviser` first. Do not guess a table over a non-ready review.

## 0) Reconcile available models (required)

Model-family profiles live in [models.md](models.md). Versions and available thinking levels change, so before filling the table:

1. Take exact slugs from the list of models available for subagents in the current environment (model slugs in the Task tool description / Cursor model list).
2. For each family use the **latest available version** (for opus — Opus 5-class and newer when present in the environment).
3. Specify a thinking level only from those actually available for that model (usually a subset of low / medium / high / max; for some models the level is fixed in the slug — then state it as-is).
4. If the requested family is not in the environment — do not silently substitute: note the nearest replacement in the table and call it out in the summary.

## 1) Plan analysis

Before splitting, identify and record in 3–5 lines:

- which modules/workspaces are touched (for Flora: `Products/*/crates/modules/*`, `Backend/crates/*`, `Apps/Web`, `Apps/Mobile`, `Packages/*`);
- high-risk zones: DB migrations, public HTTP contracts, auth/security, concurrency, frozen surfaces;
- which work depends on what, and what can proceed in parallel;
- overall scale (hours/days) — this drives whether an expensive orchestrator is warranted.

## 2) Rules for splitting into parts

Each part becomes one subagent task, so:

1. **One part = one verifiable outcome.** A part has a clear definition of done: “endpoint X responds per contract”, “migration applies and rolls back”, “tests Y are green”. Merge parts that lack a verifiable exit with neighbors.
2. **Part boundary = architecture boundary.** A part must not cross module/workspace boundaries. Work that touches several modules is cut into: (a) a “contracts/DTO” part, (b) one part per module, (c) an “integration/composition” part.
3. **Dependency layers set the order.** Typical sequence: contracts and data schema → per-module implementation → integration/wiring → tests and verification → docs/rollout. Parts within one layer are parallel candidates.
4. **A parallel wave must not share files.** Parts that will run on subagents at the same time must not touch the same files (including lockfiles and shared configs). If they would — either one part, or different waves.
5. **Size: 2–8 hours of focused agent work.** Smaller — merge (context overhead eats the savings); larger — cut by sub-outcomes.
6. **Homogeneous complexity.** Do not mix architecturally hard work and mechanical work in one part: otherwise you pay top-model price for boilerplate. Pull mechanics (renames, configs, docs) into separate cheap parts.
7. **Risk stands alone.** DB migrations, auth, public-contract changes, concurrent code — always separate parts so a strong model can be assigned surgically.

For each part record: title, scope (files/modules), dependencies (part numbers), parallelism wave.

## 3) Model assignment

Default principle: **mid-tier by default (sonnet / terra / codex); any deviation either way needs an explicit criterion.** Do not swat flies with a microscope — and not the reverse.

Escalation to top models is two-tiered:

**Tier A — Opus** (default top; near-frontier to Fable at ~½ the price). Assign if at least one is true:

- the part crosses inter-module contracts or changes a public API;
- security/auth/cryptography/payment logic;
- data migrations or concurrency/distributed invariants;
- a non-trivial algorithm, RCA, or debugging a flaky bug;
- cost of error — broken prod or expensive rollback;
- a long multi-step agentic implementation where self-checking the diff matters.

**Tier B — Fable** (escalation from Opus only, not a parallel default). Assign instead of Opus if at least one is true:

- a very long unsupervised horizon (the agent must drive work for hours with almost no oversight);
- orchestration with heavy reconciliation of many foreign results and conflict resolution on the critical path;
- an explicit user request for maximum frontier / Fable.

**gpt sol** — a peer alternative to Tier A (and sometimes B) for debugging, algorithms, migrations with edge cases; useful for diversity in parallel waves next to Opus.

De-escalate to light models (haiku, luna, grok) only if all are true:

- the work is mechanical and well-specified (template, rename, config, docs, simple tests by example);
- the part is isolated and errors are caught by tests/linter;
- holding a large context is not required.

Assign thinking level independently of the model: high/max — for architecture, debugging, invariants; medium — standard implementation; low — mechanics. Raising thinking on a mid model is often cheaper than taking a top model; but for the escalation criteria above — take both the top model and a high level. Between Opus (high) and Fable (high) at comparable complexity — choose Opus.

Family specialization (details — [models.md](models.md)): fable — only the most ambitious long autonomous/orchestration tasks; opus — default top (hard refactors, security, contracts, most orchestrations); sonnet — universal workhorse; haiku — mechanics; gpt sol — hard debugging and algorithms; terra — mid-level implementation; luna — small stuff and boilerplate; grok — fast code exploration and iteration; codex — focused code and test writing; gemini — large-context document analysis.

## 4) Orchestrator

The first table row is the orchestrator: the model that, on a separate request, will decompose waves, launch subagents, reconcile results, and resolve conflicts. Criteria:

- **plan ≥ 5 parts, with parallel waves or cross-module dependencies** → Opus (or gpt sol), thinking high — near-frontier at a better budget;
- **same scale, but a very long unsupervised horizon / heavy reconciliation of many agents on the critical path** → Fable, thinking high;
- **linear plan of 2–4 parts with no overlap** → sonnet, thinking medium — an expensive orchestrator does not pay off here;
- the orchestrator needs long horizon, tool discipline, and reconciling foreign results — not raw code-generation speed. max thinking is usually unnecessary for the orchestrator: deep thinking goes to subagents on hard parts.

## 5) Output format

Table (first row — orchestrator):

| # | Part | Scope | Depends on | Wave | Model (slug) | Thinking | Rationale |
|---|------|-------|------------|------|--------------|----------|-----------|
| 0 | Orchestrator | whole plan | — | — | claude-opus-…-high | high | 7 parts, 3 parallel waves — Opus covers near-frontier result reconciliation without ×2 Fable price |
| 1 | Auth contracts: DTO + ports in `flora-auth-contracts` | 1 crate, ~3 files | — | 1 | claude-opus-… | high | Public inter-module contract; cost of error — refactor all consumers (Tier A) |
| 2 | DB migration + rollback | 1 migration, verify scripts | 1 | 2 | gpt-…-sol-… | high | Data migration: needs edge-case analysis and a rollback plan |
| 3 | Implementation in module `flora-auth` | 1 module, ~6 files | 1 | 2 | claude-sonnet-… | medium | Standard implementation against a frozen contract; risks covered by tests |
| 4 | Client in `@flora/client-core` + types | 1 package | 1 | 2 | …codex-… | medium | Focused TS code per spec, narrow context |
| 5 | Update CI configs and docs | 3 files | 3, 4 | 3 | claude-haiku-… | low | Mechanical edits by example; CI catches errors |

Table requirements:

- under “Model” — the exact current slug (after step 0), not an abstract family name;
- “Rationale” — 1 sentence: why this model and level, referencing an escalation/de-escalation criterion (for top models — Tier A/B);
- “Wave” shows which parts can run in parallel.

After the table — a 2–4 line summary: how many parts on top models (how many Opus vs Fable) and why, where budget was saved, which parts block the critical path. If a `## Plan review` is present and not `ready` (`revise` / `blocked`) — do not emit a routing table; tell the user to run `/flora-plan-reviser` first. If there is no review yet and the plan is too vague to split — first list the missing decisions and do not emit a guessed table; suggest running `/flora-plan-reviewer` (`.agents/skills/flora-plan-reviewer/SKILL.md`) before routing.

## 6) Writing the table into the plan file (required when the plan is a file)

If the plan arrived as a file (attached document, path in the request, plan/PRD/TODO open in the editor) — the table and summary are **written into that file**, not only into chat. Otherwise routing is lost by the time subagents start.

How to write:

1. **Where.** Section `## Model routing` at the end of the plan file. If that section already exists — rewrite it entirely; do not duplicate. Also accept a legacy heading `## Маршрутизация по моделям` and replace it with `## Model routing`. If the plan has an explicit place for execution metadata (section “Execution”, “Agents”, “Rollout”) — insert there.
2. **What.** Exactly what §5 describes: the table (first row — orchestrator) + budget summary. Plus, as the first line of the section — routing date and the environment the slugs came from (step 0), so it is clear when the table goes stale.
3. **Tie to plan items.** If plan items are numbered or have headings — in the “Part” column refer to them by the same number/title so the part maps unambiguously to the source item. Inventing a numbering on top of the existing one is not allowed.
4. **Do not rewrite the plan itself.** Wording, order, and content of plan items stay as-is; only adding the routing section is allowed. If the split into parts diverged from plan items — explain the divergence in the summary, do not edit the plan.
5. **No plan file** (plan dictated in chat) — emit the table in chat and ask where to save it, suggesting a path; do not create a new file yourself.
6. After writing, name the changed file and section — and duplicate the table in chat if it is short.
