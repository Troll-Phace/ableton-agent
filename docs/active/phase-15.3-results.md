# Phase 15.3 feasibility results

Status: F2 corrected and installed no-credential checks completed. Unshimmed native-stream/abort gate BLOCKED on Live 12.4.25b2; browser, local IPC and synthetic storage/restart passed. No OAuth or provider inference.

| Gate | Status |
| --- | --- |
| F1 plan / roles | Approved; owner authorized Dot to approve plans |
| F2 independent fixture + headless test | PASS after correction, 39/39 fixture tests and 990/990 aggregate |
| F2 installed no-credential host capabilities | BLOCKED for native stream/abort; browser, loopback, private storage/restart PASS |
| F3 official sign-in / Responses fixture | Not started; blocked on direct native transport |
| F4 regression proof | PASS after correction (39/39, baseline 951/951) |
| F5 personal consent and real function round trip | NOT RUN; no consent requested and no real API usage |
| F6 review PR | Bounded code-reviewer: no blocking findings for BLOCKED checkpoint; PR #5 merged by owner (2ca8db0 verified), BLOCKED outcome retained |

Only sanitized outcomes and tested revisions/artifact hashes belong here.


## F2 backend handoff (2026-11-27)

Artifact: ignored dist/chatgpt-feasibility/ableton-chatgpt-feasibility-0.0.1.ablx;
SHA256 383e349e16d046ecb11fdb0713ba0054423cc1a4a4842c273ec082996eb085c4
verified by coordinator. Archive contains manifest.json, extension.js and
webview/index.html. Backend reported TypeScript, target lint, package integrity,
native Node 24.16.0 capabilities, synthetic loopback/SSE/abort, synthetic
private storage replacement and cross-process persistence/deletion all passed.
The system-browser launch and actual installed Live host remain untested.
No code outside the four F2 paths was changed. F4 independent test-engineer
assigned coverage for the F2 subset only; no F3/OAuth work until installed
no-credential gate passes. Test result and package hash must be reverified
after any corrections.


## F4 independent test handoff (2026-11-27)

Test engineer added 39 offline tests in the two assigned test files.
Targeted 38/39 passed; full Vitest 989/990 passed, all 951 baseline
tests unchanged. TypeScript, full ESLint, new-file format passed. One
blocking regression at tests/chatgpt-feasibility.test.ts:396: synchronous
permission denial from server.listen() bypasses cleanup, retaining one
error listener and deadline timer. Async denial cleanup passes. Backend
assigned bounded correction without modifying test expectations or
permissions; no Live/OAuth action until verified.


## Correction and independent coordinator rerun (2026-11-27)

Synchronous server.listen() denial now runs the same cleanup path as async
denial; unchanged F4 regression passed. Backend reported 39/39, 990/990,
lint, TypeScript and package integrity passing. Coordinator independently
reran Vitest (990/990, 27 files), configured framework validator and 14/14
Python tests. Rebuilt package SHA256
5bd7bc9c91e2365371bdb17bd8171e1637e3b102f2bb6bbbfa01b739ee14152c
verified again; three expected archive files, zip integrity pass.

## Actual installed fixture, 2026-11-27 22:58–22:59 UTC

Normal installed (not Developer Mode) Live 12.4.25b2, Node host 24.22.1,
pinned SDK 1.0.0-beta.0; exact artifact above. The Live extension settings
accepted installation and required restart. Context menu listed both the
existing Claude agent and independent feasibility fixture. The fixture
opened and ran from a disposable Untitled Set; no SDK song reads or writes,
real credentials, auth, external network or provider usage.

| Probe | First run | Second after Live restart |
| --- | --- | --- |
| SDK activation + command | PASS | PASS |
| Nonce-bound modal IPC + ephemeral loopback | PASS | PASS |
| Native globals | BLOCKED: missing_native_globals; fetch and AbortController present; TextDecoder, URL, ReadableStream absent | Same |
| HTTP, fs, path and crypto builtins | PASS | PASS |
| Random 32-byte samples distinct | PASS | PASS |
| Synthetic private storage + atomic replacement | PASS for mode and replacement, restart_required | PASS restart_verified_and_deleted, private mode/atomic replacement/restart/deletion true |
| Native SSE stream | BLOCKED: missing_native_globals | Same |
| Native abort | FAILED: operation_failed | Same; no conclusion about specific internal cause |
| System-browser launch | PASS fixed_loopback_page_visited | PASS |

The synthetic marker was verified deleted after restart. All evidence is
the fixture's allowlisted sanitized status codes; no callback URLs, tokens,
identities or transcripts. A system-browser visit was to the fixed local
test page only. The raw Fetch route is blocked, but this does NOT prove the
direct installed-host approach impossible: browser and secure local
storage capability are promising, and allowed Node builtins are present.
The original product shim supplied missing globals in its own realm before
the obsolete external Undici require failed. Recommend a separate bounded
compatibility experiment using only documented allowed Node builtins, with
the same unmodified host permissions, to establish stream and cancellation
before any OAuth. Do not silently treat this as a passed prerequisite or
switch to a companion, developer host or alternate credential route.
F3/F5 remain unstarted; review before continuing. No regression to existing
Live tooling is asserted from these isolated tests.


