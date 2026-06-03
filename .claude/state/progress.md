# Project Progress — Ableton Claude Agent

## Current Phase
Phase: 6
Title: Capability Guardrails & System Prompt (R2)
Status: NOT STARTED
Started: 2026-06-02
> Next: Phase 5 COMPLETE. Phase 6 authors the cacheable system prompt + verbatim "You cannot…" contract (§9) and adds the `report_limitation` tool (deliberately omitted from Phase 5's registry — wire it into `src/shared/tools.ts` + the registry now) so unsupported requests route to a limitation/structured error, never a fake success. The §9 guard surface already exists at the executor layer (loud structured errors, no phantom success) — Phase 6 adds the model-facing contract + the honesty tool on top. Phases 7/8/9/13 target the **D** task sets.

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

### Phase 5 — Tool Registry & Executors ✅ COMPLETE (2026-06-02) — outcome-independent
- [x] 5.1 Shared schemas + arg types `src/shared/tools.ts` (PURE; type-only `@anthropic-ai/sdk` + `./refs.js`, no Extensions SDK/DOM). All 15 §8 tools (`report_limitation` deliberately deferred to Phase 6). Exports `TOOL_DEFINITIONS`/`TOOL_BY_NAME`/`TOOL_NAMES`/`TOOL_NAME_SET`/`isToolName`, `classify`/`TOOL_CLASS` (unknown→`"mutation"` safe side), per-tool arg types, `WARP_MODE_VALUE`/`NoteDescriptionArg`/`ClipLoopSettingsArg`. **`strict:true` on every mutating tool + `input_examples` natively typed in installed `@anthropic-ai/sdk` v0.100.1** (`messages.d.ts:1199/1205`) — NO deviation, no `any`, no beta type. No `cache_control` in defs (client stamps last tool).
- [x] 5.2 Registry + `ToolRuntime` impl `src/extension/tool-registry.ts` (`LiveToolRuntime<V>(ctx, refs=new ReferenceTable(), signal?)` — one per turn, ReferenceTable turn-scoped §6) + executors `src/extension/executors/{read,mutation,shared}.ts`. Read: `live_get_project/track/clip/device_params` (lazy `getValue` on-demand only, §15); mutation: update_track/clip, set_param (clamp+quantize, mixer vol/pan/send), edit_midi_notes (replace/transpose/quantize/humanize; `filter`→`destructive:true`), create, create_clip (MIDI), insert_device, modify_device_chain (duplicate/insert_chain), delete (type-routed). **Audio tools deferred to Phase 14** — `live_render_audio`/`live_replace_sample`/`live_import_audio`/audio-branch `live_create_clip` return honest `{error:"deferred",isError:true}`, never fake success.
- [x] **Transaction discipline (§7/R5) verified by reviewer trace, not comments:** exactly ONE `withinTransaction` per `flushMutations` batch; two-phase prepare(async, outside)→run(sync-launch, inside) with callback `return Promise.all([...]).then(...)` — **NO `await` inside the callback**, txn awaited outside; abort re-checked BEFORE opening txn (defense-in-depth w/ loop's own check); sync-throw → whole batch `sdk_error` (atomic rollback). Creates mint fresh ref by re-reading parent collection + matching handle id; deletes use `ReferenceTable.invalidateAndShift` → return affected refs. Create-then-configure = ≥2 transactions by design.
- [x] 5.5 Extended `tests/fixtures/fake-extension-context.ts` with mutation/create/transaction surface pinned to SDK `.d.mts` sync/async split + observability hooks: `ctx.transactions[]`/`committedCount` (prove one-txn-per-batch), `ctx.paramValueOf(ref)`/`ctx.notesOf(ref)`, seed-spec fields (`mute/solo/arm/color/looping/muted/warping/warpMode/notes/param{min,max,isQuantized,value}`), `FakeWarpMode`/`FakeNoteDescription`. R5 sync-throw rollback modeled via reverse-order undo journal.
- [x] 5.6 Tests `tests/executors.test.ts` (109) + `tests/tool-registry.test.ts` (12) = **121 new; 301 total pass.** Coverage (lines): tool-registry 91.01%, mutation 90.15%, read 90.65%, shared 100%, tools.ts 100% — all ≥90%.
- QA gate (code-reviewer): **PASS, 0 CRITICAL, 0 MAJOR, 2 MINOR (forward-looking coverage only).** Reviewer hand-traced `flushMutations` (single-txn boundary, no-await-in-callback, slotToIndex distribution), handle discipline (no caching across calls/within batch; ReferenceTable holds strings only), honesty (4 audio deferrals + unsupported branches, `report_limitation` correctly absent), schema correctness, shared purity. `tsc -b` 0 / `npm run lint` 0 / `npm test` 301.

#### Phase 5 follow-ups (non-blocking, tracked)
- **P5-1 (verify @ Phase 11, first LIVE API call):** `live_set_param.target` and `live_create_clip` use JSON-Schema `oneOf`/`const` under `strict:true`. Anthropic strict mode is a JSON-Schema subset — confirm the wire accepts `oneOf`/`const` at first live call. If rejected: flatten to a single object with an explicit discriminator enum + conditionally-required fields in prose (executor narrows by discriminant either way, so only the schema shape changes). No wrong-target/honesty risk — a rejection surfaces as a loud API error, never silent mis-execution.
- **P5-2 (RESOLVED 2026-06-02, audit-fix pass):** the mixed async-`live_create` + sync-`live_update_*` batch (interleaved positive/negative `slotToIndex` markers) now has a dedicated test in `tests/executors.test.ts` (slot distribution + 2-txn count asserted). Closed.
- **P5-3 (MINOR, in-Live @ Phase 12/19):** `live_insert_device` keeps no built-in allowlist (relies on SDK to reject third-party names → structured `sdk_error`). Sound, but the §9 "no plugins" guard is only enforced at the live boundary; add an in-Live third-party-rejection check in the limitation-honesty pass.

#### Phase 1-5 audit-fix pass ✅ COMPLETE (2026-06-02) — pre-Phase-6, code-reviewer PASS (0 CRIT/0 MAJOR)
Ran a full audit of Phases 1-5 (`/phase-review`), then fixed the actionable findings before starting Phase 6. Final state: **323 tests pass**, `tsc -b` 0, `eslint src/ tests/` 0. Coverage held ≥90% (mutation.ts 91.14%, tool-registry.ts 92.89%).
- **MAJOR — `live_create` silently dropped `name` (§9 honesty gap) → RESOLVED via full-honor create-then-configure.** `live_create` now applies `name` for ALL kinds (track/scene/cue_point/take_lane). Creates run in the batch txn (#1); ALL queued name-sets run in ONE shared SECOND txn (#2) via `applyPendingRenames` — named create = 2 undo steps (in-spec §7), unnamed = 1 (rename block skipped). No-`await`-in-callback + abort re-checked before the rename txn preserved. Honest non-applied paths (both SUCCESS, never phantom-name): abort-between → `"created, but name not applied — cancelled before configure"`; rename-txn-throw (R5 rollback) → `"created, but name not applied — naming failed: <msg>"` (un-renamed ref surfaced so the agent doesn't duplicate-create). Returned ref minted AFTER rename so its name segment reflects the applied name.
- **⚠️ AUDIT CORRECTION (record so it isn't re-introduced):** the `/phase-review` report claimed `Scene.name`/`CuePoint.name` are getter-only and scene/cue-point naming was "SDK-impossible." That is **WRONG** — verified in `node_modules/@ableton-extensions/sdk/dist/index.d.mts`: `Scene.name` (631-632), `CuePoint.name` (612-613), `Track.name` (504-505), `TakeLane.name` (471-472) ALL have setters. All four created kinds are nameable.
- **`index` honesty:** only `createScene(index)` accepts a position (`-1` appends); `createAudioTrack()`/`createMidiTrack()`/`createTakeLane()` take no position arg, `createCuePoint(time)` uses time. Schema/description scoped `index` to "scene only"; a stray `index` on any other kind now returns a kind-accurate `note` (track / take_lane / cue_point variants) instead of being silently dropped.
- **MINOR — `pause_turn` comment-vs-behavior lie (agent-loop.ts) → FIXED (comment only).** The loop has always treated any non-`tool_use` stop (incl. `pause_turn`) as terminal; the stale comment now matches (note: resuming `pause_turn` would only matter if server tools are added). No behavior change.
- **Coverage added:** named-create-per-kind (name applied + name-bearing ref), 2-txn named / 1-txn unnamed / N-named=2-txn, the P5-2 mixed batch, abort-before-rename, rename-throw-rollback, index-ignored notes (all kinds), and `name:123` wrong-type → `invalid_args`. Two opt-in fake hooks added (`onCommit`, `failNameSets`, default OFF).
- **Carried forward (unchanged):** P5-1 (strict-mode `oneOf`/`const` at first live API call), P5-3 (in-Live plugin-rejection check). The TS hint 80006 "may be converted to an async function" at tool-registry.ts:205 + several fake-context lines is the INTENTIONAL §7 sync-callback-returns-`.then()` pattern — accepted, do not "fix".

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
- 2026-06-02 21:28: Session ended
- 2026-06-02 22:11: Session ended
- 2026-06-02 22:14: Session ended
- 2026-06-02 22:40: Session ended
- 2026-06-02 22:52: Session ended
- 2026-06-02 22:53: Session ended
- 2026-06-02 22:57: Session ended
- 2026-06-02 22:59: Session ended
