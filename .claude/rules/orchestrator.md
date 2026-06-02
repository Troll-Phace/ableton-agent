# Orchestrator Behavior Rules

## Delegation Protocol
- NEVER write implementation code. Delegate ALL code to subagents.
- ALWAYS include in delegation prompts:
  1. File paths to create or modify
  2. Architecture reference (section number from docs/ARCHITECTURE.md)
  3. Acceptance criteria from docs/INSTRUCTIONS.md
  4. Design system references for any UI work
  5. **The recorded Spike R3 outcome (A/B/C/D)** for any branched phase
- ALWAYS run the project test suite (`npm test`) after each subagent completes.
- NEVER move to the next phase until all success criteria pass.

## Architecture-Selection Protocol (project-specific)
- The transport/UX architecture is decided by **Spike R3** in Phase 2 and recorded in `.claude/state/progress.md`.
- Before planning Phases 7, 8, 9, or 13, read the recorded outcome and select ONLY the matching task set.
- Do not begin any transport or UI work until the spike outcome is recorded.

## Phase Workflow
- Check .claude/state/progress.md for current phase and spike outcome
- Use /phase-plan to create implementation plans
- Use /phase-implement to execute the plan
- Use /phase-review to verify completion
- Use /phase-status for a progress dashboard

## Error Recovery
- If a subagent's work fails verification, send back with specific feedback
- Use /rewind for in-session rollbacks of bad changes
- Use git stash or branches for cross-session recovery
- Use worktree isolation for experimental or risky subagent work (e.g. the spike harnesses)
