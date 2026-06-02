# Project Progress — Ableton Claude Agent

## Current Phase
Phase: 2
Title: Spike R3 / R5 & Architecture Decision  🔴 GATE
Status: NOT STARTED
Started: 2026-06-02
> Next: build + run the §17 spike harnesses in the Live Beta to record outcome A/B/C/D and the R5 rollback result.

## Architecture Decision (Spike R3)
Outcome: NOT YET RUN (decided in Phase 2 — A/B/C/D)
R5 transaction rollback: NOT YET RUN
> Phases 7, 8, 9, and 13 are branched on this outcome. Do not begin transport/UI work until it is recorded here.

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

## Current Phase Tasks (Phase 2 — Spike R3/R5)
- [ ] 2.1 Build the spike harness (§17 probes: liveness, 127.0.0.1 HTTP+WS, modal data:/served variants, mutate-while-open, transaction throw)
- [ ] 2.2 Run probes 3.1 → 3.2 → 3.3 + R5 in the Live Beta; tail ExtensionHost.txt
- [ ] 2.3 Record outcome A/B/C/D + R5 result here with justification

## Session Log
(no sessions yet)
- 2026-06-02 16:10: Session ended
- 2026-06-02 16:44: Session ended
- 2026-06-02 16:47: Session ended
