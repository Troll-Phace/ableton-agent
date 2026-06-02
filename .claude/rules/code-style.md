---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "build.ts"
  - "*.config.ts"
---

# Code Standards — Ableton Claude Agent

## TypeScript Standards (extension host + webview + shared)
- **ESLint**: clean, no warnings (`@typescript-eslint` recommended-type-checked ruleset).
- **Prettier**: applied on save (enforced by the PostToolUse hook). 2-space indent, double quotes, semicolons, trailing commas (es5).
- **`strict: true`** in every tsconfig. No `any`, no non-null `!` except where the SDK forces it on freshly re-resolved handles (comment why). Prefer `unknown` + narrowing.
- **Error handling**: every `async` SDK call and every tool executor is wrapped in try/catch; failures return a structured tool error (`{ error, ref?, detail, hint }`), never an unhandled rejection. The host has only `console.*` → `ExtensionHost.txt`, so log context on every catch.
- **Naming**: `camelCase` for vars/functions, `PascalCase` for types/classes, `SCREAMING_SNAKE` for constants, tool names are `snake_case` and namespaced `live_*`.
- **Module organization**:
  - `src/extension/` — Node host code (SDK, Claude client, tools, transport server, persistence).
  - `src/webview/` — Vite SPA chat UI. **Never imports from `src/extension/`.**
  - `src/shared/` — types shared across the socket boundary (protocol messages, ref strings, tool arg shapes). Pure types + pure functions only; no SDK, no DOM.
- Comments (TSDoc) on all exported functions/classes.

## Async & SDK Discipline (project-critical)
- `async`/`await` everywhere; never mix with raw `.then()` chains.
- **Never cache SDK handles or resolved objects across tool calls.** Re-resolve every ref to a fresh handle immediately before use (docs/ARCHITECTURE.md §6).
- **Never `await` inside `context.withinTransaction(...)`.** To group async creations, `return Promise.all([...])` from the transaction and await the transaction itself (docs/ARCHITECTURE.md §7).
- All Live mutations for one agent action go in a single `withinTransaction` where possible; create-then-configure legitimately spans two.
- Time values crossing the tool boundary are in **beats**; convert seconds↔beats (`60/tempo`) only inside executors, never expose seconds to the agent.

## Webview Standards
- Vite + TypeScript, vanilla DOM (no heavy framework). Keep the bundle small.
- The webview talks to the extension ONLY over the transport defined by the active Spike R3 branch (WebSocket or `close_and_send`). No other host access.
- Never embed the Anthropic API key in webview code or markup — the extension owns all Claude calls.

## Import Organization
- Order: Node/SDK builtins → third-party → `src/shared` → local. Blank line between groups.

## Prohibited Patterns
- No filesystem access outside `environment.storageDirectory` / `tempDirectory` (docs/ARCHITECTURE.md §10).
- No third-party plugin names passed to `insertDevice` (built-in Live devices only).
- No `localStorage`/`sessionStorage` reliance for anything that must survive a session (use the storage directory).
- No silent no-ops in tool executors — always return success data or a structured error.
