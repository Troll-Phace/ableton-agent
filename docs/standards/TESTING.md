# Testing

For the active Phase 15 provider migration, use the acceptance matrix in
[CHATGPT_MIGRATION.md](../CHATGPT_MIGRATION.md). Use mocked OAuth and Responses
SSE fixtures, a fake SDK context, and provider-neutral tool/undo proofs. Explicit
operator consent and a disposable Set are required for the installed-host spike
and live smoke. Never run the legacy Anthropic schema probe for this migration.

Use the shared [testing rules](../../.claude/rules/testing.md) and observed
commands in [PROJECT.md](../PROJECT.md). Build tests around fake SDK/API seams
and preserve non-vacuous behavior checks. Report headless gate results separately
from operator Live smoke results. Do not load keys, live transcripts or real
Ableton sets for unit tests. For Codex framework changes run the configured
scaffold validator and Python tests, and distinguish simulated hooks from live
Codex lifecycle events.
