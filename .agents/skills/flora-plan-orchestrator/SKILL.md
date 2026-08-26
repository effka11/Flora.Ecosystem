---
name: flora-plan-orchestrator
description: Executes an attached work plan as an engineering lead: reads the routing table from flora-plan-router, splits execution into waves, launches subagents with assigned models, runs gates itself (cargo/npm/architecture validator), resolves conflicts, and keeps an execution log in the plan file. If the plan has no routing table — first invokes the flora-plan-router skill. Use when the user asks to execute/implement a plan, distribute a plan to subagents, run a plan from a routing table, or orchestrate agents against a plan.
---

# Flora Plan Orchestrator — execute a plan with subagents

Role: **execution engineering lead**. You do not write the code for plan parts — you own routing analysis, briefs, waves, acceptance, conflicts, and reporting. Subagents write the code using the models assigned in the routing table.

Input: a work plan (file) with a `## Model routing` section from the `/flora-plan-router` skill (`.agents/skills/flora-plan-router/SKILL.md`). Also accept a legacy heading `## Маршрутизация по моделям`. Output: an executed plan, green gates, an execution log in the plan file, and a report to the user.

## Workflow

```
- [ ] 0. Read the plan end-to-end and find the routing table
- [ ] 1. No routing → invoke /flora-plan-router, then continue
- [ ] 2. Build the execution plan: waves, file zones, gates, result contract
- [ ] 3. Capture a gate baseline on a clean tree; start the log (todo + section in the plan file)
- [ ] 4. Per wave: brief → launch subagents → acceptance → gate → log
- [ ] 5. Failures: resume → model escalation → stop and ask the user
- [ ] 6. Final verification, “needs a human” list, report
```

## 0) Parse the routing table

Source — section `## Model routing` (or legacy `## Маршрутизация по моделям`) in the plan file. From each row take: part #, scope, “depends on”, wave, model slug, thinking level, rationale.

- **Row 0 — orchestrator.** If your model does not match the assigned one: say so once and continue; if the table requires a substantially stronger orchestrator (e.g. fable or opus assigned, and you are on a light model) — propose restarting the session on the required model before starting waves.
- **Slug unavailable in the environment.** Slug is stale but the family exists → take the latest available version of the same family and record the substitution in the log. Family missing entirely → ask the user (`AskQuestion`); do not silently substitute.
- **Plan changed after routing** (items added or rewritten, routing date clearly stale) → re-route the delta via `/flora-plan-router`; do not assign models by eye.
- Do not edit the routing table. All factual divergences go into the execution log.

## 1) If there is no routing

Read and execute the `/flora-plan-router` skill (`.agents/skills/flora-plan-router/SKILL.md`): get the table, write it into the plan file — and only then proceed to step 2. Execution “by intuition” without assigned models is forbidden: that kills both budget control and the rationale for model choice. Tell the user in one line that you are routing first.

## 2) Execution plan

Before the first wave, for each part determine five things:

1. **File zone** — concrete files/directories the part is allowed to change. This is the most important item: local subagents share one working directory, so overlapping zones in one wave = lost edits. If the zone is unclear — send a cheap reconnaissance subagent (`subagent_type: explore`, grok/gemini-class model per router) **before** the waves: that also cheapens implementation parts because they get ready context.
2. **Acceptance gate** — concrete commands from “Commands” in `AGENTS.md`, narrowed to the affected crate/workspace.
3. **Result contract** — what the subagent must return in its final message (see §4).
4. **Required context** — which specs and skills the subagent must read: `Apps/Web` edits → `/apps-web-grid-placement` (and `/apps-web-messages-chat` for chat), messaging/E2E → `/flora-fscp-e2e`, C# → Rust migration and `Backend/` edits → `/rust-migration`, `Apps/Mobile` → `Apps/Mobile/AGENTS.md`.
5. **DoD verifiability.** What exactly proves the part is done: a gate command — or a human with a device. Second-kind items (perf measurements, “no flicker”, “no junk”, threshold tuning, visual acceptance) are not closed by a gate: they must not be a `done` condition for a part. Collect them into one “needs a human” list, tell the user about it **before** the first wave, and repeat it in the final report.

Then rebuild waves — by file zones **and** by code dependencies:

