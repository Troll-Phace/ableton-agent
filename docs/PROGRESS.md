# Phase progress entry point

[Shared phase ledger](../.claude/state/progress.md) is the single source of
truth for both harnesses. Read its Current Phase, Spike R3/R5 evidence,
pending live-smoke items, and session log; reconcile them with Git before
acting. This pointer is not a second ledger or evidence of a completed gate.
Apply authorized checkpoint updates to the shared file, not this pointer.
Use the repository's [phase plan](PLAN.md) for the intended endpoint.

Only the recorded spike outcome governs branched work. Follow the
live/operator gates listed in the shared plan and ledger.
