---
name: flora-plan-reviser
description: >-
  Edits a work plan surgically from a flora-plan-reviewer report using a closed
  patch-op set and an invariant check. Does not mark the plan ready, assign
  models, or execute. Use when the user asks to revise a plan after review,
  close holes from a Plan review, or invokes /flora-plan-reviser /
  «доработай план» / «закрой дыры» / «исправь план по ревью» — not for
  routing, orchestration, or code/PR review (use /flora-code-reviser).
---

# Flora Plan Reviser — edit a work plan after review

## Role / pipeline

Role: **plan editor**. Pipeline position: **review → reviser → router → orchestrator**. After verdict `revise` / `blocked`, this is the only stage allowed to edit plan items — surgically, closed op set, invariant check vs regressions. The critic (`/flora-plan-reviewer`) stays read-only. This skill never writes a reviewer verdict `ready` and never launches router or orchestrator.

**Always** load [patch-ops.md](patch-ops.md) before classifying or editing. Hole ids: [taxonomy.md](../flora-plan-reviewer/taxonomy.md). Named Flora gates/skills: [flora-lenses.md](../flora-plan-reviewer/flora-lenses.md). Do not copy those files into this skill. If a review `hole_id` has no row in patch-ops.md, **stop** — do not invent an operation.

Chat report language = the plan’s primary language; finding ids (`G#`/`M#`), `hole_id`s, and tokens stay English. No scripts.

## Input / output

**Input:** plan file + `## Plan review` (this thread or attachment).

**Output:** edits **in the plan file** + chat report `## Plan revision`.

- No `## Plan review` → run `/flora-plan-reviewer` first; do not invent holes.
- Source verdict already `ready` → change nothing; next action may be `run /flora-plan-router`.
- Verdict `blocked` (mix of human questions and deltas) → AskQuestion the human items **and** apply unrelated `patch` items in the same turn.
- Plan only in chat → table of proposed edits in chat + ask where to save; **do not create** a new plan file.

## Workflow

```
- [ ] 0. Locate plan + ## Plan review; no review → run reviewer first
- [ ] 1. Snapshot invariants (goal, non-goals, constraints, per-step owner/DoD/gates/skills/deps)
- [ ] 2. Classify each G#/M#: patch | skip | needs-human
- [ ] 3. Same turn: AskQuestion on needs-human AND apply all `patch` items from patch-ops.md (do not wait on human answers to land unrelated surgical edits)
- [ ] 4. Sync YAML todos in plan frontmatter if present
- [ ] 5. Invalidate ## Model routing if items split/added/reordered (remove the section so orchestrator re-routes); do not touch ## Execution log
- [ ] 6. Regression walk vs snapshot; emit ## Plan revision; stop
```

**Snapshot (step 1).** Record, before any edit: stated goal; non-goals / out of scope; freeze notes; constraints; and per step: owner, DoD, named gates, named skills, depends-on. This list is the regression baseline.

**Classify (step 2).** SoT for each `hole_id` is [patch-ops.md](patch-ops.md) — one op + forbid per taxonomy id; AskQuestion-only ids and apply-predicates are marked there. Do not enumerate or invent ops in this file.

- **needs-human** (AskQuestion, do not patch): Unknowns; any finding whose patch-ops.md row is do-not-patch or whose apply-predicate fails; any **vague** suggested delta that would require guessing.
- **patch:** every other finding whose patch-ops.md row is apply-able and whose suggested delta is concrete. Minors only if the edit is surgical (wording, skill name, one gate) — do not bloat the plan “while here”.
- **skip:** already reflected in the plan, or a minor that is not surgical. Record why.

Do not wait for AskQuestion answers before landing unrelated surgical patches. One agent, whole plan. **No** dual-pass, **no** subagents.

**Code-read budget: 0** by default. Do not search the repo. Read a cited path only if the delta needs an exact crate/skill name missing from the plan and the review (cap ≤5).

**YAML todos (step 4).** If the plan has frontmatter `todos`, mirror structural edits: added/split/removed items, updated `content` / `depends on` when those changed. Do not invent new todos that were not authorized by a `G#`/`M#`.