- Two parts in one wave have overlapping zones → move one to the next wave, or merge the parts and give them to one subagent.
- **Zones do not overlap, but part B calls a symbol that part A creates → they are not parallel**, no matter what the table says. Walk pairs in the wave and ask: whose code imports whom. A missed dependency gives a red typecheck to whoever finishes first, and the wave collapses mid-flight.
- You can resolve a dependency without breaking parallelism with a **pre-written contract**: a type, options field, or signature (up to ~10 lines) written by you before the wave so both parts compile independently. This does not cover stubs with bodies — declarations only.
- **Cut a cross-cutting part in advance** into “contract → implementation → consumer wiring”. Perf logic, loading bars, cache, data migration look like one plan item but actually pull in foreign files: without a pre-cut this becomes a resume chain where every acceptance opens the next layer of work.
- Wave width — 3–4 subagents. More — reconciling results and conflicts eat the parallelism gain; split into sub-waves by zone. Sub-waves (5a, 5b) are normal when a dependency is discovered inside a table wave; divergence from the table goes into the log.
- Isolated worktrees (`subagent_type: best-of-n-runner`) — escape hatch when parallelism is critical and zones cannot be separated. Then merge is on you: use only if the gain clearly outweighs that cost.

## 3) Gate baseline and execution log

**Before the first wave, run the gate on the current tree and record the baseline in the log:** commit, test count per workspace, count and provenance of pre-existing warnings, green/red commands. Without a baseline, acceptance is blind — you cannot tell a new warning from an old one, and a quietly deleted test looks like “all tests pass”. If the baseline is red, tell the user before starting waves: you are not obliged to fix unrelated redness within the plan, but every later acceptance must know about it.

Keep **two** trackers; they do not replace each other:

- **`TodoWrite`** — one todo per part plus a todo for final verification. Mark all parts of a parallel wave `in_progress` together (a deliberate exception to the “one in_progress” rule).
- **Section `## Execution log` in the plan file** — append-only, updated **after each wave**, not at the end. Also accept a legacy heading `## Журнал исполнения`. If the session breaks, the next orchestrator continues from the log.

Log line format: `wave | part # | model slug | subagent id | status (done/retry/failed/blocked) | gate (command → pass/fail) | 1 line what was done`. Plus a separate line for model substitutions and divergences from the plan.

Do not rewrite the plan itself (wording, order, and content of items stay as-is) and do not touch the routing section.

## 4) Subagent brief

A subagent sees neither the user request, nor your history, nor other subagents’ results. The brief must be self-contained, or the part will be done wrong. Template:

```
Repository: <absolute path to repo root> (user OS and shell)
Plan part N «<part title verbatim from the plan>»
Task: <plan item wording verbatim + 1–3 clarifying sentences>

Files in your zone (change only these): <paths>
Do not touch: <other zones in this wave, frozen surfaces>

Read before starting: AGENTS.md; <skills and specs — see §2 item 4>
Context from prior waves: <what is already done and what to build on: contracts, DTOs, migrations>

Definition of done: <verifiable outcome>
Gate (run yourself before returning): <commands>

Boundaries: a module sees other modules only through their *-contracts crate; business logic
only in modules (not in flora-shared / flora-api / Products composition); own DB — own only.
Forbidden: git commit/push; hand-editing Documents/test-vectors/** and Artifacts/contract-fixtures/**;
changing the public HTTP contract or DB schema; leaving the file zone; quick hacks without explanation;
stubs (unimplemented!/TODO/commented-out tests) instead of implementation;
new dependencies (package.json / Cargo.toml) without explicit permission in this brief.

Gate baseline (do not regress): <test count, pre-existing warning count>

Return in the final message:
1) changed files (paths), 2) gate output (pass/fail + error text),
3) deviations from the brief and why, 4) what remains open, 5) architecture questions — as questions, not decisions.
```

Briefing rules:

- **Take the part wording from the plan verbatim.** Paraphrasing in your own words = requirement drift every wave.
- **`subagent_type` for the task:** implementation and edits → `generalPurpose`; codebase exploration → `explore`; git/commands/runs → `shell`; red CI triage → `ci-investigator`; risky-part diff review → `bugbot`, and auth/crypto/payments → `security-review` (both only if the user asked for review or the part hits router Tier A on risk).
- **`model`** — exact slug from the table; `description` — 3–5 words, distinct across subagents in the wave.
- **Architecture decisions are not delegated to subagents.** The orchestrator or the user decides; the subagent executes. If it returns with an architecture question — answer yourself or ask the user; do not “let it choose”.
- **De-escalate mechanical work.** If you have already frozen all decisions and only expression moves, import cuts, or consumer wiring remain — drop the model one tier against the table (its rationale was about deciding, not executing) and record the substitution in the log. A top model on a move is both burned budget and a long run that is expensive to lose.
- **One brief = one work step.** Three or more independent changes in one brief, “and while you’re at it fix…” — cut into parts. The longer the run, the more is lost on interruption and the later you see the part went off-course.
- **List frozen invariants literally.** Not “respect prior-wave decisions”, but a list: what must not be displaced, when React must not commit, who owns the formula, which signature is frozen. The subagent sees neither the log nor foreign reports.

