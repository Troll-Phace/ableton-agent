# Approved Phase 15.3 response diagnostic execution contract

Approved by coordinator 2026-11-28 for offline development and reviewed checkpoint only. No real model request without a separately explicit owner approval after PR review; existing 1/3 budget preserved/frozen. Fresh backend session selected as owner requested.

**Plan: instrument the existing response path first; propose one separately authorized text-only request afterward.** No request-body correction is established, and the recorded zero counters are not reliable evidence of an empty response.

Verified clean branch `phase/15-chatgpt-response-diagnostic`, HEAD `5286d55`, containing PR #9 merge `541f405`. No files changed, credentials inspected, or provider calls made.

The source confirms that `runRoundTrip()` can replace captured progress with `evidence(undefined, …)` after an outer failure. Diagnostics must survive failures in transport, consumption, parsing, and cleanup without changing acceptance rules.

**Scope and ownership**

| ID | Owner | Exact paths / deliverable |
|---|---|---|
| D1 | Dot | New `docs/active/phase-15.3-response-diagnostic-plan.md`; append to `docs/active/phase-15.3-results.md`; update `.claude/state/progress.md`. Preserve original reported values, explaining their uncertainty. |
| D2 | Backend, `gpt-6.2-sol/high` | New `src/extension/feasibility/response-diagnostics.ts`; instrument `official-http.ts` and `responses.ts`; narrowly extend `signin-session.ts` projection. No request or parser acceptance changes. |
| D3 | Backend, same role | New `src/companion-feasibility/{response-diagnostic,diagnostic-budget}.ts`; narrow changes to `runtime.ts`, `contracts.ts`, `control-server.ts`, `control-view.html`, and `storage.ts` for one disabled-by-default diagnostic action and separate durable cap. |
| D4 | Independent test-engineer, `gpt-6.2-sol/high` | New `tests/chatgpt-response-diagnostics.test.ts`, `tests/chatgpt-companion-diagnostic.test.ts`, `tests/fixtures/chatgpt-response-diagnostics.ts`; targeted existing regression updates only where evidence semantics change. |
| D5 | Backend + Dot | `scripts/build-chatgpt-companion.ts`, companion runbook: new version/build, package inventory and hashes. |
| D6 | Read-only reviewer + Dot | One bounded review, corrections, verification, checkpoint PR. Anthony reviews before any live diagnostic. |

D2 defines the evidence contract before D3/D4 proceed. Backend owns implementation; independent tests own test files. Preserve all 1280 current tests and existing artifacts. No Live bridge, production changes, dependency changes, or broad response-adapter rewrite.

**Diagnostic contract**

Create one per-request accumulator **before request preparation**, retained through `finally`. Expose only a sanitized immutable snapshot.

Use nullable measurements:

- `httpStatus: number | null`
- `mimeCategory: "sse" | "json" | "other" | "missing" | "invalid" | "unobserved"`
- `transportBytes`, `transportChunks`, `parserBytes`, `framedEvents`, `consumerEvents`: `number | null`

`null` means that measurement was not established. Zero is valid only after its instrumentation boundary initialized successfully. Record separately whether the first read started, settled, returned EOF, or returned bytes. Never convert unknowns to zero in `signin-session.ts`, UI, or serialization.

Track fixed stage states—`not_started`, `started`, `passed`, `failed`—for:

1. Request validation/serialization.
2. Fetch invocation and resolution.
3. HTTP status and header inspection.
4. Response-body inspection and reader acquisition.
5. Consumer entry and body reads.
6. SSE framing, event decoding, semantic validation, terminal observation.
7. Reader cancellation/release and transport cleanup.

Retain both `primaryFailureStage/code` and `cleanupFailureCode`; cleanup must not erase the original failure or observed counters. Distinguish an actual observed `response.failed`/`response.incomplete` from a locally classified malformed response.

Preserve progress before potentially throwing operations. For example, count delivered transport bytes before parser invocation; a parser error must retain those bytes even if no event completed. Use observer hooks or a shared accumulator, not raw exceptions carrying response objects.

**Privacy boundary**

Allow only fixed enums, bounded integer counts, booleans, status integers, known terminal categories, and allowlisted provider error codes.

Do not emit:

- Raw headers or MIME strings.
- Request/response bodies, text deltas, arguments, reasoning, transcripts.
- URLs, IDs, tokens, callback data, exception messages/stacks/causes.
- Arbitrary event names or arbitrary provider error strings.

