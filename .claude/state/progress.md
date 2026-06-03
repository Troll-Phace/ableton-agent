# Project Progress — Ableton Claude Agent

## Current Phase
Phase: 5
Title: Tool Registry & Executors
Status: NOT STARTED
Started: 2026-06-02
> Next: Phase 4 COMPLETE. Phase 5 (tool schemas in `src/shared/tools.ts` + executors) depends on Phases 3+4 — it implements the `ToolRuntime` seam (`toolDefinitions`/`classify`/`executeRead`/`flushMutations`) defined in `src/extension/agent-loop.ts`, wrapping `flushMutations` in a single `withinTransaction` (§7). Phase 6 fills the real system prompt + cannot-list. Phases 7/8/9/13 target the **D** task sets.

## Architecture Decision (Spike R3)
Outcome: **D** — all three probes passed. Localhost WS full-duplex; persistent streaming chat; in-chat confirm cards; **act-in-place** mutations.
R5 transaction rollback: **YES (atomic)** — throwing inside `withinTransaction` rolls the whole transaction back; the partial `track.name` set did not commit (in-process read returned the original name) and Live recorded **no undo entry** for it. The §7 "one undo step / all-or-nothing" guarantee holds; still check the abort signal *before* opening a transaction.
> Phases 7, 8, 9, and 13 implement the **D** branch. Decided + verified in Live 12.4.5b3 Beta on 2026-06-02.

### Spike R3/R5 — recorded evidence (2026-06-02, Live 12.4.5b3 Beta, branch experiment/spike-r3)
- **3.1 (gate) — event loop alive while modal open: PASS.** Fire-and-forget modal; `setInterval` TICKs continued at a steady 500 ms cadence for the entire ~12 s the modal was open (n=1→24), `3.1 | PASS`, then `modal closed`. → Outcome A ruled out.
- **3.2 — webview reaches localhost socket: PASS (both variants).** 3.2b served from `http://127.0.0.1:17999/` (same-origin) → `ws connected from 127.0.0.1` + `hello-from-served`; 3.2a `data:` URL page (cross-origin) → `ws connected` + `hello-from-data`. No CSP block on either. → Outcome B ruled out. Both delivery modes (served URL and inlined `data:`) reach the socket.
- **3.3 — mutate model while modal open: PASS.** With the modal still open, the clicked track renamed to `SPIKE …` **and** a new audio track appeared (operator confirmed both visually); log shows `createAudioTrack resolved, tracks=4` ~4 s **before** `modal closed`. → **Outcome D** (act-in-place), not C.
- **R5 — transaction rollback on throw: rollback = YES.** Sync `track.name` set + throw inside one `withinTransaction`: name unchanged in Live and in-process (`name after throw="4-Audio" (was "4-Audio")`); Cmd-Z undid the operator's *prior* action, i.e. the thrown transaction left no undo entry at all.
- **Harness:** throwaway, on branch `experiment/spike-r3` (commit 04b37fb, kept for re-runs, never merged). Logs streamed to the `npm start`/extensions-cli terminal — note this beta (12.4.5b3) did **not** create `ExtensionHost.txt`; host stdout carries `console.log` (prefixed `[ableton-claude-agent]:`).
- **Doc drift found:** ARCHITECTURE.md §17 shows callback-style `showModalDialog`/`registerContextMenuAction`; the installed SDK is Promise-based (`showModalDialog(url,w,h): Promise<string>` resolves on close; `registerContextMenuAction` returns a Promise<unregister>). Worth correcting §17 separately.

## Completed Phases
### Phase 1 — Project Scaffold & Toolchain ✅ COMPLETE (2026-06-02)
- [x] 1.1 Scaffold via create-extension (UI=yes), merged into repo without disturbing .git/.claude/docs/CLAUDE.md
- [x] 1.2 Workspace layout (src/extension, src/webview, src/shared, tests) + esbuild (single dist/extension.js) + Vite (single inlined dist/webview/index.html)
- [x] 1.3 Tooling: type-checked ESLint (flat) + Prettier (2-space/dq/semi/es5) + Vitest (smoke test) + strict per-workspace tsconfigs (tsc -b) + .gitignore + .env.example
- [x] 1.4 Added @anthropic-ai/sdk + ws (+@types/ws); production build proves SDK bundles cleanly into single Node CJS bundle
- QA gate (code-reviewer): PASS, 0 CRITICAL. Criteria 2/3/4 verified headlessly.
- Criterion 1 VERIFIED LIVE (2026-06-02): `npm start` in Live 12 Beta logged "Hello from ableton-claude-agent! Your Live Set's tempo is: 120 bpm." + SDK probe line in ExtensionHost.txt. (No context-menu/UI entry by design — the Phase-1 activate() only logs tempo; launch UI arrives Phase 11/16.)
- Env: Node upgraded 22.16.0 → 24.16.0 (Homebrew node@24, arm64). Old /usr/local Node 22 left shadowed for user to remove later; global CLIs (codex/gemini/pnpm/etc.) untouched.

