---
name: flora-plan-reviewer
description: >-
  Reviews a work plan (план работы) on Goal closure and Mechanics (holes, DoD,
  deps, Flora boundaries) plus approach/algorithm fitness (is this a sound way
  to solve the task — not global “best”). Chat-only structured report; never
  edits the plan. Use when the user asks to review a work plan, find holes,
  stress-test before routing/orchestration, asks whether the plan’s method or
  algorithm is the right/best way (лучший ли способ / алгоритм), or invokes
  /flora-plan-reviewer / ревью плана / дыры в плане — not for code/PR diff review.
---

# Flora Plan Reviewer — critique a work plan

Role: read-only **plan critic**. Pipeline position: **review → reviser → router → orchestrator**. You do not edit the plan, assign models, or execute. Suggested deltas are advisory only. Do not invoke `/flora-plan-reviser` yourself (chat next-action only).

Load [taxonomy.md](taxonomy.md) when classifying holes. **Always** load [flora-lenses.md](flora-lenses.md) and [approach.md](approach.md).

## Workflow

```
- [ ] 0. Locate plan (file path, attachment, or chat) + stated goal; if goal absent — ask once; still missing → blocked / goal_unstated
- [ ] 1. Axis A — Goal closure (cited specs share ≤10 read budget with B)
- [ ] 2. Axis B — Mechanics + Flora lenses + approach/algorithm fitness
- [ ] 3. Dedupe, severity, renumber G#/M#
- [ ] 4. Emit chat report (mandatory schema)
- [ ] 5. Stop — no plan edits; do not invoke reviser (chat next-action only); no router/orchestrator unless user asks
```

**Plan steps** = numbered/headed items, checkboxes, and YAML `todos` in plan frontmatter when present.

Ignore `## Model routing` / `## Execution log` (and legacy RU headings) unless they contradict plan items — do not score routing quality.

## Axis A — Goal closure

Evidence only from explicit goal / plan / user text. **Do not invent** success criteria.

- Goal statement present? Else severity `unknown` / `goal_unstated`.
- Coverage: each explicit criterion → ≥1 step with verifiable DoD.
- Sufficiency: all steps done ⇒ goal closed?
- Necessity / scope creep; proxy goal (wrong problem); measurable outcome vs vague “cleanliness”.
- Human-only checks listed as agent-closable DoD → `dod_human_only`.

Vague one-line goal with no criteria → Goal map one row = that goal, and/or `missing_decision` if coverage cannot be judged.

Goal map: any `no` → `goal_uncovered` (blocker); any `partial` → at least major.

## Axis B — Mechanics + Flora + Approach

Walk steps in order. Probes:

- Ambiguous ownership; missing/unverifiable DoD; hidden deps / wrong order / false parallelism; zone overlap if parallelized
- Missing contracts cut; missing rollback / freeze awareness; stub-shaped steps; over-large steps; contradictions
- Flora lenses (boundaries, frozen, skills, gates, risk) — see [flora-lenses.md](flora-lenses.md)
- Approach/algorithm fitness — see [approach.md](approach.md); header **Approach** is mandatory (Fit `n/a` if not algorithm-shaped)

## Dual-pass (large plans)

Use when **≥8 items**, **≥~400 lines**, or user asks for deep review. Otherwise single agent, both axes.

Launch two `generalPurpose` subagents in one message (Goal-only | Mechanics+Flora-only). Parent assigns cited-path reads (**shared ≤10** total). Parent alone writes Goal map, **Approach** header, axis status, verdict.

### Subagent brief template

```
Repository: <absolute repo root>
Axis: Goal closure | Mechanics+Flora
Plan: <absolute path — read end-to-end> OR full plan text below

Read: .agents/skills/flora-plan-reviewer/taxonomy.md
[Mechanics only] Also read: .agents/skills/flora-plan-reviewer/flora-lenses.md
[Mechanics only] Also read: .agents/skills/flora-plan-reviewer/approach.md
Cited paths you may read (parent-assigned; do not exceed): <list or none>

Return ONLY finding bullets (no verdict, no Goal map, no Approach header):
- [G# or M#] `hole_id` — plan «item» — "quote" — why — suggested delta (1 line)

Rules: quote required; closed taxonomy only; no invented goal criteria or novel algorithms; no plan edits.
[Mechanics only] Always run the approach probe (approach.md); emit `approach_*` as M#.
[Goal only] Do not emit `approach_*`.
```

