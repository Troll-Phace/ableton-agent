# Development Instructions — Ableton Claude Agent

## Overview

Phased development guide. Each phase is small enough for a single session. The orchestrator (CLAUDE.md) delegates all implementation to subagents.

**Architecture branching:** Phase 2 runs Spike R3 and records an outcome **A/B/C/D** in `.claude/state/progress.md`. Phases **7, 8, 9, and 13** contain per-outcome task sets — implement only the branch matching the recorded outcome. Phases 3–6 and 10 are outcome-independent shared core, so progress is never blocked on the spike.

### Subagent Roles
| Subagent | Responsibilities |
|----------|-----------------|
| `backend-dev` | Extension host: SDK, Claude loop, refs, snapshot, tools, transactions, transport server, persistence, guardrails |
| `frontend-dev` | Vite webview chat UI (streaming or turn-based variant) |
| `test-engineer` | Vitest suites; building/running the Spike R3/R5 harnesses; recording outcomes |
| `code-reviewer` | Code review, quality gates, architecture & spike-branch compliance |

### Key Commands
`npm start` · `npm run build` · `npm run build:dev` · `npm run package` · `npm test` · `npm run lint` · `npm run format`

---

## Phase 1: Project Scaffold & Toolchain

### Objective
Create a runnable extension+webview workspace that round-trips the SDK hello-world.

### Prerequisites
- Live Beta build (from Centercode) installed; Developer Mode enabled (Preferences → Extensions).
- Node ≥ 24.14.1; an Anthropic API key available for later phases.

### Reference Documents
- docs/ARCHITECTURE.md §3 (workspaces), §16 (commands)

### Tasks
#### 1.1 Scaffold via create-extension
**Delegate to**: `backend-dev`
Run the SDK project creator from `ableton-create-extension-1.0.0-beta.0.tgz`, answering **yes** to "needs a user interface". Confirm `.env` `EXTENSION_HOST_PATH` is populated and `npm start` prints the hello-world tempo line.

#### 1.2 Establish the workspace layout
**Delegate to**: `backend-dev`
Create `src/extension/`, `src/webview/`, `src/shared/`, `tests/`. Wire esbuild (`build.ts`, `loader: { ".html": "text" }`, `platform: node`, `format: cjs`) for the extension and Vite for the webview. Set `manifest.json` (`entry: dist/extension.js`, `minimumApiVersion: "1.0.0"`).

#### 1.3 Tooling: ESLint, Prettier, Vitest, tsconfig (strict)
**Delegate to**: `backend-dev`
Add strict tsconfigs per workspace, ESLint (type-checked), Prettier, and Vitest with `npm test`/`test:watch`. Add `.gitignore` (`node_modules/`, `dist/`, `*.ablx`, `.env`, `.claude/settings.local.json`, `.claude/state/`).

#### 1.4 Add dependencies
**Delegate to**: `backend-dev`
Add `@anthropic-ai/sdk` and `ws` (+ types). Confirm `@anthropic-ai/sdk` bundles cleanly into `dist/extension.js` with a production build.

### Success Criteria
- [ ] `npm start` loads the extension into Live and prints the tempo line
- [ ] `npm run build` produces a single `dist/extension.js`; Vite builds the webview
- [ ] `npm test`, `npm run lint`, `npm run format` all run clean on an empty suite
- [ ] `@anthropic-ai/sdk` confirmed to bundle for Node

---

## Phase 2: Spike R3 / R5 & Architecture Decision  🔴 GATE

### Objective
Empirically determine the transport architecture (A/B/C/D) and the transaction-rollback behavior, and record both.

### Prerequisites
- Phase 1

### Reference Documents
- docs/ARCHITECTURE.md §17 (the full spike plan), §12 (outcome matrix)

### Tasks
#### 2.1 Build the spike harness
**Delegate to**: `test-engineer`
In a throwaway/experiment branch, build the probes from §17: a context-menu trigger; `setInterval` liveness logging; a `127.0.0.1` HTTP+WS server; a tiny modal page (both `data:` and served `http://127.0.0.1` variants); timer/socket-driven mutation calls; and a transaction-throw test.