#### Phase 1 follow-ups (non-blocking, tracked)
- **M1 (revisit @ Phase 18):** entry is CJS `dist/extension.js` while package.json is `"type":"module"` — matches the official scaffolder template; Live host evaluates as CJS so load works. Validate against a real `.ablx` at packaging; switch to `dist/extension.cjs` only if host/standard-ESM resolution requires it.
- **M4 (RESOLVED @ Phase 4, 2026-06-02):** the inert `import Anthropic` + `Anthropic.name` bundle-probe was removed from src/extension/index.ts when the real Claude client landed; `activate()` is now the tempo-log only (no client at activation — no background mode).
- **M3 (maintenance):** vitest <4.1.0 dev-only advisory GHSA-5xrq-8626-4rwp (`npm audit --omit=dev` = 0); bump to vitest 4.x in a maintenance step.
- **M2 (Phase 18):** README is stale scaffolder boilerplate (refs src/extension.ts; omits test/lint/format scripts).

### Phase 2 — Spike R3 / R5 & Architecture Decision ✅ COMPLETE (2026-06-02) 🔴 GATE PASSED
- [x] 2.1 Built the spike harness (test-engineer; §17 probes: liveness, 127.0.0.1 HTTP+WS, modal data:/served variants, mutate-while-open, transaction throw) — build:dev + lint + test all clean
- [x] 2.2 Ran probes 3.1 → 3.2b → 3.2a → 3.3 + R5 in Live 12.4.5b3 Beta (user-driven; logs via npm start terminal)
- [x] 2.3 Recorded **Outcome D** + **R5 = atomic rollback** above with full per-probe evidence

### Phase 3 — Reference & Identity Layer (R1) ✅ COMPLETE (2026-06-02)
- [x] 3.1 Ref grammar + parser/serializer in `src/shared/refs.ts` (pure; no SDK/DOM). Discriminated-union segment model; percent-encode `%`/`:`/`/` in name field; `parseRef` (lexical) + `validateRef` (structural) + `serializeRef` + `shiftSiblingIndices` + `RefParseError`.
- [x] 3.2 Resolver in `src/extension/references.ts`: `resolveRef`/`refFromHandle`/`ReferenceTable`. Re-reads `song` fresh every call, walks live collection getters (no handle caching), unique-name re-anchor with re-minted canonicalRef, leaf type-assertion via `getObjectFromHandle` (base class), `type_mismatch`-vs-`ref_unresolved` via base-`DataModelObject` re-probe. `ReferenceTable` holds canonical ref strings only.
- [x] 3.3 `tests/fixtures/fake-extension-context.ts` (SDK double; sync getter collections, throwing `getObjectFromHandle`, drift helpers) + `tests/refs.test.ts` (69) + `tests/references.test.ts` (63). **133 tests pass.** Coverage: refs.ts 96.12% lines / 92.98% branch; references.ts 90.13% lines / 83.14% branch.
- QA gate (code-reviewer): **PASS, 0 CRITICAL, 0 MAJOR.** Handle discipline, structured-error contract, and shared/extension purity all verified against the real SDK `.d.mts`. Success criteria met (fresh handles every call; drift → correct structured error; ≥90% coverage).
- Key wiring note: resolver takes an optional 3rd `tokens: ClassTokens` arg defaulting to real SDK base constructors; tests inject `FakeClass`-backed tokens (`as unknown as ClassTokens`) so the resolver runs unmodified against both fake and SDK.

#### Phase 3 follow-ups (non-blocking, tracked)
- **R3-1 (MINOR):** `tsconfig.tests.json` `include` was widened to `src/extension/**/*` so `references.test.ts` can import across workspaces (project-reference route blocked by `noEmit:true` → TS6310). `tsc -b` exits 0; add a one-line rationale comment in the tsconfig when next touched.
- **R3-2 (MINOR):** `refFromHandle` Phase-3 scope: anchors top-level `track`/`scene`/`cuePoint` only; return/main tracks and nested handles return `type_mismatch` — nested reverse-anchoring layered in a later phase.
- **R3-3 (dep):** added `@vitest/coverage-v8` (dev-only) — the project had no coverage provider; resolves the M3 vitest-coverage gap.