Example filled brief (part 3 from the router table example — module implementation against a frozen contract, `subagent_type: generalPurpose`, slug `claude-sonnet-…`, thinking medium):

```
Repository: <repo root> (Windows, PowerShell)
Plan part 3 «Implementation in module flora-auth»
Task: implement ports from flora-auth-contracts in module flora-auth: handlers, repository,
error mapping. The contract is already fixed in part 1 — do not change it.

Files in your zone (change only these): Products/Flora.Social/crates/modules/flora-auth/**
Do not touch: flora-auth-contracts (part 1, frozen), Packages/flora-client-core (part 4, running in parallel),
migrations (part 2), flora-api and flora-social.

Read before starting: AGENTS.md; .agents/skills/rust-migration/SKILL.md
Context from prior waves: DTOs and port traits in flora-auth-contracts; part 2 migration already
applied — tables exist, do not change the schema.

Definition of done: contracts ports implemented, errors map to status codes per contract,
module tests cover happy path and 401/409.
Gate (run yourself before returning):
  cargo fmt --all --check
  cargo clippy -p flora-auth --all-targets -- -D warnings
  cargo test -p flora-auth
```

## 5) Launching a wave

- All wave parts — **one message, multiple Task blocks** (so the wave starts in parallel and results converge at one point). `run_in_background: false`, except Multitask Mode or an explicit user request.
- The next wave does not start until the previous gate is green.
- Do not poll subagents (do not use `AwaitShell` for them) — the result comes from the call itself.
- Small inter-wave wiring (import, module registration in composition, version in config — up to ~10 lines) do yourself. Anything larger — a separate part/subagent.
- **A run must be bounded.** A part that runs very long (roughly a quarter hour or more) is almost never “hard” — it is too wide: several independent changes in the brief, or an unfrozen decision the subagent is pushing alone. Next time cut that part; do not endure it.
- **After a session break or subagent interrupt** first `git status --short` and reconcile the tree with the log: an interrupted run may have written nothing, half, or everything. Only then decide. Blind `resume` of an interrupted run is undesirable — it can redo the whole long path; if the tree is empty, a fresh narrow brief on the remainder is cheaper (model — per the de-escalation rule above).

## 6) Accepting a result

Do not trust the subagent report. After each wave, in order:

1. `git status --short` and `git diff --stat` — what actually changed; reconcile with the parts’ file zones. Left the zone → narrow the diff; before reverting foreign edits, ask the user. Diff looks disproportionately huge → repeat with `-w`: reindentation from a new wrapper (JSX, block) inflates the line count without changing logic; compare the `-w` version.
2. **Run the gate yourself.** Rust: `cargo fmt --all --check`, `cargo clippy -p <crate> --all-targets -- -D warnings`, `cargo test -p <crate>`. TS: `npm run typecheck`, plus `lint`/`test` for the relevant workspace. Compare the result to the §3 baseline: test count grew, warning set is the same.
3. **Test diffs must be additive only.** Deleted cases, weakened asserts, expectations fitted to whatever the implementation produced — part failure, even when the run is green. Checked by reading the test-file diff, not by test count.
4. `ReadLints` on changed files; read key diffs (contracts, migrations, auth, public surfaces) with your own eyes.
5. **The mechanism must execute, not only compile.** For a new surface find a live consumer and confirm its entry condition is reachable at runtime: a prefetch bar deeper than the list ever mounts rows; a branch no call ever hits; a parameter nobody passes — “implemented and covered by tests but never called” is not done. Checked by searching call sites and reading the path from the consumer, not by the subagent report.
6. Boundaries: `pwsh ./Tools/validate-architecture-rust.ps1`; no imports of other modules’ internal types; business logic did not migrate into `flora-shared`/`flora-api`/Products composition. Also check import cycles: a cycle that “works because references are read from function bodies” is hidden debt, not a solution.
7. Stubs, `unimplemented!()`, `TODO` instead of code, disabled or implementation-fitted tests, hand-editing `Documents/test-vectors/**` — that is part **failure**, not “done”.
8. **Record new invariants in the log as a frozen contract** before starting a dependent wave: what must not be displaced, when commits are forbidden, who owns the formula, which signature is frozen. An invariant that lives only in your head will be broken by the next part — and that is your error, not theirs.