#### 2.2 Run probes in the Live Beta build
**Delegate to**: `test-engineer`
Execute 3.1 → 3.2 → 3.3 in order (3.1 gates the rest), plus R5. Tail `ExtensionHost.txt`. Capture exact observations.

#### 2.3 Record the outcome
**Delegate to**: `test-engineer`
Write the determined outcome (**A/B/C/D**) and the R5 rollback result into `.claude/state/progress.md`, with a one-paragraph justification and any partial-pass notes (e.g. "3.1 pass, 3.3 fail → C").

### Success Criteria
- [ ] 3.1 result recorded (event loop alive while modal open: yes/no)
- [ ] 3.2 result recorded (localhost reachable; which variant)
- [ ] 3.3 result recorded (mutate-while-open: yes/no)
- [ ] R5 result recorded (rollback on throw: yes/no)
- [ ] A single outcome **A/B/C/D** is written to progress.md and justified

---

## Phase 3: Reference & Identity Layer (R1)

### Objective
Implement semantic refs and the re-resolve-every-call routine with drift detection. (Outcome-independent.)

### Prerequisites
- Phase 1 (Phase 2 may run in parallel)

### Reference Documents
- docs/ARCHITECTURE.md §6

### Tasks
#### 3.1 Ref grammar + parser/serializer
**Delegate to**: `backend-dev`
Implement the `kind:index:name` path grammar in `src/shared/refs.ts` (pure). Parse, serialize, validate.

#### 3.2 Reference Table + resolver
**Delegate to**: `backend-dev`
In `src/extension/`, implement resolution: walk from `song`, re-resolve fresh handles, verify name, re-anchor or emit `ref_unresolved`/`ref_ambiguous`/`type_mismatch`. Add subtree-rebuild after mutations.

#### 3.3 Tests against FakeExtensionContext
**Delegate to**: `test-engineer`
Cover happy path, index drift (reorder), rename, deletion, ambiguity, type mismatch.

### Success Criteria
- [ ] Refs resolve to fresh handles every call (no caching)
- [ ] Drift cases produce the correct structured error
- [ ] 90%+ coverage on refs + resolver

---

## Phase 4: Claude Client & Tool-Use Loop

### Objective
Drive the Messages API tool-use loop with streaming, caching, and strict tools. (Outcome-independent.)

### Prerequisites
- Phase 1

### Reference Documents
- docs/ARCHITECTURE.md §4 (loop), §8 (tools), §15 (budgets)

### Tasks
#### 4.1 Claude client wrapper
**Delegate to**: `backend-dev`
Wrap `@anthropic-ai/sdk`: build requests (system + cacheable tool prefix + snapshot block), stream deltas, surface `stop_reason`.

#### 4.2 The agentic loop
**Delegate to**: `backend-dev`
Implement: while `stop_reason==="tool_use"`, execute tools (read=immediate, mutation=queued), append `tool_result`, continue; exit on `end_turn`/`max_tokens`/`stop_sequence`/`refusal`. Handle parallel tool_use blocks. Add an iteration cap.

#### 4.3 Loop tests with stub client
**Delegate to**: `test-engineer`
Script multi-step tool-use sequences and assert correct batching, result framing, and termination.

### Success Criteria
- [ ] Loop runs end-to-end against the stub client
- [ ] Parallel tool calls collected before transaction flush
- [ ] Streaming deltas emitted; iteration cap enforced

---

## Phase 5: Tool Registry & Executors

### Objective
Implement the ~15 consolidated tools with transaction batching and structured errors. (Outcome-independent.)

### Prerequisites
- Phase 3, Phase 4

### Reference Documents
- docs/ARCHITECTURE.md §8, §7, §14

### Tasks
#### 5.1 Schemas + registry
**Delegate to**: `backend-dev`
Define each tool's JSON Schema (with `strict: true`, `input_examples` where format-sensitive) in `src/shared/tools.ts`; build the registry.