### Phase 4 — Claude Client & Tool-Use Loop ✅ COMPLETE (2026-06-02)
- [x] 4.1 Claude client wrapper `src/extension/claude-client.ts`: wraps `@anthropic-ai/sdk` v0.100.1; **manual `messages.stream` loop** (NOT beta `toolRunner`). Default `MODEL="claude-sonnet-4-6"`, `MAX_TOKENS=4096`. Injectable `MessagesClient`/`MessageStreamLike` seam (tests swap a scripted fake; production adapter constructs `new Anthropic({apiKey})`). Prompt caching per §15.1: `cache_control:{type:"ephemeral"}` on the **last** system block + **last** tool; snapshot in a **separate, uncached** user block. `runTurn` streams deltas → `onDelta`, resolves the assembled final message (`content`/`stop_reason`/`usage`); honors `AbortSignal`; maps abort/`APIError`/other → structured `{error,detail,hint}`, never throws.
- [x] 4.2 Agentic loop `src/extension/agent-loop.ts`: DI seams `ToolRuntime` (`toolDefinitions`/`classify`/`executeRead`/`flushMutations`) + `AgentEvents` (`assistantDelta`/`toolActivity`/`assistantDone`/`error`). Per assistant iteration: collect ALL `tool_use` blocks → run reads immediately in-order → **check abort BEFORE** flushing → flush ALL mutations in **ONE** `flushMutations(calls)` (§7 seam Phase 5 wraps in `withinTransaction`). `tool_result` blocks appended in same order/ids; `is_error:true` on error payloads. Exits on `end_turn`/`max_tokens`/`stop_sequence`/`refusal`; iteration cap (default `DEFAULT_MAX_ITERATIONS=10`) — no infinite loop. Defensive guards for no-block/short-flush/wrong-id.
- [x] 4.3 Removed the Phase-1 M4 `Anthropic` bundle-probe from `index.ts` (tempo-log only; no client at activation). Tests: `tests/fixtures/fake-anthropic-client.ts` (scriptable `FakeMessagesClient`, captures request params) + `tests/fixtures/fake-tool-runtime.ts` (classifier + ordered call log) + `tests/claude-client.test.ts` (25) + `tests/agent-loop.test.ts` (22). **180 tests pass** (47 new + 133 prior). Coverage: claude-client.ts **98.75%** lines, agent-loop.ts **100%** lines (uncovered = production SDK adapter body, untestable without live network per the stub-only decision).
- QA gate (code-reviewer): **PASS, 0 CRITICAL, 0 MAJOR, 2 MINOR (bookkeeping only).** Verified: manual-loop, mutation-batch boundary, abort-before-flush, cache_control placement, structured-error contract (never throws/no-ops), no API key in any source/test, strict TS no `any`, no phase bleed (no real schemas/system-prompt/snapshot/transport — only seams). `tsc -b` 0 / `npm test` 180 / `npm run lint` 0.
- Decisions: **stub-only tests** (no live API call this phase); key via **constructor arg + `process.env.ANTHROPIC_API_KEY` fallback** (Phase 10 supplies from config.json). Model **sonnet 4.6** (`claude-sonnet-4-6`, confirmed valid `Model` literal in installed SDK).

## Session Log
(no sessions yet)
- 2026-06-02 16:10: Session ended
- 2026-06-02 16:44: Session ended
- 2026-06-02 16:47: Session ended
- 2026-06-02 16:50: Session ended
- 2026-06-02 18:49: Session ended
- 2026-06-02 18:58: Session ended
- 2026-06-02 19:03: Session ended
- 2026-06-02 19:05: Session ended
- 2026-06-02 19:08: Session ended
- 2026-06-02 19:10: Session ended
- 2026-06-02 19:11: Session ended
- 2026-06-02 19:14: Session ended
- 2026-06-02 19:19: Session ended
- 2026-06-02 19:48: Session ended
- 2026-06-02 20:32: Session ended
- 2026-06-02 20:34: Session ended
- 2026-06-02 21:07: Session ended
- 2026-06-02 21:11: Session ended
- 2026-06-02 21:11: Session ended
