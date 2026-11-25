---
name: run-tests
description: "Run relevant project tests and diagnose failures within the phase scope."
---

# Run Tests

Read framework.json and docs/standards/TESTING.md. Use the configured non-watch test command, or a documented targeted invocation for the requested test. Use the verify command for a phase-wide gate. Commands are project data, not portable assumptions.

Report exact command, result, duration when available, failing behavior, and evidence for the suspected cause. Follow the diagnostic budget in AGENTS.md. Delegate noisy, substantial diagnosis only when useful.