#### 5.2 Read + mutation executors
**Delegate to**: `backend-dev`
Implement executors mapping to the SDK (§8 tables), with ref resolution, unit conversion (beats↔seconds), param clamping/quantization, and transaction batching of the turn's mutations.

#### 5.3 Executor tests
**Delegate to**: `test-engineer`
Validate argument validation, unit conversion, transaction grouping, create-then-configure split, and structured-error mapping against the fake context.

### Success Criteria
- [ ] All tools registered with strict schemas
- [ ] Mutations batch into a single transaction (where physically possible)
- [ ] Every executor returns success data or a structured error — never throws/no-ops

---

## Phase 6: Capability Guardrails & System Prompt (R2)

### Objective
Make unsupported requests impossible to "succeed" silently. (Outcome-independent.)

### Prerequisites
- Phase 5

### Reference Documents
- docs/ARCHITECTURE.md §9

### Tasks
#### 6.1 System prompt + "You cannot…" contract
**Delegate to**: `backend-dev`
Author the system prompt (role, operating rules, units, confirmation placeholder, the verbatim cannot-list). Mark it cacheable.

#### 6.2 `report_limitation` tool + loud failures
**Delegate to**: `backend-dev`
Implement `report_limitation`; ensure executors reject unsupported inputs (plugin names, marker edits, automation requests) with clear errors.

#### 6.3 Guardrail tests
**Delegate to**: `test-engineer`
Assert unsupported requests route to `report_limitation` / structured errors, never to a fake success.

### Success Criteria
- [ ] Cannot-list present and cached
- [ ] Unsupported actions always produce a limitation/error, never a false success
- [ ] Tests cover automation, routing, plugin, and marker-edit attempts

---

## Phase 7: Transport Layer  🔀 BRANCHED BY SPIKE OUTCOME

### Objective
Implement the channel between extension and webview for the recorded outcome.

### Prerequisites
- Phase 2 (outcome recorded), Phase 4

### Reference Documents
- docs/ARCHITECTURE.md §11, §12, §13

### Tasks — Outcome **D** (act-in-place) or **C** (close-to-apply)
#### 7.D.1 Localhost WS server
**Delegate to**: `backend-dev`
Start a `127.0.0.1` HTTP+WS server on activate (before opening the modal). Serve the built SPA (or pass an inlined `data:` URL if 3.2 variant (b) failed). Implement the §13 protocol envelope and message router.
#### 7.D.2 Stream wiring
**Delegate to**: `backend-dev`
Pipe Claude deltas → `assistant_delta`; tool execution → `tool_activity`; ref updates → `refs_updated`.
#### 7.D.3 (Outcome C only) Close-to-apply bridge
**Delegate to**: `backend-dev`
For mutations, gather the approved batch, close the modal, apply under a progress dialog in one transaction, re-open. (Skip for D — mutations apply in place.)

### Tasks — Outcome **A** or **B** (turn-based modal)
#### 7.A.1 Turn round-trip
**Delegate to**: `backend-dev`
Implement the `showModalDialog` per-turn cycle: open pre-loaded with transcript → `close_and_send` user text → run loop behind a progress dialog → re-open with reply + change summary.
#### 7.A.2 (Outcome B only) Optional host-bridge probe
**Delegate to**: `backend-dev`
If desired, attempt the undocumented inbound message bridge (§17 probe 3.2b) behind a feature flag; default off; do not block on it.

### Success Criteria
- [ ] Implemented branch matches the recorded outcome (verified by code-reviewer)
- [ ] A user message reaches the loop and a reply returns through the chosen transport
- [ ] (C/D) socket reconnect handled; (A/B) transcript correctly re-loaded each turn

---

## Phase 8: Webview Chat UI  🔀 BRANCHED BY SPIKE OUTCOME

### Objective
Build the chat interface variant for the recorded outcome.

### Prerequisites
- Phase 7

### Reference Documents
- docs/DESIGN_SYSTEM.md, docs/ARCHITECTURE.md §11, §13

