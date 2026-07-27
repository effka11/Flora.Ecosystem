# Model family profiles

Reference for assigning plan parts. Do **not hardcode** versions and slugs — take the latest available in the environment (step 0 of SKILL.md). Here — stable family traits: strengths, typical tasks, relative cost.

Relative cost scale: $ (cheap) → $$$$ (flagship). Thinking levels — typical range; check actual availability against environment slugs.

## Anthropic (Claude)

| Family | Cost | Thinking | Strengths | Assign to |
|---|---|---|---|---|
| **fable** | $$$$ | up to max | Absolute frontier: longest autonomous horizon, tool discipline, reconciling foreign results with minimal oversight | Only the most ambitious orchestrations and long unsupervised agents; when near-frontier Opus is not enough and the cost of error justifies ×2 vs Opus |
| **opus** | $$$ | up to max | Near-frontier to Fable (~same bar on coding/agentic benchmarks) at ~½ price; stronger at verifying its own work, RCA/debugging, careful large diffs, long multi-step tasks; thinking on by default | **Default top** for hard parts: security/auth/crypto; public contracts; hard refactors; concurrency; orchestration of medium/large plans; code with expensive failure modes |
| **sonnet** | $$ | up to high | Best quality/price balance among mid-tier; reliable general implementation | Default for standard feature work against a frozen contract; medium refactors; review |
| **haiku** | $ | low–medium | Fast and cheap; follows examples well | Mechanics: rename, configs, docs, simple template tests, routine edits |

### Opus vs Fable (after Opus 5)

- **Opus** — working top by default: coding, agentic implementation, hard refactors, most orchestrations. Take the latest available family version (currently — Opus 5-class).
- **Fable** — escalation from Opus, not a parallel default: a plan with a very long unsupervised horizon, many waves with heavy foreign-result reconciliation, or an explicit “maximum frontier” request.
- Do not pick Fable “just in case”: at similar quality Opus usually wins on plan budget.

## OpenAI (GPT)

| Family | Cost | Thinking | Strengths | Assign to |
|---|---|---|---|---|
| **gpt sol** | $$$$ | up to max | Flagship reasoning, strongest debugging, algorithms, formal precision | Flaky bugs; non-trivial algorithms; data migrations; math/edge-case tasks; Opus/Fable alternative for diversity in parallel waves |
| **terra** | $$ | up to high | Steady mid-level implementation; good spec following | Sonnet alternative for implementation and tests; useful for diversity in parallel waves |
| **luna** | $ | low–medium | Light and fast | Small stuff: boilerplate, glossaries, comments, single-file edits by example |
| **codex** | $$–$$$ | medium–high | Code specialization: dense generation, tests, API work from a spec | Focused code writing in a narrow context; test generation; SDK/clients from a contract |

## Other

| Family | Cost | Thinking | Strengths | Assign to |
|---|---|---|---|---|
| **grok** | $$ | low–high | Iteration speed; fast exploration of a large repo | Codebase exploration before waves; fast edit-run loops; rough prototypes |
| **gemini** | $$–$$$ | up to high | Largest context window; long-document analysis; multimodality | Analyzing large plans/specs/logs whole; multi-file summaries; tasks with images/screenshots |

## Quick heuristics

- Close top-tier escalation criteria with **Opus**, not Fable — Fable only when Opus clearly falls short on horizon/oversight.
- Do not assign two flagships in a dependency chain if the intermediate result is verified by tests — give the middle part to sonnet/terra.
- Do exploration (“understand how X is built”) with grok/gemini **before** the implementation wave — that cheapens implementation parts because they get ready context.
- If the part is “write code strictly from a frozen spec”, codex/sonnet is almost always enough no matter how important the module is: importance was already covered at the spec stage.
- If unsure between levels — take the lower model, higher thinking: usually cheaper and no worse on mid-size coding tasks.
- Between Opus (high) and Fable (high) at comparable part complexity — choose Opus.
