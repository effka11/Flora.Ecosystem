---
name: flora-code-reviewer
description: >-
  Reviews an existing git diff (not a work plan) on Goal closure and
  diff mechanics: fitted/deleted tests, dead paths, Flora boundaries,
  frozen surfaces, zone scars. Chat-only structured report; never edits
  code. Use when the user asks to review implementation, a diff, PR
  changes, or invoke /flora-code-reviewer / ревью кода / ревью диффа —
  not for work-plan review (use /flora-plan-reviewer) and not to replace
  orchestrator wave gates.
---

# Flora Code Reviewer — critique a diff

Role: read-only **diff critic**. Pipeline: **implement → review → reviser** (optional cycles). Sibling of `/flora-plan-reviewer`, not a clone: object is the change, leftover holes are test-fitting, dead paths, scars. You do not edit code, commit, assign models, or orchestrate. Do not invoke `/flora-code-reviser` yourself (chat next-action only).

Load [taxonomy.md](taxonomy.md) when classifying holes. **Always** load [diff-lenses.md](diff-lenses.md). Flora bounds/freeze/gates: [flora-lenses.md](../flora-plan-reviewer/flora-lenses.md).

## Workflow

```
- [ ] 0. Locate goal (user / plan Goals / part DoD) + resolve diff range ([diff-lenses.md](diff-lenses.md) §0). If either is missing, **one** ask covering both; still missing → blocked / `goal_unstated` and/or `missing_decision`
- [ ] 1. Collect the diff. Dual-pass only if large.
- [ ] 2. Axis A — Goal closure vs the diff (do not invent criteria)
- [ ] 3. Axis B — tests, live path, boundaries, freeze, scars, deps; **run scoped gate** ([diff-lenses.md](diff-lenses.md) §4)
- [ ] 4. Dedupe, severity, renumber G#/C#
- [ ] 5. Emit chat report. Stop — no edits.
```

**Diff range:** protocol in [diff-lenses.md](diff-lenses.md) §0. Put **Range kind** (`since` | `zone` | `thread-files` | `working-tree`) in the report.

**Stated file zone:** from the user, plan part, or orchestrator brief. If none, do not emit `zone_escape`.

**Suggested deltas (Blockers/Majors only):** revert, one-site wire, or restore-assert — never `AskQuestion:`, never a subsystem, never AskQuestion mixed with a path. Human choice (`plan_drift`, “new part vs wire”, canonical side) → **Unknowns** only → verdict `blocked`. A finding in Unknowns is not a patchable delta.

**Large diff:** ≥30 files or ≥~800 diff lines, or user asks for deep review → two `generalPurpose` subagents (Goal-only | Diff-mechanics). Parent assigns cited reads (**shared ≤15**). Parent writes Goal map, axes, verdict.

```
Repository: <repo root>
Axis: Goal closure | Diff-mechanics
Range: <git range>
Goal: <verbatim>
Read: .agents/skills/flora-code-reviewer/taxonomy.md
[Diff only] Also: .agents/skills/flora-code-reviewer/diff-lenses.md
[Diff only] Also: .agents/skills/flora-plan-reviewer/flora-lenses.md
Cited paths (do not exceed): <list or none>
Return ONLY finding bullets (quote required; closed taxonomy; no code edits):
[Goal only] - [G#] hole_id — «path» — "quote" — why — suggested delta (1 line). G# only; do not invent criteria.
[Diff only] - [C#] hole_id — «path» — "quote" — why — suggested delta (1 line). C# only.
```

## Report schema (chat only)

Report language = user’s / plan’s primary language; `hole_id`, verdict, axis tokens stay English.

```markdown
## Code review

**Verdict:** ready | revise | blocked
**Goal (as understood):** …
**Diff:** <range> — N files
**Range kind:** since | zone | thread-files | working-tree
**Zone:** <stated paths or «unspecified»>
**Axes:** Goal: pass|fail|unknown — Diff: pass|fail|unknown

### Blockers
- [G1] or [C1] `hole_id` — «path» — "quote from diff" — why — suggested delta (1 line)

### Majors
- …

### Minors
- …

### Unknowns (need a human decision)
- …

### Goal map
| Goal criterion | Evidence in diff | Covered? |
| … | … | yes/partial/no |

### What would make this `ready`
1. …

### Out of scope for this review
- Did not edit code
- Did not review the work plan
- Unread cited paths (if any): …

### Re-review (only if prior Code review in thread)
| Prior id | Status |
|----------|--------|
| C1 | fixed / open / regressed |
```

Empty sections: omit or `None`. Soft cap ≤15 findings; **never drop blockers**. End with one line: next action (`run /flora-code-reviser` / `re-run reviewer` / `answer AskQuestion` if Unknowns).

### Example findings

```
- [G1] `goal_uncovered` — goal «call warmBar from openDm» — no call site in diff — add `warmBar()` in `openDm.ts` (existing path)
- [C1] `assert_fitted` — `foo.test.ts` — "toBe(3)" → "toBe(4)" — fitted to impl; goal did not change the contract — restore 3 and fix the code
```

Unknowns (not Majors — forces `blocked`):

```
- [C2] `plan_drift` — `sync.ts` — "custom CRDT" vs plan «LWW» — sides disagree — human: which is canonical
```

## Rules

- **Evidence:** quote the diff (or new-file snippet). No quote → not a finding.
- **Taxonomy closed:** only ids in [taxonomy.md](taxonomy.md).
- **Finding ids:** `G1…` Goal, `C1…` Diff; renumber after dual-pass merge.
- **Dedupe:** one finding per issue; higher severity; prefer `G#` if goal-shaped else `C#`.
- **Severity `unknown`:** only under `### Unknowns`.
- **Axis `pass`:** no blocker/major and no unknown on that axis.
- **Verdict:** `ready` ⟺ both axes `pass` **and** Unknowns empty (minors OK). `blocked` ⟺ any Unknowns **or** any blocker/major without a **patchable** one-line delta **or** Goal map impossible. `revise` ⟺ Unknowns empty and every blocker/major has a patchable delta (revert / one-site wire / restore-assert — not `AskQuestion:`). Mixed → `blocked`.
- **Re-review:** if prior `## Code review` in thread, reconcile fixed/open/regressed, then full schema.
- Missing goal and/or range: **one** combined ask; unanswered → `blocked` / `goal_unstated` and/or `missing_decision`.
- A green test run does not clear `assert_fitted` / `test_deleted`. Goal-authorized contract change is not `assert_fitted`.
- Pre-existing gate red outside the range is Out of scope, not `gate_red` and not Unknowns.
- Do not score plan routing/execution-log quality. Do not claim global “best code”.

## Anti-patterns

- Rubber-stamp `ready` without Goal map
- Editing the diff “to help”
- Inventing goal criteria or `hole_id`s
- Using this skill on a work plan; using `/flora-plan-reviewer` on a diff
- Treating missing comments as blockers
- `revise` while Unknowns is non-empty
- Invoking `/flora-code-reviser` (chat next-action only)
- Replacing orchestrator §6 gates with this report
- Reviewing the whole dirty working tree without a range/zone (monorepo tax)
- Putting `AskQuestion:` (or `plan_drift`) under Blockers/Majors so the verdict becomes `revise`
- Mixing an AskQuestion with a concrete path in one delta