### Tasks — Outcome **C/D** (streaming SPA)
#### 8.CD.1 Chat shell + message list
**Delegate to**: `frontend-dev`
Build the SPA shell, scrolling message list, and pinned input bar per the design system.
#### 8.CD.2 Streaming + tool-activity chips
**Delegate to**: `frontend-dev`
Render `assistant_delta` incrementally with a streaming caret; show `tool_activity` chips with started/ok/error states.

### Tasks — Outcome **A/B** (turn-based)
#### 8.AB.1 Single-file transcript view
**Delegate to**: `frontend-dev`
Build a `data:`-URL single-file page (`vite-plugin-singlefile`) that renders the passed-in transcript and submits the next message via `close_and_send`.
#### 8.AB.2 Progress + summary affordances
**Delegate to**: `frontend-dev`
Make re-opened turns clearly show the prior change summary and a "working…" state expectation.

### Success Criteria
- [ ] UI matches design tokens (no hardcoded colors/spacing)
- [ ] Focus states, AA contrast, reduced-motion respected
- [ ] (C/D) tokens stream visibly; (A/B) transcript persists across turns

---

## Phase 9: Confirmation & Safety Flow  🔀 BRANCHED BY SPIKE OUTCOME

### Objective
Implement destructive-action approval for the recorded outcome.

### Prerequisites
- Phase 7, Phase 8

### Reference Documents
- docs/ARCHITECTURE.md §9, §12, §13

### Tasks — Outcome **D** (in-place)
#### 9.D.1 In-chat confirm cards
**Delegate to**: `frontend-dev` + `backend-dev`
On a destructive batch, emit `confirm_request`; render an unmistakable confirm card; on `confirm_response.approved`, execute in place in one transaction.

### Tasks — Outcome **C** (close-to-apply)
#### 9.C.1 In-chat approval → close-to-apply
**Delegate to**: `frontend-dev` + `backend-dev`
Same in-chat card, but approval triggers the Phase 7.D.3 close-to-apply bridge.

### Tasks — Outcome **A/B** (propose→apply)
#### 9.AB.1 Plan object + approval step
**Delegate to**: `backend-dev` + `frontend-dev`
The agent emits a structured plan (intended tool calls + human summary); render it for approval; on approval, execute the *captured* plan deterministically (do not re-ask Claude).

### Success Criteria
- [ ] No destructive action executes without explicit approval
- [ ] Approval path matches the recorded outcome
- [ ] Approved plans execute exactly as presented (no drift between proposal and action)

---

## Phase 10: Persistence & Secrets

### Objective
Store config/key/transcript safely; capture the key on first run. (Outcome-independent.)

### Prerequisites
- Phase 1

### Reference Documents
- docs/ARCHITECTURE.md §10

### Tasks
#### 10.1 Config store
**Delegate to**: `backend-dev`
Read/write `storageDirectory/config.json` (`{ anthropicApiKey, model, defaults }`); never log/serialize the key to the webview.
#### 10.2 First-run settings modal + dev override
**Delegate to**: `backend-dev` + `frontend-dev`
If no key, open a settings modal to capture it; support a `--storage-directory` dev config override.
#### 10.3 Transcript persistence
**Delegate to**: `backend-dev`
Persist/restore transcripts under `storageDirectory/sessions/`.

### Success Criteria
- [ ] Key persisted and read in Node only
- [ ] First-run capture works; dev override works
- [ ] Transcript survives across sessions

---

## Phase 11: Read-Only Agent (End-to-End)

### Objective
Launch → snapshot → chat → Claude answers questions about the Set, no mutations.

### Prerequisites
- Phases 3, 4, 6, 7, 8, 10

### Tasks
#### 11.1 Scoped snapshot serializer
**Delegate to**: `backend-dev`
Build the project/selection snapshot (§4) feeding the loop; wire `live_get_*` read tools.
#### 11.2 Launch command (single scope)
**Delegate to**: `backend-dev`
Register `live.launchAgent` on `AudioTrack`; seed context from the clicked object.
#### 11.3 E2E read test in Live
**Delegate to**: `test-engineer`
Verify the agent accurately answers "what's in this track / project" via read tools.

