---
name: safe-commit
description: "Create a well-formatted git commit with safety checks for the Ableton Claude Agent. Use when asked to commit, save progress, or checkpoint work."
argument-hint: "[commit message]"
allowed-tools: Bash(git *) Read Grep
---

# Safe Commit

## Steps

1. Run `git status` to review all changes.
2. Run `git diff --stat` for an overview.
3. Safety checks:
   - Verify NO Anthropic API key, `.env`, runtime `config.json`, credentials, or `.ablx` artifact is staged.
   - Verify `node_modules/` and `dist/` are not staged.
   - Check that lockfiles aren't accidentally modified.
4. Run `npm test` if any source files changed.
5. Stage relevant files (specific files, NOT `git add .` / `git add -A`).
6. Commit with format: `phase({N}): {description}`
   - If $0 was provided, use it as the commit message.
   - Otherwise generate a message from the staged changes.
   - For Phase 2 commits, include the recorded Spike R3 outcome in the body.
7. Report: commit hash, files changed, insertions/deletions.