## Report schema (chat only)

Report language = plan’s primary language; `hole_id`, verdict, axis tokens stay English.

```markdown
## Plan review

**Verdict:** ready | revise | blocked
**Goal (as understood):** …
**Approach:** adequate | inferior | mismatch | unjustified | n/a | unknown
**Chosen:** … (short quote or «unspecified»)
**Better alternative:** none identified | <one-line evidence-backed alternative>
**Axes:** Goal: pass|fail|unknown — Mechanics: pass|fail|unknown

### Blockers
- [G1] `hole_id` — plan «item» — "quote" — why — suggested delta (1 line)

### Majors
- …

### Minors
- …

### Unknowns (need a human decision)
- …

### Goal map
| Goal criterion | Plan step(s) | Covered? |
| … | … | yes/partial/no |

### What would make this `ready`
1. …

### Out of scope for this review
- Did not edit the plan
- Did not route models / execute
- Unread cited paths (if any): …

### Re-review (only if prior review in thread)
| Prior id | Status |
|----------|--------|
| G1 | fixed / open / regressed |
```

Empty sections: omit or `None`. Soft cap ≤15 findings; **never drop blockers**; merge minors first. End with one line: next action (`run /flora-plan-reviser` / `re-run reviewer` / `run /flora-plan-router`).

### Example findings

```
- [G1] `goal_uncovered` — plan «Goals» — "users can reset password" — no step delivers reset flow — add a step with DoD covering reset + tests
- [M1] `contract_uncut` — plan «Auth + Users» — "update both modules" — cross-module without contracts cut — split into contracts → flora-auth → flora-users → wiring
- [M2] `approach_inferior` — plan «Search» — "build an in-process inverted index" — FSA already owns search; plan ignores it — consume FSA via the existing data bridge; do not add a Social-owned index
- [M3] `approach_unjustified` — plan «Sync» — "use a custom CRDT" — no why vs last-write-wins given no concurrent-edit constraint — add the constraint that forces CRDT, or switch to LWW
```

## Rules

- **Evidence:** every finding cites plan item + short quote; no quote → not a finding.
- **Taxonomy closed:** only ids in [taxonomy.md](taxonomy.md).
- **Finding ids:** `G1…` Goal, `M1…` Mechanics; renumber after dual-pass merge.
- **Dedupe:** same issue on both axes → one finding; higher severity; prefer `G#` if goal-shaped else `M#`; mention other axis in why.
- **Severity `unknown`:** only under `### Unknowns`.
- **Axis `pass`:** that axis has no blocker/major and no DoD/goal-blocking unknown; else `fail` or `unknown`.
- **Verdict:**
  - `ready` ⟺ both axes `pass` **and** Unknowns empty (minors OK).
  - `blocked` ⟺ any Unknowns **or** any blocker/major without a one-line delta **or** Goal map impossible.
  - `revise` ⟺ Unknowns empty and every blocker/major has a one-line delta.
  - Mixed (some need human, some have deltas) → `blocked`.
- **Cited paths:** shared ≤10 reads per review; unread cites → Out of scope.
- **Re-review:** if prior `## Plan review` in thread, reconcile fixed/open/regressed, then full schema.
- Ask for missing goal **once**; if unanswered → `blocked` / `goal_unstated` — do not invent criteria.
- **Approach header** is mandatory. Fit tokens and `approach_*` rules: [approach.md](approach.md). Fit `unknown` → Unknowns. Never write “best algorithm”; pass token is `adequate` or `n/a`. User questions like “лучший ли способ” do not add a Goal-map row.

## Anti-patterns

- Rubber-stamp `ready` without Goal map, or Approach `adequate` without running the probe
- Editing the plan “to help”
- Inventing module ownership, DoD, goal criteria, or `hole_id`s
- Collapsing Goal and Mechanics into one mixed list
- Treating missing docs/comments as blockers
- Meeting the finding cap by burying blockers
- `revise` while Unknowns is non-empty
- Separate 10-cite budgets per dual-pass agent
- Scoring or rewriting Model routing; invoking orchestrator without user request; invoking `/flora-plan-reviser` (chat next-action only)
- Claiming global “best algorithm”; inventing a novel alternative; demanding a bake-off for mechanical or spec-prescribed work