## Bounded review (2026-11-27)

Independent read-only reviewer: no blocking findings for the review-only
BLOCKED checkpoint PR. Confirmed fixture isolation, authenticated loopback,
synchronous denial cleanup, non-vacuous tests, archive contents and exact
SHA256. Confirmed the native stream/abort blockers and unstarted F3/F5
are reported accurately. This is not a migration GO, OAuth proof, or
provider test. Owner merged [PR #5](https://github.com/Troll-Phace/ableton-agent/pull/5) on 2026-11-27 and authorized continuing with the recommended bounded compatibility spike. This does not clear the F3/F5 gate.


## F2C follow-up (2026-11-27)

Owner merged #5 and approved continuing. Dedicated Astra/low follow-up
plan approved: [native compatibility](phase-15.3-native-compatibility-plan.md).
The original raw outcome remains BLOCKED. F2C will test only permitted
builtin constructors and existing native Fetch; no host permission edits,
provider inference or OAuth. New results pending.


F2C backend C2/C3 completed: separate local and supplemented lanes,
bounded SSE/abort stage evidence, exact restoration checks, no production
changes. New version 0.0.2 visible build f2c-eac1f698060668a6, SHA256
82d904f7e3fd510a6d1091d83f39cd28f51dd2e6ac84ae0c325ea73f9a8828d8.
Original 0.0.1 archive preserved. Backend reported full 990/990 baseline
and build/lint/types plus guarded standalone loopback passes in both
lanes. C4 independent tests assigned; no installed 0.0.2, OAuth, or
provider evidence yet. Package hash subject to correction/rebuild.


C4 independent test engineer added 51 tests in the two assigned files;
51/51 and full 1041/1041 (28 files) passed, all 990 existing tests unchanged.
TypeScript, lint, targeted formatting passed. Coordinator independently
reran aggregate and configured framework 14/14 checks; archive hashes
confirmed unchanged. No blocking backend finding in tested scope.
C5 initial normal installed upgrade attempt: Live explicitly rejected
existing installation directory (0.0.1 manifest still present);
v0.0.2 not installed or run. Temporary fixture must be removed through
normal Live extension settings then updated. Computer-use session
timed out after the dialog; owner asked to release session. Awaiting
reconnect; no transport or OAuth conclusion from this install conflict.


### F2C actual installed evidence — 2026-11-27 23:29 and 23:30 UTC

After reconnect, explicitly uninstalled only temporary 0.0.1 via Live
Extensions settings, restarted, installed reviewed 0.0.2 and restarted
again. Production Claude extension remained installed; no real Set was
opened or changed. Normal installed Live 12.4.25b2, Node 24.22.1, pinned
SDK 1.0.0-beta.0. Native modal verified visible version 0.0.2 and build
f2c-eac1f698060668a6, artifact SHA256
82d904f7e3fd510a6d1091d83f39cd28f51dd2e6ac84ae0c325ea73f9a8828d8.
Ran compatibility checks twice, second after a fresh Live restart.
Sanitized host report from 18:29:14 and 18:30:11 local time agrees:

| Check | Both runs |
| --- | --- |
| Raw globals before lane | TextDecoder, URL, ReadableStream absent; native fetch and AbortController present (prior raw result unchanged) |
| Independent builtin constructors | All three functional, node_builtin |
| Local-only lane | PASS transport_verified, no global supplementation |
| Synthetic SSE | PASS synthetic_sse_completed, 2 chunks / 39 bytes, read before EOF, exact payload and cleanup |
| Native pending read abort | PASS pending_read_aborted_and_closed, 1 initial chunk / 13 bytes, pending read rejected AbortError, response closed before forced teardown and cleanup true |
| Global state | Exact restoration/unchanged true; supplemented lane not needed or executed |

No real credentials, external network, HTTP provider, browser launch,
storage or Live Set operations in the compatibility action. User-initiated
Cancel is independently covered headless; no manual cancel claimed.
F2C transport gate passes for the local-constructors lane; directly
addresses the raw F2 failure without changing host permissions or
introducing Undici/global shims. Prior F2 evidence remains historical;
HTTPS auth/provider functionality and actual account eligibility still
unknown. Next: owner-reviewed compatibility checkpoint PR, then F3/F5
official sign-in and bounded model/tool call with owner consent.

Independent C6 review (2026-11-27): PASS for checkpoint PR, no blocking
findings. Reviewer verified non-vacuous pre-EOF/abort evidence, restoration
and cleanup gates, isolation from production/auth, exact build ID and
archive SHA256, package integrity and preserved original artifact.
No new installed or provider test was claimed by the reviewer.