Final verification of the whole plan: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo deny check`, `pwsh ./Tools/validate-architecture-rust.ps1`, `npm run ci` — whichever are relevant to the touched stacks. Plus: any build step the gate does not run (native libs, codegen, migrations) goes in the report as a separate line of required user action — otherwise the new code physically never reaches the app.

§6 is not `/flora-code-reviewer`. Do **not** invoke the code loop yourself after a wave. If the user asks to review/revise the implementation, run `/flora-code-reviewer` then `/flora-code-reviser` on that diff. Code-loop `ready` does not skip §6; a red §6 gate is not closed by a code-review report.

## 7) Failures, retries, escalation

First distinguish two cases — they are treated differently:

- **Failure** — red gate, unmet DoD, broken invariant. Treated with `resume`.
- **Work found at acceptance** — invariant hole, dead path, missing move, newly surfaced dependency. That is a **new part with its own brief**, not another resume of the same one. Otherwise one part stretches across several runs, holds the wave, and grows context until the model starts losing the original requirements.

Then for failures:

- **First failure** → `resume` the same subagent by its id with a concrete list of divergences. Cheaper than a new brief and keeps context.
- **Second failure** → reassign the part one tier up by router criteria (sonnet/terra → opus or gpt sol → fable); in the brief explicitly list the traps from prior attempts. Record the substitution in the log.
- **Third failure** → stop on this part. Report to the user via `AskQuestion`: what you tried, where it breaks, 2–3 options next. Silently finishing it yourself in a loop is forbidden — that burns the plan budget.
- **Symptoms of bad slicing, not a weak model:** more than two resumes on one part; each resume comes from your acceptance, not a red gate; the subagent repeatedly leaves the zone; DoD is unverifiable; finishing needs access to a foreign module. Then stop the part and cut the remainder into independent parts each with a verifiable DoD; note the divergence in the log — do not edit the plan.
- **Conflicting edits in one file:** do not merge both blindly. Choose the owner by module boundaries; give the second subagent a brief to adapt to the accepted variant.

## 8) When to stop and ask the user

- The part would require violating `AGENTS.md` boundaries: access to another module’s DB, business logic in Shared/API/Products, a direct dependency between App products, functional → Social. Do not execute — reject and propose an alternative.
- Need to change something frozen: public HTTP contract, DB schema, FIRA formulas, `Documents/test-vectors/**`, `Artifacts/contract-fixtures/**`.
- Need `git commit`/`push` or preparing commits — only on an explicit user request.
- The model family from the table is not in the environment.
- The plan is internally contradictory or a key decision is missing — list what is missing and do not start a wave on guesses.

## 9) Reporting

After each wave — 2–4 lines: which wave closed, which parts, what you ran and with what result, what is next.

Final report:

```
Result: <what works now — one sentence>
Parts: N closed / M failed / K blocked
Changes: files by module (git diff --stat)
Verification: commands → result
Plan divergences and model substitutions: ...
Open / needs user decision: ...
Needs a human and a device: <list from §2 item 5 — what and how to check>
Required build steps before checking: <native libs, codegen, migrations>
Budget: how many parts used top models, where retries happened and why
No commits made; execution log written to <plan file>
```

Call out foreign tree edits unrelated to the plan (someone changed files before you) on a separate line in the report — otherwise the user will attribute them to you.

Plus, as `AGENTS.md` requires: briefly — why this structure, how boundaries were kept, why it is safe to scale (the module can be extracted to a service without a large refactor).

## Anti-patterns

- The orchestrator writes part code itself (“faster than explaining”) — nullifies the point of routing and the budget.
- One mega-brief “do the whole plan” to one subagent.
- A parallel wave with overlapping file zones.
- A parallel wave “as in the table” where one part imports what another creates.
- Acceptance from the subagent report without running the gate yourself.
- Acceptance without checking that the new code actually executes in the app.
- Waves without a captured gate baseline: “all tests pass” means nothing without a reference point.
- A third resume instead of opening a new part for work you found at acceptance.
- A top model on a mechanical move when all decisions are already frozen.
- A part marked `done` on a green gate when its DoD is only checkable on a device.
- Changing the model against the table without recording it in the log.
- Editing the routing table or the plan itself “to match reality” — divergences go into the log.
- Delegating an architecture decision to a subagent.
- `git commit` on your own initiative.
- Invoking `/flora-code-reviewer` unprompted after every wave, or using it instead of §6 gates.
