---
name: run-lint
description: "Run configured static and format checks for intended project changes."
---

# Run Lint

Read lint and format_check in framework.json. If a command is unset, establish it from project configuration; do not claim a passing check. Fix only intended formatting using the project formatter, then recheck affected files.

Report checks, results, changed files, and unresolved failures. Do not bulk-reformat unrelated files.
