# Ableton Agent

Ableton Live 12 Extensions SDK extension with an embedded agent chat UI.
The installed implementation still uses Claude; the approved product direction
is Sign in with ChatGPT plan usage through the Responses API, as scoped in
[provider migration](CHATGPT_MIGRATION.md). The product runtime is distinct from
the Claude and Codex development harnesses; retain both. Phase 15's migration
and live gate are active, not yet implemented. Sources: `src/extension`
(SDK host, transaction and transport boundaries), `src/webview` (Vite SPA) and `src/shared` (shared TypeScript
contracts). Tests use Vitest and fake SDK/API seams. See
[architecture](ARCHITECTURE.md), [phase plan](PLAN.md), and [progress](PROGRESS.md).

## Checks and live boundaries

- Use the declared Node engine (`>=24.14.1`) and the existing lockfile.
- Headless gate: `npm run lint && npm test`. This includes the local schema
  tests. `npm run validate:tools` is a separate, networked Anthropic schema probe
  that reads API credentials and requires explicit live authorization.
- `npm run build:dev` compiles TypeScript and bundles extension/webview. Run it
  for relevant code changes; it writes ignored output and is not live proof.
- `npm start` starts the real Extensions CLI and is an operator/manual step for
  the recorded Live Beta setup, not an automated or CI check. Do not start Live,
  open a real set, spend API usage, expose secrets, or perform mutations unless
  the user authorizes that live exercise. Refer to the phase's exact smoke
  checklist. Headless checks cannot substitute for a recorded in-Live gate,
  including the replacement Phase 15 live gate.
  Use the installed extension on a disposable Set for current-beta verification.
  OAuth consent and real provider usage require operator authorization; use
  offline fake providers in automated tests.
- Keep API keys, OAuth tokens/codes/credential files, `.env`, runtime
  `config.json`, transcripts, Live sets and `*.ablx` artifacts out of commits,
  logs and issue repros. The legacy Anthropic schema command is not a ChatGPT
  verification command; do not run it to validate the migration.

## Delivery and roles

Git remote metadata identifies `Troll-Phace/ableton-agent`; default branch is
`main`. Existing `dev` work must be reconciled and preserved before cutting a
future phase branch. Do not infer a clean merge or use that branch to ship
unrelated work. See [issue policy](ISSUES.md) and the Codex ship-pr workflow.

Retained implementors: backend-dev, frontend-dev and test-engineer. No user
Codex model/effort choices were available for them during adoption. Leave both
fields unset and do not dispatch these agents until the user selects both per
role. Claude agent configuration and the application's runtime model are not
substitutes. Phase planning uses the dedicated Astra/low agent; the orchestrator
inherits the user's chat selection and code-reviewer is read-only.

## Native client caveats

Hooks use a POSIX shell, Git and Python 3.11+; SessionStart is budgeted for 5s
and SessionEnd for 3s. Session context only reads local data; deferred issue
cache refresh is explicit. The shell's legacy Codex binary and current app-bundled binary are distinct.
Structural and simulated checks do not prove native discovery or delivery. Run a native pilot from a
current Codex client with project trust before claiming those behaviors work.
