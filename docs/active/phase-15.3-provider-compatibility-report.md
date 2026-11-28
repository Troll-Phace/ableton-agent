# Phase 15.3 — provider compatibility report (draft, not submitted)

## Question for provider support

Does the documented ChatGPT plan-use Responses endpoint intentionally return successful streaming HTTP responses without a Content-Type header? Is there a documented compatibility requirement for clients consuming those responses, or a supported way to determine why a header is not visible? The following is an observed client-side result, not a confirmed origin defect.

## Observed result

- 2026-11-28 02:33 UTC, standalone macOS Node 24.16.0 companion version 0.0.4, build f3c-3a3e0fea1a3f94f1.
- Official Sign in with ChatGPT OAuth, plan-use scope, fresh account-specific catalog, restart and refresh verified. Owner selected gpt-6.2-sol and confirmed plan-only use, disabled credit fallback.
- One separately authorized fixed text-only synthetic request to the public Responses API, with store:false and stream:true. No tools, no retries.
- Fetch resolved, HTTP 200, response body present and reader acquired. The client's Content-Type lookup produced no value. The explicit SSE MIME gate rejected before its first body read (invalid_response); terminal not observed; parser counters unavailable; cleanup passed.
- Earlier function-roundtrip invocation failed before producing a successful completion; its zero counters were unreliable. Neither attempt establishes origin header behavior, body syntax, account denial or completed inference.

Original experiment 1/3 frozen; separate diagnostic 1/1 exhausted. No additional request for investigation. Local connection credential files cleared; remote revocation unconfirmed. No request IDs, tokens, account identity, response content, or raw headers are included.

## Offline comparison of the official client

The documented [official SIWC inference example](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) uses the public endpoint and an OAuth bearer with zero retries, store:false, and stream:true; completion requires response.completed. It does not specify a missing-response-MIME policy.

Independent backend exercised the [official SDK release v7.65.0](https://github.com/openai/openai-node/releases/tag/v7.65.0), integrity sha512-n7tmWKiUptMIugQMGAEDsfeu8MsPLR4uHPFWRcUjy7Mn2w968TuAUMGOlvnh/AghLF1iz4zYop2RoxfHZFKaEw==, Node 24.16.0; 34 paired synthetic cases, 12 raw-response comparisons, two cancellation cases, one isolation case. Injected fetch only, zero non-injected dispatches. The SDK accepted valid synthetic SSE with no MIME, while the existing strict wrapper rejected before reading. It also accepted conflicting MIME. Adding only a terminal/marker guard was not equivalent to the current validation: six synthetic malformed, mismatched or oversized cases exceeded its guarantees. The SDK's fetch timeout did not terminate stalled consumption; explicit cancellation released the reader but iteration did not throw. Cleanup/error bounds and sanitized error/configuration isolation need independent guarding. The SDK raw-response composition with existing strict wrapper still rejected missing MIME.

The comparison supports a documented client-behavior difference, not a claim that the actual live response is valid SSE or that the SDK would resolve the failure. Do not remove the MIME gate, silently change billing, or adopt a drop-in SDK replacement. A future supported guarded adapter would need a reviewed design and separately authorized experiment, or provider clarification first. The current conservative recommendation is to keep the provider phase blocked, preserve both reservations, and seek provider guidance.

Pinned release references: [parser](https://github.com/openai/openai-node/blob/v7.65.0/src/internal/parse.ts), [streaming](https://github.com/openai/openai-node/blob/v7.65.0/src/core/streaming.ts), [manifest](https://github.com/openai/openai-node/blob/v7.65.0/package.json).