Map unknown event types to `other`; a fixed known-event category or last known category is sufficient. Do not retain a raw-response file or introduce tracing/proxy capture.

For non-SSE/non-success responses, preserve status, MIME category, and whether the existing bounded JSON classifier observed an `error`, `detail`, other, or unreadable shape. Do not read an additional body solely for diagnostics.

**Narrow provider classification**

Current official documentation requires public Responses, `store:false`, `stream:true`, and success only after `response.completed`; failed, incomplete, and interrupted outcomes remain distinct. Keep those requirements unchanged. [Inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

Preserve documented codes such as `subscription_sharing_usage_limit_exceeded` and `subscription_sharing_usage_unavailable` when found in a valid in-stream failure envelope. Unknown or conflicting codes remain generic. No inference retries or billing fallback follow classification. Direct-admission bodies may use `detail` rather than the usual error object, so shape alone is not a stable error code. [Official error guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

**Defensive tests before any live proposal**

Drive the actual wrapper and consumer with offline fixtures covering:

- Failure before Fetch; rejected Fetch; resolved response with invalid status.
- Missing, JSON, SSE-with-parameters, unexpected, or inaccessible content type.
- Missing body, throwing `getReader`, invalid reader, first-read rejection.
- Actual empty EOF versus unknown counts.
- Nonempty malformed UTF-8/JSON/SSE and semantic `invalid_response` after valid events.
- Completed, failed, incomplete, premature EOF, documented usage failures.
- Consumer failure followed by cleanup failure.
- Nonzero progress retained through outer catch and session/UI projection.
- Unknown event/error categories and secret sentinels never appearing in evidence.
- Counter limits, cancellation, timeout, cleanup, and unchanged acceptance criteria.

Reproduce the current counter-loss defect with a failing test before fixing it. Do not relax function-call validation, MIME validation, or terminal parsing based on an unverified hypothesis.

**Separate one-request experiment**

A text-only request is the smallest useful real experiment: it removes namespace/function assembly while exercising the same HTTP, SSE, consumer, and terminal path. It cannot prove the original function request works.

Implement a separate action, disabled until explicit owner authorization:

```text
run_text_diagnostic
model: freshly selected from the current catalog
input: fixed request to reply with p15_3
store: false
stream: true
no tools
```

Reuse the instrumented transport and collector with calls disallowed. No user-supplied prompt, automatic continuation, function execution, or cancellation experiment. Retain existing time/size limits and manual emergency Cancel.

Use a fixed separate durable record, `response-diagnostic-budget.json`, with schema version, experiment ID, cap `1`, and reserved attempts `0|1`. Creation requires explicit authorization for this named experiment. Reserve durably before Fetch; failure or uncertain dispatch consumes the slot. No reset UI, new-run button, retry, or automatic experiment-ID rotation.

The original `run-budget.json` must remain **1/3** and unchanged. Its two remaining slots are frozen for this checkpoint. Show original and diagnostic accounting separately. Missing/corrupt/uncertain diagnostic state blocks dispatch rather than recreating allowance. Sign-out and restart do not reset either record. Use the existing strict file/directory durability machinery.

Required additional tests: no request without every gate, no second diagnostic request, no original-budget mutation, restart persistence, uncertain reservation, late completion after sign-out, and rejection of the old roundtrip/cancellation actions in diagnostic mode.

**Delivery and operator gates**

Build companion **0.0.4** into a new versioned directory; preserve 0.0.3 and its hashes. Include all diagnostic inputs in build identity, reproduce package contents independently, and record checksums.

Run lint, typecheck, all Vitest tests, existing dev build, and companion package checks. Review the concrete diff and artifact before live use. Open the checkpoint PR and stop for Anthony’s review.

After review, Dot must obtain separate explicit authorization equivalent to:

> “Authorize one additional synthetic text-only Responses request for this diagnostic. Preserve the previous 1/3 budget; do not use its remaining slots.”

“Continue,” the prior three-request allowance, and successful earlier consent do not substitute for this new cap.

Only then Anthony personally launches, pairs, completes fresh sign-in as needed, verifies current plan-only/no-credit settings, loads the catalog, selects the model, and runs the action once. Agents make no live calls. Record sanitized evidence, then have Anthony sign out and wait for the cleanup/revocation result before stopping.

A successful text response proves only this diagnostic path. A failure should identify the last established stage and remaining uncertainty. Either outcome returns to review; no replay, function roundtrip, cancellation request, Phase 15.4 advancement, or alternative provider is automatically authorized.
