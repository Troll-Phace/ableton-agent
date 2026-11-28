# Phase 15.3 — standalone official SDK offline checkpoint

**Scope:** companion 0.0.5 is an offline implementation and packaging checkpoint, not a live inference release. It uses the documented OpenAI SDK for ordinary streaming and leaves previous custom-parser code/history intact. It has no usable live allowance. Do not sign in, launch a live request, or use earlier packages to replay an experiment. Live can remain closed; no Live bridge or production integration.

## Package verification

From the repository root:

```sh
node --import tsx scripts/build-chatgpt-companion.ts
cd dist/chatgpt-companion/0.0.5
shasum -a 256 -c SHA256SUMS
node companion.cjs --version
```

The package contains companion.cjs (including the control panel), this runbook, license, third-party notices, exact dependency inventory and SHA256SUMS. Requires ordinary-user macOS Node >=24.14.1. The SDK is pinned to 7.65.0. Previous 0.0.1–0.0.4 packages are historical evidence; preserve them and do not launch for replay.

## Offline acceptance and future gate

The official SDK's normal streaming behavior replaces the custom MIME, SSE framing and UTF-8 handling for this new path. The adapter uses the documented public Responses endpoint, existing selected OAuth connection, selected catalog model, store:false/stream:true, zero retries, disabled logging, bounded consumption and application deadline. A successful synthetic result requires the expected marker in a completed response; failed/incomplete/EOF, timeout or cancellation are not success. Cancellation stops local work, not a guarantee about provider-side usage. Evidence contains fixed sanitized classifications only.

The original experiment remains frozen at 1/3 and the previous diagnostic at 1/1 exhausted. Their accounting is read-only and cannot be replayed, reset or renewed in this build. The native composition will not dispatch SDK inference; the packaged UI reports no allowance. Offline tests use injected synthetic Fetch and synthetic reservation only. No real authorization or provider request was performed. Review this exact artifact and PR before separately planning and explicitly authorizing a new owner-operated experiment with its own cap; that future scope requires personal OAuth consent as needed, plan-only/no credit fallback, selected account model and safe cleanup. No alternate provider or credential, no paid fallback, no support contact.

Do not share pairing codes, callback URLs, credentials, account details, raw SDK errors or response content. If ever authorized and launched for a future experiment, use ordinary foreground process and the authenticated loopback panel; personally sign out, wait for separately reported local credential deletion and remote revocation status, then stop. That is not an instruction to launch the offline checkpoint.
