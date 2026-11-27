# Code style

During the provider migration, follow [CHATGPT_MIGRATION.md](../CHATGPT_MIGRATION.md)
for the host-only OAuth, neutral tool boundary and Responses stream contract.
No credentials in the webview, logs, Git or issue repros; no implicit provider
fallback. Existing provider-specific examples are the historical Claude baseline.

Use the shared [project code-style rules](../../.claude/rules/code-style.md)
for TypeScript, folder boundaries, and naming. The active architecture is
[ARCHITECTURE.md](../ARCHITECTURE.md); for branched phases follow the recorded
Spike R3 outcome in the [shared progress ledger](../PROGRESS.md). Preserve
handle re-resolution, transaction and destructive-confirmation boundaries.
