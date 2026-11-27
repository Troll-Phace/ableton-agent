# Phase 15.3 — Installed ChatGPT provider feasibility

**Approved by the orchestrator, 2026-11-27.** Dedicated Astra/low planning
review finished; owner authorized Dot to approve plans. This phase tests a
separate installed extension, not production provider migration. Baseline PR
#4 is merged; branch phase/15-chatgpt-feasibility starts from c6baad3.
Scope and current evidence: [CHATGPT_MIGRATION](../CHATGPT_MIGRATION.md).

## Sequencing and ownership

| ID | Owner | Exact paths / scope |
| --- | --- | --- |
| F1 | Dot | This plan, phase-15.3-results.md, shared ledger, migration scope and role config. |
| F2 | backend-dev (Sol/high) | New src/extension/feasibility/{contracts,host-probes,index}.ts, scripts/build-chatgpt-feasibility.ts; isolated fixture entry, staging under ignored dist/chatgpt-feasibility/, independently named manifest and minimal webview. |
| F3 | backend-dev (Sol/high) | New src/extension/feasibility/{oauth,credential-store,responses}.ts; only bounded official auth/storage/inference probes with injected network, clock, browser, storage seams. F2 contract must precede. |
| F4 | test-engineer (Sol/high) | New tests/chatgpt-feasibility.test.ts, tests/fixtures/chatgpt-feasibility.ts; mocked proof, no live actions. F3 and F4 may proceed once interface agreed; do not share writes. |
| F5 | Dot/owner | Normal installed current-beta fixture test on disposable empty Set. Start with no-credential host checks. Owner personally approves OAuth/model/usage only if prerequisites pass. |
| F6 | Dot and bounded read-only reviewer | Record exact results and checkpoint, run final checks and review, open PR for owner; stop before next phase. |

Optimization: perform F2's installed no-credential checks as soon as its
headless tests pass, before doing dependent OAuth/inference implementation
if the direct host is demonstrably blocked. The spike may yield a valid
BLOCKED outcome and review PR with evidence; do not pretend the migration
can advance. No production entry, manifest, tools, dependencies or behavior
changes outside explicitly approved fixture scope.

## Fixture constraints and checks

- Independent, unmistakably temporary extension manifest; package archive in
  ignored dist, explicit webview asset inclusion (the CLI default does not
  package the webview). Verify manifest, files and SHA256. Normal installed
  host, not developer mode. Use existing pinned SDK only as necessary for
  activation, SDK-provided environment directories, context UI and modal.
- Never load production index, shim, config, transcript, Anthropic, Undici,
  SDK song/handles, executors, snapshots or transactions. No Live Set data
  is collected, modified or sent. Existing 17 tools untouched.
- ProbeResult = { probe, outcome: pass|blocked|failed, code, measurements? };
  only bounded status counts, bools, timings, versions and sanitized codes.
  One pending auth and request; bounded deadline and cancellation;
  deterministic cleanup of listeners, readers, timers and fixture files.
  Minimal modal: status, Continue with ChatGPT, Cancel, Sign out (later F3).
  Nonce-protected loopback IPC only, no secrets/authorization URL in webview.
- F2 no-credential host checks: native Fetch/stream read/AbortController;
  randomness; required Node builtins; ephemeral loopback listener and fixed
  synthetic SSE response, abort + cleanup; create owned private synthetic
  file in SDK storage only, atomic replacement/0600/restart persistence/
  delete; system browser launch once for fixed harmless loopback URL via
  documented supported host behavior. Pinned SDK exposes no dedicated
  system-browser API; fixed macOS /usr/bin/open with argument array and no
  shell may be tested only under normal host permissions. Denial is a
  blocker, not an invitation to change restrictions or use another launcher.

## F3 official OAuth and inference (only if F2 direct-host gate passes)

Follow current official [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[models](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and [preview](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
First registration through documented dynamic_agent_client and persisted
unique host identifier; issue-specific client ID persisted, PKCE S256/state/
nonce, documented loopback callback and response processing, identical
redirect/resource on exchange, proper signature/issuer/audience/expiry/
nonce checks via maintained bundled JWT verifier and official discovery/JWKS.
No incidental login-token reuse, unofficial endpoint, cookie access, or
credential from old config/transcripts. Validate granted plan-use scope before
inference; protect per-registration token storage and atomic owner-only
replacement. Consent denial/cancel/expiry/account mismatch/refresh failure/
revocation/sign-out cleanly handled. Never leak credentials to UI or logs.
Owner personally consents and chooses available catalog model. No API key
fallback, extra credits, or paid Anthropic; confirm plan-only usage route.

Fetch account-specific model catalog; use selected visible slug. Public
Responses endpoint, official OAuth access token, store:false, stream:true,
explicit input and developer instructions; no unsupported preview parameters.
One synthetic namespace feasibility function echo, strict schema accepting
only value p15_3 (no Live access). After response.completed, accept exactly
one fully assembled unique call ID and validated arguments. Append the complete
prior input, returned required output/reasoning items, and matching
function_call_output with fixed JSON result; require completed final response
acknowledging the marker. No partial/malformed/unknown/duplicate action.
Bound actual usage to three inference requests (two-request function round
trip plus short cancellation probe); disabled automatic inference retries.
No further requests without owner authorization.

## Acceptance and stop decisions

- Headless: TypeScript, lint, complete Vitest with existing 951 tests
  preserved, framework 14 tests, build and inspected package. F4 covers
  wrong/replayed state, denial, timeout, JWT claims/signature and missing
  plan-use scope, unsafe storage, refresh rotation/failure, revoked session,
  catalog mismatch, fragmented SSE, duplicate/malformed calls, premature
  EOF, failed/incomplete terminals, abort and secret redaction for implemented
  paths; F2 includes synthetic independent host-probe failure cases.
- GO requires normal installed host capability and protected persistence/
  restart, official registration and scope, refresh, completed function
  round trip and cancellation on exact recorded artifact.
- BLOCKED: missing/denied prerequisite or eligibility; stop direct path,
  record precise sanitized evidence, no workaround, permission changes,
  external launcher, alternate credentials or runtime mutation. A minimal
  user-launched local companion (auth/inference only, bounded authenticated
  loopback, no SDK/tool access) is a separate owner decision, not this phase.
- Record only revision, hash, Live/Node/SDK versions, installed activation,
  sanitized probe outcomes, granted scope names, model slug, counts/terminal
  statuses, and persistence outcomes. Never token/identity/callback URL/body
  or raw transcript. Stop for owner consent before real auth/usage. Open
  review PR with evidence, not a claim Phase 15.4 is complete.

No automatic next-stage dispatch after PR. Owner review required.
