---
name: phase-plan
description: "Plan the current development phase for the Ableton Claude Agent. Use when starting a new phase, when asked to plan, or at the beginning of a session after checking status. ALWAYS fetches up-to-date library documentation via Context7 before planning."
argument-hint: "[phase-number]"
allowed-tools: Read Grep Glob Bash(git status) Bash(git log *) mcp__Context7__resolve-library-id mcp__Context7__get-library-docs
---

# Plan Phase

Review the current development phase and create an implementation plan.

## MANDATORY: Fetch Current Library Documentation (Context7)

**Before doing ANY planning work**, use the Context7 MCP to fetch up-to-date documentation for every library and framework involved in the current phase. APIs change between versions and training data may be stale — this project depends on two fast-moving, beta-era APIs.

1. Identify all libraries/frameworks relevant to this phase's tasks (from docs/ARCHITECTURE.md and the stack below).
2. For EACH, call `mcp__Context7__resolve-library-id` with the library name to get its Context7 ID.
3. For EACH resolved library, call `mcp__Context7__get-library-docs` to fetch current documentation.
4. Use that documentation as the source of truth for API signatures and patterns in your plan.

**Always fetch docs for the libraries this phase touches**, typically including:
- `@ableton-extensions/sdk` (the Extensions SDK — beta, surface may shift)
- `@anthropic-ai/sdk` (Claude Messages API + tool use)
- `ws` (WebSocket, socket branches)
- `vite`, `esbuild`, `vitest` (tooling phases)

**Do NOT skip this step.**

## Steps

1. **Fetch library docs** (above — always step 1).
2. Read .claude/state/progress.md for the current phase **and the recorded Spike R3 outcome (A/B/C/D)**.
3. If a phase number was provided ($0), use that phase instead.
4. Read docs/INSTRUCTIONS.md for the phase's tasks and success criteria.
5. Read docs/ARCHITECTURE.md sections referenced by the phase.
6. **If this is a branched phase (7, 8, 9, 13), select ONLY the task set matching the recorded spike outcome.** If the outcome is not yet recorded, stop and route to Phase 2 first.
7. If the phase involves UI, also read docs/DESIGN_SYSTEM.md.
8. For each task, identify: assignee, files to create/modify, dependencies, architecture refs.
9. Present the plan in table format for approval before execution.

## Output Format

### Phase {N}: {Title}  (Spike outcome: {A/B/C/D or N/A})

**Objective**: {one sentence}
**Prerequisites**: {completed phases}

| # | Task | Assignee | Files | Dependencies | Arch Reference |
|---|------|----------|-------|-------------|----------------|
| 1 | ...  | ...      | ...   | ...         | ...            |

**Parallel opportunities**: {tasks that can run simultaneously}
**Risk areas**: {concerns, unknowns, complexity hotspots}
**Estimated delegations**: {count}
