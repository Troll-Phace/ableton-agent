# Ableton Claude Agent — Architecture Reference

> A conversational agent, embedded in Ableton Live 12 via the Extensions SDK and powered by the Claude API, that reads the current Live Set, reasons about it, and edits it through a constrained, undoable tool surface — reached through a chat window.

## Table of Contents

1. [Project Philosophy](#1-project-philosophy)
2. [Complete Feature Set](#2-complete-feature-set)
3. [Technical Architecture](#3-technical-architecture)
4. [Data Flow](#4-data-flow)
5. [Activation, Context & Lifecycle](#5-activation-context--lifecycle)
6. [Reference & Identity Resolution](#6-reference--identity-resolution)
7. [Transactions & Undo](#7-transactions--undo)
8. [Tool Surface](#8-tool-surface)
9. [Capability Guardrails](#9-capability-guardrails)
10. [Persistence, Secrets & Filesystem](#10-persistence-secrets--filesystem)
11. [UI & Transport](#11-ui--transport)
12. [Architecture Selection (Spike R3 Outcomes)](#12-architecture-selection-spike-r3-outcomes)
13. [Socket Protocol](#13-socket-protocol)
14. [SDK Capability Map](#14-sdk-capability-map)
15. [Performance Budgets](#15-performance-budgets)
16. [Quick Reference Tables](#16-quick-reference-tables)
17. [Spike R3 & R5 — Validation Plan](#17-spike-r3--r5--validation-plan)

---

## 1. Project Philosophy

The Ableton Claude Agent is a Live extension that turns natural-language intent into precise, reversible edits of the user's Set. It is built around five principles.

### 1.1 The model decides, the extension acts
Claude never touches Live directly. It emits structured tool calls; the extension (Node, in Live's Extension Host) executes them against the SDK. This is the documented client-tool-use contract and keeps all side effects, secrets, and SDK access in one trusted place.

### 1.2 Reversibility is sacred
Every agent action maps to one undo step where physically possible (`withinTransaction`). The user must always be able to Cmd-Z the agent. This constrains how mutations are batched and is the reason the transaction-rollback behavior is spiked before we rely on it (§17, R5).

### 1.3 Honesty over capability
The SDK can do a constrained set of things. The agent must know its real limits and never claim a change it didn't make. Capability guardrails (§9) and a `report_limitation` tool make "I can't do that, but I can do this" a first-class outcome.

### 1.4 Identity is earned, not assumed
The SDK has no stable object ID — handles die on delete and move, and names aren't unique. The agent speaks in semantic refs that are **re-resolved against the live model on every call** (§6). This is the project's highest-risk subsystem.

### 1.5 The architecture is chosen by experiment
The chat UX depends on undocumented host behavior (can the extension stay live and mutate while a modal is open?). Rather than guess, **Spike R3** decides the transport, and the build plan branches on its outcome (§12, §17).

---

## 2. Complete Feature Set

### 2.1 Core Features (MVP)

#### Feature 1: Conversational chat agent
A chat window, launched from a Live context menu, where the user talks to Claude about the current Set. Transport is socket-streamed or turn-based modal depending on Spike R3 (§11–12).

#### Feature 2: Project contextualization
A scoped JSON snapshot of the Set (tempo, scale, grid, tracks, clips, devices, mixer) fed to Claude, with read tools (`live_get_*`) to fetch detail on demand (§8.1, §4).

#### Feature 3: Tool-driven manipulation
~15 consolidated, action-parameterized tools mapped to the SDK's writable surface, batched into single undo transactions (§8, §7).

#### Feature 4: Reference & identity resolution
Semantic refs (`track:2:Bass/device:1:Reverb`) re-resolved to fresh handles every call, with drift detection and structured errors (§6).

#### Feature 5: Capability guardrails
A system-prompt "you cannot…" contract plus `report_limitation`, preventing false success claims for unsupported requests (§9).

#### Feature 6: Destructive-action confirmation
Approval required before deletes/destructive edits. The mechanism (in-chat buttons vs. propose→apply) is selected by Spike R3 (§12).

#### Feature 7: Persistence & secrets
API key, model choice, and conversation transcript stored under the SDK storage directory; first-run settings modal to capture the key (§10).

### 2.2 Post-MVP Features

#### Feature 8: Audio tools
Sample import (local/URL) and audio-clip creation; optional pre-FX render + analysis for "what's here" answers (§8.6).

#### Feature 9: Context management
Token-budgeted snapshots, prompt caching of the stable tool/system prefix, and transcript eviction/summarization for long sessions (§15).

#### Feature 10: Multi-scope launch
Launch from any of the SDK's object/selection context-menu scopes, normalized into one entry routine; selection-aware scoping (§5, §16).

---

## 3. Technical Architecture

### 3.1 System Architecture Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│ Ableton Live 12 (Beta) — Extension Host = Node.js process           │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ Extension (src/extension/**)                                 │   │
│  │  • activation + context-menu registry                        │   │
│  │  • Context Serializer  (model → JSON snapshot)               │   │
│  │  • Reference Table     (semantic refs ⇄ fresh handles)       │   │
│  │  • Claude Client       (@anthropic-ai/sdk, tool-use loop)    │   │
│  │  • Tool Registry       (schema + executor per tool)          │   │
│  │  • Transaction Runner  (batch mutations → 1 undo)            │   │
│  │  • Transport           (localhost WS  OR  modal close_and_send)│ │
│  │  • Persistence         (config/transcript in storageDir)     │   │
│  └─────┬───────────────────────────────────┬────────────────────┘   │
│        │ getObjectFromHandle / mutate       │ showModalDialog        │
│        ▼                                     ▼                        │
│  Live Object Model                    Modal Webview (chat UI)         │
│  (src/shared types mirror it)         (src/webview/** — Vite SPA)     │
└────────┼─────────────────────────────────────┼──────────────────────┘
         │                                       │ WS (C/D) or close_and_send (A/B)
         ▼                                       ▼
  ctx.application.song …                  Claude API (called from Node)
```

### 3.2 Workspaces

- `src/extension/` — Node host; bundled by esbuild → `dist/extension.js` (single file, declared in `manifest.json`).
- `src/webview/` — Vite + TypeScript SPA chat UI; built to a single inlined file (`data:` URL) or served from the localhost server, depending on the spike branch.
- `src/shared/` — pure types/functions shared across the socket boundary (protocol messages, ref grammar, tool arg shapes). No SDK, no DOM.
- `tests/` — Vitest unit/integration tests over the pure modules, using a `FakeExtensionContext` and a stub Anthropic client.

### 3.3 Communication
- **Extension ⇄ Claude**: HTTPS via `@anthropic-ai/sdk`, from Node. Key never leaves the host.
- **Extension ⇄ Webview**: a localhost WebSocket (Spike R3 = C/D) or the documented `close_and_send` round-trip (A/B). Protocol in §13.
- **Extension ⇄ Live**: the SDK object model, handles, transactions, resources.

---

## 4. Data Flow

Primary journey — "user asks the agent to change something":

```
1. User right-clicks an object/selection in Live → context-menu action → launch command.
2. Extension builds the scoped snapshot (selection if present, else project header).
3. Chat window opens (socket branch: stays open; modal branch: opens per turn).
4. User message → extension.
5. Extension runs the Claude tool-use loop:
     a. messages += user text; system + tools (+ cached prefix) + snapshot block.
     b. Claude returns stop_reason=tool_use with one or more tool_use blocks.
     c. READ tools execute immediately; MUTATION tools are queued.
     d. Queued mutations flush in ONE withinTransaction; fresh refs returned.
     e. tool_result blocks (success or structured error) appended; loop continues.
     f. On end_turn → assistant text returned.
6. Destructive actions pause for confirmation (mechanism per spike branch).
7. Progress/tool-activity surfaced to the user (progress dialog A/B, chips C/D).
8. Transcript persisted; snapshot rebuilt next turn.
```

---

## 5. Activation, Context & Lifecycle

- Entry: `export function activate(activation) { const ctx = initialize(activation, "1.0.0"); … }`.
- A single command `live.launchAgent` is registered on multiple context-menu scopes; it branches on the argument type (`Handle` | `ArrangementSelection` | `ClipSlotSelection`) to seed the initial scoped context (§16 scopes).
- The extension runs only while invoked — **no background mode**. In socket branches the modal is opened once per session and left open; the `showModalDialog` promise resolves only on close.
- `ctx` exposes `application.song`, `commands`, `ui`, `resources`, `environment`, `getObjectFromHandle`, `withinTransaction`.

---

## 6. Reference & Identity Resolution

**Ref grammar** — a `/`-joined path of `kind:index:name` segments anchored at the song:

```
track:2:Bass
track:2:Bass/clip:0:Verse
track:2:Bass/device:1:Reverb
track:2:Bass/device:1:Reverb/param:7:Decay
track:2:Bass/mixer/param:volume
scene:4:Chorus
```

`kind` ∈ {track, clip, clipSlot, takeLane, scene, cuePoint, device, chain, param, mixer}. Each segment carries both index (position at snapshot time) and name (for drift detection).

**Resolution routine — runs on EVERY tool call (never reuse a handle across calls):**
1. Walk from `song` segment by segment, indexing the live collection and resolving handles fresh via `getObjectFromHandle` with the expected class.
2. At each segment verify the name matches. On mismatch, search that level for a unique object with the expected name: exactly one → use it (re-anchored); zero or many → structured error.
3. Return the freshly resolved object for immediate use.

**Intra-turn drift handling:**
- A create mints a new ref from the object's current position and returns it in the `tool_result`.
- A delete invalidates the ref and shifts sibling indices; the executor rebuilds the affected subtree of the Reference Table.
- After any mutating call, return fresh/affected refs so the agent re-grounds.

**Error contract** (returned as `tool_result` with `is_error: true`):
```json
{ "error": "ref_unresolved | ref_ambiguous | type_mismatch", "ref": "<ref>", "detail": "...", "hint": "re-read with live_get_project" }
```

**Cross-turn:** refs are turn-scoped; snapshot rebuilt each turn; an old ref is re-resolved against the current model or returns `ref_unresolved`.

---

## 7. Transactions & Undo

- One agent action → one undo step where possible. Queue mutation-tool effects; flush in a single `context.withinTransaction(...)`.
- `withinTransaction` is **synchronous**: for async creations `return Promise.all([...])` from it and await the transaction itself. **Never `await` inside the callback.**
- **Create-then-configure spans two transactions** (you need the created object before configuring it) — surfaced to the user as one logical action but ≥2 undo steps.
- Nested transactions auto-collapse, so per-tool executors may each open one and still group when batched.
- **R5 (must be spiked):** whether throwing inside a transaction rolls back or commits partial is undocumented — validated in §17 before the undo guarantee is relied upon. Until confirmed, treat each transaction as all-or-nothing and check the abort signal *before* opening it.

---

## 8. Tool Surface

~15 consolidated, namespaced, action-parameterized tools (Anthropic guidance: fewer capable tools beat many narrow ones). `Txn` = batched into the undo transaction. `D` = destructive (gated, §9/§12). Set `strict: true` on every mutating tool; mark `live_get_*` + system prompt cacheable.

### 8.1 Read / context tools
| Tool | Params | Wraps (SDK) |
|---|---|---|
| `live_get_project` | – | `song.*` (tempo, scale, grid, tracks, scenes, cuePoints, returnTracks, mainTrack) |
| `live_get_track` | `track` | `track.{devices,arrangementClips,clipSlots,takeLanes,mixer,mute,solo,arm,groupTrack}` |
| `live_get_clip` | `clip` | clip accessors; midi→`notes`; audio→`warp*`/`filePath` |
| `live_get_device_params` | `device` | `device.parameters[]` + `getValue()`/`min`/`max`/`isQuantized`/`valueItems` |
| `live_render_audio` | `track,startTime,endTime` | `resources.renderPreFxAudio` → temp WAV path |

### 8.2 Mutation tools
| Tool | Params | Wraps (SDK) | Txn | D |
|---|---|---|---|---|
| `live_update_track` | `track,{name?,mute?,solo?,arm?}` | track setters | ✓ | – |
| `live_update_clip` | `clip,{name?,color?,looping?,muted?,warping?,warpMode?}` | clip / audioClip setters | ✓ | – |
| `live_edit_midi_notes` | `clip,op:replace\|transpose\|quantize\|humanize\|filter,...` | get→transform→set `midiClip.notes` | ✓ | filter=D |
| `live_set_param` | `target:{device,param}\|{track,mixer:volume\|pan\|send[i]},value` | `DeviceParameter.setValue` (clamped/quantized) | ✓ | – |
| `live_create` | `kind:audio_track\|midi_track\|scene\|cue_point\|take_lane,...` | `song.create*` / `track.createTakeLane` | ✓ | – |
| `live_create_clip` | `location,type:midi\|audio,startTime?,duration?/length,filePath?,isWarped?,loopSettings?` | `createMidiClip`/`createAudioClip` on track/slot/takeLane | ✓ | – |
| `live_insert_device` | `location,deviceName,index` (built-in only) | `track.insertDevice`/`chain.insertDevice` | ✓ | – |
| `live_modify_device_chain` | `location,op:duplicate\|insert_chain,device?,index?` | `duplicateDevice`/`insertChain` | ✓ | – |
| `live_replace_sample` | `simpler,filePath` | `simpler.replaceSample` | ✓ | – |
| `live_delete` | `target` (track\|scene\|cuePoint\|clip\|device) | type-routed `delete*` | ✓ | **D** |

### 8.3 Side-effect / honesty tools
| Tool | Params | Wraps |
|---|---|---|
| `live_import_audio` | `source:path\|url` | url→`fetch`→tempDir→`resources.importIntoProject` (returns managed path) |
| `report_limitation` | `requested,reason,alternative?` | none (agent-facing honesty tool) |

---

## 9. Capability Guardrails

The system prompt carries an explicit, verbatim **"You cannot…"** contract, and tool executors fail loudly so the agent never reports phantom success.

**You cannot:**
- Process real-time audio or apply DSP ("make it warmer/louder/punchier").
- **Draw automation / envelopes** — `live_set_param` sets a *static* value only.
- Route signals or create sidechains; route MIDI.
- Apply groove / quantize-to-groove (only quantize note start times to a grid).
- Move loop/start/end markers after a clip exists (set only at creation).
- Load third-party plugins (built-in Live devices only).
- Act as a control surface, run in the background, or draw in Live's native UI.
- See the global selection — only the object/selection that launched the agent, plus what tools read.

When a request needs an unsupported capability, the agent calls `report_limitation` and offers the closest supported alternative.

---

## 10. Persistence, Secrets & Filesystem

| Data | Location | Notes |
|---|---|---|
| Anthropic API key | `storageDirectory/config.json` | Read in Node only; never sent to the webview; never logged/committed. |
| Model + defaults | `storageDirectory/config.json` | `{ model, defaults:{ scopeToSelection, confirmDestructive } }`. |
| Conversation transcript | `storageDirectory/sessions/*.json` | Re-fed each turn to fake continuity (no background mode). |
| Downloaded/rendered audio | `tempDirectory` | Then `importIntoProject` before referencing in clips. May be cleared between sessions. |

First-run key entry: if no key present, open a settings modal (the `modal-dialog` pattern) to capture it; a dev override may read from a `--storage-directory`-pointed dev config. **Never** access paths outside the storage/temp directories (a stricter OS sandbox is coming).

---

## 11. UI & Transport

The only SDK UI primitives are the **modal webview** (`ui.showModalDialog(url, w, h)`) and the **progress dialog** (`ui.withinProgressDialog`). The webview has zero Live-model access; its only documented channel back to the extension is `close_and_send`, which closes it. These facts force the two transport families:

- **Socket transport (C/D):** the extension runs a localhost WS server; the modal hosts the Vite SPA (served by URL or inlined) and connects to it. The chat stays open; turns ride the socket; tool-activity chips + streaming render live. Confirmation = in-chat cards.
- **Modal transport (A/B):** turn-based. The user types → `close_and_send` → window closes → extension runs the loop behind a progress dialog → re-opens pre-loaded with the transcript. Confirmation = propose→apply (a captured plan the user approves).

Which family is live is decided by Spike R3 (§12) and recorded in `.claude/state/progress.md`.

---

## 12. Architecture Selection (Spike R3 Outcomes)

Spike R3 (§17) runs three dependency-ordered probes; the result selects the architecture. **The build plan (INSTRUCTIONS Phases 7/8/9/13) implements exactly one of these.**

| Outcome | Observed | Transport | Chat UX | Confirmation | Acts while open? |
|---|---|---|---|---|---|
| **A** | 3.1 fail (event loop parked while modal open) | Modal `close_and_send`, turn-based | Window blinks per turn; no streaming | Propose→apply (captured plan) | No — close to act |
| **B** | 3.1 pass, 3.2 fail (no localhost reachability) | Modal `close_and_send` (+ optional host-bridge probe 3.2b) | Turn-based; possible richer modal | Propose→apply | No — close to act |
| **C** | 3.1+3.2 pass, 3.3 fail (can't mutate while modal open) | Localhost WS for chat/stream | Persistent, streaming chat | In-chat approval, then **close-to-apply** for the mutation batch | Chat yes; mutate no |
| **D** | All pass | Localhost WS, full duplex | Persistent, streaming chat | In-chat confirm cards | **Yes — act in place** |

**Shared, outcome-independent core** (Phases 3–6, 10): reference resolution, snapshot serializer, Claude loop, tool registry/executors, guardrails, persistence. Only the transport (Phase 7), UI variant (Phase 8), and confirmation flow (Phase 9) branch.

**Durability caveat:** outcomes C/D rely on binding a localhost port, which a future OS-level sandbox may restrict. Propose→apply (A/B path) is the permanent documented fallback and must remain buildable even if D ships.

---

## 13. Socket Protocol

Built only for outcomes C/D. Localhost WebSocket; extension = server, webview = client. Envelope: `{ "v": 1, "id": "<uuid>", "type": "...", "payload": {...} }`. Types defined in `src/shared/protocol.ts`.

| Direction | `type` | `payload` |
|---|---|---|
| webview → ext | `ready` | – |
| webview → ext | `user_message` | `{ text }` |
| webview → ext | `confirm_response` | `{ planId, approved }` |
| webview → ext | `cancel` | – |
| webview → ext | `set_config` | `{ apiKey?, model? }` |
| ext → webview | `config_state` | `{ hasKey, model }` |
| ext → webview | `assistant_delta` | `{ text }` (streamed token) |
| ext → webview | `assistant_done` | `{ stopReason }` |
| ext → webview | `tool_activity` | `{ tool, summary, status: started\|ok\|error }` |
| ext → webview | `confirm_request` | `{ planId, summary, actions[] }` |
| ext → webview | `refs_updated` | `{ refs[] }` |
| ext → webview | `error` | `{ message }` |

`tool_activity` doubles as progress narration. In outcome C, `confirm_request`/`confirm_response` gate an approval that then triggers a close-to-apply batch; in D they gate in-place execution. In A/B these collapse into the propose→apply modal step.

---

## 14. SDK Capability Map

Writable surface (defines what tools can do): `Track.{name,mute,solo,arm}`; `Clip.{name,color,looping,muted}`; `AudioClip.{warping,warpMode}`; `MidiClip.notes` (full read/write); `DeviceParameter.setValue`; `Song.tempo`; create/delete of tracks, scenes, cue points, clips, devices, take lanes; `Simpler.replaceSample`; mixer `volume`/`panning`/`sends` (DeviceParameters).

Read surface: full object model traversal from `song`; `DeviceParameter.getValue` (async); `resources.renderPreFxAudio` (pre-FX WAV).

Hard limits (→ §9): no automation, routing, real-time audio, plugins, post-creation marker edits, background mode, native-UI drawing, global-selection read.

Key enums/types: `WarpMode` {Beats 0, Tones 1, Texture 2, Repitch 3, Complex 4, ComplexPro 6}; `NoteDescription { pitch, startTime, duration, velocity?, muted?, probability?, releaseVelocity?, selected?, velocityDeviation? }`; `ClipLoopSettings { looping, startMarker, endMarker, loopStart, loopEnd }` (create-time only); context-menu scopes per §16.

---

## 15. Performance Budgets

| Metric | Target |
|--------|--------|
| Launch → chat window visible | < 800 ms |
| Snapshot build (selection-scoped) | < 150 ms |
| Snapshot build (whole Set, shallow) | < 600 ms |
| First streamed token (socket branch) | < 1.5 s after send |
| Single mutation tool execute + commit | < 100 ms |
| Bulk op (e.g. rename 200 clips) | chunked; UI feedback every ≤ 500 ms |
| Per-turn token budget (incl. snapshot) | ≤ 25k input; evict/cache beyond |
| `getValue()` fan-out | lazy/on-demand only; never eager for the whole Set |

---

## 16. Quick Reference Tables

**Context-menu scopes (launch points):** `AudioClip`, `MidiClip`, `AudioTrack`, `MidiTrack`, `ClipSlot`, `Scene`, `Simpler`, `Sample`, `DrumRack`, `ClipSlotSelection`, `AudioTrack.ArrangementSelection`, `MidiTrack.ArrangementSelection`.

**Selection payloads:** `ArrangementSelection { selected_lanes: Handle[], time_selection_start, time_selection_end }`; `ClipSlotSelection { selected_clip_slots: Handle[] }`.

**Units:** arrangement time = beats; render analysis = seconds (convert `60/tempo`); device params = raw `min…max`; tempo = BPM.

**Build/run commands:** `npm start` (dev build + run in Live), `npm run build`, `npm run build:dev`, `npm run package` (.ablx), `npm test`, `npm run lint`, `npm run format`.

**Log file:** macOS `~/Library/Preferences/Ableton/Live <ver>/ExtensionHost.txt`; Windows `%APPDATA%\Ableton\Live <ver>\Preferences\ExtensionHost.txt`.

---

## 17. Spike R3 & R5 — Validation Plan

Run before Phase 3. Throwaway probes; record the outcome (A/B/C/D) and R5 result in progress.md.

### Spike 3.1 — Event loop alive while a modal is open? (the gate)
Start `setInterval(() => console.log("tick", Date.now()), 500)`, then open the modal **fire-and-forget** (not awaited). **Pass:** ticks continue at cadence while the modal is open. **Fail:** ticks stop → in-process side-channel impossible → outcome A.

### Spike 3.2 — Webview reaches a localhost socket?
Start an HTTP+WS server on `127.0.0.1:<port>` before opening the modal. Test two variants: (a) `data:` URL page connecting cross-origin; (b) `showModalDialog('http://127.0.0.1:<port>/')` with a same-origin WS. **Pass (b):** cleanest — serve SPA + socket from one server. **Fail both:** outcome B (try optional probe 3.2b: does the host route a non-`close_and_send` webview message anywhere? — undocumented, low expectations).

### Spike 3.3 — Mutate the model while the modal is open? (make-or-break)
With the modal open, run `withinTransaction(() => { track.name = "SPIKE "+Date.now(); })` and an async `createAudioTrack()`. **Pass:** changes appear in Live while open → outcome D. **Fail:** mutations rejected/queued/no-op → outcome C (chat live, close-to-apply).

### Spike R5 — Transaction rollback on throw
Throw inside `withinTransaction`; observe whether Live records a partial undo entry or none. Record the result; it determines whether the "one undo step / all-or-nothing" guarantee holds as stated in §7.

### Outcome matrix
| 3.1 | 3.2 | 3.3 | Outcome |
|---|---|---|---|
| Fail | – | – | **A** — propose→apply + turn-based modal |
| Pass | Fail | – | **B** — try 3.2b, else propose→apply |
| Pass | Pass | Fail | **C** — streaming chat + in-chat approval, close-to-apply |
| Pass | Pass | Pass | **D** — persistent chat, in-chat confirm, act-in-place |

---

*This document evolves with implementation.*
