# Issue policy

Standing user authorization (October 1, 2026): immediately publish every
verified deferred defect or meaningful deferred work item to the configured
GitHub repository. Do not wait for phase close or request per-issue approval.
Automatically close an issue once Codex verifies all its done-criteria are fixed;
no user input or separate closure approval is needed. These are agent-operated
workflows, not autonomous hook or background-service guarantees.

## Capture and categorization

Verify repository identity from framework.json and Git remotes. Search open and
closed issues before creation. Update a matching open issue with new evidence;
inspect closed matches for regressions instead of silently dropping a finding.
Record what, where, reproduction/evidence, impact, done-criteria, and deferral
reason. Keep unconfirmed suspicions explicitly unconfirmed.

Each issue has exactly one type: bug, feature, perf, refactor, docs, test, or
security; and one severity: critical, high, medium, or low. Labels use type: and
severity: prefixes. Optional status labels include needs-triage and blocked.
Critical blocks affected delivery; high precedes dependent phases; medium is
scheduled; low is optional or batched. Remove conflicting labels when reclassifying.

Assign an appropriate existing open milestone during capture, using the project's
roadmap categorization. Milestones group planned outcomes, not severity levels.
If no milestone fits, use or create a Deferred backlog milestone with no invented
due date, then refine it during planning. Creating the required labels and this
fallback milestone is included in the standing categorization authorization.
Do not leave categorization until phase close. If permissions prevent metadata
updates, still publish the issue if possible and record the pending labels or
milestone with the exact operational reason.

## GitHub execution

Use gh CLI as the primary interface for GitHub reads and writes, including gh api
for milestones. Run gh through the host's permitted direct/regular network
execution route from the first call. With exec_command in a restricted sandbox,
request require_escalated for that scoped command rather than repeating a known
network-blocked call. This does not grant access or bypass a denied approval,
managed policy, authentication, or branch protection. Do not globally disable the
sandbox or change global settings. Hooks cannot grant themselves network access;
run explicit refresh-backlog commands through the same permitted route.

Use explicit --repo owner/repo (or repos/owner/repo API paths), and --body-file
for multiline issue and PR bodies. Verify the resulting issue URL, labels,
milestone and state. Reconcile uncertain writes against remote state before
retrying to avoid duplicates. When the repository is unresolved or access fails,
keep an immediate pending record in the shared ledger linked from
docs/PROGRESS.md with prepared content,
classification, milestone and failure reason; retry when the constraint clears.
GitHub is canonical after confirmation. Never record credentials in artifacts.

## Verified closure

Check every issue done-criterion against the actual fix and record reproduction,
regression/direct-check evidence and the fixing commit or PR. A passing generic
suite, phase completion, or partial fix is insufficient. Keep unmet criteria open.
If done-criteria require merge, deployment or live verification, wait for that
evidence. Close automatically with gh issue close --reason completed and an
evidence comment when all criteria are met; verify the remote closed state.
PR closing keywords are appropriate only when merge completes all remaining
criteria. Otherwise use Refs and close explicitly after verification. Issue
closure does not authorize merging a PR; PR approval remains a user gate.
Milestone closure remains separate and requires its full scope to be satisfied.
