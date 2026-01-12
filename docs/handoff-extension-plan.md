---
summary: Plan for a high-fidelity /handoff workflow via a pi extension.
read_when: Use when implementing or reviewing a seamless handoff feature that creates a new session with curated context from the current session tree.
---

# /handoff Extension Plan

## Goal

Implement a **seamless, high-fidelity** `/handoff <goal>` workflow for `pi` that:

- Produces a **goal-conditioned checkpoint** (not a generic “last N turns” recap).
- Extracts relevant information from the **current session branch** (messages + tool calls/results + summaries).
- Creates a **new session** linked via `parentSession` and pre-fills the editor with a draft prompt.

This is intentionally different from compaction:
- Compaction is for fitting the current thread into a context window.
- Handoff is for starting a new thread with the *right* context, not just the *most recent* context.

## Principles

- **Goal-conditioned extraction**: choose what to carry forward based on the user’s handoff goal.
- **Coverage over recency**: ensure early constraints/decisions survive; don’t only keep “recent”.
- **High signal, bounded size**: hard token budgets; drop noise first.
- **Operationally actionable**: include commands, errors, file paths/symbols required to proceed.
- **Human review**: always present a draft in an editor before submitting.

## Constraints

- Use `ctx.sessionManager` APIs, not JSONL parsing.
- Provider-agnostic (works for any model supported by pi).
- Avoid blowing the context window during handoff generation.
- Preserve exact file paths, function names, commands, and error messages.
- Avoid secrets leakage (do not include raw `.env` contents, tokens, etc.).

## Non-Goals (v1)

- Server-side opaque compaction objects (Codex-style).
- Cross-session retrieval (“search all sessions”) and/or automatic parent-session crawling.
- Replacing compaction/branch summarization.

## Capabilities to Leverage

Session and navigation primitives:
- `ctx.sessionManager.getBranch()` gives the full branch history (not only current LLM context).
- `ctx.sessionManager.buildSessionContext()` gives what the LLM currently sees.
- `ctx.sessionManager.getSessionFile()` and header `parentSession` for lineage.
- `ctx.newSession({ parentSession })` for seamless session creation.

Existing patterns:
- Compaction and branch summarization already define structured summary formats and file tracking.
- Example extension `packages/coding-agent/examples/extensions/handoff.ts` proves the UX skeleton.

## User Experience

1. User runs `/handoff <goal>`.
2. Extension builds a bounded “handoff bundle” using **coverage + relevance** (not only recency).
3. Extension generates a draft prompt using the selected model.
4. User reviews/edits the draft.
5. Extension creates a new session with `parentSession` pointing to the old session file.
6. Extension injects the final draft into the editor and tells the user to submit.

Optional (nice-to-have): a small pre-flight dialog:
- Include repo state (git status/diffstat): yes/no
- Include “operational context” (commands + errors): yes/no
- Include file list rationale: yes/no

## Definitions

- **Branch entries**: `ctx.sessionManager.getBranch()` returns a chronological path root → leaf including:
  - `message` (user/assistant/toolResult/bashExecution)
  - `compaction`, `branch_summary`
  - `custom_message` and extension state
- **Turns**: A turn starts at a user message and includes all assistant messages and tool calls/results until the next user message.

## Output: “Handoff Packet” Format

The output is a single message suitable as the *first message* in a new session.

Recommended structure:

- `## Context`
  - What we were doing and why
  - Key constraints/preferences
  - Key decisions (with rationale)
  - Current state of work

- `## Operational Context`
  - Last successful relevant commands (git/checks)
  - Important failures and their error messages
  - Any stateful actions to remember (generated files, migrations applied)

- `## Files`
  - Files touched (read/modified) with a one-line “why” each
  - Prefer paths + symbols over long excerpts

- `## Task`
  - Restate the user’s `/handoff <goal>` as a crisp objective
  - Ordered next steps checklist

- `## Notes`
  - Risks / gotchas
  - What not to redo

Additionally include machine-parseable blocks:

- `<read-files> ... </read-files>`
- `<modified-files> ... </modified-files>`

## Extraction + Generation Pipeline

### Overview

We avoid “last N turns is the cap” because it can discard early but essential nuance.

Instead we build a bounded bundle from:
- **Summaries** already present (`compaction`, `branch_summary`) — carry forward intentional context bridges.
- **Anchors** selected across the full branch (early constraints, key decisions, hard errors).
- **Recent detail** (a small tail of recent turns) to preserve current momentum.

### Pass 0 (local): Build a lightweight index

From `SessionEntry[]`, compute a turn-based index with features. No model calls required.

For each turn:
- time span, entry ids
- text snippets (first user line, first assistant line)
- extracted file paths mentioned
- whether it contains errors (toolResult.isError / assistant stopReason=error)
- whether it contains high-signal markers (`must`, `constraint`, `decision`, `blocked`, `TODO`, etc.)
- tool calls used (names only)

