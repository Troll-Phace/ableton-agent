# Project Progress — Ableton Claude Agent

## Current Phase
Phase: 3
Title: Reference & Identity Layer (R1)
Status: NOT STARTED
Started: 2026-06-02
> Next: Phase 2 GATE PASSED (Outcome D). Begin shared core — Phases 3, 4, 5, 6, 10 are outcome-independent; Phases 7/8/9/13 now target the **D** task sets.

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
- **M4 (remove @ Phase 4):** inert `import Anthropic` + `Anthropic.name` log in src/extension/index.ts is a Phase-1 bundle-inclusion probe; remove when the real Claude client lands.
- **M3 (maintenance):** vitest <4.1.0 dev-only advisory GHSA-5xrq-8626-4rwp (`npm audit --omit=dev` = 0); bump to vitest 4.x in a maintenance step.
- **M2 (Phase 18):** README is stale scaffolder boilerplate (refs src/extension.ts; omits test/lint/format scripts).

### Phase 2 — Spike R3 / R5 & Architecture Decision ✅ COMPLETE (2026-06-02) 🔴 GATE PASSED
- [x] 2.1 Built the spike harness (test-engineer; §17 probes: liveness, 127.0.0.1 HTTP+WS, modal data:/served variants, mutate-while-open, transaction throw) — build:dev + lint + test all clean
- [x] 2.2 Ran probes 3.1 → 3.2b → 3.2a → 3.3 + R5 in Live 12.4.5b3 Beta (user-driven; logs via npm start terminal)
- [x] 2.3 Recorded **Outcome D** + **R5 = atomic rollback** above with full per-probe evidence

## Current Phase Tasks (Phase 3 — Reference & Identity Layer)
- [ ] 3.1 Ref grammar + parser/serializer in src/shared/refs.ts (pure)
- [ ] 3.2 Reference Table + resolver in src/extension (re-resolve every call, drift detection, structured errors)
- [ ] 3.3 Tests vs FakeExtensionContext (happy path, index drift, rename, deletion, ambiguity, type mismatch; 90%+ coverage)

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
