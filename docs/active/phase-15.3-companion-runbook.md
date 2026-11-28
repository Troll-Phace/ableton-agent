# Phase 15.3 — SDK synthetic tool roundtrip (owner-operated probe)

**Scope:** companion 0.0.8 implements the owner's separate authorization for at most two additional fixed synthetic SDK requests, using the ChatGPT plan only with credit fallback disabled. Review the exact PR and artifact before personally operating the companion. Agents must not launch, sign in, access real storage or dispatch. Live remains closed; no Live bridge, general tool dispatcher or production integration is present.

## Package verification

From the repository root:

```sh
node --import tsx scripts/build-chatgpt-companion.ts
cd dist/chatgpt-companion/0.0.8
shasum -a 256 -c SHA256SUMS
node companion.cjs --version
```

The package contains companion.cjs (including the control panel), this runbook, license, third-party notices, exact dependency inventory and SHA256SUMS. Requires ordinary-user macOS Node >=24.14.1. The SDK is pinned to 7.65.0. Compare the exact build ID, entry digest and manifest digest with the owner-reviewed checkpoint. Previous 0.0.1–0.0.7 packages are historical evidence; preserve them and do not launch for replay. The version command is inert and makes no request.

## Operating boundaries

The official SDK's documented public Responses endpoint and normal streaming are reused through the same bounded transport as the successful text adapter. Selected OAuth connection and catalog model, personal consent, plan-only/no credit fallback, `store:false`, `stream:true`, zero retries, logging disabled, bounded consumption and application deadlines remain mandatory. The packaged runtime uses its separate durable budget, not the test-only reservation seam.

The original 1/3, previous diagnostic exhausted 1/1, and successful SDK text exhausted 1/1 all remain read-only and byte-identical. Missing, malformed or uncertain historical accounting blocks a run. Separate named authorization creates exactly two fixed, private records for this experiment (authorization intent and budget). Never inspect, copy, edit or delete real records, reset an allowance, launch earlier packages, switch providers, use a paid fallback, or register an alternate account.

## Owner operation (only after PR and artifact review)

1. From the verified package directory run `node companion.cjs` as the ordinary user. Pair privately using the one-time code from the controlling terminal, complete storage preflight, and use the existing registration for personal sign-in. Do not request new registration. Complete persisted-connection refresh and load the catalog.
2. Select the current catalog model. Confirm plan only and disabled credit fallback. Check the three historical budgets are frozen at 1/3, 1/1, and 1/1, respectively, and the new named tool allowance is not authorized. If the controls or status disagree, stop.
3. Confirm the separate owner consent for at most two additional fixed synthetic requests, then click **Authorize named SDK tool roundtrip (up to two requests)**. Verify the new allowance is ready at 0/2. Authorization itself sends no inference. Click **Run fixed SDK echo roundtrip** only once.

The Run performs only the following fixed sequence:

1. Durably reserve step 1 (intent then count), then send the fixed input and strict namespace `feasibility.echo` definition. The app validates a completed terminal containing exactly one matching function call, unique bounded IDs and exact unique-key `{"value":"p15_3"}` arguments. No partial frame can execute anything.
2. The sole local operation is the constant in-memory `{"ok":true,"value":"p15_3"}` echo. Build bounded explicit history from the original input and the required complete returned output/context, including returned reasoning context and the unchanged matching call ID. Only this active generation may durably reserve step 2 before dispatching the continuation. Require a completed final marker, without further function activity.
3. Stop after the second request. Failed/incomplete/interrupted streams, invalid calls, timeout, cancellation or uncertain reservation do not count as successful completion. No retry, third request, restart resume, or general tool execution is available. Only fixed sanitized counts and state codes are retained; raw returned content, IDs, arguments, reasoning and credentials are never projected or persisted.

Report only sanitized state/evidence, including the new durable count, echo validation and final marker acknowledgement. A ready zero may survive restart, but a process that reserved step one cannot resume after restart, cancel, sign-out, interruption or failure. No remaining slot may be repurposed or refunded. On failure or uncertainty stop; do not retry or run another experiment. Sign out and await reported local credential deletion and remote revocation status separately, then stop the companion. A success establishes fixed synthetic SDK tool roundtrip feasibility only, not real Live tool behavior, cancellation proof or production integration.