### Success Criteria
- [ ] Agent answers project/track questions correctly from a real Set
- [ ] No mutations occur in read-only mode
- [ ] Snapshot scoping respects the launch selection

---

## Phase 12: Safe Mutations (End-to-End)

### Objective
Non-destructive tools live end-to-end, one undo step per action, with progress narration.

### Prerequisites
- Phases 5, 9, 11

### Tasks
#### 12.1 Wire non-destructive tools
**Delegate to**: `backend-dev`
Enable `live_update_track/clip`, `live_set_param`, `live_edit_midi_notes` (non-filter ops), `live_create` end-to-end.
#### 12.2 Undo verification
**Delegate to**: `test-engineer`
Confirm each agent action is a single undo step (or documented two for create+configure), honoring the R5 result.
#### 12.3 Progress narration
**Delegate to**: `backend-dev` + `frontend-dev`
Surface tool activity (chips C/D, progress-dialog text A/B).

### Success Criteria
- [ ] Rename/recolor/param/MIDI/create work from chat on a real Set
- [ ] Each action is one undo step (per R5 reality)
- [ ] User sees live progress narration

---

## Phase 13: Creation, Deletion & Destructive Confirmation  🔀 BRANCHED

### Objective
Enable destructive tools behind the outcome-appropriate confirmation.

### Prerequisites
- Phase 9, Phase 12

### Tasks — all outcomes
#### 13.1 Wire `live_delete`, `live_modify_device_chain`, filter notes
**Delegate to**: `backend-dev`
Route type-specific deletions; mark destructive ops.
#### 13.2 Bind to the confirmation flow
**Delegate to**: `backend-dev` + `frontend-dev`
Outcome **D** → in-chat confirm + in-place execute; **C** → in-chat confirm + close-to-apply; **A/B** → propose→apply plan.
#### 13.3 Destructive-path tests
**Delegate to**: `test-engineer`
Verify no deletion without approval; verify create→configure two-transaction handling.

### Success Criteria
- [ ] Deletions/destructive edits require approval via the recorded flow
- [ ] Create-then-configure handled correctly
- [ ] Cancel before commit leaves the Set unchanged

---

## Phase 14: Audio Tools

### Objective
Sample import and audio-clip creation; optional render/analysis.

### Prerequisites
- Phase 12

### Tasks
#### 14.1 `live_import_audio`
**Delegate to**: `backend-dev`
URL → `fetch` → tempDir → `importIntoProject`; return managed path.
#### 14.2 `live_create_clip` (audio) + `live_replace_sample`
**Delegate to**: `backend-dev`
Create audio clips on track/slot; replace Simpler samples.
#### 14.3 `live_render_audio` + analysis hook
**Delegate to**: `backend-dev`
Pre-FX render to temp; expose for "what's here" answers.

### Success Criteria
- [ ] A URL sample imports and lands in a clip
- [ ] Audio clip creation works with/without warp
- [ ] Render returns a readable temp WAV path

---

## Phase 15: Context Management (R6)

### Objective
Keep long sessions within budget and cost.

### Prerequisites
- Phase 11

### Tasks
#### 15.1 Prompt caching
**Delegate to**: `backend-dev`
Cache the stable system + tool prefix; keep the snapshot in a separate uncached block.
#### 15.2 Transcript eviction/summarization
**Delegate to**: `backend-dev`
Summarize/drop stale tool results; cap snapshot depth; add token counting against the §15 budget.

### Success Criteria
- [ ] Cached prefix reused across turns (verified via usage metrics)
- [ ] Long sessions stay within the per-turn token budget

---

## Phase 16: Multi-Scope Launch & Selection Scoping (R7)

### Objective
Launch from all relevant scopes, normalized; scope context to selection.

### Prerequisites
- Phase 11

### Tasks
#### 16.1 Register all scopes
**Delegate to**: `backend-dev`
Register `live.launchAgent` on all object + selection scopes (§16); branch on arg type.
#### 16.2 Selection-aware snapshot
**Delegate to**: `backend-dev`
When launched from a selection scope, scope the snapshot to it.

