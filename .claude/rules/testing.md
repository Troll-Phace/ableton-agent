---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Standards

## General Rules
- Write tests for every pure module: reference resolution, snapshot serialization, note transforms, tool-argument validation, unit conversion (beats↔seconds), and socket-protocol framing.
- Test happy path, edge cases, and error handling (especially ref drift: deleted/moved/renamed objects).
- **Mock the Anthropic API and the SDK `ExtensionContext`** — never hit the real Claude API or a running Live instance in automated tests.
- Descriptive names: `test_{module}_{behavior}_{scenario}` (e.g. `referenceResolver_reanchorsByName_whenIndexShifts`).
- One logical assertion per test where practical.
- Tests must be deterministic — seed any randomness (humanize/jitter transforms), no wall-clock timing dependencies.

## Vitest Patterns
- Use Vitest (`npm test` → `vitest run`; `npm run test:watch` for watch mode).
- Mock the SDK context with a hand-written `FakeExtensionContext` test double exposing `application.song`, `withinTransaction`, `getObjectFromHandle`, `resources`, `ui`, `environment` — model a small fixture Set (2 tracks, a clip, a device) as plain objects.
- Mock Anthropic with a stub client that returns scripted `tool_use` / `end_turn` responses so the tool-use loop can be driven deterministically.
- Fixtures live in `tests/fixtures/`; the fake Set is a reusable factory.

## What is NOT unit-tested (manual / spike validation)
- Real SDK behavior in Live (mutation-while-modal-open, transaction rollback, webview→localhost reachability) is validated by the **Spike harnesses** (Phase 2), not Vitest. Record outcomes in progress.md.
- Streaming UX and modal lifecycle are verified manually in the Live Beta build.

## Coverage Expectations
- Pure logic (reference resolution, transforms, protocol, validation): 90%+ — these are the integrity-critical paths.
- Tool executors: test argument validation, unit conversion, transaction grouping, and error mapping against the fake context.
- New code generally: 80%+.
