---
name: ship-pr
description: "Finalize phase ledgers, commit and open a PR; merge after user approval and reconcile progress directly on main."
---

# Ship PR

Use gh CLI through the permitted direct network route in docs/ISSUES.md for all
GitHub operations. Preserve unrelated changes and use a phase branch. Respect an
explicitly narrower user endpoint; otherwise authorized phase completion follows:

1. Resolve blockers and verify phase criteria. Update all progress, plan status,
   issue references, evidence and ledgers before the completion commit. State
   technical readiness accurately and mark merge pending; never claim a future
   PR or merge has happened. Close fully verified issues per docs/ISSUES.md.
2. Inspect and stage intended files, run required checks on the final content,
   commit, push and open/update the branch PR. Reuse an existing PR. Use
   --body-file for its summary, phase reference, validation and issue references.
   Attach the PR to the chat when the host provides that capability.
3. Present the concrete PR for user approval. Wait before merging; do not treat
   general implementation authorization as PR approval. If approval for this PR
   was already given, do not ask again. Material changes after approval require
   renewed approval of the changed PR.
4. After approval, verify required checks and review requirements on the current
   PR head and merge via gh. A new commit invalidates prior head evidence. Do not
   use admin override, force-push or bypass protection. Confirm merged state,
   merge commit and issue outcomes remotely.
5. If progress/ledger docs need immediate merge-status corrections, synchronize
   main (or the established default branch), edit only those docs, validate the
   relevant links/content, commit and push directly. No follow-up PR or redundant
   approval. Preserve unrelated local edits, using a clean checkout if necessary.
   If protection blocks the direct push, report the pending correction rather
   than bypass protection or silently opening a PR. Confirm local/remote parity
   and any checks required for the documentation commit before claiming delivery.

Use Refs unless all issue criteria will be satisfied by merge; closing keywords
must not close partial or live-verification-pending issues. No code changes belong
in the direct-main documentation exception. Report PR, merge, reconciliation and
remaining pending operations separately. Do not delete another worktree's branch.
