---
name: phase-plan
description: "Delegate detailed phase planning to the dedicated Astra planner, including completed-batch rollover."
---

# Phase Plan

The orchestrator dispatches planning to the dedicated phase-plan agent in
.codex/agents/phase-plan.toml, separate from itself. Use gpt-6-astra with
model_reasoning_effort = low (the user's light effort). With spawn tools that
cannot override a full-history fork, provide a focused handoff without a full
history fork and explicitly select that model and effort. Do not silently fall
back to the orchestrator or another model if the planner is unavailable; report
the limitation and continue independent preparation.

Give the planner the user's scope, actual repository paths, docs/PLAN.md,
docs/PROGRESS.md and the shared plan/ledger they link to, relevant architecture/design/standards, issue references,
framework.json commands, and selected implementor roles. The planner reads and
returns the plan; the orchestrator persists it and owns any file moves. Planning
only does not authorize implementation, commits or a PR.

## Execution-ready plan

Read the repository before naming files or interfaces. Every task needs an ID,
objective, scope/exclusions, exact owned files or creation paths, dependencies,
ordered implementation steps, interface/data/state contracts, edge/error behavior,
relevant architecture references, and observable acceptance criteria. Name exact
checks and expected outcomes, fixtures and required manual/live gates; distinguish
existing commands from proposed ones. Supply examples or pseudocode where
ambiguity would otherwise force an implementor to design behavior. Define safe
parallel groups, integration order, and the evidence each implementor must return.
Resolve design choices before dispatch; mark genuinely unresolved decisions as
blocked questions rather than silently assigning them to implementors. Include
risks, issue/milestone mapping, phase boundaries and the delivery/approval gates.
The orchestrator checks completeness and repository accuracy before execution.

## New batch after all planned phases close

Trigger only when both conditions hold: the final planned phase and all earlier
planned phases are closed with required delivery evidence, and the user requests
a new batch of work be planned. An open deferred backlog alone does not prevent
rollover, but incomplete required phase work does. A status request, resume,
ordinary replan or merely closing the final phase does not trigger it.

1. Reconcile Git, PR outcomes and the ledger. Inventory every active planning and
   progress document, including PLAN.md, PROGRESS.md, phase plans, execution logs,
   results and runbooks in docs/active or other established locations. Classify
   by purpose, not filename alone. Keep persistent policy/reference docs active.
2. Move that full batch state to a unique docs/history/<batch-id>/ directory,
   preserving relative structure, evidence, issue/PR links and unresolved pending
   records. Never overwrite an existing archive. Record a small archive index
   mapping original paths to their new locations; repair internal/inbound links.
   Ableton's actual planning and progress live at docs/INSTRUCTIONS.md and
   .claude/state/progress.md. Archive their prior contents with their relative
   paths, then restore fresh active files at the original paths required by
   Claude imports/hooks. Keep Codex entry points linked to those same files;
   do not create a parallel progress ledger.
3. Refresh docs/PLAN.md and docs/PROGRESS.md as pointers to the fresh shared
   active state documents. Identify the new batch, link its archive, preserve phase numbering
   conventions and carry forward open issues/dependencies explicitly. Do not
   copy completed checkboxes into fresh state or close issues merely to reset it.
4. Update PROJECT.md, ARCHITECTURE.md, DESIGN_SYSTEM.md, standards and other
   persistent project references in place to reflect the actual current system
   and accepted new decisions. Mark proposed architecture as proposed. Keep
   ISSUES.md's standing policy in place; move only batch-specific logs out of it.
5. Verify the inventory was fully archived, fresh state is coherent, links resolve
   and no evidence was lost. A partial rollover is pending, not a completed reset.

Return the phase/task plan, unresolved decisions, archive mapping if applicable,
and next action. Continue implementation only if already authorized.
