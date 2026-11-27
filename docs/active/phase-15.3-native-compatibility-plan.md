# Phase 15.3 follow-up — F2C native Fetch compatibility

**Approved 2026-11-27 by Dot.** Dedicated Astra/low plan; owner merged PR #5
and authorized continuation. Baseline main ee0713e, branch
phase/15-chatgpt-native-compatibility. Retain original BLOCKED F2 evidence
in [15.3 results](phase-15.3-results.md); this is a new, bounded no-credential
experiment, not OAuth or product-provider work.

Raw F2 did not establish native Fetch cannot stream: probeStream exited
before Fetch when TextDecoder was absent. The abort failure was generic
and does not identify Fetch, reader acquisition, read or abort stage.
A minimal separate probe must distinguish those possibilities.

## Ownership

| Task | Owner and exact paths |
| --- | --- |
| C1 | Dot: this plan, append-only result section, shared ledger. |
| C2 | Backend Sol/high: new src/extension/feasibility/native-compatibility.ts, extend contracts.ts; separate results, preserve raw host-probes.ts. |
| C3 | Same backend: feasibility/index.ts and scripts/build-chatgpt-feasibility.ts; operator action, explicit version 0.0.2, visible build identity. |
| C4 | Test Sol/high: new tests/chatgpt-native-compatibility.test.ts and tests/fixtures/chatgpt-native-compatibility.ts; independent proofs, do not alter earlier 990 tests. |
| C5 | Dot/operator and bounded reviewer: package/headless and normal installed test, evidence and owner-reviewed checkpoint PR. |

C2 contract before C3/C4. Backend source only, independent test files.
Do not alter production runtime/source, manifest, dependencies, 17 tools,
permissions or real Set. No external network, credentials, OAuth or provider
requests. No frontend specialist needed.

## Capability and transport contract

Only lazily and independently load documented Node builtins:
node:util TextDecoder, node:url URL, node:stream/web ReadableStream.
Use injected seams; report native/node_builtin/unavailable for each
constructor. Test functional split UTF-8 decode + flush, synthetic URL
parse, and synthetic readable stream construct/read/cancel independently.
Import denial is evidence, no alternate module or permission workarounds.
Preserve original native Fetch/AbortController/etc; never replace fetch,
Headers, Request, Response, AbortController or AbortSignal.

Lanes: (1) local constructor only, global state untouched, using local
TextDecoder; (2) if not proven, temporarily supplement only those three
standard missing globals when undefined, never overwrite a defined value,
restore exact original property descriptors on cleanup. No concurrent lanes.
Raw availability is captured before supplementation, exact restoration is
required before repeating, or restart. All supplemental outcomes labeled.

No global URL or ReadableStream constructor is required merely for a string
URL or returned body's getReader; missing optional constructor must not
prevent independent stream and abort probe. Use structural methods, not
cross-realm instanceof. Constructor functionality and actual transport
are separate results.

Only ephemeral loopback listener, fixed route/payload, no browser/storage
work in compatibility action; no user-controlled destinations. Bounded
stage diagnostics (listen/fetch_started/headers_received/reader_acquired/
first_chunk/pending_read/abort_requested/read_settled/cleanup), fixed
allowlisted statuses/codes, booleans/counts only. No raw exception,
paths, URLs, messages, stacks, or credential data. Structural error
classification across realms.

- Stream: native Fetch, HTTP 200 and SSE content type; exact fixed payload
  with split UTF-8 decoded; prove initial reading **before EOF** via
  server handshake, not just buffered body; five-second operation
  deadlines, bounded bytes/chunks.
- Abort: receive headers and nonempty first chunk, server keeps response
  open, a pending read rejects with actual expected abort classification
  after original native controller abort before deadline. Separately
  verify server response closure before forced teardown. Unrelated error,
  timeout or forced closure is not a passing abort.
- Operator cancellation is cancelled, not pass; pre-cancel avoids import/
  bind work. All paths remove timers/listeners, cancel/release reader,
  close sockets and restore globals. Cleanup failure blocks passing lane.

## Required independent verification

Tests: each builtin present/missing/denied; preserve or restore exact
descriptors including undefined/nonconfigurable/unwritable paths; no
import side effects; local-lane success without optional globals; missing
Fetch/controller/body/reader, staged Fetch/read failures, fragmented UTF-8,
size limits, malformed/EOF/pre-EOF handshake; actual pending-read abort,
structural cross-realm AbortError, unrelated failure/ignored abort/
timeout/cancel; synchronous/asynchronous listen denial and cleanup;
bundle isolation (fixture + pinned SDK only). Fake seams for failures,
guarded in-process Node loopback only for real streaming.

Run lint, Vitest (990 preserved plus new tests), tsc -b, build:dev,
tsx scripts/build-chatgpt-feasibility.ts, framework validator and tests.
New archive version 0.0.2, old 0.0.1 retained; manifest/entry/explicit
webview asset, inspect and hash. No npm start or validate:tools.

## Installed acceptance and stop gate

Normal installed Live 12.4.25b2, disposable Set, verify actual host
version, fixture visible version/build and exact artifact SHA. Run only
compatibility action, repeat after fresh restart, record lane stages,
restoration and cancellation. Earlier browser/storage evidence retained
as historical, not freshly retested claims.

Transport pass in either lane establishes only **F2C**; does not prove
OAuth/provider HTTPS/function calling or full phase. Denial/failure is
not bypassed; no assumption about root cause. If both lanes fail or
diagnostic/time/correction limits reached, stop with evidence. Subsequent
legitimate node:http/https transport or a user-launched companion is a
separate owner decision, not this experiment. F3/F5 gated on actual
compatibility outcome and owner review of next PR. No OAuth consent yet.
