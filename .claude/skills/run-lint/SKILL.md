---
name: run-lint
description: "Run linters and formatters across the Ableton Claude Agent. Use before committing, after implementation, or when code quality checks are needed."
context: fork
allowed-tools: Bash Read Grep Glob
---

# Run Lint & Format

## Steps

1. Run the linter:
   - `npm run lint`   (ESLint over src/ and build.ts)
   - `npx tsc --noEmit` (type-check the whole workspace)
2. Run the formatter in check mode:
   - `npx prettier --check "src/**/*.{ts,css,html}" "*.ts"`
3. Report any issues found with file paths and line numbers.
4. If the user wants auto-fix:
   - `npm run lint -- --fix`
   - `npm run format`   (Prettier write mode)
5. Report summary: {N} issues found, {M} auto-fixed.