### Success Criteria
- [ ] Launch works from track/clip/slot/scene/selection scopes
- [ ] Selection scoping narrows the snapshot correctly

---

## Phase 17: Hardening

### Objective
Robust error recovery, cancellation, and bulk-op behavior.

### Prerequisites
- Phases 12–14

### Tasks
#### 17.1 Handle-invalidation recovery
**Delegate to**: `backend-dev`
Ensure ref errors prompt the agent to re-read rather than crash; cap re-read loops.
#### 17.2 Cancellation + bulk throttling
**Delegate to**: `backend-dev`
Honor `AbortSignal`/`cancel`; check abort before opening transactions; chunk large operations with periodic UI feedback.
#### 17.3 Failure-path tests
**Delegate to**: `test-engineer`
Cover mid-turn deletion, cancel-before-commit, and 200-item bulk ops.

### Success Criteria
- [ ] Stale refs recover gracefully (no crashes, no wrong-target edits)
- [ ] Cancel leaves a consistent Set
- [ ] Bulk ops stay responsive

---

## Phase 18: Packaging & Distribution

### Objective
Produce an installable `.ablx` and finalize docs.

### Prerequisites
- Phases 12, 13

### Tasks
#### 18.1 Production build + package
**Delegate to**: `backend-dev`
`npm run build` then `npm run package` → `.ablx`; include the webview asset per the active branch.
#### 18.2 README + settings/onboarding
**Delegate to**: `backend-dev` + `frontend-dev`
Document install (drop `.ablx` into Live's Extensions page), the first-run key flow, and the active architecture branch.

### Success Criteria
- [ ] `.ablx` installs and launches in Live
- [ ] First-run key capture works from a clean install
- [ ] README documents install + the chosen architecture

---

## Phase 19: E2E Validation & Final Review

### Objective
Full-journey validation and architecture-compliance sign-off.

### Prerequisites
- All prior phases

### Tasks
#### 19.1 Scripted E2E journeys
**Delegate to**: `test-engineer`
Run representative journeys (rename batch, transpose MIDI, insert+set device, delete with confirm, import sample) on a real Set; verify undo for each.
#### 19.2 Limitation-honesty pass
**Delegate to**: `test-engineer`
Attempt unsupported requests (automation, sidechain, plugin, move loop brace); confirm honest `report_limitation` responses.
#### 19.3 Final architecture review
**Delegate to**: `code-reviewer`
Full checklist incl. handle discipline, transaction discipline, guardrails, and spike-branch correctness.

### Success Criteria
- [ ] All E2E journeys pass with correct undo
- [ ] Every unsupported request is refused honestly
- [ ] Code-reviewer sign-off with no CRITICAL findings

---

## Checklist Summary

### Foundation
- [ ] Phase 1: Project Scaffold & Toolchain
- [ ] Phase 2: Spike R3/R5 & Architecture Decision 🔴
- [ ] Phase 3: Reference & Identity Layer
- [ ] Phase 4: Claude Client & Tool-Use Loop
- [ ] Phase 5: Tool Registry & Executors
- [ ] Phase 6: Capability Guardrails & System Prompt
- [ ] Phase 10: Persistence & Secrets

### Transport / UI (branched on spike outcome)
- [ ] Phase 7: Transport Layer 🔀
- [ ] Phase 8: Webview Chat UI 🔀
- [ ] Phase 9: Confirmation & Safety Flow 🔀

### Features
- [ ] Phase 11: Read-Only Agent (E2E)
- [ ] Phase 12: Safe Mutations (E2E)
- [ ] Phase 13: Creation/Deletion + Confirmation 🔀
- [ ] Phase 14: Audio Tools
- [ ] Phase 15: Context Management
- [ ] Phase 16: Multi-Scope Launch & Selection Scoping

### Polish & Release
- [ ] Phase 17: Hardening
- [ ] Phase 18: Packaging & Distribution
- [ ] Phase 19: E2E Validation & Final Review
