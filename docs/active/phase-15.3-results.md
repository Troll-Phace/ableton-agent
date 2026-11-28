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

Owner merged [PR #6](https://github.com/Troll-Phace/ableton-agent/pull/6)
on 2026-11-27; verified merge 998cbcb. F2C checkpoint reconciled on main.
F3/F5 feasibility may begin; owner consent is required before real OAuth,
and no inference or eligibility claim exists yet.

F3/F5 dedicated Astra/low plan approved for offline implementation only; [execution contract](phase-15.3-signin-plan.md). Eligibility unresolved: public repo has no license and selected private client status is unverified. No real OAuth or inference allowed until resolved; owner asked about licensing, no change authorized yet.

Owner authorized MIT and eligibility prep. Focused [PR #7](https://github.com/Troll-Phace/ableton-agent/pull/7) (head 9eae1e8) open for review: project MIT, third-party exclusions, pinned Ableton SDK/CLI archives removed from current tracked tree and retained locally. No historical rewrite. Official preview registration and account eligibility remain unverified; no live OAuth until the licensing gate is reviewed and eligibility basis recorded.

Owner merged #7 on 2026-11-27; 0959efc verified from origin/main. Published project source is now MIT-licensed, separate proprietary dependencies are locally acquired under their own terms. This supplies the open-source basis for the documented dynamic registration path, not proof of account or provider acceptance. Local SDK archives remain intact. Current feasibility branch contains the same licensing commit; main reconciliation deferred until the backend workspace is idle.

S2 backend completed five assigned host-only files, with synthetic lifecycle smoke and baseline 1041/1041, lint/type/format passing; real JWT/library and provider not yet tested. S3 dispatched to backend, S5 independent tests to test engineer. Coordinator verified registry metadata for Auth0 jsonwebtoken 9.0.3 and DefinitelyTyped @types/jsonwebtoken 9.0.10, installed exact dev-only pins with scripts disabled; lockfile changes add only verifier/types dependency closure with registry integrity and MIT/BSD/Apache licenses. S4 must include distribution notices for bundled third-party code and verify actual installed-host signature operation before auth.

S3 backend completed isolated responses.ts and signin-session.ts; baseline 1041/1041 and checks passed; synthetic fixed function call/output, retained reasoning items, three durable attempt reservations, pending-read cancellation, no fourth request and sanitized projection/sign-out passed. S4 integration dispatched; S5 tests remain independent. No live/provider work yet.

Independent S5 completed 158 tests (65 OAuth/discovery/ID token, 22 storage, 52 Responses, 19 session and isolation); 1199/1199 total across 32 files, TypeScript/lint/target format passed. Actual maintained verifier signature validation passed with generated RSA keys; exact dependency closure checked. No blocking S2/S3 defect found. S4 fixture integration not yet available; actual bundle isolation, installed preflight and owner OAuth/inference pending.

S4 backend packaged isolated version 0.0.3 with six entries, pinned SDK + exact 15-runtime-package JWT closure, third-party notices and bundle inventory. 1199/1199, lint/type/format/dev build, exact packaged-entry synthetic preflight and credential-free webview mock passed; discovery/JWKS mocked. Coordinator verified official Manage usage link https://chatgpt.com/settings/usage, added documented data-oai-siwc-button attribute to the white full-label button and rebuilt. Current installed-candidate build f3-5ba5a787c25e301e, SHA256 ad1783d35f9f697e40c8878769f43422ab4b096a973980a070d66b4a78eb4d4c; ZIP integrity passed. S8 read-only close review and S5 actual packaged integration regressions assigned before installed preflight. No real provider/auth/Set access.

S8 first close review BLOCKED before live consent: returning sign-in omitted required stable host ID, and failed credential-temp deletion could let later sign-out falsely report complete cleanup. Backend bounded correction assigned; independent failure/restart and returning host-ID tests required, targeted re-review after. Nonblocking fixed-code refresh/stream error classification recorded. Archive/source check passed on superseded candidate, production unchanged. No installed or real OAuth action until corrected.

S5 integration review independently reproduced pre-correction package JS byte-for-byte; verified six entries, 16 exact dependencies, licenses/inventory, production excludes fixture/JWT. Seven additional regression tests cover nonce/owner gates, preflight, modal lifetime, model/plan selection, sanitized projection, bundled JWT; full 1206/1206 at that point. S8 blockers remain and independent correction regressions assigned; current artifact is stale until corrections and re-review.

S8 bounded corrections implemented: same stable host ID in first/return sign-in; restart-safe owned temporary-file cleanup obligations, sign-out incomplete if any remain; bounded structured stream error classification improved. Independent tests reproduced both defects with five failing assertions before correction; afterwards 91/91 targeted, 1210/1210 total across 32 files, lint/type/format pass. Coordinator rebuilt candidate 0.0.3 f3-a9f9ef6af1fd0267 SHA256 9989debcdab110daff709a34e879e3f096262fda51be1e243d3d49856cfe6fd2, ZIP integrity passed, 0.0.1/0.0.2 hashes unchanged. Targeted S8 re-review in progress.

Targeted S8 re-review passed both blockers; archive exact six-file/current input verification. Coordinator independently reran lint, TypeScript, 1210/1210 Vitest and 14/14 framework tests. Installed corrected 0.0.3 using normal Live Settings: removed only temporary 0.0.2, restarted, installed reviewed archive and restarted, production Claude extension unchanged; Untitled disposable Set. 2026-11-28 00:42 UTC local transport/callback binding/bundled verifier PASS, privateStorage BLOCKED (not_verified), so session blocked host_preflight_failed and Continue with ChatGPT disabled. No discovery, OAuth, real credentials, external inference or Set operations. Nonsecret storage metadata only: SDK root owned uid501 mode0755, nested p15-3-signin owned uid501 mode0700, empty. Bounded fixed-stage credential-free diagnostic assigned; no permission changes or alternate storage.

Credential-free storage diagnostic source complete; no root cause assumed. Distinguishes fixed stages/allowlisted errors and adds fail-closed missing-native-constant guard without relaxing protections. 1210/1210 baseline, synthetic filesystem failure classes, lint/type/format, archive integrity passed. Separate 0.0.3-storage-diagnostic.ablx f3-4d40208b0e983bee SHA256 c36baebcaa9ff989320f04084939624d49da0e354b911ff80d3607857eb94fdc; previous candidate and 0.0.1/0.0.2 preserved. Focused review assigned prior to actual credential-free diagnostic.

### Installed storage diagnostic — 2026-11-28 00:54 UTC

Focused reviewer PASS for credential-free diagnostic, exact archive and no security relaxation. Through standard Live settings removed only prior temporary 0.0.3 and restarted, installed separate reviewed diagnostic and restarted; production extension preserved, blank Untitled Set. Visible version 0.0.3 build f3-4d40208b0e983bee, SHA256 c36baebcaa9ff989320f04084939624d49da0e354b911ff80d3607857eb94fdc. Native transport, callback binding, bundled verifier again PASS. Protected storage BLOCKED. Sanitized fixed-stage host event at 19:54:39 local: ensure_host_id root/directory owner/mode/identity, enumeration, temp reconciliation, exclusive no-follow open, fstat, write bytes and file metadata all passed; write_sync (fsyncSync) BLOCKED permission_denied. Descriptor close, owned-temp metadata/unlink/absence and cleanup all PASS. Post-run nested directory remains owner-only 0700 and empty. No host/budget/credentials persisted. No official HTTPS discovery, OAuth, real account credentials, browser launch or model/inference requests.

**F3/F5 direct native route blocked before consent.** Do not remove fsync or lower credential durability/security, change host permissions, try permission-bypass mechanisms or silently use API credits. The installed diagnostic establishes that the current protected store cannot complete its required durable writes in normal host conditions. The previous F2 synthetic atomic-replacement result did not establish this stricter durability capability. Deliver an honest blocked checkpoint PR and stop for owner review. Recommended next decision: separately scope a sanctioned local companion for official in-app sign-in, durable protected store and inference; preserve native Live tool/UI architecture and local authenticated bridge, or await a documented host-supported durable storage facility. No companion work, live consent or Phase 15.4 without owner direction.

Independent final diagnostic regression PASS: eight additional tests, 60/60 focused and 1218/1218 full (32 files), lint/type/target format clean. Confirmed synthetic fsync permission_denied classified fixed write_sync, descriptor close and cleanup, sanitized output, blocked preflight and zero OAuth/provider traffic; invalid/missing required native flags fail closed. No installed feasibility claim. Coordinator prior final aggregate 1210/1210 and 14/14 framework passed before adding these tests; rerun final aggregate.

Coordinator final verification after diagnostic regression additions:
lint, typecheck, 1218/1218 Vitest (32 files) and 14/14 framework tests PASS.
Checkpoint remains BLOCKED for direct real sign-in and inference, not a
production migration or Phase 15.3 acceptance.

Owner merged [PR #8](https://github.com/Troll-Phace/ableton-agent/pull/8) on 2026-11-28 (0909e47 verified). Direct native checkpoint is preserved on main, still BLOCKED before OAuth. Awaiting separate direction on companion or documented durable host alternative.
