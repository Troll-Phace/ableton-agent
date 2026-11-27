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
| F6 review PR | Bounded code-reviewer: no blocking findings for BLOCKED checkpoint; owner PR review pending |

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
provider test. Owner review is required before the recommended next spike.
