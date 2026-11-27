---
name: log-issue
description: "Immediately publish a deferred finding with labels and milestone, or preserve a pending record if access is blocked."
---

# Log Issue

Follow docs/ISSUES.md immediately when a verified finding is deferred, without
waiting for phase close or asking permission. Verify the repository, search open
and closed issues, and prepare evidence, impact, done-criteria and deferral reason.
Use gh CLI through permitted direct network access. Create or update the matching
issue with exactly one type label, one severity label and the appropriate open
milestone; use the Deferred backlog milestone if no planned milestone fits.
Use --body-file for multiline bodies. Confirm the URL and remote classification.
Record unavailable publication or metadata as pending, and reconcile uncertain
writes before retrying. Return the confirmed result or specific operational block.