**Model routing (step 5).** If items were **split, added, or reordered**, **remove** the `## Model routing` section so a later orchestrator re-routes. Wording-only / DoD-only patches leave routing in place. **Never** edit `## Execution log` (do not append, rewrite, or delete it). Do not write a new routing table.

**Cycle.** Default: **one** patch-pass, then stop. **Next** in chat = `re-run /flora-plan-reviewer`. Auto-cycle (this skill runs the reviewer, then revises again) **only** if the user explicitly asks to close to `ready` — max **2** revise→review iterations, then stop. Do not invoke `/flora-plan-router` or `/flora-plan-orchestrator`.

**Hard stops (do not proceed as editor):** source verdict already `ready` (change nothing); missing/incomplete [patch-ops.md](patch-ops.md) vs the review’s `hole_id`s or vs taxonomy; no plan (file or chat) to edit. No `## Plan review` is **not** a hard stop: run `/flora-plan-reviewer` first (step 0), then continue as editor.

## Invariants (anti-regression)

Before edits, snapshot. After edits, **regression walk (step 6):**

- Every snapshotted goal / non-goal / freeze / constraint is still present, or a cited `G#`/`M#` authorized the change.
- Every snapshotted owner, DoD, gate, skill, and depends-on is still present or authorized.
- No plan item outside the review list was rewritten.
- `## Execution log` unchanged; `## Model routing` removed only on split/add/reorder.

Strengthen OK, weaken not:

- DoD / gates / named skills / ownership / freeze notes / non-goals — only **add or clarify**, never drop.
- Approach (algorithm) change **only** on `approach_*` and **only** to the alternative already in the review report (`Better alternative` / suggested delta). Do not invent a new method.
- Do not invent goal criteria. Close only Goal map rows and the explicit goal.
- Delete a step only for `scope_creep`: **move** it to Out of scope (create that heading if missing), never silent drop.
- Do not rewrite items the review did not list.
- Vague suggested delta → `needs-human`, not a guess.

## Report schema (chat)

```markdown
## Plan revision

**Source review:** revise | blocked | ready
**Applied:** G1, M2, … (N)
**Skipped:** … — why
**Needs human:** …

### Invariants
- Preserved: …
- Authorized change: «item» — finding id — what

### Edits
- «plan item»: 1 line what changed

**Self-check:** not a review; remaining Unknowns yes/no
**Next:** re-run /flora-plan-reviewer | answer AskQuestion | run /flora-plan-router
```

Forbidden: writing reviewer verdict `ready` (this report is not a review). Omit empty sections. `Source review: ready` is allowed only when the incoming review was already `ready` and **no edits** were made.

**Self-check** means: you did not rubber-stamp Goal/Mechanics; you only patched listed findings; remaining Unknowns yes/no.

**Next** defaults to `re-run /flora-plan-reviewer` after a patch-pass. Use `answer AskQuestion` when needs-human is non-empty. Use `run /flora-plan-router` only when the source review was already `ready` (nothing changed).

## Anti-patterns

- Rewrite the plan from scratch “to make it cleaner”
- Invent answers to Unknowns, goal criteria, or module-owner
- Weaken DoD, drop a gate, or change approach without `approach_*`
- Add scope that was not in the findings
- Assign models or launch orchestrator
- Self-assign `ready` without a fresh `/flora-plan-reviewer`
- Review↔revise loop more than 2 iterations
- Edit `## Execution log`
- Invent patch ops instead of loading [patch-ops.md](patch-ops.md)
- Incomplete [patch-ops.md](patch-ops.md) (not every taxonomy `hole_id` has a row)
- Dual-pass / subagents; repo-wide code reads
- Creating a new plan file when the plan existed only in chat
- Waiting on AskQuestion before applying unrelated `patch` items
- Copying [taxonomy.md](../flora-plan-reviewer/taxonomy.md) or [flora-lenses.md](../flora-plan-reviewer/flora-lenses.md) into this skill or into the plan