This index is used to select anchors and bound the later LLM inputs.

### Pass 1: Extract (structured checkpoint)

Goal: produce a compact, structured “facts bundle” that the composer can reliably turn into a clean prompt.

Inputs:
- The user’s handoff goal.
- All `compaction` summaries on the current branch (if any).
- All `branch_summary` entries on the current branch.
- A curated set of turn excerpts from across the branch:
  - **Always**: first user message of the branch + most recent 1–2 turns.
  - **Always**: any turns containing errors or explicit constraints/decisions.
  - **Plus**: top-K turns by relevance to the goal (keyword match against goal + file paths + tool names).

Outputs (structured text):
- Goal
- Constraints & preferences
- Decisions
- Progress (done/in-progress/blocked)
- Errors encountered (with exact error strings)
- File lists + rationale
- “Operational highlights” derived from tool calls (commands to rerun, failures, stateful actions)

Selection rules:
- Prefer including summary entries (`compaction`, `branch_summary`) since they’re already compressed.
- Include full tool results only when they contain:
  - errors
  - diffs/patches
  - stack traces
  - identifiers needed later (paths, command lines, migration IDs)
- Otherwise include a *1–3 line* outcome summary for a tool call.

### Pass 2: Compose (final new-session prompt)

Goal: turn the extracted checkpoint into the final prompt message the user will submit in the new session.

Requirements:
- Clean structure and direct next steps.
- Preserve exact paths/symbols/errors.
- Avoid transcript dumps; reference files instead.

## Relevance Heuristics (v1)

We want coverage guarantees, not just recency.

Always include:
- Latest `compaction` summary if present.
- All `branch_summary` entries on the current branch.
- The **first user message** (often contains the original scope/requirements).
- The most recent 1–2 turns.
- Any turns with errors.

Prefer include (goal-conditioned):
- Turns mentioning files/modules referenced by the handoff goal.
- Tool calls that touched those files.
- Turns where the user states constraints/preferences.

Operational highlights derived from tool calls/results:
- Commands to rerun (git/checks/migrations/scripts).
- Failures: command + minimal error snippet.

Exclude / downweight:
- Repetitive search output.
- Large file dumps unless the goal references them.
- Noisy intermediate logs.

## Token Budgeting (Budget Allocation, Not “N turns cap”)

Reality: the handoff bundle must still fit in a context window.

Instead of hard-capping by “last N turns”, allocate budgets per section and drop noise in priority order.

Suggested allocation (tunable):
- Summaries (compaction + branch summaries): always include (bounded by their own size).
- Structured checkpoint (Pass 1 output): ~2–4k tokens.
- Recent detail: keep until budget (not a fixed count).
- Anchor excerpts: keep until budget.
- Repo state (git status/diffstat): small fixed cap.

Drop order when over budget:
1. Non-error tool outputs.
2. Low-relevance turns.
3. Reduce excerpt lengths (truncate tool outputs / message blocks).
4. Reduce the number of anchors (keep first-user + error turns + top goal-matches).

## Repo State Capture (Optional)

If `bash` tool is enabled, gather lightweight state for the handoff:
- `git status -sb`
- `git diff --stat`
- optional `git log -5 --oneline`

Do not run expensive repo-wide commands.

## Safety / Redaction

The handoff should avoid copying secrets from tool outputs.

v1 rules:
- Never include full contents of `.env`, `auth.json`, `id_*`, or obvious secret files.
- If a tool output contains patterns like `API_KEY=`, `BEGIN PRIVATE KEY`, `Bearer `, redact the value.
- Prefer summarizing credential/setup steps instead of pasting tokens.

## Implementation Steps

1. Implement a project-local extension at `.pi/extensions/handoff.ts` (auto-discovered in this repo). Optionally port it back to `packages/coding-agent/examples/extensions/handoff.ts` later.
2. Implement turn grouping and index builder from `SessionEntry[]`.
3. Implement anchor selection (coverage + goal-conditioned relevance).
4. Extract file ops and produce `<read-files>` / `<modified-files>` blocks.
5. (Optional) collect repo state via bash, gated on tool availability.
6. Implement Pass 1 “extractor” prompt and Pass 2 “composer” prompt.
7. Add editor review step and then `ctx.newSession({ parentSession })` + prefill editor.
8. Add minimal unit tests for:
  - turn grouping
  - anchor selection ordering
  - budget enforcement + truncation
  - redaction rules

## Verification

Manual:
- Long session → `/handoff implement X` → verify new session is created and draft is usable.
- Ensure early scope/constraints survive when the thread is long.
- Ensure cancellation paths do not mutate session.

Automated:
- Unit tests for bundle builder + redaction.

## Follow-ups

- Add handoff “presets” (implementation vs docs vs debugging).
- Add a small interactive selector for which files/commands to include.
- Persist a lightweight “artifact index” as a `custom` entry so subsequent handoffs can be faster and more consistent.
