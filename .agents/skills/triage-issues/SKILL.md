---
name: triage-issues
description: "Classify and schedule findings relevant to a phase or an explicitly requested backlog scope."
---

# Triage Issues

Read docs/ISSUES.md. Use gh CLI through permitted direct network access. Reconcile labels and milestones, including items in Deferred backlog. Automatically close issues whose full done-criteria have verified evidence; no user input is needed. Keep partial fixes open. Include needs-triage and missing or conflicting classifications. Scope the batch to the phase and dependency blockers unless the user asked for a wider sweep. Do not merely add a new severity while retaining a conflicting one.

Return a table of issue, evidence, type, severity, tier/disposition, and confirmed or pending operation. Flag genuine ambiguity; continue independent classifications.
