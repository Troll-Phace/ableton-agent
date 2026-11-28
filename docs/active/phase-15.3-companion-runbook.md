# Phase 15.3 — standalone official SDK one-request operator test

**Scope:** companion 0.0.6 is a separate owner-operated feasibility test of exactly one additional synthetic text-only SDK request, using the ChatGPT plan only with credit fallback disabled. Review the exact artifact and PR before any live action. The SDK adapter and previous custom-parser evidence are unchanged. Live can remain closed; no tool roundtrip, Live bridge or production integration is authorized. Agents perform offline synthetic tests only.

## Package verification

From the repository root:

```sh
node --import tsx scripts/build-chatgpt-companion.ts
cd dist/chatgpt-companion/0.0.6
shasum -a 256 -c SHA256SUMS
node companion.cjs --version
```

The package contains companion.cjs (including the control panel), this runbook, license, third-party notices, exact dependency inventory and SHA256SUMS. Requires ordinary-user macOS Node >=24.14.1. The SDK is pinned to 7.65.0. Compare the exact build ID, entry digest and manifest digest with the owner-reviewed checkpoint. Previous 0.0.1–0.0.5 packages are historical evidence; preserve them and do not launch for replay. Do not launch this package before PR review, or if any identity, integrity or prerequisite check fails.

## Owner operation — only after PR review

The official SDK's normal streaming behavior replaces the custom MIME, SSE framing and UTF-8 handling for this new path. The adapter uses the documented public Responses endpoint, existing selected OAuth connection, selected catalog model, store:false/stream:true, zero retries, disabled logging, bounded consumption and application deadline. A successful synthetic result requires the expected marker in a completed response; failed/incomplete/EOF, timeout or cancellation are not success. Cancellation stops local work, not a guarantee about provider-side usage. Evidence contains fixed sanitized classifications only.

The original experiment must remain frozen at 1/3 and the previous diagnostic at 1/1 exhausted, byte-for-byte. Both records are read-only. The new SDK experiment is separately named `p15_3_official_sdk_diagnostic`, cap 1, initially not authorized. Its authorization and budget records are `sdk-diagnostic-authorization.json` and `sdk-diagnostic-budget.json`. Missing half-records, malformed state, orphan temporaries or uncertain commits block the SDK request. Never inspect, copy, delete or edit records, and never reset or renew an allowance. No alternate provider, destination, credential, paid fallback, support contact or automatic registration is authorized.

After the owner reviews the concrete PR and exact artifact, the owner personally operates these steps in order:

1. Launch the verified `node companion.cjs` in an ordinary interactive foreground terminal. Pair via the fixed loopback panel using the private, one-time terminal code. Do not share pairing codes, cookies, CSRF values, callback URLs or account credentials.
2. Run preflight. Confirm actual local durability and the previously verified private storage/restart conditions. Stop on any blocked or uncertain condition. Only the explicit preflight may perform official discovery/JWKS; it does not start consent.
3. Personally select **Continue with ChatGPT**, review official consent, and verify the plan-use permission. Use the established returning registration, not an alternate account or new registration. If necessary stop preserving validated credentials, relaunch this same package, pair and preflight. Check persisted connection and perform the one explicit refresh. No automatic refresh or sign-in retry.
4. Load the account catalog, select a currently listed model, verify ChatGPT plan-only use and disabled credit fallback in ChatGPT settings, and confirm both statements in the panel. The panel does not independently control billing. Verify original 1/3, previous exhausted 1/1, and SDK not authorized.
5. Check the separate SDK experiment authorization statement and select **Authorize named one-request SDK diagnostic**. This creates the durable named SDK allowance at 0/1 but sends no inference request. Verify SDK ready 0/1 and both historical counts unchanged. Do not try to authorize again.
6. Select **Run fixed SDK text diagnostic** once. Reservation is committed at 1/1 before Fetch. Failure, interruption, cancellation or uncertain dispatch is not success and must not be retried. A valid completed marker establishes synthetic text inference only; no function/tool inference, cancellation experiment, further request or Live integration follows automatically.
7. Report only sanitized outcomes: package identity, budget states, fixed HTTP/MIME/stream/terminal/cleanup classifications, bounded counts and marker acknowledgment. Do not share raw responses, SDK errors, headers, tokens, IDs or provider content.
8. Select **Sign out and clear local credentials** and wait until local deletion and remote revocation are separately reported. An unconfirmed revocation is not success. Then select **Stop** and verify terminal cleanup. Ctrl-C, SIGTERM or idle stop is not sign-out and does not guarantee revocation. Do not restart to replay a failed attempt.

No agent has performed actual sign-in, reservation on real storage, or inference. This runbook does not authorize any request beyond the fixed one-request owner test after PR review.
