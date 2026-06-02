---
name: phase-implement
description: "Execute the planned implementation for the current phase of the Ableton Claude Agent by delegating tasks to subagents. Use after phase-plan has been approved."
allowed-tools: Read Write Edit Bash Grep Glob Agent
---

# Implement Phase

Execute all tasks in the current phase via delegation to subagents.

## Steps

1. Confirm the plan from /phase-plan is approved.
2. For branched phases (7/8/9/13), confirm the recorded Spike R3 outcome and implement ONLY that branch.
3. For each task in dependency order:
   a. Prepare the delegation prompt with full context (architecture refs, design specs, acceptance criteria, spike outcome).
   b. Delegate to the assigned subagent (`backend-dev`, `frontend-dev`, or `test-engineer`).
   c. Review the subagent's output against the task's success criteria.
   d. If issues found, provide specific feedback and re-delegate.
4. After all tasks complete:
   a. Run the full test suite: `npm test`.
   b. Verify every success criterion from docs/INSTRUCTIONS.md.
5. Update .claude/state/progress.md:
   - Check off completed tasks.
   - If all pass: advance to next phase.
   - If any fail: document what needs fixing.
   - For Phase 2 specifically: **record the Spike R3 outcome (A/B/C/D) and the R5 rollback result** — these gate later phases.
