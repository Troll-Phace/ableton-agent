# Testing

Use the shared [testing rules](../../.claude/rules/testing.md) and observed
commands in [PROJECT.md](../PROJECT.md). Build tests around fake SDK/API seams
and preserve non-vacuous behavior checks. Report headless gate results separately
from operator Live smoke results. Do not load keys, live transcripts or real
Ableton sets for unit tests. For Codex framework changes run the configured
scaffold validator and Python tests, and distinguish simulated hooks from live
Codex lifecycle events.
