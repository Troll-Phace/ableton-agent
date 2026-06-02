---
name: run-tests
description: "Run the Ableton Claude Agent test suite with detailed reporting. Use after any implementation work, when asked to test, or as part of phase verification."
argument-hint: "[file pattern or test name]"
context: fork
allowed-tools: Bash Read Grep
---

# Run Tests

Execute the project's Vitest suite and report results.

## Steps

1. If a specific file pattern or test name was provided ($0), run only those:
   - `npx vitest run $0`
2. Otherwise run the full suite:
   - `npm test`   (alias for `vitest run`)
3. Parse output for pass/fail/skip counts.
4. For any failures:
   - Show the test name and error message.
   - Show the relevant source code context (the module under test + the FakeExtensionContext or Anthropic stub if relevant).
   - Suggest a likely fix.
5. Report summary: {passed}/{total} tests in {duration}.

> Note: automated tests cover pure logic only (reference resolution, transforms, protocol framing, tool validation). In-Live SDK behavior is validated by the Phase 2 spike harnesses, not here.
