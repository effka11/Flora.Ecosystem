---
name: flora-smart-agent-economy
description: >-
  Gathers information in a disposable subagent so a high-class parent's context
  stays small. The gatherer uses the model the user named in this message,
  otherwise the standing slug in gatherer.txt, otherwise grok-4.7-xhigh, and
  returns a short evidence brief. The parent keeps the decision, the edit, and
  the answer. Use when a task needs multi-file search, codebase exploration,
  log or data digging, or a broad how-it-works question, or when the user says
  flora-smart-agent-economy, экономь токены, сабагент, gatherer, собери информацию.
---

# Flora smart agent economy

The parent is the model answering the user. Everything it reads stays in its context for the rest of the chat. The gatherer reads in its own window, which is discarded. The parent receives a brief.

The save is that context. The default gatherer is `grok-4.7-xhigh`: a strong model writes the brief, so the parent still has the facts it would have found itself. A cheaper gatherer runs only when the user names it. A gap in a brief is unknown — the parent does not invent the missing fact.

Delegate even when the parent is already on the gatherer's model. The window being saved is the parent's conversation.

## Which model gathers

1. The user named a model in this message → that slug, this gather only. Leave the standing file untouched.
2. Otherwise the first non-empty line of `~/.cursor/skills/flora-smart-agent-economy/gatherer.txt`.
3. Otherwise `grok-4.7-xhigh`.

The slug must be in this session's subagent model list. A short name (`opus`, `sonnet`, `grok`, `composer`, `flash`, `gemini`, `gpt`, `соннет`, `грок`) matches one slug in that list. Several matches → the slug whose name is closer to the user's words (`grok 4.7` → `grok-4.7-xhigh`, not a 4.6 slug).

- The built-in default is missing from the list, and the user did not require that exact slug → the latest `grok-*` slug in the list. No grok family → say so and use `inherit`.
- The user, or `gatherer.txt`, named a slug that is not in the list → do not substitute. Say which slug is missing and which slugs exist.

`запомни` / `remember` / `по умолчанию` writes that slug as the only line of `gatherer.txt` (create the directory if needed).

Pass `model` on a fresh Task. On `resume`, omit `model`.

## When to gather

Send a gatherer when the parent would otherwise take file bodies, a fan-out of search hits, logs, or a comparison of several places into its own context.

Keep on the parent: one known file, one symbol, an answer already in the chat, and the span the parent is about to edit. The user said to look yourself → keep the read on the parent.

The gatherer does not decide, edit, commit, or answer the user. Implementation parts stay with `/flora-plan-orchestrator`. This skill is the read.

## Call

`Task`, local, not cloud. `run_in_background: false` unless the session is already in Multitask Mode. `description` — 3–5 words naming the question, distinct when several run together.

- Repo questions → `explore`.
- Logs, data files, shell → `generalPurpose`. If this session lists a `shell` subagent type, use it for command-only gathers.

Independent questions → several Task calls in one message. A follow-up in the same area → `resume` that gatherer. A different area → a new gatherer.

The prompt is self-contained. The gatherer does not see this chat. Do not paste the user's whole message. Put only the return block below into the prompt, not this skill.

```
Question: <one question>
Root: <absolute repo path>
Known: <facts already established>
Scope: <directories, or unknown>
Do not edit, commit, or answer the user.

Return at most 60 lines:
- Answer: <the fact>
- Evidence: path:start-end — why this line matters. Quote only if the decision turns on the wording (8 quoted lines max in the whole brief). A call chain is hops, not pasted functions.
- Missing: <what you searched and did not find>
- Conflict: <two readings, both with lines — or none>
- Next: <one narrower read if the answer is incomplete, or none>
```

## What the parent does with the brief

The brief is the evidence. Leave cited files closed. Two exceptions: the span you are about to edit, and a claim you are about to reject — read those lines yourself.

A decision-critical fact with no path and lines → one `resume` with one narrow question. Do not start a fresh crawl, and do not guess.

The parent writes the user's answer from the brief. The gatherer's message is not that answer. The user's whole task does not go to the gatherer.

## Examples

Delegate: "which modules call the session port, and what do they pass?" — several files, one `explore` brief.

Keep: the brief named `flora-auth/src/lib.rs:40-80` and you are about to change those lines — read that span, then edit.
