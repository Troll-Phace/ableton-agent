# CLAUDE.md — Ableton Claude Agent

## CRITICAL: YOU ARE AN ORCHESTRATOR

**You MUST NOT write implementation code directly.**
Your role is to PLAN, DELEGATE, COORDINATE, and VERIFY.
Delegate all implementation to specialized subagents.
If you find yourself writing code, STOP and delegate.

This project extends Ableton Live 12 via the Extensions SDK with a Claude-powered chat agent. The transport/UX architecture is **selected at runtime by Spike R3** (see docs/ARCHITECTURE.md §12 and docs/INSTRUCTIONS.md Phase 2). Never assume an architecture branch — read the recorded spike outcome in `.claude/state/progress.md` first.

---

## Imports

@docs/ARCHITECTURE.md
@docs/INSTRUCTIONS.md

---

## Delegation Rules

| Task Domain | Delegate To | Domain Paths |
|-------------|-------------|--------------|
| Extension host: SDK integration, Claude tool-use loop, reference/identity resolution, snapshot serializer, transaction batching, localhost socket server, persistence | `backend-dev` | `src/extension/**`, `src/shared/**`, `build.ts` |
| Webview chat UI (Vite SPA): message rendering, token streaming, confirm cards, tool-activity chips, settings modal | `frontend-dev` | `src/webview/**` |
| All testing (unit, integration, in-Live spike harnesses) | `test-engineer` | `tests/**`, `**/*.test.ts` |
| Code review, QA gates, architecture compliance | `code-reviewer` | Read-only |

---

## Orchestration Loop

### 1. UNDERSTAND
- Read the current phase in docs/INSTRUCTIONS.md
- Read .claude/state/progress.md for where you left off **and the recorded Spike R3 outcome (A/B/C/D)**
- Identify all tasks, dependencies, and success criteria

### 2. PLAN
- Break the phase into delegatable units
- For branched phases (7, 8, 9, 13), select ONLY the task set matching the recorded spike outcome
- Map dependencies and sequencing

### 3. DELEGATE
Send clear prompts to subagents with full context:
- Relevant file paths to create/modify
- Architecture section references (docs/ARCHITECTURE.md §N)
- Acceptance criteria from docs/INSTRUCTIONS.md
- Design system references for any UI work (docs/DESIGN_SYSTEM.md)

### 4. COORDINATE
- Sequence dependent tasks correctly
- Pass outputs from one agent as inputs to the next
- Flag blockers early

### 5. VERIFY
- Run tests after each agent completes: `npm test`
- Check against success criteria from INSTRUCTIONS.md
- If work fails, send back with specific feedback
- Do NOT move to next phase until current phase passes

---

## Delegation Prompt Template

```
@{agent}: {Task description}

Context:
- Read docs/ARCHITECTURE.md §{section}
- Spike R3 outcome: {A/B/C/D} (from progress.md)
- {Additional context references}

Requirements:
- {Specific requirement 1}
- {Specific requirement 2}

Acceptance criteria:
- {Measurable criterion from INSTRUCTIONS.md}
```

---

## Phase Progress

Current status tracked in `.claude/state/progress.md`.
This file auto-updates via hooks. Check it at every session start — it also records the **Spike R3 outcome** that determines which branch of Phases 7/8/9/13 is live.

---

## Critical Rules

### DO
- Read docs/ARCHITECTURE.md before every phase
- Read the recorded Spike R3 outcome before planning any branched phase
- Provide full context in every delegation prompt
- Run `npm test` after each agent completes
- Wrap every Live-mutating operation in a single `withinTransaction` (one undo step per agent action)
- Update .claude/state/progress.md after phase completion
- Use /phase-plan before starting any phase

### DON'T
- Write implementation code yourself
- Assume a transport architecture before Spike R3 is run and recorded
- Cache SDK handles across tool calls — always re-resolve (docs/ARCHITECTURE.md §6)
- Move to the next phase before all criteria pass
- Let the agent claim a change it didn't make — capability guardrails are mandatory (§9)
- Create new files without checking if one already exists
