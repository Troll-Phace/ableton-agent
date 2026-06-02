---
name: phase-status
description: "Show the current Ableton Claude Agent progress dashboard. Use when asked about project status, at the start of a session, or when the user wants an overview of where things stand."
allowed-tools: Read Bash(git log *) Bash(git status) Bash(git diff --stat) Grep Glob
---

# Project Status Dashboard

## Steps

1. Read .claude/state/progress.md for phase tracking and the recorded Spike R3 outcome.
2. Check `git log --oneline -10` for recent commits.
3. Run the test suite (`npm test`) and count pass/fail.
4. Count source files and lines of code in src/.
5. Check for TODO/FIXME/HACK comments across the codebase.

## Output Format

**Current Phase**: {N} — {Title} ({status})
**Spike R3 outcome**: {A/B/C/D, or "not yet run"}
**Completed Phases**: {list with dates}
**Build Status**: pass/fail
**Tests**: X passing, Y failing, Z total
**Codebase**: N files, M lines of code
**Open TODOs**: count (list locations if < 10)
**Last Commit**: {hash} — {message} — {date}
**Next Steps**: {what to work on based on progress.md}
